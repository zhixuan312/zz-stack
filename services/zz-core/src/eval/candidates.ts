/**
 * IMPROVE's own ledger (Task I-18, FR-34 to FR-37, AC-34.1 to AC-37.1): `improvement_start` opens
 * one durable improvement run against an `eval_run`'s plugin-owned findings, and `candidate_record`
 * persists one proposed patch against it — `zz.improvement_run`/`zz.candidate` — before anything
 * about that candidate ever executes (FR-36's own words: "no candidate executes before its ledger
 * row... exist").
 *
 * `complexity.ts` (Task I-18) is this file's only computation of a candidate's numbers —
 * `complexityDelta`, the patch's own file list and its mapping onto the base subject's
 * `component_manifest` — never re-derived here. `proposer-bundle.ts` (Task I-18) is the other
 * half: `improvement_start`'s own response carries it, because the run that consumes the
 * evidence and the run that opens it are the same call.
 *
 * `candidate_validate` is this file's third tool: it asks the local `npm run candidate-build` for
 * the candidate's build and gate and consumes the result — `candidate-validate.ts` carries those
 * decisions; this file only wires the tool's registration to it. A candidate that builds and
 * gates is releasable: it is judged on real use after release (`release_verify`), never by
 * replaying past initiatives before it.
 *
 * `improvement_stop` is the fourth: IMPROVE's own end on an owned subject when no candidate is
 * worth releasing — every one invalid, or none proposed — recorded as release_mode:
 * not_applicable so the initiative can close on `findings.md` alone.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { validateCandidate } from "./candidate-validate.js";
import {
  complexityDelta, componentCounts, hypothesisDigest, parseUnifiedDiff, patchDigest, touchedComponents,
  type ComplexityInput, type ManifestComponent, type PatchFile, type PatchStats, type TouchedComponent,
} from "./complexity.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { improvementRunOf } from "./initiative-run.js";
import { loadSubjectForEvalRun } from "./proposal-doc.js";
import { loadProposerBundle, REJECTED_CANDIDATE_STATUSES, type ProposerBundle } from "./proposer-bundle.js";
import { writeBranchFacts } from "./protocol.js";
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

/** `base_subject_version_id` travels on the response because IMPROVE may open in a fresh
 *  conversation: `candidate_record` names it, and no other call in the stage returns it. */
interface ImprovementStartResult {
  readonly improvement_run_id: string;
  readonly base_subject_version_id: string;
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
        "WHEN an eval_run's findings name work worth improving: opens one durable " +
        "zz.improvement_run against eval_run_id and its finding_ids. RETURNS { improvement_run_id, " +
        "base_subject_version_id, status, proposer_bundle } — the base subject every " +
        "candidate_record names; proposer_bundle (AC-37.1) is this run's own actionable " +
        "evidence: failing traces, evaluator critiques, refusal text, corrections, dependency/ " +
        "tool errors, cost/latency and prior rejected hypotheses for this eval_run's plugin, so " +
        "a candidate is proposed against what already failed rather than guessed blind. REFUSES an eval_run_id nothing minted, an empty finding_ids list " +
        "(unless skip: true), a finding_ids entry naming no finding, a finding recorded against " +
        "a DIFFERENT eval_run, and any finding whose owner_kind is not 'plugin' — " +
        "\"ERROR: finding <id> is owned by <kind>; it is reported to its owner, not optimised\" " +
        "(FR-34: a dependency/platform/environment/user_input/unknown finding stays an " +
        "owner-facing finding and starts no improvement). Pass `initiative` to record " +
        "improvement_mode as that initiative's durable branch fact (FR-58) — release when the " +
        "base subject records release_owners, proposal when it does not; omit `initiative` and " +
        "nothing is recorded. `skip: true` is the explicit route for no plugin-owned actionable " +
        "finding at all: opens no improvement_run, and — with `initiative` — records " +
        "improvement_mode: skip and release_mode: not_applicable in one call. Checked and " +
        "REFUSED, before the idempotency ledger and before ANY row is written, when this " +
        "initiative's improvement_mode is already set to something else (FR-58, a hard refusal " +
        "— unlike protocol_read's own informational one — because opening or replaying into a " +
        "zz.improvement_run regardless would leave a release or proposal running that the " +
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

      const run = (await p.query<{ id: string; subject_version_id: string }>(
        "select id::text as id, subject_version_id::text as subject_version_id " +
        "from zz.eval_run where id = $1::uuid", [eval_run_id])).rows[0];
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
        // `defect`/`unknown` are the only kinds a candidate is ever proposed from.
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
        // stands on a different branch (an improvement run already opened for it, say), and letting the
        // ledger anchor proceed regardless would leave the facts saying skip while a real
        // improvement run is or was open — the exact cross-branch inconsistency release_prepare's own pre-write
        // check exists to prevent.
        let skipFacts: Record<string, string> = {};
        if (initiative) {
          const written = await writeBranchFacts(
            initiative, { improvement_mode: "skip", release_mode: "not_applicable" });
          if (typeof written === "string") return text(written);
          skipFacts = written;
        }

        const principal = parseCaller(requestHeaders()).email;
        // No zz.improvement_run row: skip records that no improvement run started. zz.eval_run's own
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
        return text("ERROR: finding_ids is required unless skip: true — nothing named to improve");
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

      // FR-58: release when the base subject this eval_run scored records release_owners, proposal
      // when it does not — the SAME ownership split release_prepare/proposal_prepare's own mirror
      // guard already enforces (release.ts), read here rather than re-derived a second way.
      // Checked and refused as a HARD error, BEFORE the idempotency ledger below (never a soft
      // facts_refused) — the same reason the skip branch above moved its own write earlier: a
      // conflict here means a DIFFERENT improvement_mode already stands for this initiative, and
      // opening (or replaying into) a zz.improvement_run regardless would leave a release or
      // proposal running that the initiative's own facts do not admit to.
      const subject = await loadSubjectForEvalRun(p, eval_run_id);
      const improvement_mode = (subject?.release_owners.length ?? 0) > 0 ? "release" : "proposal";
      let runFacts: Record<string, string> = {};
      if (initiative) {
        const written = await writeBranchFacts(initiative, { improvement_mode });
        if (typeof written === "string") return text(written);
        runFacts = written;
      }

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "improvement_start", idempotency_key, { eval_run_id, finding_ids },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.improvement_run (eval_run_id, finding_ids, created_at)
            values ($1::uuid, $2::jsonb, now())
            returning id::text as id`,
            [eval_run_id, JSON.stringify(finding_ids)])).rows[0];
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
        status: "open", proposer_bundle: bundle,
        facts_recorded: !!initiative, facts: initiative ? runFacts : undefined,
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
        "it executes (FR-36): records improvement_run_id, base_subject_version_id, hypothesis, " +
        "expected_effect and patchset.diff, computing patch_digest (sha256 of the diff), complexity_delta " +
        "(complexityDelta over the diff's own added/removed lines and added/removed files), " +
        "touched_components (the patch's files mapped onto base_subject_version_id's own " +
        "component_manifest) and touched_owners (the base subject's plugin's own " +
        "release_owners, FR-47 — every touched component inherits plugin-level ownership in " +
        "this initiative). RETURNS { candidate_id, patch_digest, complexity_delta, " +
        "touched_components, touched_owners, status: 'recorded' }. REFUSES an " +
        "improvement_run_id nothing minted; a base_subject_version_id nothing minted, or one of a " +
        "different plugin than the run's eval_run; and a hypothesis whose normalised-text digest " +
        "matches a candidate of the same plugin already " + REJECTED_CANDIDATE_STATUSES.join("/") +
        " — \"ERROR: hypothesis already rejected as candidate <id>\" (FR-38: an idea that failed " +
        "its gate, or that measured worse on real use and was rolled back, is not proposed again). " +
        "A mutator: writes through the FR-59 idempotency ledger.",
      inputSchema: {
        improvement_run_id: z.string(),
        base_subject_version_id: z.string(),
        hypothesis: z.string().min(1),
        expected_effect: z.record(z.string(), z.unknown()),
        patchset: z.object({
          diff: z.string().min(1).describe("a unified diff — the file list and per-file " +
            "added/removed/modified state are derived from it, never supplied separately"),
        }),
        idempotency_key: z.string().min(1),
      },
    },
    async ({ improvement_run_id, base_subject_version_id, hypothesis, expected_effect, patchset, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();

      const run = (await p.query<{ id: string; eval_run_id: string }>(
        "select id::text as id, eval_run_id::text as eval_run_id from zz.improvement_run where id = $1::uuid",
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
      if (repeat) return text(`ERROR: hypothesis already rejected as candidate ${repeat.id}`);

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
        id: string; patch_digest: string; complexity_delta: number;
        touched_components: typeof touched_components; touched_owners: string[];
      }> = await withIdempotency(
        caller.email, "candidate_record", idempotency_key,
        { improvement_run_id, base_subject_version_id, hypothesis, expected_effect, patchset },
        async (client): Promise<MutatorOutcome<{
          id: string; patch_digest: string; complexity_delta: number;
          touched_components: typeof touched_components; touched_owners: string[];
        }>> => {
          const row = (await client.query<{ id: string }>(`
            insert into zz.candidate
              (improvement_run_id, base_subject_version_id, hypothesis,
               expected_effect, patchset, patch_digest, complexity_delta, touched_components,
               touched_owners, proposer_identity, status, created_at)
            values ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb,
                    $9::jsonb, $10::jsonb, 'recorded', now())
            returning id::text as id`,
            [improvement_run_id, base_subject_version_id, hypothesis,
             JSON.stringify(expected_effect), JSON.stringify({ diff: patchset.diff, files: stats.files.map((f) => f.path) }),
             digest, complexity_delta, JSON.stringify(touched_components), JSON.stringify(touched_owners),
             JSON.stringify(proposer_identity)])).rows[0];
          if (!row) throw new Error("insert into zz.candidate produced no row");
          return {
            result: { id: row.id, patch_digest: digest, complexity_delta, touched_components, touched_owners },
            result_table: "zz.candidate", result_id: row.id,
          };
        },
      );

      let result: { id: string; patch_digest: string; complexity_delta: number;
        touched_components: unknown; touched_owners: unknown };
      if (outcome.replayed) {
        const row = (await p.query<{
          id: string; patch_digest: string; complexity_delta: number;
          touched_components: unknown; touched_owners: unknown;
        }>(`select id::text as id, patch_digest, complexity_delta, touched_components, touched_owners
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
        candidate_id: result.id, patch_digest: result.patch_digest,
        complexity_delta: result.complexity_delta, touched_components: result.touched_components,
        touched_owners: result.touched_owners, status: "recorded",
        next: "No candidate executes before this row exists — it now does. candidate_validate " +
              "asks for its build and gate.",
      });
    },
  );

  // -----------------------------------------------------------------------------------------
  // candidate_validate

  server.registerTool(
    "candidate_validate",
    {
      description:
        "WHEN a recorded candidate is ready to be built and gated: on a first call (status: " +
        "recorded) moves it to awaiting_build and RETURNS { candidate_id, status: " +
        "'awaiting_build', build_required: { patch_digest, lease_expires_at, command } }: zz-core " +
        "never builds; run the printed npm run candidate-build (it records through " +
        "candidate_build_record), then call again — the same answer comes back until a build is " +
        "recorded. The next call consumes it: a failed apply/install/build/gate makes the " +
        "candidate invalid and REFUSES with the failing command's own output tail; a timeout or " +
        "host failure returns it to recorded (nothing about the patch was judged). A passed build " +
        "makes it valid and RETURNS { candidate_id, status: 'valid', patch_digest, releasable: " +
        "true, build, next } — releasable, with no replay and no proof: a released candidate is " +
        "judged on real use afterwards (release_verify). An awaiting_build lease (60 minutes) " +
        "that expired unrecorded returns the candidate to recorded first. REFUSES a candidate_id " +
        "nothing minted and a status outside (recorded, awaiting_build, valid). A mutator when it " +
        "consumes a build: writes through the FR-59 idempotency ledger — build_required is not.",
      inputSchema: { candidate_id: z.string(), idempotency_key: z.string().min(1) },
    },
    async ({ candidate_id, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const principal = parseCaller(requestHeaders()).email;

      const outcome = await validateCandidate(p, candidate_id, idempotency_key, principal);
      if ("error" in outcome) return text(outcome.error);
      if ("build_required" in outcome) return json(outcome);

      logActivity(await userRoot(), null, { user: principal, action: "candidate_validate", candidate_id, status: outcome.status });
      return json(outcome);
    },
  );

  // -----------------------------------------------------------------------------------------
  // improvement_stop

  server.registerTool(
    "improvement_stop",
    {
      description:
        "WHEN IMPROVE ends on an OWNED subject with no candidate worth releasing — every candidate " +
        "failed its build or gate, or none could be proposed: records release_mode: " +
        "not_applicable as the initiative's durable branch fact (FR-58), so it closes on " +
        "findings.md alone. Resolves the improvement run from the initiative (the newest on the " +
        "eval_run its findings.md records). RETURNS { improvement_run_id, facts }. REFUSES an " +
        "initiative with no findings.md eval_run (no_eval_run) or no improvement run on it " +
        "(no_improvement_run); an initiative with a valid (built and gated) candidate — " +
        "release_prepare it instead; a subject with no release_owners — proposal_prepare writes " +
        "its proposal.md instead; and (FR-58, hard refusal) a release_mode already set to " +
        "something else. A mutator: writes through the FR-59 idempotency ledger, anchored on the " +
        "improvement run's own row.",
      inputSchema: { initiative: z.string(), idempotency_key: z.string().min(1) },
    },
    async ({ initiative, idempotency_key }) => {
      const p = db();
      if (!p) return noDb();
      const resolved = await improvementRunOf(p, initiative);
      if (typeof resolved !== "string") return text(resolved.error);
      const run = (await p.query<{ eval_run_id: string }>(
        "select eval_run_id::text as eval_run_id from zz.improvement_run where id = $1::uuid", [resolved])).rows[0];
      if (!run) return text(`ERROR: no improvement_run ${resolved}`);
      const subject = await loadSubjectForEvalRun(p, run.eval_run_id);
      if (!subject?.release_owners.length) {
        return text("ERROR: proposal_only — this subject records no release_owners; proposal_prepare(initiative) " +
          "writes its proposal.md, which is how IMPROVE ends for it");
      }
      const valid = (await p.query<{ id: string }>(`
        select c.id::text as id from zz.candidate c join zz.improvement_run ir on ir.id = c.improvement_run_id
         where ir.eval_run_id = $1::uuid and c.status = 'valid' order by c.created_at`, [run.eval_run_id])).rows;
      if (valid.length) {
        return text(`ERROR: releasable — candidate(s) ${valid.map((c) => c.id).join(", ")} built and gated; ` +
          "release_prepare(initiative) prepares one for release instead of stopping");
      }
      const written = await writeBranchFacts(initiative, { release_mode: "not_applicable" });
      if (typeof written === "string") return text(written);

      const principal = parseCaller(requestHeaders()).email;
      const outcome: IdempotencyOutcome<{ id: string }> = await withIdempotency(
        principal, "improvement_stop", idempotency_key, { initiative, improvement_run_id: resolved },
        async (client): Promise<MutatorOutcome<{ id: string }>> => {
          const row = (await client.query<{ id: string }>(
            "select id::text as id from zz.improvement_run where id = $1::uuid", [resolved])).rows[0];
          if (!row) throw new Error("zz.improvement_run row vanished between the check above and this transaction");
          return { result: { id: row.id }, result_table: "zz.improvement_run", result_id: row.id };
        },
      );
      logActivity(await userRoot(), null, {
        user: principal, action: "improvement_stop", improvement_run_id: resolved, replayed: outcome.replayed,
      });
      return json({ improvement_run_id: resolved, facts: written });
    },
  );
}
