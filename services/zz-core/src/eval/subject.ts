/**
 * Subject identity (FR-1): the one immutable `subject_version` every later stage binds to.
 *
 * `plugin_locate` is IDENTIFY. It resolves a catalog plugin's released version, computes its
 * whole-plugin content digest from the sorted digests of its own components (skills, declared
 * servers, the flow manifest itself — never the environment it happens to run in), and upserts
 * the immutable row `zz.eval_subject_version` is keyed on: `(plugin_id, declared_version,
 * content_digest)`. Calling it twice for a release whose content has not moved returns the same
 * `subject_version_id` — idempotent by construction, through the unique constraint, and again
 * through the FR-59 ledger this module is the first caller of.
 *
 * DELIBERATE: this is a mutator, unlike everything in plugin-eval.ts. It is the one place a new
 * subject version comes from, so the identity every later stage joins against exists before
 * anything asks for it a second time.
 */
import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { entryOf, serversOf } from "./plugin-eval.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no subject can be recorded");

/** One entry of `component_manifest`. `kind: "config"` is part of the declared shape for a
 *  component this catalog schema does not carry yet (deploy/environment declarations, say) —
 *  none is emitted today because nothing in `CatalogManifest` represents one. */
interface Component {
  readonly kind: "skill" | "server" | "flow" | "config";
  readonly name: string;
  readonly digest: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

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
  const head = (await pool.query<{ plugin_id: string; origin: string; declared_version: string; digest: string }>(`
    select p.id::text as plugin_id, p.origin, pv.version as declared_version, pv.digest
      from zz.plugin p join zz.plugin_version pv on pv.plugin_id = p.id
     where p.name = $1 and ($2::text is null or pv.version = $2)
     order by pv.version desc limit 1`, [plugin, version ?? null])).rows[0];
  if (!head) return null;

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
    releaseIdentity: { plugin_version_id: head.plugin_id, released_digest: head.digest, origin: head.origin },
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
              -- existing id rather than nothing, the same trick ruler_record uses on zz.rubric.
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
}
