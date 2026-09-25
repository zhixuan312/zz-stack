/**
 * The two doors `npm run candidate-build` (packages/tools/src/candidate/build.ts) goes through:
 * `candidate_read`, which hands it the patch and the base subject it clones or fetches, and
 * `candidate_build_record`, which takes the build's result back.
 * `candidate_validate` (candidate-validate.ts) asks for the build and consumes the record; every
 * decision about who may record what, and what a record means, is in candidate-build-rules.ts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { BUILD_LEASE_MS, BUILD_STAGES, buildRecordRefusal } from "./candidate-build-rules.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { platformEvent } from "../indexing.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so no candidate build can be read or recorded");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The failing command's own output tail — enough to act on, never a whole log. COUPLED: the
 *  CLI trims to the same bound before it sends. */
const LOG_TAIL_MAX = 4000;

interface BuildRow {
  status: string; patch_digest: string; build_requested_by: string | null;
  build_requested_at: Date | null; build_recorded_at: Date | null;
}

export function registerCandidateBuildTools(server: McpServer): void {
  server.registerTool(
    "candidate_read",
    {
      description:
        "WHEN npm run candidate-build starts (or anyone needs one candidate's recorded patch): " +
        "RETURNS { candidate_id, status, patch_digest, candidate_patchset: { diff, files }, " +
        "subject_plugin, subject_source_locator, subject_declared_version, subject_release_digest, " +
        "subject_content_digest, subject_release_identity, build_requested_at, " +
        "build_lease_expires_at, build_recorded_at } — the build clones v<subject_declared_version> " +
        "for a catalog subject, or fetches a third-party one at its captured identity. " +
        "build_lease_expires_at is null unless the candidate is awaiting_build; build_recorded_at is " +
        "set once its build is recorded. Read-only. " +
        "REFUSES an unknown candidate_id and a deployment with no platform database.",
      inputSchema: { candidate_id: z.string() },
    },
    async ({ candidate_id }) => {
      const p = db();
      if (!p) return noDb();
      if (!UUID_RE.test(candidate_id)) return text(`ERROR: unknown candidate_id ${candidate_id}`);
      const row = (await p.query<{
        candidate_id: string; status: string; patch_digest: string;
        candidate_patchset: { diff: string; files?: string[] };
        subject_plugin: string | null; subject_source_locator: unknown;
        subject_declared_version: string | null; subject_release_digest: string | null;
        subject_content_digest: string | null; subject_release_identity: Record<string, unknown> | null;
        build_requested_at: Date | null; build_recorded_at: Date | null;
      }>(`
        select c.id::text as candidate_id, c.status, c.patch_digest, c.patchset as candidate_patchset,
               pl.name as subject_plugin, sv.source_locator as subject_source_locator,
               sv.declared_version as subject_declared_version,
               sv.release_identity->>'released_digest' as subject_release_digest,
               sv.content_digest as subject_content_digest, sv.release_identity as subject_release_identity,
               c.build_requested_at, c.build_recorded_at
          from zz.candidate c
          join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
          left join zz.plugin pl on pl.id = sv.plugin_id
         where c.id = $1::uuid`, [candidate_id])).rows[0];
      if (!row) return text(`ERROR: unknown candidate_id ${candidate_id}`);
      const awaiting = row.status === "awaiting_build" && row.build_requested_at;
      return json({
        ...row,
        build_requested_at: awaiting ? new Date(row.build_requested_at!).toISOString() : null,
        build_lease_expires_at: awaiting ? new Date(new Date(row.build_requested_at!).getTime() + BUILD_LEASE_MS).toISOString() : null,
        build_recorded_at: row.build_recorded_at ? new Date(row.build_recorded_at).toISOString() : null,
      });
    },
  );

  server.registerTool(
    "candidate_build_record",
    {
      description:
        "WHEN npm run candidate-build has built (or failed to build) an awaiting_build candidate: " +
        "records { ok, stage, log_tail, commands } against it, with the digest of the patch the " +
        "build actually applied, for the next candidate_validate to consume — ok makes the " +
        "candidate valid there, stage apply/install/build/gate makes it invalid, stage timeout or " +
        "host (a problem on the building host, never the patch's) returns it to recorded. zz-core " +
        "never builds a candidate itself. RETURNS { candidate_id, recorded: " +
        "true, ok, stage }. REFUSES an unknown candidate_id; any principal but the one whose candidate_validate " +
        "asked for the build; a candidate not awaiting_build; a build lease (60 minutes from " +
        "that candidate_validate) already expired; a patch_digest that is not the candidate's; a " +
        "build already recorded under another idempotency_key; and a deployment with no platform " +
        "database. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        candidate_id: z.string(),
        patch_digest: z.string().min(1),
        result: z.object({
          ok: z.boolean(),
          stage: z.enum(BUILD_STAGES).optional(),
          log_tail: z.string().max(LOG_TAIL_MAX).optional(),
          commands: z.array(z.string()).max(8).optional(),
        }).refine((r) => r.ok || r.stage !== undefined, { message: "a failed build names its stage" }),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ candidate_id, patch_digest, result, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      if (!UUID_RE.test(candidate_id)) return text(`ERROR: unknown candidate_id ${candidate_id}`);
      const principal = parseCaller(requestHeaders()).email;

      const outcome: IdempotencyOutcome<{ ok: boolean; stage: string | null }> = await withIdempotency(
        principal, "candidate_build_record", idempotency_key, { candidate_id, patch_digest, result },
        async (client): Promise<MutatorOutcome<{ ok: boolean; stage: string | null }>> => {
          const row = (await client.query<BuildRow>(`
            select status, patch_digest, build_requested_by, build_requested_at, build_recorded_at
              from zz.candidate where id = $1::uuid for update`, [candidate_id])).rows[0];
          if (!row) throw new Refusal(`ERROR: unknown candidate_id ${candidate_id}`);
          const now = (await client.query<{ now: Date }>("select now() as now")).rows[0].now;
          const refused = buildRecordRefusal(principal, row, patch_digest, new Date(now));
          if (refused) throw new Refusal(refused);
          const stored = { ...result, stage: result.ok ? undefined : result.stage, patch_digest };
          await client.query(
            "update zz.candidate set build_result = $2::jsonb, build_recorded_at = now() where id = $1::uuid",
            [candidate_id, JSON.stringify(stored)]);
          platformEvent({
            actor: principal, kind: "candidate.build_recorded", subject: candidate_id, team: null,
            detail: { ok: result.ok, stage: stored.stage ?? null, patch_digest },
          });
          return { result: { ok: result.ok, stage: stored.stage ?? null }, result_table: "zz.candidate", result_id: candidate_id };
        },
      );
      if (!outcome.replayed) return json({ candidate_id, recorded: true, ...outcome.result });
      // A replay reads what the first call stored — nothing else ever writes build_result while
      // the candidate awaits its build, and a consumed one was this same record.
      return json({ candidate_id, recorded: true, ok: result.ok, stage: result.ok ? null : result.stage ?? null });
    },
  );
}
