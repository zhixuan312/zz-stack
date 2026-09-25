/**
 * IMPROVE's own ledger (Task I-18, FR-34 to FR-37, AC-34.1 to AC-37.1): `improvement_start` opens
 * one durable optimization run against an `eval_run`'s plugin-owned findings, and `candidate_record`
 * persists one proposed patch set against it — migration 002's `zz.improvement_run`/`zz.candidate`
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
 *
 * `candidate_validate` (Task I-19, AC-40.1, AC-41.1) is this file's third tool: it asks the
 * local `npm run candidate-build` for the candidate's build and consumes it, plans which validation
 * replay runs are still missing, and stores the paired bootstrap verdict once enough of them
 * exist — `candidate-validate.ts` carries every one of those decisions; this file only wires the
 * tool's own registration to it.
 *
 * `candidate_search` (Task I-20, FR-38 to FR-42, FR-44, AC-38.1, AC-39.1, AC-42.1, AC-44.1) is
 * this file's fourth tool, the same split again: leakage screening, disjoint-file composition,
 * the Pareto frontier and the deterministic final selection all live in `candidate-search.ts`
 * (over the pure `paretoFrontier`/`selectFinal` in `selection.ts`) — this file only wires the
 * tool's own registration to `runCandidateSearch`. Like `candidate_validate`, it never blocks on
 * a long replay inside this call: it advances the search state it can already see from stored
 * `zz.candidate`/`zz.candidate_evaluation` rows and reports what the IMPROVE agent does next.
 *
 * `candidate_prove` (Task I-21, FR-28, FR-43, AC-28.1, AC-43.1) is this file's fifth and last
 * tool: the sealed proof a `selected` candidate opens exactly once, planned and resolved by
 * `candidate-prove.ts` the same way `candidate_validate`/`candidate_search` plan and resolve
 * theirs — this file only wires the tool's own registration to `proveCandidate`. Its own two-call
 * shape (mint the verifier_token and plan the proof runs; a later call resolves them) is that
 * file's own module note.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { recordGenerationFor, runCandidateSearch } from "./candidate-search.js";
import { proveCandidate } from "./candidate-prove.js";
import { validateCandidate } from "./candidate-validate.js";
import {
  complexityDelta, componentCounts, hypothesisDigest, parseUnifiedDiff, patchDigest, touchedComponents,
  type ComplexityInput, type ManifestComponent, type PatchFile, type PatchStats, type TouchedComponent,
} from "./complexity.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { loadSubjectForEvalRun } from "./proposal-doc.js";
import { loadProposerBundle, REJECTED_CANDIDATE_STATUSES, type ProposerBundle } from "./proposer-bundle.js";
import { writeBranchFacts } from "./protocol.js";
import { sweepExpired } from "./replay-runs.js";
import { parseSearchPolicy } from "./search-rules.js";
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

/** `base_subject_version_id` and `case_set_id` travel on the response because IMPROVE may open in
 *  a fresh conversation: `candidate_record` and every validation/proof `replay_start` name them,
 *  and no other call in the stage returns either. */
interface ImprovementStartResult {
  readonly improvement_run_id: string;
  readonly base_subject_version_id: string;
  readonly case_set_id: string | null;
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
        "snapshot taken from that run's own protocol version (improvement_policy.search — " +
        "REFUSED when it is missing or malformed; no fallback policy exists). RETURNS { improvement_run_id, " +
        "base_subject_version_id, case_set_id, search_policy, status, proposer_bundle } — the base subject every " +
        "candidate_record names and the case set this eval_run bound at evaluation_start (null when it bound none: " +
        "nothing from this run can be validated, so build one in EVALUATE first); proposer_bundle (AC-37.1) is this run's own actionable " +
        "evidence: failing traces, evaluator critiques, refusal text, corrections, dependency/ " +
        "tool errors, cost/latency and prior rejected hypotheses for this eval_run's plugin, so " +
        "the candidate this run searches for is proposed against what already failed rather " +
        "than guessed blind. REFUSES an eval_run_id nothing minted, an empty finding_ids list " +
        "(unless skip: true), a finding_ids entry naming no finding, a finding recorded against " +
        "a DIFFERENT eval_run, and any finding whose owner_kind is not 'plugin' — " +
        "\"ERROR: finding <id> is owned by <kind>; it is reported to its owner, not optimised\" " +
        "(FR-34: a dependency/platform/environment/user_input/unknown finding stays an " +
        "owner-facing finding and starts no optimization). Pass `initiative` to record " +
        "improvement_mode as that initiative's durable branch fact (FR-58) — search when the " +
        "base subject records release_owners, proposal when it does not; omit `initiative` and " +
        "nothing is recorded. `skip: true` is the explicit route for no plugin-owned actionable " +
        "finding at all: opens no improvement_run, and — with `initiative` — records " +
        "improvement_mode: skip and release_mode: not_applicable in one call. Checked and " +
        "REFUSED, before the idempotency ledger and before ANY row is written, when this " +
        "initiative's improvement_mode is already set to something else (FR-58, a hard refusal " +
        "— unlike protocol_read's own informational one — because opening or replaying into a " +
        "zz.improvement_run regardless would leave a search or proposal running that the " +
        "initiative's own facts do not admit to). REFUSES skip alongside a non-empty " +
        "finding_ids, and skip when a plugin-owned defect/unknown for this eval_run is still " +
        "`deferred` (name it and call improvement_start with it instead) — a plugin-owned " +
        "STRENGTH never blocks skip, since it carries no expected_effect and could never seed a " +
        "candidate. A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        eval_run_id: z.string(),
        finding_ids: z.array(z.string()).default([]),
        skip: z.boolean().optional().describe(
          "No plugin-owned defect/unknown is actionable for this eval_run — opens no " +
          "improvement_run. REFUSES a non-empty finding_ids, and a still-deferred plugin-owned " +
          "defect/unknown; a deferred plugin-owned strength never blocks it."),
        initiative: z.string().optional().describe(
          "Record improvement_mode (and, on skip, release_mode) as this initiative's durable " +
          "branch fact. Omit and nothing is recorded."),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ eval_run_id, finding_ids, skip, initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const run = (await p.query<{ id: string; protocol_version_id: string; subject_version_id: string; case_set_id: string | null }>(
        "select er.id::text as id, er.protocol_version_id::text as protocol_version_id, " +
        "er.subject_version_id::text as subject_version_id, es.case_set_version_id::text as case_set_id " +
        "from zz.eval_run er join zz.eval_evidence_snapshot es on es.id = er.evidence_snapshot_id " +
        "where er.id = $1::uuid", [eval_run_id])).rows[0];
      if (!run) return text(`ERROR: no eval_run ${eval_run_id}`);

      if (skip) {
        if (finding_ids.length) {
          return text("ERROR: skip is for no plugin-owned actionable finding at all — " +
            "finding_ids was non-empty; call improvement_start with them instead of skip");
        }
        // Live-verified gap (I-28's own dry pass): a deferred plugin-owned STRENGTH used to
        // block skip too, even though a strength carries no expected_effect and can never seed
        // a candidate (FR-34's "actionable" finding is one optimization could start from) — an
        // agent that recorded a strength exactly as EXPLAIN's own skill tells it to could then
        // never skip without first deciding a finding that was never optimization's business.
        // `defect`/`unknown` are the only kinds a search ever reads.
        const openPluginFindings = (await p.query<{ id: string }>(
          "select id::text as id from zz.eval_finding where eval_run_id = $1::uuid " +
          "and owner_kind = 'plugin' and kind in ('defect', 'unknown') and decision = 'deferred'",
          [eval_run_id])).rows;
        if (openPluginFindings.length) {
          return text(
            `ERROR: eval_run ${eval_run_id} has ${openPluginFindings.length} plugin-owned ` +
            `finding(s) still deferred (${openPluginFindings.map((f) => f.id).join(", ")}) — ` +
            "skip is for no plugin-owned actionable finding at all; call improvement_start with " +
            "finding_ids naming them instead.");
        }

        // FR-58: checked and refused as a HARD error, BEFORE the idempotency ledger below —
        // never a soft facts_refused. Skip declares release_mode: not_applicable alongside
        // improvement_mode: skip in one call; a conflict here means this initiative already
        // stands on a different branch (a search already opened for it, say), and letting the
        // ledger anchor proceed regardless would leave the facts saying skip while a real search
        // is or was open — the exact cross-branch inconsistency release_prepare's own pre-write
        // check exists to prevent.
        let skipFacts: Record<string, string> = {};
        if (initiative) {
          const written = await writeBranchFacts(
            initiative, { improvement_mode: "skip", release_mode: "not_applicable" });
          if (typeof written === "string") return text(written);
          skipFacts = written;
        }

        const principal = parseCaller(requestHeaders()).email;
        // No zz.improvement_run row: skip records that a search never started. zz.eval_run's own
        // row is this ledger's anchor — a re-select, never an insert — the shape proposal_prepare
        // uses (release.ts) for a call that writes no new row of its own.
        const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
          principal, "improvement_start", idempotency_key, { eval_run_id, skip: true },
          async (client): Promise<MutatorOutcome<{ id: string }>> => {
            const row = (await client.query<{ id: string }>(
              "select id::text as id from zz.eval_run where id = $1::uuid", [eval_run_id])).rows[0];
            if (!row) throw new Error("zz.eval_run row vanished between the check above and this transaction");
            return { result: { id: row.id }, result_table: "zz.eval_run", result_id: row.id };
          },
        );
        logActivity(await userRoot(), null, {
          user: principal, action: "improvement_start", eval_run_id, skip: true, replayed: outcome.replayed,
        });
        return json({
          improvement_run_id: null, status: "skipped",
          facts_recorded: !!initiative, facts: initiative ? skipFacts : undefined,
        });
      }
      if (!finding_ids.length) {
        return text("ERROR: finding_ids is required unless skip: true — nothing named to search for");
      }

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
      // Refused here, before any run exists, rather than by every later tool that reads it.
      const policyCheck = parseSearchPolicy(search_policy, "(not yet opened)");
      if ("error" in policyCheck) return text(policyCheck.error);

      // FR-58: search when the base subject this eval_run scored records release_owners, proposal
      // when it does not — the SAME ownership split release_prepare/proposal_prepare's own mirror
      // guard already enforces (release.ts), read here rather than re-derived a second way.
      // Checked and refused as a HARD error, BEFORE the idempotency ledger below (never a soft
      // facts_refused) — the same reason the skip branch above moved its own write earlier: a
      // conflict here means a DIFFERENT improvement_mode already stands for this initiative, and
      // opening (or replaying into) a zz.improvement_run regardless would leave a search or
      // proposal running that the initiative's own facts do not admit to.
      const subject = await loadSubjectForEvalRun(p, eval_run_id);
      const improvement_mode = (subject?.release_owners.length ?? 0) > 0 ? "search" : "proposal";
      let searchFacts: Record<string, string> = {};
      if (initiative) {
        const written = await writeBranchFacts(initiative, { improvement_mode });
        if (typeof written === "string") return text(written);
        searchFacts = written;
      }

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
        improvement_run_id: improvementRunId, base_subject_version_id: run.subject_version_id,
        case_set_id: run.case_set_id, search_policy, status: "open", proposer_bundle: bundle,
        facts_recorded: !!initiative, facts: initiative ? searchFacts : undefined,
      } satisfies ImprovementStartResult & { proposer_bundle: ProposerBundle } &
        { facts_recorded: boolean; facts?: Record<string, string> });
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
        "patchset.diff, into the search's current generation (search-rules.ts — parents are " +
        "lineage only, never the generation), computing patch_digest (sha256 of the diff), complexity_delta " +
        "(complexityDelta over the diff's own added/removed lines and added/removed files), " +
        "touched_components (the patch's files mapped onto base_subject_version_id's own " +
        "component_manifest) and touched_owners (the base subject's plugin's own " +
        "release_owners, FR-47 — every touched component inherits plugin-level ownership in " +
        "this initiative). RETURNS { candidate_id, generation, patch_digest, complexity_delta, " +
        "touched_components, touched_owners, status: 'recorded' }. REFUSES an " +
        "improvement_run_id nothing minted; one whose search_policy is malformed; a generation " +
        "already holding maxCandidatesPerGeneration candidates, or a search past maxGenerations; a base_subject_version_id nothing minted; a " +
        "parents entry naming no candidate; and a hypothesis whose normalised-text digest " +
        "matches a candidate already " + REJECTED_CANDIDATE_STATUSES.join("/") + ", OR whose " +
        "latest split: 'validation' zz.candidate_evaluation verdict is not_improved, for the " +
        "same base subject's plugin — \"ERROR: hypothesis already rejected as candidate <id>\" " +
        "or \"ERROR: hypothesis already tried as candidate <id>, whose validation verdict was " +
        "not_improved\" (FR-38's own repeat-rejection regularization, closed all the way — a " +
        "not_improved candidate stays status: valid and was previously invisible to this check). " +
        "A mutator: writes through the FR-59 idempotency ledger.",
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

      const run = (await p.query<{ id: string; eval_run_id: string; search_policy: unknown }>(
        "select id::text as id, eval_run_id::text as eval_run_id, search_policy from zz.improvement_run where id = $1::uuid",
        [improvement_run_id])).rows[0];
      if (!run) return text(`ERROR: no improvement_run ${improvement_run_id}`);

      if (!UUID_RE.test(base_subject_version_id)) return text("ERROR: unknown base_subject_version_id");
      const subject = (await p.query<{ id: string; plugin_id: string; component_manifest: ManifestComponent[] }>(
        "select id::text as id, plugin_id::text as plugin_id, component_manifest " +
        "from zz.eval_subject_version where id = $1::uuid", [base_subject_version_id])).rows[0];
      if (!subject) return text(`ERROR: no eval_subject_version ${base_subject_version_id}`);

      // FR-36's own ledger integrity, never checked before this task: a candidate that builds on
      // a DIFFERENT plugin than the one its own improvement_run's eval_run scored would inherit
      // that plugin's release_owners and component_manifest while claiming to descend from a run
      // that never evaluated it — the same "identity must not drift" rule evaluation_start's own
      // observation-snapshot check already applies one join over.
      const runPlugin = (await p.query<{ plugin_id: string; plugin_name: string }>(`
        select sv.plugin_id::text as plugin_id, pl.name as plugin_name
          from zz.eval_run er
          join zz.eval_subject_version sv on sv.id = er.subject_version_id
          join zz.plugin pl on pl.id = sv.plugin_id
         where er.id = $1::uuid`, [run.eval_run_id])).rows[0];
      if (runPlugin && runPlugin.plugin_id !== subject.plugin_id) {
        const subjectPlugin = (await p.query<{ name: string }>(
          "select name from zz.plugin where id = $1::uuid", [subject.plugin_id])).rows[0];
        return text(
          `ERROR: base_subject_version_id ${base_subject_version_id} belongs to plugin ` +
          `${subjectPlugin?.name ?? subject.plugin_id}, not improvement_run ${improvement_run_id}'s ` +
          `own eval_run plugin ${runPlugin.plugin_name}`);
      }

      if (parents.length) {
        const parentRows = (await p.query<{ id: string }>(
          "select id::text as id from zz.candidate where id = any($1::uuid[])", [parents])).rows;
        const found = new Set(parentRows.map((r) => r.id));
        const missing = parents.filter((id) => !found.has(id));
        if (missing.length) return text(`ERROR: parent candidate id(s) not found: ${missing.join(", ")}`);
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
      //
      // FIX (dispatch, closing FR-38's own gap): a candidate whose validation verdict came back
      // `not_improved` never moves off `status = 'valid'` — see candidate-validate.ts's own
      // module note, "a candidate stays valid after its verdict is stored" — so the ORIGINAL
      // query here, filtered to REJECTED_CANDIDATE_STATUSES alone, never saw it and the same
      // hypothesis could be proposed forever. The `exists` clause below reads
      // zz.candidate_evaluation directly for a `split: 'validation'` row whose verdict is
      // `not_improved`, whatever the candidate's own status column says — a second, independent
      // way into the SAME repeat-rejection set the status filter already builds, not a
      // replacement for it.
      //
      // FIX (dispatch, FR-28): REJECTED_CANDIDATE_STATUSES still names proof_failed — re-testing
      // a hypothesis whose proof genuinely FAILED would reuse that proof, which FR-28 forbids —
      // but deliberately NOT proof_not_established (migration 002): a candidate whose proof
      // never resolved (insufficient_proof_cases, proof_unresolved, or an abandoned allocation)
      // is an evidence gap, not a rejected idea, so its own hypothesis may be proposed again
      // under a fresh improvement_start.
      const wantDigest = hypothesisDigest(hypothesis);
      const priorRejections = (await p.query<{ id: string; hypothesis: string; status: string }>(`
        select c.id::text as id, c.hypothesis, c.status
          from zz.candidate c
          join zz.eval_subject_version sv on sv.id = c.base_subject_version_id
         where sv.plugin_id = $1::uuid
           and (c.status = any($2::text[]) or exists (
             select 1 from zz.candidate_evaluation ce
              where ce.candidate_id = c.id and ce.split = 'validation'
                and ce.aggregate_score->>'verdict' = 'not_improved'
           ))`,
        [subject.plugin_id, [...REJECTED_CANDIDATE_STATUSES]])).rows;
      const repeat = priorRejections.find((r) => hypothesisDigest(r.hypothesis) === wantDigest);
      if (repeat) {
        const rejectedByStatus = (REJECTED_CANDIDATE_STATUSES as readonly string[]).includes(repeat.status);
        return text(rejectedByStatus
          ? `ERROR: hypothesis already rejected as candidate ${repeat.id}`
          : `ERROR: hypothesis already tried as candidate ${repeat.id}, whose validation verdict was not_improved`);
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
          // Inside the ledger's transaction, never before it: a retry of the call that filled a
          // generation must reach the replay decision above, not the cap refusal.
          const generation = await recordGenerationFor(client, improvement_run_id, run.search_policy);
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
              "is what runs it.",
      });
    },
  );

  // -----------------------------------------------------------------------------------------
  // candidate_validate

  server.registerTool(
    "candidate_validate",
    {
      description:
        "WHEN a recorded or already-valid candidate is ready to be checked against its own base " +
        "(Task I-19, AC-40.1/AC-41.1): on a first call (status: recorded) first asks the " +
        "search.leakage critic (FR-38) — a clear yes rests it at rejected_precheck and REFUSES " +
        "with the critic's reason — otherwise moves it to awaiting_build and RETURNS { candidate_id, " +
        "status: 'awaiting_build', build_required: { patch_digest, lease_expires_at, command } }: " +
        "zz-core never builds; run the printed npm run candidate-build (it records through " +
        "candidate_build_record), then call again — the same answer comes back until a build is " +
        "recorded. The next call consumes it: a failed apply/install/build/gate makes the candidate invalid " +
        "and REFUSES with the failing command's own output tail; a timeout or host failure returns it to recorded. " +
        "On a passed build (or an already-valid candidate) it reads every validation-split replay case in the plugin's own " +
        "bound case set, pairs completed, scored zz.replay_run rows by case for the candidate " +
        "against its own base_subject_version_id, and, once every case has at least the " +
        "protocol's own minRepeats completed and scored runs on BOTH sides, calls the pure " +
        "pairedDecision (stats.ts) over each case's (candidate mean − baseline mean) delta. " +
        "RETURNS, when every case has enough repeats and the interval clears mme or the " +
        "protocol's own liveness bound (wallClockHours since improvement_start) has passed: " +
        "{ case_set_id, candidate_evaluation_id, verdict, interval: [lower, upper], mean_delta, guardrails, " +
        "resource_usage }, and stores the same on zz.candidate_evaluation (split: validation). " +
        "Otherwise RETURNS { case_set_id, candidate_evaluation_id: null, verdict: null, runs_required: " +
        "[{case_set_id, case_id, side, subject_version_id, candidate_id, count}] } — the exact (case, side) pairs still short of minRepeats, or, " +
        "once every case clears it but the bootstrap interval still straddles mme, one more " +
        "repeat per case per side — never a run this tool launches itself: replay_start " +
        "(case_id-steerable) and the launcher run the replay, this tool only plans and reads " +
        "back. Never reads a proof or evolve case. A candidate held 'validating' longer than " +
        "one call can take (its process died) is first returned to valid or recorded, and an " +
        "awaiting_build lease that expired unrecorded to recorded; a retry reuses the patch's " +
        "earlier leakage answer. REFUSES a candidate_id nothing minted; a status outside (recorded, " +
        "awaiting_build, valid) — including another call's live 'validating' hold; a malformed search_policy; an " +
        "improvement_run whose own eval_run bound no case_set_version_id; and a case set with no " +
        "replayable validation-split case. A mutator once it has a verdict to store: writes " +
        "through the FR-59 idempotency ledger — build_required, a build failure and an interim runs_required response are not.",
      inputSchema: { candidate_id: z.string(), idempotency_key: z.string().min(1) },
    },
    async ({ candidate_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;

      const outcome = await validateCandidate(p, candidate_id, idempotency_key, principal);
      if ("error" in outcome) return text(outcome.error);
      if ("build_required" in outcome) return json(outcome);

      logActivity(await userRoot(), null, {
        user: principal, action: "candidate_validate", candidate_id,
        verdict: outcome.verdict, runs_required: outcome.runs_required?.length ?? 0,
      });
      return json(outcome);
    },
  );

  // -----------------------------------------------------------------------------------------
  // candidate_search

  server.registerTool(
    "candidate_search",
    {
      description:
        "WHEN an improvement_run's own recorded candidates are ready to be advanced one step " +
        "(Task I-20, FR-38 to FR-42, FR-44; the leakage screen runs in candidate_validate): " +
        "composes at most one new child candidate per call from two valid candidates whose " +
        "patches touch disjoint files, recorded with its own digest and parent_ids exactly the " +
        "way candidate_record records a proposed one — only where candidate_record could record " +
        "one (never into a full generation or past maxGenerations); reduces every candidate with a stored " +
        "validation evaluation to the Pareto frontier over (per-case pass vector, cost); and, " +
        "once the protocol's own liveness bound (maxGenerations/wallClockHours) is reached, " +
        "selects exactly one final candidate FROM THAT FRONTIER — among members validated as " +
        "improves or an accepted pruning — by the protocol's deterministic selection policy — a validated candidate the frontier reduction already excluded is " +
        "never selected merely for having a good enough score on its own — " +
        "candidate.status and improvement_run.status both become 'selected', or, when no " +
        "guardrail-passing candidate cleared the equivalence band, improvement_run.status " +
        "becomes 'closed' with selected_id: null. Never runs a replay or a proof itself: like " +
        "candidate_validate, it plans and reduces from stored rows alone and reports what the " +
        "IMPROVE agent does next in `next` — propose more candidates for this generation " +
        "(directed at explore_components when the current generation has stalled), validate " +
        "the ones just proposed, or stop. RETURNS { generation, frontier_ids, rejected: " +
        "[{id, reason}], selected_id, status, explore_components, edit_budget (how many more candidate_record " +
        "would accept now), proposer_bundle, " +
        "next }. REFUSES an improvement_run_id nothing minted, one whose own eval_run names " +
        "no subject_version_id it can still resolve, and a malformed search_policy. A mutator once it has mutated candidate or " +
        "improvement_run state: writes through the FR-59 idempotency ledger; a call against an " +
        "improvement_run already at a terminal status (selected/proofing/proof_failed/" +
        "ready_for_approval/released/closed/cancelled) is read-only and writes no ledger row. " +
        "Pass `initiative` to record release_mode: not_applicable as that initiative's durable " +
        "branch fact (FR-58) the moment status becomes closed with selected_id: null on an OWNED " +
        "base subject — no candidate cleared the frontier, so release_prepare (the only thing " +
        "that could promote it) has nothing to work with. A non-owned subject's own closed run " +
        "leaves release_mode alone: proposal_prepare can still report whatever reached " +
        "validation, selected or not. Omit `initiative` and nothing is recorded; a fact already " +
        "set to something else is left standing (facts_recorded: false, facts_refused naming " +
        "why), never a hard refusal.",
      inputSchema: {
        improvement_run_id: z.string(), idempotency_key: z.string().min(1),
        initiative: z.string().optional().describe(
          "Record release_mode: not_applicable as this initiative's durable branch fact once " +
          "this run closes with nothing selected. Omit to read only."),
      },
    },
    async ({ improvement_run_id, idempotency_key, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;

      const outcome = await runCandidateSearch(p, improvement_run_id, idempotency_key, principal, initiative);
      if ("error" in outcome) return text(outcome.error);

      logActivity(await userRoot(), null, {
        user: principal, action: "candidate_search", improvement_run_id,
        generation: outcome.generation, status: outcome.status, selected_id: outcome.selected_id,
        rejected_count: outcome.rejected.length,
      });
      return json(outcome);
    },
  );

  // -----------------------------------------------------------------------------------------
  // candidate_prove

  server.registerTool(
    "candidate_prove",
    {
      description:
        "WHEN an improvement_run's own selected final candidate is ready for its sealed proof " +
        "(FR-28, FR-43): opens the candidate's ONE proof allocation. A first call (status: " +
        "selected) mints a verifier_token bound to this candidate and case set, moves the " +
        "candidate to proving and the run to proofing, claims the case set's proof split (no " +
        "other candidate opens it while this one proves), and RETURNS { proof_status: null, " +
        "verifier_token, token_already_issued, runs_required: { case_set_id, baseline, candidate " +
        "}, status: 'proving' } — run COUNTS per side, never a proof case id, and never resolving " +
        "in the same call. The IMPROVE agent calls replay_start(context: 'verifier', " +
        "verifier_token, split: 'proof', no case_id — drawn server-side) plus the launcher " +
        "(the verifier token in a mode-0600 --verifier-token-file) that many times per side. A LATER call reads back " +
        "completed, scored proof-split runs: short of minRepeats it RETURNS updated counts; once " +
        "every case clears it (or the liveness bound passes) it computes pairedDecision, " +
        "re-screens for leakage and stores one zz.candidate_evaluation (split: proof). RETURNS { " +
        "proof_status: proof_passed|proof_failed|not_established, reason, release_eligible, " +
        "candidate_evaluation_id, status, proof_split: spent|released } — never a per-case " +
        "result. proof_passed needs " +
        "improves (or an accepted pruning), every critical guardrail passing and a clear " +
        "no-leakage answer — unclear/unavailable is not_established (leakage_unresolved); " +
        "release_eligible also needs a release_owner (FR-47). not_established also covers " +
        "insufficient_proof_cases, proof_unresolved and guardrails_not_established. The case " +
        "set's proof split stays SPENT (no candidate proves on it again) after proof_passed, " +
        "proof_failed, or a not_established whose runs executed on proof cases (they observed " +
        "them); it is RELEASED after a not_established where no run ever executed or the only " +
        "gap was an unavailable leakage answer. Every terminal outcome spends the CANDIDATE's " +
        "allocation: candidate.status becomes proof_passed, " +
        "proof_failed (candidate_record refuses this hypothesis again) or proof_not_established " +
        "(an evidence gap — re-recordable); improvement_run.status becomes ready_for_approval, " +
        "closed (no owners, FR-51) or proof_failed. abandon: true recovers an allocation stuck " +
        "proving after a lost response: revokes the token, cancels its live proof runs, resolves " +
        "proof_not_established (reason: abandoned); a no-op read-back on a spent candidate. " +
        "REFUSES abandon on a selected candidate; a candidate_id nothing minted; a status neither " +
        "selected/proving nor spent — \"ERROR: only the selected candidate may open proof\"; a " +
        "non-abandon call on a spent candidate — \"ERROR: proof allocation spent\", naming what " +
        "a fresh improvement_start can still do; an eval_run with no case_set_version_id; a " +
        "plugin with no model-backed measure; a malformed search_policy; and a case set whose " +
        "proof split another candidate holds (proving, or spent as above). A mutator whenever it " +
        "writes (FR-59 ledger); an interim runs_required response is " +
        "not. Pass `initiative` to record release_mode: not_applicable (FR-58) on a proof_failed " +
        "outcome of an OWNED candidate only — not_established is a gap a fresh improvement_start " +
        "may resume from (on this case set only if proof_split was released; otherwise on a new " +
        "one), and a non-owned candidate still has proposal_prepare.",
      inputSchema: {
        candidate_id: z.string(), idempotency_key: z.string().min(1),
        abandon: z.boolean().optional()
          .describe("Resolve an allocation stuck 'proving' as not_established (abandoned). Ignored on a candidate never opened."),
        rotate_token: z.boolean().optional().describe("Lost the verifier_token? Revoke it and get a new one for the same allocation."),
        initiative: z.string().optional().describe(
          "Record release_mode: not_applicable as this initiative's durable branch fact once " +
          "this allocation resolves with nothing to promote or propose. Omit to read only."),
      },
    },
    async ({ candidate_id, idempotency_key, abandon, initiative, rotate_token }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;

      const outcome = await proveCandidate(p, candidate_id, idempotency_key, principal, abandon ?? false, initiative, rotate_token ?? false);
      if ("error" in outcome) return text(outcome.error);

      logActivity(await userRoot(), null, {
        user: principal, action: "candidate_prove", candidate_id,
        proof_status: outcome.proof_status, release_eligible: outcome.release_eligible,
        runs_required: outcome.runs_required ?? null,
      });
      return json(outcome);
    },
  );
}
