/**
 * IMPROVE's own ledger (Task I-18, FR-34 to FR-37, AC-34.1 to AC-37.1): `improvement_start` opens
 * one durable optimization run against an `eval_run`'s plugin-owned findings, and `candidate_record`
 * persists one proposed patch set against it — migration 077's `zz.improvement_run`/`zz.candidate`
 * — before anything about that candidate ever executes (FR-36's own words: "no candidate executes
 * before its ledger row... exist", which is also why `launch.ts`'s candidate-replay refusal was
 * lifted in this same task, once this file gave it a row to read).
 *
 * `complexity.ts` (Task I-18) is this file's only computation of a candidate's numbers —
 * `complexityDelta`, the patch's own file list and its mapping onto the base subject's
 * `component_manifest` — never re-derived here. `proposer-bundle.ts` (Task I-18) is the other
 * half: `improvement_start`'s own response carries it, because the run that consumes the
 * evidence and the run that opens it are the same call — a later task (I-28) is what tells an
 * agent HOW to read it, not what assembles it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import {
  complexityDelta, componentCounts, hypothesisDigest, parseUnifiedDiff, patchDigest, touchedComponents,
  type ComplexityInput, type ManifestComponent, type PatchFile, type PatchStats, type TouchedComponent,
} from "./complexity.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { loadProposerBundle, REJECTED_CANDIDATE_STATUSES, type ProposerBundle } from "./proposer-bundle.js";
import { sweepExpired } from "./replay-runs.js";
import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const noDb = () => text("ERROR: this deployment has no platform database, so nothing can be recorded");
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -------------------------------------------------------------------------------------------
// improvement_start

interface ImprovementStartResult {
  readonly improvement_run_id: string;
  readonly search_policy: Record<string, unknown>;
  readonly status: string;
}

async function loadFindingsForCheck(
  p: pg.Pool, findingIds: readonly string[],
): Promise<{ id: string; owner_kind: string | null; eval_run_id: string | null }[]> {
  return (await p.query<{ id: string; owner_kind: string | null; eval_run_id: string | null }>(
    "select id::text as id, owner_kind, eval_run_id::text as eval_run_id " +
    "from zz.eval_finding where id = any($1::uuid[])", [findingIds])).rows;
}

export function registerCandidateTools(server: McpServer): void {
  server.registerTool(
    "improvement_start",
    {
      description:
        "WHEN an eval_run's findings name work worth searching for: first closes the CALLER'S " +
        "OWN expired replay runs (FR-31, the same sweep replay_start runs — an unreachable " +
        "sandbox is torn down before a new run opens), then opens one durable " +
        "zz.improvement_run against eval_run_id and its finding_ids, with a search_policy " +
        "snapshot taken from that run's own protocol version (improvement_policy.search, or {} " +
        "for a protocol that declares none). RETURNS { improvement_run_id, search_policy, " +
        "status, proposer_bundle } — proposer_bundle (AC-37.1) is this run's own actionable " +
        "evidence: failing traces, evaluator critiques, refusal text, corrections, dependency/ " +
        "tool errors, cost/latency and prior rejected hypotheses for this eval_run's plugin, so " +
        "the candidate this run searches for is proposed against what already failed rather " +
        "than guessed blind. REFUSES an eval_run_id nothing minted, an empty finding_ids list, " +
        "a finding_ids entry naming no finding, a finding recorded against a DIFFERENT " +
        "eval_run, and any finding whose owner_kind is not 'plugin' — " +
        "\"ERROR: finding <id> is owned by <kind>; it is reported to its owner, not optimised\" " +
        "(FR-34: a dependency/platform/environment/user_input/unknown finding stays an " +
        "owner-facing finding and starts no optimization). A mutator: writes through the FR-59 " +
        "idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(),
        finding_ids: z.array(z.string()).min(1),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ eval_run_id, finding_ids, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const run = (await p.query<{ id: string; protocol_version_id: string }>(
        "select id::text as id, protocol_version_id::text as protocol_version_id " +
        "from zz.eval_run where id = $1::uuid", [eval_run_id])).rows[0];
      if (!run) return text(`ERROR: no eval_run ${eval_run_id}`);

      const findings = await loadFindingsForCheck(p, finding_ids);
      const byId = new Map(findings.map((f) => [f.id, f]));
      const missing = finding_ids.filter((id) => !byId.has(id));
      if (missing.length) {
        return text(`ERROR: finding id(s) not found: ${missing.join(", ")}`);
      }
      const wrongRun = findings.find((f) => f.eval_run_id !== eval_run_id);
      if (wrongRun) {
        return text(`ERROR: finding ${wrongRun.id} was recorded against eval_run ` +
          `${wrongRun.eval_run_id}, not ${eval_run_id}`);
      }
      const nonPlugin = findings.find((f) => f.owner_kind !== "plugin");
      if (nonPlugin) {
        return text(`ERROR: finding ${nonPlugin.id} is owned by ${nonPlugin.owner_kind ?? "unknown"}; ` +
          "it is reported to its owner, not optimised");
      }

      const protocolRow = (await p.query<{ improvement_policy: { search?: unknown } | null }>(
        "select improvement_policy from zz.eval_protocol_version where id = $1::uuid",
        [run.protocol_version_id])).rows[0];
      const search_policy = ((protocolRow?.improvement_policy as { search?: Record<string, unknown> } | null)
        ?.search ?? {}) as Record<string, unknown>;

      const principal = parseCaller(requestHeaders()).email;
      // FR-31: "Any replay_start or improvement_start call first closes the caller's own runs
      // whose liveness bound has passed" — the same sweep replay_start's own handler runs,
      // never a second implementation of it.
      await sweepExpired(p, principal);
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "improvement_start", idempotency_key, { eval_run_id, finding_ids },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.improvement_run (eval_run_id, finding_ids, search_policy, status, created_at)
            values ($1::uuid, $2::jsonb, $3::jsonb, 'open', now())
            returning id::text as id`,
            [eval_run_id, JSON.stringify(finding_ids), JSON.stringify(search_policy)])).rows[0];
          if (!row) throw new Error("insert into zz.improvement_run produced no row");
          return { result: { id: row.id }, result_table: "zz.improvement_run", result_id: row.id };
        },
      );
      const improvementRunId = outcome.replayed ? outcome.result_id : outcome.result.id;

      const bundle = await loadProposerBundle(p, improvementRunId);
      if (!bundle) throw new Refusal("ERROR: idempotency ledger points at an improvement_run this call cannot read back");

      logActivity(await userRoot(), null, {
        user: principal, action: "improvement_start", improvement_run_id: improvementRunId,
        eval_run_id, finding_count: finding_ids.length, replayed: outcome.replayed,
      });
      return json({
        improvement_run_id: improvementRunId, search_policy, status: "open", proposer_bundle: bundle,
      } satisfies ImprovementStartResult & { proposer_bundle: ProposerBundle });
    },
  );

  // -----------------------------------------------------------------------------------------
  // candidate_record

  server.registerTool(
    "candidate_record",
    {
      description:
        "WHEN a candidate patch has been proposed and MUST be persisted before anything about " +
        "it executes (FR-36): records improvement_run_id, base_subject_version_id, parents " +
        "(their generation + 1, or 0 with no parents), hypothesis, expected_effect and " +
        "patchset.diff, computing patch_digest (sha256 of the diff), complexity_delta " +
        "(complexityDelta over the diff's own added/removed lines and added/removed files), " +
        "touched_components (the patch's files mapped onto base_subject_version_id's own " +
        "component_manifest) and touched_owners (the base subject's plugin's own " +
        "release_owners, FR-47 — every touched component inherits plugin-level ownership in " +
        "this initiative). RETURNS { candidate_id, generation, patch_digest, complexity_delta, " +
        "touched_components, touched_owners, status: 'recorded' }. REFUSES an " +
        "improvement_run_id nothing minted; a base_subject_version_id nothing minted; a " +
        "parents entry naming no candidate; and a hypothesis whose normalised-text digest " +
        "matches a candidate already " + REJECTED_CANDIDATE_STATUSES.join("/") + " for the same " +
        "base subject's plugin — \"ERROR: hypothesis already rejected as candidate <id>\" " +
        "(FR-38's own repeat-rejection regularization). A mutator: writes through the FR-59 " +
        "idempotency ledger.",
      inputSchema: {
        improvement_run_id: z.string(),
        base_subject_version_id: z.string(),
        parents: z.array(z.string()).default([]),
        hypothesis: z.string().min(1),
        expected_effect: z.record(z.string(), z.unknown()),
        patchset: z.object({
          diff: z.string().min(1).describe("a unified diff — the file list and per-file " +
            "added/removed/modified state are derived from it, never supplied separately"),
        }),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ improvement_run_id, base_subject_version_id, parents, hypothesis, expected_effect,
             patchset, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const run = (await p.query<{ id: string }>(
        "select id::text as id from zz.improvement_run where id = $1::uuid", [improvement_run_id])).rows[0];
      if (!run) return text(`ERROR: no improvement_run ${improvement_run_id}`);

      if (!UUID_RE.test(base_subject_version_id)) return text("ERROR: unknown base_subject_version_id");
      const subject = (await p.query<{ id: string; plugin_id: string; component_manifest: ManifestComponent[] }>(
        "select id::text as id, plugin_id::text as plugin_id, component_manifest " +
        "from zz.eval_subject_version where id = $1::uuid", [base_subject_version_id])).rows[0];
      if (!subject) return text(`ERROR: no eval_subject_version ${base_subject_version_id}`);

      let generation = 0;
      if (parents.length) {
        const parentRows = (await p.query<{ id: string; generation: number }>(
          "select id::text as id, generation from zz.candidate where id = any($1::uuid[])", [parents])).rows;
        const found = new Map(parentRows.map((r) => [r.id, r]));
        const missing = parents.filter((id) => !found.has(id));
        if (missing.length) return text(`ERROR: parent candidate id(s) not found: ${missing.join(", ")}`);
        generation = Math.max(...parentRows.map((r) => r.generation)) + 1;
      }

      const stats: PatchStats = parseUnifiedDiff(patchset.diff);
      const files: readonly PatchFile[] = stats.files;
      const counts = componentCounts(files);
      const complexityInput: ComplexityInput = {
        lines_added: stats.lines_added, lines_removed: stats.lines_removed,
        components_added: counts.added, components_removed: counts.removed,
      };
      const complexity_delta = complexityDelta(complexityInput);
      const digest = patchDigest(patchset.diff);
      const touched_components: TouchedComponent[] = touchedComponents(files, subject.component_manifest ?? []);

      const ownerRow = (await p.query<{ release_owners: string[] }>(
        "select release_owners from zz.plugin where id = $1::uuid", [subject.plugin_id])).rows[0];
      const touched_owners = ownerRow?.release_owners ?? [];

      // FR-38's repeat-rejection regularization: a hypothesis already tried and rejected for
      // THIS plugin refuses outright rather than recording a second, identical attempt.
      // Digests compared in JS, not SQL, because normaliseHypothesis is this file's own rule and
      // a database index would need to duplicate it to filter server-side — fine at this scale
      // (one plugin's own rejected candidates, not the whole ledger).
      const wantDigest = hypothesisDigest(hypothesis);
      const priorRejections = (await p.query<{ id: string; hypothesis: string }>(`
        select c.id::text as id, c.hypothesis
          from zz.candidate c
          join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
         where sv.plugin_id = $1::uuid and c.status = any($2::text[])`,
        [subject.plugin_id, [...REJECTED_CANDIDATE_STATUSES]])).rows;
      const repeat = priorRejections.find((r) => hypothesisDigest(r.hypothesis) === wantDigest);
      if (repeat) {
        return text(`ERROR: hypothesis already rejected as candidate ${repeat.id}`);
      }

      const caller = parseCaller(requestHeaders());
      const proposer_identity = {
        principal: caller.email,
        client: one(requestHeaders()["x-zz-client"]) || null,
        // Recorded so a reader can tell a repeat digest apart from the same text re-proposed by
        // a different model — never read back by the dedupe check above, which is keyed on the
        // hypothesis text alone (FR-38 rejects the IDEA, whoever proposes it again).
        hypothesis_digest: wantDigest,
      };

      const outcome: IdempotencyOutcome<{
        id: string; generation: number; patch_digest: string; complexity_delta: number;
        touched_components: typeof touched_components; touched_owners: string[];
      }> = await withIdempotency(
        caller.email, "candidate_record", idempotency_key,
        { improvement_run_id, base_subject_version_id, parents, hypothesis, expected_effect, patchset },
        async (client): Promise<MutatorOutcome<{
          id: string; generation: number; patch_digest: string; complexity_delta: number;
          touched_components: typeof touched_components; touched_owners: string[];
        }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.candidate
              (improvement_run_id, base_subject_version_id, generation, parent_ids, hypothesis,
               expected_effect, patchset, patch_digest, complexity_delta, touched_components,
               touched_owners, proposer_identity, status, created_at)
            values ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
                    $11::jsonb, $12::jsonb, 'recorded', now())
            returning id::text as id`,
            [improvement_run_id, base_subject_version_id, generation, JSON.stringify(parents), hypothesis,
             JSON.stringify(expected_effect), JSON.stringify({ diff: patchset.diff, files: stats.files.map((f) => f.path) }),
             digest, complexity_delta, JSON.stringify(touched_components), JSON.stringify(touched_owners),
             JSON.stringify(proposer_identity)])).rows[0];
          if (!row) throw new Error("insert into zz.candidate produced no row");
          return {
            result: { id: row.id, generation, patch_digest: digest, complexity_delta, touched_components, touched_owners },
            result_table: "zz.candidate", result_id: row.id,
          };
        },
      );

      let result: { id: string; generation: number; patch_digest: string; complexity_delta: number;
        touched_components: unknown; touched_owners: unknown };
      if (outcome.replayed) {
        const row = (await p.query<{
          id: string; generation: number; patch_digest: string; complexity_delta: number;
          touched_components: unknown; touched_owners: unknown;
        }>(`select id::text as id, generation, patch_digest, complexity_delta, touched_components, touched_owners
              from zz.candidate where id = $1::uuid`, [outcome.result_id])).rows[0];
        if (!row) throw new Refusal("ERROR: idempotency ledger points at a candidate this call cannot read back");
        result = row;
      } else {
        result = outcome.result;
      }

      logActivity(await userRoot(), null, {
        user: caller.email, action: "candidate_record", candidate_id: result.id,
        improvement_run_id, complexity_delta: result.complexity_delta, replayed: outcome.replayed,
      });
      return json({
        candidate_id: result.id, generation: result.generation, patch_digest: result.patch_digest,
        complexity_delta: result.complexity_delta, touched_components: result.touched_components,
        touched_owners: result.touched_owners, status: "recorded",
        next: "No candidate executes before this row exists — it now does. candidate_validate " +
              "(a later task) is what runs it.",
      });
    },
  );
}
