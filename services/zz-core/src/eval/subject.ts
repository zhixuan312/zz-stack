/**
 * Subject identity (FR-1, FR-24): the one immutable `subject_version` every later stage binds to.
 *
 * A subject version IS a `zz.plugin_version` row. The evaluation family used to keep a second row
 * per released thing — `zz.eval_subject_version`, carrying the same `plugin_id` and the same
 * declared version beside a digest `plugin_locate` recomputed on every call — and the two could
 * disagree: a component digest source that moved under a release made the same (plugin, version)
 * answer with two different ids depending on which tool had minted the row first. `plugin_version`
 * is that release's one identity now: its `digest` is written once, at insert, by whichever path
 * registered the version (`register-plugins.ts` at a release, `plugin_register` at a capture), and
 * no path rewrites it, so `subject_version_id` is a `plugin_version.id` and a released version is
 * a stable thing to evaluate.
 *
 * `plugin_locate` is IDENTIFY for a plugin the catalog has released. It resolves the version that
 * plugin is at now (`currentVersionOf`, ../release-head.ts) — or the exact version the caller
 * names, which a rollback's retracted row still resolves — and returns that row's own facts. It
 * writes nothing to the release identity: the row is immutable history, so two calls for one
 * release content answer with the same `subject_version_id` by construction rather than by an
 * upsert. It still runs through the FR-59 ledger, so a retried call replays the same id and records
 * the same IDENTIFY step.
 *
 * `plugin_register` is IDENTIFY for everything else (FR-2): a plugin the catalog has never
 * released, captured once from its own source — a directory under the catalog root, a public https
 * git repository or a registry package — and written into that same row shape, with the four
 * source columns (`component_manifest`, `source_locator`, `tree_digest`, `resolved_commit`) a
 * catalog release leaves null. Its source readers, and the confinement that bounds what a caller's
 * locator may reach, are subject-source.ts's.
 *
 * A registered version never changes content: the same content is a no-op, different content is
 * refused by name, and the changed source lands as a new version instead — the digest every
 * earlier evaluation of that version was judged against must not move under it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type PluginComponent, pluginContentDigest, sha256 } from "@zz/catalog";
import { parseCaller } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, serversOf } from "./plugin-eval.js";
import { currentVersionOf } from "../release-head.js";
import { resolveSource } from "./subject-source.js";
import { recordStage } from "./stage-record.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no subject can be recorded");

/** ISO 8601 through `to_char`, never `::text`: the session's DateStyle decides what text a
 *  timestamptz renders as, and this value travels to a caller. */
const ISO = (column: string) =>
  `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** One released (plugin, version): the `plugin_version` row every later stage reads, with the
 *  ownership the plugin's own row and `plugin_release_owner` carry.
 *
 *  A `type`, not an `interface`, for the reason every row type in this door is one: an interface
 *  has no implicit index signature and so does not satisfy `pg.QueryResultRow`. */
type SubjectVersionRow = {
  subject_version_id: string; plugin_id: string; plugin: string; declared_version: string;
  digest: string; released_at: string;
  component_manifest: PluginComponent[] | null; source_locator: Record<string, unknown> | null;
  tree_digest: string | null; resolved_commit: string | null;
  origin: string; owner_team_id: string | null; owner_team: string | null; release_owners: string[];
};

/** The columns and joins both readers of a subject version share: the row by its own id
 *  (`subjectResponse`) and the row by plugin name and version (`resolveSubjectVersion`), so the
 *  two cannot disagree about what a subject version's facts are. */
const SUBJECT_SELECT = `
    select pv.id::text as subject_version_id, pv.plugin_id::text as plugin_id, p.name as plugin,
           pv.version as declared_version, pv.digest, ${ISO("pv.released_at")} as released_at,
           pv.component_manifest, pv.source_locator, pv.tree_digest, pv.resolved_commit,
           p.origin, p.owner_team_id::text as owner_team_id, t.slug as owner_team,
           owners.slugs as release_owners
      from zz.plugin_version pv
      join zz.plugin p on p.id = pv.plugin_id
      left join zz.team t on t.id = p.owner_team_id
      -- 'release_owners' was a jsonb list nobody could join; it is a relation now, and a reader
      -- that wants the slugs aggregates the teams the relation names.
      left join lateral (
        select coalesce(array_agg(t2.slug order by t2.slug), '{}'::text[]) as slugs
          from zz.plugin_release_owner r
          join zz.team t2 on t2.id = r.team_id
         where r.plugin_id = p.id) owners on true`;

/** Everything IDENTIFY needs about one released (plugin, version), resolved once before any write.
 *  Returns null for a plugin or a version this platform never released — the caller turns that
 *  into the contract's exact refusal text; this function does no I/O beyond reading. */
async function resolveSubjectVersion(
  runner: Pick<pg.Pool, "query">, plugin: string, version: string | undefined,
): Promise<SubjectVersionRow | null> {
  const pluginId = (await runner.query<{ id: string }>(
    "select id::text as id from zz.plugin where name = $1", [plugin])).rows[0]?.id;
  if (!pluginId) return null;
  // The current release is `currentVersionOf`'s (../release-head.ts), the same reader
  // release_apply's baseline uses: for a catalog plugin, the version the running deployment
  // declares; for any other, the newest by semver with every version a rollback retracted left
  // out. A retracted row stays in zz.plugin_version, and naming its exact version still resolves
  // it — verifying and explaining a rolled-back release needs it.
  const target = version ?? await currentVersionOf(runner, pluginId);
  if (target === null) return null;
  const row = (await runner.query<SubjectVersionRow>(
    `${SUBJECT_SELECT} where p.name = $1 and pv.version = $2`, [plugin, target])).rows[0];
  return row ?? null;
}

/** The `plugin_locate` response: the row's own facts, read back rather than re-derived — a
 *  replayed idempotent call and a freshly resolved one return through this one path, so the two
 *  can never disagree about the shape. The one field that is not the row's is the component
 *  manifest: `plugin_version.component_manifest` is null for a catalog release, and the contract
 *  this tool answers to promises a digest per component, so the manifest comes from the one
 *  derivation `candidate_record` maps a patch onto (`componentManifestOf`) rather than from a
 *  second, response-only one that could answer differently. */
async function subjectResponse(
  runner: Pick<pg.Pool, "query">, subjectVersionId: string,
): Promise<Record<string, unknown>> {
  const row = (await runner.query<SubjectVersionRow>(
    `${SUBJECT_SELECT} where pv.id = $1::uuid`, [subjectVersionId])).rows[0];
  if (!row) throw new Refusal(`ERROR: no plugin_version ${subjectVersionId} — the release this subject named is gone`);

  // The newest protocol version this plugin has, if any — affirmed or not. DELIBERATE: no
  // compatibility check against `subject_compatibility` or the triggers, and no affirmation
  // check: deciding which protocol applies is protocol_read's one job, and doing it here too would
  // give two answers to that question from two different tools.
  //
  // The header `eval_protocol` folded into the version row (FR-27), so the plugin a protocol
  // belongs to is `eval_protocol_version.plugin_id` and the lookup is one table. This statement
  // is the fold's, reached here because this file owns the reads it issues.
  const protocol = (await runner.query<{ id: string }>(`
    select epv.id::text as id
      from zz.eval_protocol_version epv
     where epv.plugin_id = $1::uuid
     order by epv.version desc limit 1`, [row.plugin_id])).rows[0];

  // A catalog release is registered by `register-plugins.ts`, which has no capture to record: its
  // four source columns are null and the source it came from is this repository's own catalog. A
  // reader that has to know which kind of source a subject is (the candidate build's own
  // `sourceKind`) reads this, so the derivation is made once, here, rather than inferred from a
  // null at every call site.
  const sourceLocator = row.source_locator
    ?? (row.origin === "platform" ? { kind: "catalog" } : null);

  return {
    subject_version_id: row.subject_version_id,
    plugin: row.plugin,
    declared_version: row.declared_version,
    content_digest: row.digest,
    // The capture's own column for a third-party subject, and the derived manifest — digests
    // included — for a catalog release, whose own column is null. Never null: the contract this
    // tool publishes says "per-component manifest ... each a sha256 of the component's content",
    // and a caller reading a null there cannot tell the release ships nothing from the release
    // having been registered rather than captured.
    component_manifest: await componentManifestOf(runner, {
      id: row.subject_version_id, plugin: row.plugin,
      declared_version: row.declared_version, release_digest: row.digest,
      component_manifest: row.component_manifest,
    }),
    source_locator: sourceLocator,
    tree_digest: row.tree_digest,
    resolved_commit: row.resolved_commit,
    released_at: row.released_at,
    // FR-1's "immutable source/release identity", assembled from the row's own columns: what the
    // release digest was, where the release came from, and — for a third-party capture — the
    // commit or files it was captured at.
    release_identity: {
      plugin_version_id: row.subject_version_id, released_digest: row.digest, origin: row.origin,
      tree_digest: row.tree_digest, resolved_commit: row.resolved_commit,
    },
    origin: row.origin,
    owner_team: row.owner_team,
    release_owners: row.release_owners,
    // Ownership's own release track, not the per-initiative branch fact of the same name
    // FR-52/FR-58 has `release_prepare`/`proposal_prepare` write into `_facts.json` (Task I-27).
    // That later fact is read from THIS one: a subject with no release owners can never be
    // promoted (FR-47), so it is `proposal_only`; the reverse is `promotable`, contingent on
    // every later gate this initiative still has to pass. Never `not_applicable` here — that
    // value belongs to an initiative that never reached a release/proposal stage at all, which
    // is not a fact plugin_locate, called before any evaluation exists, can see.
    release_mode: row.release_owners.length > 0 ? "promotable" : "proposal_only",
    latest_protocol_version_id: protocol?.id ?? null,
    // What an evaluation may do with its findings follows from whose the plugin is — carried
    // over from plugin-eval.ts's pre-FR-1 plugin_locate, which this module replaces. Ours
    // (`origin = "platform"`): the findings feed a change somebody makes. A third party's
    // (`origin = "third_party"`): assess and stop, because a proposed change against a plugin we
    // do not own is a finding pretending to be an instruction (FR-51).
    origin_mode: row.origin === "third_party" ? "assess only" : "assess, then change",
  };
}

/** The component manifest one subject version carries: what a patch's own files are mapped onto
 *  (`candidate_record`'s `touched_components`) and what `plugin_locate` answers with.
 *
 *  A third-party capture carries its own — `plugin_register` recorded `component_manifest` when it
 *  read the source, digests included — and that is what this answers with. A catalog release has no
 *  capture to carry: its four source columns are null because `register-plugins.ts` registers a
 *  version rather than reading a source, and that is not its manifest ceasing to exist. It is
 *  DERIVED from what the release actually ships — the skills `plugin_version_skill` binds to this
 *  exact version, the servers the catalog entry declares (`serversOf`, the baseline door included)
 *  and the flow itself, in the order and with the kinds IDENTIFY derived them before a subject
 *  version folded onto `plugin_version`.
 *
 *  Read, never guessed. `touchedComponents` matches a patch's file against THIS list, so a manifest
 *  inferred from the patch's own paths would answer `in_manifest` with the inference — and every
 *  digest below is a fact of the release, never a value minted to fill the shape: a skill version's
 *  own `content_hash`, the release digest `register-plugins.ts` wrote once at insert, and, for a
 *  server, the same construction the capture makes (`sha256(name:path)`, versioned when the door is
 *  the plugin's own — see the comment on it below). A shape without them was the hole
 *  `plugin_locate`'s response contract named: it promises "a per-component manifest
 *  (skill/server/flow/config digests, each a sha256 of the component's content)", and the column a
 *  catalog release answers from is null. */
export async function componentManifestOf(
  runner: Pick<pg.Pool, "query">,
  subject: {
    readonly id: string; readonly plugin: string;
    /** The release's own declared version and whole-plugin digest, as the `plugin_version` row
     *  carries them. Two facts of a catalog release that its components alone do not give: a
     *  server's identity is the build it shipped with, and the flow component's digest IS the
     *  release digest. */
    readonly declared_version: string; readonly release_digest: string;
    /** The `plugin_version.component_manifest` column, as any caller reads it: the release's own
     *  components for a capture, and null for a catalog release, which the derivation below
     *  answers for instead. */
    readonly component_manifest: readonly PluginComponent[] | null;
  },
): Promise<readonly PluginComponent[]> {
  if (subject.component_manifest) return subject.component_manifest;
  const entry = entryOf(subject.plugin);
  const skills = (await runner.query<{ name: string; version: string; content_hash: string }>(`
    select s.name, sv.version, sv.content_hash
      from zz.plugin_version_skill pvs
      join zz.skill_version sv on sv.id = pvs.skill_version_id
      join zz.skill s on s.id = pvs.skill_id
     where pvs.plugin_version_id = $1::uuid
     order by s.name`, [subject.id])).rows;
  const components: PluginComponent[] = [
    ...skills.map((s): PluginComponent => ({
      kind: "skill", name: s.name,
      // A skill version's own content hash, never blank in practice (register-skills.ts always
      // writes one) — falling back to a hash of its identity rather than throwing, so a stray
      // pre-migration row cannot take IDENTIFY down for the whole plugin.
      digest: s.content_hash || sha256(`${s.name}@${s.version}`),
    })),
    // A plugin's own server is code in the platform build it shipped with, so its identity is
    // that build: hashed from name and path alone it was a constant, and a door that changed with
    // every release read as unchanged. A server the plugin only calls (sdlc's baseline door) is
    // not its content, and stays keyed by address.
    ...serversOf(entry).map((sv): PluginComponent => ({
      kind: "server", name: sv.name,
      digest: sha256(sv.name === subject.plugin
        ? `${sv.name}:${sv.path}@${subject.declared_version}` : `${sv.name}:${sv.path}`),
    })),
  ];
  // The flow's own name, as the catalog package carries it — not the plugin name, which drops the
  // `-flow` suffix a package directory is named with — and the digest register-plugins recorded
  // for this version from the marketplace lock, never a hash of the manifest on disk today: hashed
  // from today's manifest, a past version's identity moved whenever the catalog did.
  if (entry) components.push({ kind: "flow", name: entry.flow, digest: subject.release_digest });
  return components;
}

export function registerSubjectTools(server: McpServer): void {
  server.registerTool(
    "plugin_locate",
    {
      annotations: WRITES,
      description:
        "WHEN an evaluation begins, before any other tool on this door: IDENTIFY the plugin it is " +
        "about. It RETURNS the immutable subject_version — the declared version, its release " +
        "digest (the whole plugin's identity, written once when the version was registered and " +
        "never rewritten), the per-component manifest (the capture's own for a third-party " +
        "subject, derived from what a catalog release ships — a digest per component — for one " +
        "nobody captured), the row's other source columns (source locator, tree digest and " +
        "resolved commit: set for a third-party capture, null for a catalog release), " +
        "ownership and its release mode, and the plugin's newest protocol version if one exists " +
        "(no compatibility check — protocol_read decides that) — with the SAME subject_version_id " +
        "for the same release content, whichever call resolved it. Every later tool takes the " +
        "subject_version_id this returns, so an evaluation cannot drift onto a different version " +
        "of its own subject halfway through. It writes nothing: a subject version IS a " +
        "zz.plugin_version row, and that row is immutable history. A caller that retries with the " +
        "same idempotency_key replays the same answer through the idempotency ledger. REFUSES a plugin " +
        "this platform has never released, and a version it has no row for.",
      inputSchema: {
        plugin: z.string(),
        version: z.string().optional().describe("Omit for the currently released version."),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in: records subject_version_id as its IDENTIFY record, " +
          "which initiative_status hands to a stage started in a new conversation."),
      },
    },
    async ({ plugin, version, idempotency_key, initiative }) => {
      const pool = db();
      if (!pool) return noDb();

      const resolved = await resolveSubjectVersion(pool, plugin, version);
      if (!resolved) {
        return text(`ERROR: no plugin named ${plugin} is registered — plugin_register adds one that is not in the catalog`);
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_locate", idempotency_key, { plugin, version },
        // The ledger is the only row this call writes, and it anchors on the release's own
        // `plugin_version` id — the identity itself is immutable history no path updates
        // (AC-6.2), so a replay and a fresh resolve answer with the same row and cannot disagree.
        async (): Promise<MutatorOutcome<string>> => ({
          result: resolved.subject_version_id,
          result_table: "zz.plugin_version", result_id: resolved.subject_version_id,
        }),
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      platformEvent({ actor: principal, kind: "plugin_locate", initiative, plugin, version: resolved.declared_version,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      const recorded = await recordStage(initiative, "zz-plugin-identify", { subject_version_id: subjectVersionId });
      return json({ ...await subjectResponse(pool, subjectVersionId), ...recorded });
    },
  );

  server.registerTool(
    "plugin_register",
    {
      annotations: { ...WRITES, openWorldHint: true },
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
        "The captured row IS that subject's whole identity: unlike plugin_locate, a later call " +
        "for the same plugin/version reads this capture back rather than recomputing it, " +
        "because a third party has no release moment to recompute against. A mutator, through " +
        "the same idempotency ledger plugin_locate uses. REFUSES a name the catalog " +
        "already owns — that plugin is registered by release, never by this tool — REFUSES a " +
        "payload naming origin, owner_team, evolvable or release_owners, since the platform " +
        "derives every authority field itself and never takes one as input, REFUSES a " +
        "source_locator it cannot read or may not reach, and REFUSES re-registering a version " +
        "whose content changed — a changed source is a new version, and its digest is never " +
        "rewritten onto an existing one.",
      inputSchema: {
        name: z.string(),
        version: z.string(),
        source_kind: z.enum(["local_dir", "git", "package"]),
        source_locator: z.string(),
        idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "The initiative this evaluation runs in: records subject_version_id as its IDENTIFY record."),
        // Not accepted — named here only so a caller that supplies one is not silently
        // stripped before the handler below can refuse it. See the contract's "authority
        // field" refusal.
        origin: z.unknown().optional(),
        owner_team: z.unknown().optional(),
        evolvable: z.unknown().optional(),
        release_owners: z.unknown().optional(),
      },
    },
    async ({ name, version, source_kind, source_locator, idempotency_key, initiative,
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
      const contentDigest = pluginContentDigest(resolved.components);
      const treeDigest = resolved.identityExtra.tree_digest;
      const resolvedCommit = (resolved.identityExtra.resolved_commit as string | undefined) ?? null;

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<string> = await withIdempotency(
        principal, "plugin_register", idempotency_key,
        { name, version, source_kind, source_locator },
        async (client): Promise<MutatorOutcome<string>> => {
          const pluginRow = (await client.query<{ id: string }>(`
            insert into zz.plugin (name, origin) values ($1, 'third_party')
            on conflict (name) do update set origin = excluded.origin
            returning id::text as id`, [name])).rows[0];
          // The digest is written once, here, and never again: a declared version is immutable
          // once captured, and re-registering it from a source whose content moved would rewrite
          // the digest every earlier evaluation of that version was judged against. `do nothing`
          // is what keeps that promise at the database; the read below is the refusal that tells
          // the caller why. `for update` so two concurrent registrations of one version cannot
          // both see nothing.
          //
          // `source_locator` is the capture's own provenance: where it came from, and — for a
          // package — the integrity of the tarball that came from there. `plugin_version` has no
          // column for a package capture's `tarball_integrity`, and the candidate build
          // (`packages/tools/src/candidate/third-party.ts`) refuses a package subject whose
          // identity does not carry it, so it travels with the locator it belongs to.
          const sourceLocator = {
            kind: source_kind, locator: source_locator,
            ...(resolved.identityExtra.tarball_integrity
              ? { tarball_integrity: resolved.identityExtra.tarball_integrity } : {}),
          };
          await client.query(`
            insert into zz.plugin_version
              (plugin_id, version, digest, component_manifest, source_locator, tree_digest, resolved_commit)
            values ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
            on conflict (plugin_id, version) do nothing`,
            [pluginRow.id, version, contentDigest, JSON.stringify(resolved.components),
             JSON.stringify(sourceLocator), treeDigest, resolvedCommit]);
          const held = (await client.query<{ id: string; digest: string; tree_digest: string | null }>(`
            select id::text as id, digest, tree_digest from zz.plugin_version
             where plugin_id = $1::uuid and version = $2 for update`,
            [pluginRow.id, version])).rows[0];
          if (held.digest !== contentDigest) {
            throw new Refusal(
              `ERROR: ${name}@${version} is already registered with content digest ${held.digest}, and ` +
              `this source digests to ${contentDigest}. A registered version never changes content — ` +
              "register the changed source under a new version.");
          }
          // The content digest covers only skills and the manifest; `tree_digest` is every file.
          // Same skills with changed hooks, commands or server code is still changed content.
          if (held.tree_digest !== treeDigest) {
            throw new Refusal(
              `ERROR: ${name}@${version} is already registered with tree digest ${held.tree_digest ?? "(none)"}, and ` +
              `this source's files digest to ${treeDigest}. A registered version ` +
              "never changes content — register the changed source under a new version.");
          }
          return { result: held.id, result_table: "zz.plugin_version", result_id: held.id };
        },
      );
      const subjectVersionId = outcome.replayed ? outcome.result_id : outcome.result;

      platformEvent({ actor: principal, kind: "plugin_register", initiative, plugin: name, version,
          subject_version_id: subjectVersionId, replayed: outcome.replayed });

      const recorded = await recordStage(initiative, "zz-plugin-identify", { subject_version_id: subjectVersionId });
      return json({ ...await subjectResponse(pool, subjectVersionId), ...recorded });
    },
  );
}
