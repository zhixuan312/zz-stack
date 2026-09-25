/**
 * Subject identity (FR-1): the one immutable `subject_version` every later stage binds to.
 *
 * `plugin_locate` is IDENTIFY for a catalog plugin. It resolves a catalog plugin's released
 * version, computes its whole-plugin content digest from the sorted digests of its own
 * components (skills, declared servers, the flow manifest itself — never the environment it
 * happens to run in), and upserts the immutable row `zz.eval_subject_version` is keyed on:
 * `(plugin_id, declared_version, content_digest)`. Calling it twice for a release whose content
 * has not moved returns the same `subject_version_id` — idempotent by construction, through the
 * unique constraint, and again through the FR-59 ledger this module is the first caller of.
 *
 * `plugin_register` is IDENTIFY for everything else (FR-2): a plugin the catalog has never
 * released, captured once from its own source directory rather than recomputed on every call —
 * there is no release to anchor a recompute to, so the row `plugin_register` writes is what
 * `plugin_locate` reads back for it afterwards, unchanged, rather than a second derivation that
 * could disagree with the first. Its source readers, and the confinement that bounds what a
 * caller's locator may reach, are subject-source.ts's.
 *
 * DELIBERATE: both are mutators, unlike everything in plugin-eval.ts. They are the only places a
 * new subject version comes from, so the identity every later stage joins against exists before
 * anything asks for it a second time.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, serversOf } from "./plugin-eval.js";
import { retractedVersions } from "./release-retracted.js";
import { type Component, resolveSource, sha256 } from "./subject-source.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no subject can be recorded");

/** The whole-plugin digest: sha256 over the SORTED per-component digests, never over an order a
 *  query happened to return them in — two locates of the same release must agree on this digest
 *  however their component rows came back. */
function combinedDigest(components: readonly Component[]): string {
  return sha256([...components.map((c) => c.digest)].sort().join("\n"));
}

/** Everything IDENTIFY needs about one released (plugin, version), resolved once before any
 *  write. Returns null for a plugin/version this platform never released — the caller turns
 *  that into the contract's exact refusal text; this function does no I/O beyond reading. */
async function resolveSubject(pool: pg.Pool, plugin: string, version: string | undefined): Promise<{
  pluginId: string; origin: string; declaredVersion: string; releasedDigest: string;
  components: Component[]; contentDigest: string;
  sourceLocator: Record<string, unknown>; releaseIdentity: Record<string, unknown>;
} | null> {
  // `$2::text is null` rather than two query strings: one text keeps the "latest release" and
  // "this exact release" paths from drifting apart the way plugin-eval.ts's old copy of this
  // query and this one already had, once, before this task merged them.
  //
  // The newest release leaves out every version a rollback retracted (`retractedVersions`, the
  // same rule release_apply's baseline applies), so after a rollback the head IS the prior
  // version again — the retracted row stays in zz.plugin_version, and naming its exact version
  // still resolves it.
  const pluginId = (await pool.query<{ id: string }>(
    "select id::text as id from zz.plugin where name = $1", [plugin])).rows[0]?.id;
  const retracted = pluginId && !version ? await retractedVersions(pool, pluginId) : [];
  const head = (await pool.query<{
    plugin_id: string; plugin_version_id: string; origin: string; declared_version: string; digest: string;
  }>(`
    select p.id::text as plugin_id, pv.id::text as plugin_version_id, p.origin,
           pv.version as declared_version, pv.digest
      from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
     where p.name = $1 and ($2::text is null or pv.version = $2) and pv.version <> all($3::text[])
     -- Semver order, not text order: '0.10.0' sorts below '0.9.0' as text. The numeric core is
     -- compared as numeric[] (never int[], which a long digit run overflows); a version with no
     -- numeric core reads null and sorts last rather than failing the cast; at an equal core a
     -- release outranks its own pre-release ('1.0.0' above '1.0.0-rc.1'), and text breaks any
     -- tie that is left.
     order by string_to_array(substring(pv.version from '^[0-9]+(?:\\.[0-9]+)*'), '.')::numeric[] desc nulls last,
              (pv.version like '%-%') asc, pv.version desc
     limit 1`, [plugin, version ?? null, retracted])).rows[0];
  if (!head) return null;

  // A third party has no release to recompute against — plugin_register captured its
  // component set once, from the source directory it was given, and that capture is this
  // subject's whole identity. Recomputing here the way the catalog path does below would read
  // zz.plugin_version_skill (empty: a third party's skills never go through register-skills)
  // and the catalog manifest (absent by definition), landing on a digest that can never agree
  // with the one plugin_register wrote — the same plugin/version would then answer with two
  // different subject_version_id values depending on which tool minted the row first.
  if (head.origin === "third_party") {
    const captured = (await pool.query<{
      component_manifest: Component[]; content_digest: string;
      source_locator: Record<string, unknown>; release_identity: Record<string, unknown>;
    }>(`
      select component_manifest, content_digest, source_locator, release_identity
        from zz.eval_subject_version
       where plugin_id = $1::uuid and declared_version = $2
       order by captured_at desc limit 1`, [head.plugin_id, head.declared_version])).rows[0];
    // Registered but never captured should not happen — plugin_register writes zz.plugin_version
    // and zz.eval_subject_version in the same transaction — but a partial state is reported as
    // "never released" rather than crashing on a read that found nothing to return.
    if (!captured) return null;
    return {
      pluginId: head.plugin_id, origin: head.origin, declaredVersion: head.declared_version,
      releasedDigest: head.digest, components: captured.component_manifest,
      contentDigest: captured.content_digest, sourceLocator: captured.source_locator,
      releaseIdentity: captured.release_identity,
    };
  }

  const skills = (await pool.query<{ name: string; version: string; content_hash: string }>(`
    select s.name, sv.version, sv.content_hash
      from zz.plugin_version pv
      join zz.plugin p on p.id = pv.plugin_id
      join zz.plugin_version_skill pvs on pvs.plugin_version_id = pv.id
      join zz.skill_version sv on sv.id = pvs.skill_version_id
      join zz.skill s on s.id = sv.skill_id
     where p.name = $1 and pv.version = $2
     order by s.name`, [plugin, head.declared_version])).rows;

  const entry = entryOf(plugin);
  const components: Component[] = [
    ...skills.map((s): Component => ({
      kind: "skill", name: s.name,
      // A skill version's own content hash, never blank in practice (register-skills.ts always
      // writes one) — falling back to a hash of its identity rather than throwing, so a stray
      // pre-migration row cannot take IDENTIFY down for the whole plugin.
      digest: s.content_hash || sha256(`${s.name}@${s.version}`),
    })),
    ...serversOf(entry).map((sv): Component => ({
      kind: "server", name: sv.name, digest: sha256(`${sv.name}:${sv.path}`),
    })),
  ];
  if (entry) {
    // The manifest @zz/catalog already parsed and validated for us — `entryOf` runs through
    // `catalogEntries()`, which is @zz/catalog's own `manifestAt`. Hashing that object, never a
    // second raw read of flow.json off disk, is what keeps this the only reader a flow's
    // manifest has: catalog-manifest.ts's gate check refuses a second one.
    components.push({ kind: "flow", name: entry.flow, digest: sha256(JSON.stringify(entry.manifest)) });
  }

  return {
    pluginId: head.plugin_id, origin: head.origin, declaredVersion: head.declared_version,
    releasedDigest: head.digest, components, contentDigest: combinedDigest(components),
    sourceLocator: entry
      ? { kind: "catalog", owner: entry.owner, flow: entry.flow }
      : { kind: "unrecorded" },
    // FR-1's "immutable source/release identity" — what release.ts's own digest (written once,
    // at release, by register-plugins.ts) and this call's origin were at the moment this subject
    // version was captured. Not the content digest above: that is recomputed here and can differ
    // from the release-time one if a component's digest source changes under it, which is exactly
    // what a second locate is supposed to catch.
    releaseIdentity: { plugin_version_id: head.plugin_version_id, released_digest: head.digest, origin: head.origin },
  };
}

/** The `plugin_locate` response, read back from the row rather than re-derived — a replayed
 *  idempotent call and a freshly inserted one return through this one path, so the two can never
 *  disagree about the shape. */
async function subjectResponse(
  runner: Pick<pg.Pool, "query">, subjectVersionId: string,
): Promise<Record<string, unknown>> {
  const row = (await runner.query<{
    id: string; plugin: string; declared_version: string; content_digest: string;
    component_manifest: Component[]; release_identity: Record<string, unknown>;
    origin: string; owner_team: string | null; evolvable: boolean; release_owners: string[];
  }>(`
    select sv.id::text as id, p.name as plugin, sv.declared_version, sv.content_digest,
           sv.component_manifest, sv.release_identity,
           p.origin, p.owner_team, p.evolvable, p.release_owners
      from zz.eval_subject_version sv
      join zz.plugin p on p.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];

  // The newest protocol version this plugin has, if any — FR-4/FR-5's protocol lineage has no
  // writer yet in this task's dependency scope (protocol_record is a later stage), so this reads
  // as null until it does. Not a compatibility check against `subject_compatibility`: that
  // reading is protocol_read's one job, and duplicating it here would give two answers to
  // "which protocol applies" from two different tools.
  const protocol = (await runner.query<{ id: string }>(`
    select epv.id::text as id
      from zz.eval_protocol_version epv
      join zz.eval_protocol ep on ep.id = epv.protocol_id
      join zz.plugin p on p.id = ep.plugin_id
     where p.name = $1
     order by epv.version desc limit 1`, [row.plugin])).rows[0];

  return {
    subject_version_id: row.id,
    plugin: row.plugin,
    declared_version: row.declared_version,
    content_digest: row.content_digest,
    component_manifest: row.component_manifest,
    release_identity: row.release_identity,
    origin: row.origin,
    owner_team: row.owner_team,
    evolvable: row.evolvable,
    release_owners: row.release_owners,
    // Ownership's own release track, not the per-initiative branch fact of the same name
    // FR-52/FR-58 has `release_prepare`/`proposal_prepare` write into `_facts.json` (Task I-27).
    // That later fact is read from THIS one: a subject with no release owners can never be
    // promoted (FR-47), so it is `proposal_only`; the reverse is `promotable`, contingent on
    // every later gate this initiative still has to pass. Never `not_applicable` here — that
    // value belongs to an initiative that never reached a release/proposal stage at all, which
    // is not a fact plugin_locate, called before any evaluation exists, can see.
    release_mode: row.release_owners.length > 0 ? "promotable" : "proposal_only",
    latest_compatible_protocol_version_id: protocol?.id ?? null,
    // What an evaluation may do with its findings follows from whose the plugin is — carried
    // over from plugin-eval.ts's pre-FR-1 plugin_locate, which this module replaces. Ours
    // (`origin = "platform"`): the findings feed a change somebody makes. A third party's
    // (`origin = "third_party"`): assess and stop, because a proposed change against a plugin we
    // do not own is a finding pretending to be an instruction (FR-51).
    origin_mode: row.origin === "third_party" ? "assess only" : "assess, then change",
  };
}


export function registerSubjectTools(server: McpServer): void {
  server.registerTool(
    "plugin_locate",
    {
      description:
        "WHEN an evaluation begins, before any other tool on this door: IDENTIFY the plugin it is " +
        "about. It RETURNS FR-1's immutable subject_version — declared version, whole-plugin " +
        "content digest, per-component manifest (skill/server/flow/config digests, never the " +
        "environment), ownership and its release mode, and the latest compatible protocol version " +
        "if one exists — with the SAME subject_version_id for the same release content, whichever " +
        "call minted the row. Every later tool takes the subject_version_id this returns, so an " +
        "evaluation cannot drift onto a different version of its own subject halfway through. A " +
        "mutator: it upserts zz.eval_subject_version through the FR-59 idempotency ledger, so a " +
        "retried call with the same idempotency_key replays rather than minting a second row. " +
        "REFUSES a plugin this platform has never released.",
      inputSchema: {
        plugin: z.string(),
        version: z.string().optional().describe("Omit for the newest released version."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ plugin, version, idempotency_key }) => {
      const pool = db();
      if (!pool) return noDb();

      const resolved = await resolveSubject(pool, plugin, version);
      if (!resolved) {
        return text(`ERROR: no plugin named ${plugin} is registered — plugin_register adds one that is not in the catalog`);
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_locate", idempotency_key, { plugin, version },
        async (client): Promise<MutatorOutcome<string>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_subject_version
              (plugin_id, declared_version, content_digest, component_manifest, source_locator,
               release_identity, captured_at)
            values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
            on conflict (plugin_id, declared_version, content_digest)
              -- A no-op write of the row onto itself: the conflict key already fixes every other
              -- column's value, so this exists only so the RETURNING clause below gives back the
              -- existing id rather than nothing, the same trick protocol-record.ts's upsert of
              -- zz.eval_protocol uses (Task I-10), and the removed ruler_record used to on zz.rubric.
              do update set component_manifest = excluded.component_manifest
            returning id::text as id`,
            [resolved.pluginId, resolved.declaredVersion, resolved.contentDigest,
             JSON.stringify(resolved.components), JSON.stringify(resolved.sourceLocator),
             JSON.stringify(resolved.releaseIdentity)])).rows[0];
          // `result` carries the id on the fresh path — the only thing `subjectResponse` needs —
          // so both arms below read the id off a field `IdempotencyOutcome` actually has.
          return { result: row.id, result_table: "zz.eval_subject_version", result_id: row.id };
        },
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      logActivity(await userRoot(), null,
        { user: principal, action: "plugin_locate", plugin, version: resolved.declaredVersion,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      return json(await subjectResponse(pool, subjectVersionId));
    },
  );

  server.registerTool(
    "plugin_register",
    {
      description:
        "WHEN a plugin needs to be evaluated and the catalog has never released it: IDENTIFY " +
        "it from its own source instead. It reads source_locator — for source_kind local_dir, " +
        "a directory under the catalog root: its own SKILL.md files, declared servers and flow " +
        "manifest; for git, an https:// repository URL on a public host (optionally '#ref') " +
        "shallow-cloned and read the same way, with the commit it landed on recorded; for " +
        "package, a registry spec (name or @scope/name, optionally @version) fetched with " +
        "npm pack and read from its extracted tarball, with the tarball's own integrity " +
        "recorded — and RETURNS the same subject_version_id shape plugin_locate comes back with, so plugin_locate, " +
        "plugin_profile and plugin_conform all then work for this plugin with no catalog entry. " +
        "The row it captures is that subject's whole identity: unlike plugin_locate, a later " +
        "call for the same plugin/version reads this capture back rather than recomputing it, " +
        "because a third party has no release moment to recompute against. A mutator, through " +
        "the same FR-59 idempotency ledger plugin_locate uses. REFUSES a name the catalog " +
        "already owns — that plugin is registered by release, never by this tool — REFUSES a " +
        "payload naming origin, owner_team, evolvable or release_owners, since the platform " +
        "derives every authority field itself and never takes one as input, REFUSES a " +
        "source_locator it cannot read or may not reach, and REFUSES re-registering a version " +
        "whose content changed — a changed source is a new version.",
      inputSchema: {
        name: z.string(),
        version: z.string(),
        source_kind: z.enum(["local_dir", "git", "package"]),
        source_locator: z.string(),
        idempotency_key: z.string().min(1),
        // Not accepted — named here only so a caller that supplies one is not silently
        // stripped before the handler below can refuse it. See the contract's "authority
        // field" refusal.
        origin: z.unknown().optional(),
        owner_team: z.unknown().optional(),
        evolvable: z.unknown().optional(),
        release_owners: z.unknown().optional(),
      },
    },
    async ({ name, version, source_kind, source_locator, idempotency_key,
             origin, owner_team, evolvable, release_owners }) => {
      if (origin !== undefined || owner_team !== undefined || evolvable !== undefined
          || release_owners !== undefined) {
        return text("ERROR: origin/owner/evolvable/release_owners are derived by the platform, not supplied");
      }
      if (entryOf(name)) {
        return text(`ERROR: ${name} is a catalog plugin; it is registered by release`);
      }

      const pool = db();
      if (!pool) return noDb();

      // A name this platform once released and the catalog no longer carries is still the
      // catalog's to speak for — never flipped to third_party by a call that merely found the
      // entry gone, which `entryOf` above cannot see for a removed flow.
      const existing = (await pool.query<{ origin: string }>(
        `select origin from zz.plugin where name = $1`, [name])).rows[0];
      if (existing?.origin === "platform") {
        return text(`ERROR: ${name} is a catalog plugin; it is registered by release`);
      }

      // Ahead of withIdempotency, and so ahead of the ledger's own proceed/replay decision — a
      // replayed call re-clones/re-fetches only to have its result discarded below, the same
      // cost local_dir already paid to re-read a directory before this task. Moving the fetch
      // inside the ledger's transaction would mean holding a database connection open for a
      // multi-second git clone or npm pack, which is the worse trade.
      const resolved = await resolveSource(source_kind, source_locator);
      if ("error" in resolved) {
        return text(`ERROR: source ${source_locator} could not be read: ${resolved.error}`);
      }
      const contentDigest = combinedDigest(resolved.components);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_register", idempotency_key,
        { name, version, source_kind, source_locator },
        async (client): Promise<MutatorOutcome<string>> => {
          const pluginRow = (await client.query<{ id: string }>(`
            insert into zz.plugin (name, origin) values ($1, 'third_party')
            on conflict (name) do update set origin = excluded.origin
            returning id::text as id`, [name])).rows[0];
          // A declared version is immutable once captured: re-registering it from a source whose
          // content moved would rewrite the digest every earlier evaluation of that version was
          // judged against, and a subject's identity is exactly what must not move under it. The
          // same content is a no-op; different content is a new version, and the caller says so.
          // `for update` so two concurrent registrations of one version cannot both see nothing.
          await client.query(`
            insert into zz.plugin_version (plugin_id, version, digest)
            values ($1::uuid, $2, $3)
            on conflict (plugin_id, version) do nothing`,
            [pluginRow.id, version, contentDigest]);
          const held = (await client.query<{ digest: string }>(`
            select digest from zz.plugin_version where plugin_id = $1::uuid and version = $2 for update`,
            [pluginRow.id, version])).rows[0];
          if (held.digest !== contentDigest) {
            throw new Refusal(
              `ERROR: ${name}@${version} is already registered with content digest ${held.digest}, and ` +
              `this source digests to ${contentDigest}. A registered version never changes content — ` +
              "register the changed source under a new version.");
          }
          const row = (await client.query<{ id: string }>(`
            insert into zz.eval_subject_version
              (plugin_id, declared_version, content_digest, component_manifest, source_locator,
               release_identity, captured_at)
            values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
            on conflict (plugin_id, declared_version, content_digest)
              do update set component_manifest = excluded.component_manifest
            returning id::text as id`,
            [pluginRow.id, version, contentDigest, JSON.stringify(resolved.components),
             JSON.stringify({ kind: source_kind, locator: source_locator }),
             JSON.stringify({ origin: "third_party", ...resolved.identityExtra })])).rows[0];
          return { result: row.id, result_table: "zz.eval_subject_version", result_id: row.id };
        },
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      logActivity(await userRoot(), null,
        { user: principal, action: "plugin_register", plugin: name, version,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      return json(await subjectResponse(pool, subjectVersionId));
    },
  );
}
