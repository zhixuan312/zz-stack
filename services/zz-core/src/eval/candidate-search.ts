/**
 * `candidate_search`'s own planning + regularization (Task I-20, FR-38 to FR-42, FR-44, AC-38.1,
 * AC-39.1, AC-42.1, AC-44.1): everything between a generation's own recorded candidates and the
 * response an IMPROVE agent reads to decide what to do next. `candidates.ts` keeps only the
 * tool's own registration and description, the same split it already keeps with
 * `candidate-validate.ts` (Task I-19) — every decision this contract asks for lives here.
 *
 * Never an executor: like `candidate_validate`, this file plans and reduces, never runs a replay
 * or a proof itself (FR-46's own boundary — "search never calls a proof tool" is this task's
 * contract line for the same reason). What it DOES do inside one call:
 *   - composes at most one new child candidate per call, from two `valid` candidates whose
 *     patches touch disjoint files (FR-39, this task's own invariant: "composition only merges
 *     candidates touching disjoint files"), recorded exactly the way `candidate_record`
 *     (`candidates.ts`) records a proposed one — its own digest, its own `parent_ids`, `status:
 *     'recorded'`, ready for the SAME `candidate_validate` calls (leakage screen, local build, replay)
 *     any other candidate goes through. It joins the search's current generation
 *     (`search-rules.ts`), never "its parents' generation + 1" — composition depth is not a
 *     search round — and only when `generationCapRefusal` would let `candidate_record` add one
 *     there, so composition never runs a search past maxGenerations;
 *   - reduces every candidate with a stored validation evaluation to `selection.ts`'s pure
 *     `paretoFrontier`, and, once the protocol's own liveness bound is reached, to `selectFinal`
 *     over the frontier members whose verdict is `improves` or an accepted pruning trade-off —
 *     one deterministic winner, or `null` when none qualifies;
 *
 * The leakage critic (FR-38) used to run here, over `recorded` candidates only — but the
 * documented order validates a candidate before search ever sees it, so the screen was skipped
 * for exactly the candidates that mattered. It now runs inside `candidate_validate`, before the
 * build (`candidate-leakage.ts`), and this call asks no model at all.
 *   - when the current generation has nothing left to try — every one of its own candidates
 *     `rejected_precheck`, `invalid` or validated `not_improved` — names which of the base
 *     subject's own manifest components no candidate in this run has touched yet (FR-38's own
 *     "exploration of untouched components"), so the next generation's proposer is steered away
 *     from repeating the same ground.
 *
 * Pruning (FR-44) needs no special code: a candidate whose patch only deletes/simplifies is
 * recorded, screened, composed and selected through the exact same path as any other — a negative
 * `complexity_delta` is never filtered out anywhere in this file, which IS "pruning admitted as a
 * first-class candidate operation" in practice.
 */
import type { SearchPolicy } from "@zz/contracts";
import type pg from "pg";

import {
  complexityDelta, componentCounts, hypothesisDigest, parseUnifiedDiff, patchDigest, touchedComponents,
  type ManifestComponent, type PatchFile, type TouchedComponent,
} from "./complexity.js";
import { loadProposerBundle, type ProposerBundle } from "./proposer-bundle.js";
import { paretoFrontier, selectFinal, type FrontierCandidate, type SelectionCandidate } from "./selection.js";
import { withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { writeBranchFacts } from "./protocol.js";
import {
  generationCapRefusal, parseSearchPolicy, searchGeneration, type GenerationMember, type GenerationState,
} from "./search-rules.js";
import { releaseStaleValidating } from "./candidate-validate.js";
import { Refusal } from "../refusal.js";

type Runner = pg.Pool | pg.PoolClient;

// -------------------------------------------------------------------------------------------
// Candidates, as this file needs to read and reason about them — a narrower shape than
// candidates.ts's own insert path, built once per call and mutated in place as leakage screening
// and composition change what is true about a row within the SAME call.

interface CandidateRow {
  readonly id: string;
  status: string;
  readonly generation: number;
  readonly parent_ids: readonly string[];
  readonly hypothesis: string;
  readonly expected_effect: Record<string, unknown>;
  readonly diff: string;
  readonly complexity_delta: number;
  readonly touched_components: readonly TouchedComponent[];
}

async function loadCandidates(runner: Runner, improvementRunId: string): Promise<CandidateRow[]> {
  const rows = (await runner.query<{
    id: string; status: string; generation: number; parent_ids: string[] | null;
    hypothesis: string; expected_effect: Record<string, unknown> | null; diff: string | null;
    complexity_delta: number; touched_components: TouchedComponent[] | null;
  }>(`
    select id::text as id, status, generation, parent_ids, hypothesis, expected_effect,
           patchset->>'diff' as diff, complexity_delta, touched_components
      from zz.candidate where improvement_run_id = $1::uuid order by created_at`,
    [improvementRunId])).rows;
  return rows.map((r) => ({
    id: r.id, status: r.status, generation: r.generation, parent_ids: r.parent_ids ?? [],
    hypothesis: r.hypothesis, expected_effect: r.expected_effect ?? {}, diff: r.diff ?? "",
    complexity_delta: r.complexity_delta, touched_components: r.touched_components ?? [],
  }));
}

function rejectionReason(c: CandidateRow): string {
  const stored = c.expected_effect._rejection_reason;
  return typeof stored === "string" ? stored : "rejected before validation";
}

// -------------------------------------------------------------------------------------------
// Composition (FR-39): at most one new child per call, from two `valid` candidates whose patches
// touch disjoint files — the contract's own invariant, enforced here by set intersection over
// `touched_components[].path` rather than over `.name` (two components can share a manifest name
// while their patches touch different files, and the invariant is about files).

function alreadyComposed(existing: readonly CandidateRow[], aId: string, bId: string): boolean {
  const want = [aId, bId].sort().join("|");
  return existing.some((c) => c.parent_ids.length === 2 && [...c.parent_ids].sort().join("|") === want);
}

/** Deterministic: candidates sorted by id, the first disjoint-and-not-yet-composed pair found —
 *  so two calls over the same candidate set always propose the same composition, never a
 *  different one depending on iteration order. */
function findComposablePair(cands: readonly CandidateRow[]): readonly [CandidateRow, CandidateRow] | null {
  const valid = [...cands.filter((c) => c.status === "valid")].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i], b = valid[j];
      const aFiles = new Set(a.touched_components.map((t) => t.path));
      const overlaps = b.touched_components.some((t) => aFiles.has(t.path));
      if (!overlaps && !alreadyComposed(cands, a.id, b.id)) return [a, b];
    }
  }
  return null;
}

/** Concatenation, not a merge algorithm: two unified diffs whose files never overlap are each a
 *  self-contained sequence of `diff --git` blocks, so joining them end to end is itself a valid
 *  unified diff over the union of files — `patch`/`git apply` read one `diff --git` header at a
 *  time and neither cares what preceded it. A real three-way merge is only needed when two
 *  patches touch the SAME file, which `findComposablePair` above has already ruled out. */
function concatDiffs(a: string, b: string): string {
  const left = a.endsWith("\n") ? a : `${a}\n`;
  return `${left}${b}`;
}

async function composeCandidate(
  client: pg.PoolClient, improvementRunId: string, baseSubjectVersionId: string,
  manifest: readonly ManifestComponent[], releaseOwners: readonly string[],
  a: CandidateRow, b: CandidateRow, principal: string, generation: number,
): Promise<CandidateRow> {
  const diff = concatDiffs(a.diff, b.diff);
  const stats = parseUnifiedDiff(diff);
  const files: readonly PatchFile[] = stats.files;
  const counts = componentCounts(files);
  const complexity_delta = complexityDelta({
    lines_added: stats.lines_added, lines_removed: stats.lines_removed,
    components_added: counts.added, components_removed: counts.removed,
  });
  const digest = patchDigest(diff);
  const touched_components = touchedComponents(files, manifest);
  const hypothesis =
    `Composed from candidate ${a.id} ("${a.hypothesis.slice(0, 80)}") and candidate ${b.id} ` +
    `("${b.hypothesis.slice(0, 80)}") — disjoint-file crossover, FR-39.`;
  const expected_effect = { composed_from: [a.id, b.id] };
  const proposer_identity = {
    principal, client: null, method: "composition", hypothesis_digest: hypothesisDigest(hypothesis),
  };
  const row = (await client.query<{ id: string }>(`
    insert into zz.candidate
      (improvement_run_id, base_subject_version_id, generation, parent_ids, hypothesis,
       expected_effect, patchset, patch_digest, complexity_delta, touched_components,
       touched_owners, proposer_identity, status, created_at)
    values ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
            $11::jsonb, $12::jsonb, 'recorded', now())
    returning id::text as id`,
    [improvementRunId, baseSubjectVersionId, generation, JSON.stringify([a.id, b.id]), hypothesis,
     JSON.stringify(expected_effect), JSON.stringify({ diff, files: files.map((f) => f.path) }),
     digest, complexity_delta, JSON.stringify(touched_components), JSON.stringify(releaseOwners),
     JSON.stringify(proposer_identity)])).rows[0];
  if (!row) throw new Error("insert into zz.candidate produced no row for a composed candidate");
  return {
    id: row.id, status: "recorded", generation, parent_ids: [a.id, b.id], hypothesis,
    expected_effect, diff, complexity_delta, touched_components,
  };
}

// -------------------------------------------------------------------------------------------
// Validation evidence, reduced to what paretoFrontier/selectFinal need — read once per call, from
// whatever zz.candidate_evaluation (split: 'validation') candidate_validate has already stored.
// Never a replay itself: exactly the evidence candidate_validate already resolved, reduced again.

interface ValidationEval {
  readonly lower: number;
  readonly verdict: string;
  readonly guardrails_pass: boolean;
  readonly per_case: ReadonlyMap<string, number>;
  readonly candidate_cost: number | null;
  readonly candidate_duration: number | null;
  readonly baseline_cost: number | null;
  readonly baseline_duration: number | null;
}

async function caseSetIdFor(runner: Runner, improvementRunId: string): Promise<string | null> {
  const row = (await runner.query<{ case_set_version_id: string | null }>(`
    select es.case_set_version_id::text as case_set_version_id
      from zz.improvement_run ir
      join zz.eval_run er on er.id = ir.eval_run_id
      join zz.eval_evidence_snapshot es on es.id = er.evidence_snapshot_id
     where ir.id = $1::uuid`, [improvementRunId])).rows[0];
  return row?.case_set_version_id ?? null;
}

async function loadValidationCaseIds(runner: Runner, caseSetId: string): Promise<string[]> {
  return (await runner.query<{ case_id: string }>(`
    select id::text as case_id from zz.replay_case
     where case_set_id = $1::uuid and split = 'validation' and status = 'replayable'
     order by id`, [caseSetId])).rows.map((r) => r.case_id);
}

async function loadValidationEvaluations(
  runner: Runner, candidateIds: readonly string[],
): Promise<Map<string, ValidationEval>> {
  const out = new Map<string, ValidationEval>();
  if (!candidateIds.length) return out;
  const rows = (await runner.query<{
    candidate_id: string;
    aggregate_score: { lower: number; verdict: string };
    guardrails: { status: string };
    statistics: { per_case?: { case_id: string; delta: number }[] };
    resource_usage: {
      candidate?: { mean_cost: number | null; mean_duration_ms: number | null };
      baseline?: { mean_cost: number | null; mean_duration_ms: number | null };
    };
  }>(`
    select distinct on (candidate_id) candidate_id::text as candidate_id, aggregate_score,
           guardrails, statistics, resource_usage
      from zz.candidate_evaluation
     where candidate_id = any($1::uuid[]) and split = 'validation'
     order by candidate_id, created_at desc`, [candidateIds])).rows;
  for (const r of rows) {
    out.set(r.candidate_id, {
      lower: r.aggregate_score.lower, verdict: r.aggregate_score.verdict,
      guardrails_pass: r.guardrails.status === "pass",
      per_case: new Map((r.statistics.per_case ?? []).map((pc) => [pc.case_id, pc.delta])),
      candidate_cost: r.resource_usage.candidate?.mean_cost ?? null,
      candidate_duration: r.resource_usage.candidate?.mean_duration_ms ?? null,
      baseline_cost: r.resource_usage.baseline?.mean_cost ?? null,
      baseline_duration: r.resource_usage.baseline?.mean_duration_ms ?? null,
    });
  }
  return out;
}

function buildFrontierInput(
  candidates: readonly CandidateRow[], evaluations: ReadonlyMap<string, ValidationEval>,
  caseIds: readonly string[],
): FrontierCandidate[] {
  const out: FrontierCandidate[] = [];
  for (const c of candidates) {
    const ev = evaluations.get(c.id);
    if (!ev) continue; // no validation evidence yet — not a frontier candidate this call
    const pass_vector = caseIds.map((id) => ((ev.per_case.get(id) ?? -Infinity) >= 0 ? 1 : 0));
    out.push({ id: c.id, pass_vector, cost: ev.candidate_cost ?? 0 });
  }
  return out;
}

function buildSelectionInput(
  candidates: readonly CandidateRow[], evaluations: ReadonlyMap<string, ValidationEval>,
): SelectionCandidate[] {
  const out: SelectionCandidate[] = [];
  for (const c of candidates) {
    const ev = evaluations.get(c.id);
    if (!ev) continue;
    out.push({
      id: c.id, guardrails_pass: ev.guardrails_pass, lower_bound: ev.lower,
      complexity_delta: c.complexity_delta,
      latency_delta: (ev.candidate_duration ?? 0) - (ev.baseline_duration ?? 0),
      cost_delta: (ev.candidate_cost ?? 0) - (ev.baseline_cost ?? 0),
    });
  }
  return out;
}

function isTerminalNegative(c: CandidateRow, evaluations: ReadonlyMap<string, ValidationEval>): boolean {
  if (c.status === "rejected_precheck" || c.status === "invalid") return true;
  return evaluations.get(c.id)?.verdict === "not_improved";
}

function untouchedComponents(manifest: readonly ManifestComponent[], candidates: readonly CandidateRow[]): string[] {
  const touchedNames = new Set(candidates.flatMap((c) => c.touched_components.map((tc) => tc.name)));
  return manifest.filter((m) => !touchedNames.has(m.name)).map((m) => m.name);
}

// -------------------------------------------------------------------------------------------
// The view: generation, frontier, rejections, selection and the exploration hint — computed the
// SAME way whether this call just mutated the candidate set or is only reading back a prior
// call's committed result (a replay, or a run that already reached a terminal status). Only the
// mutator branch below decides whether the computed selected_id/stopped actually get WRITTEN.

interface ViewCore {
  readonly generation: number;
  readonly stopped: boolean;
  readonly frontier_ids: readonly string[];
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly selected_id: string | null;
  readonly explore_components: readonly string[];
  /** How many more candidates `candidate_record` would accept right now: the room left in the
   *  generation a new one joins, 0 once `maxGenerations` is used up — the same rule
   *  `generationCapRefusal` refuses by, so the number never promises a slot the record refuses. */
  readonly edit_budget: number;
  /** The generation a newly recorded candidate joins — `generation` + 1 once it has settled. */
  readonly joins: number;
}

function generationOf(
  candidates: readonly CandidateRow[], evaluations: ReadonlyMap<string, ValidationEval>,
): GenerationState {
  const members: GenerationMember[] = candidates.map((c) => ({
    generation: c.generation, validated: evaluations.has(c.id),
    rejected: c.status === "rejected_precheck" || c.status === "invalid",
  }));
  return searchGeneration(members);
}

/** FR-43's own bar, applied at selection too: a frontier member is selectable only when its
 *  validation verdict is `improves`, or it is a pruning candidate (negative complexity_delta)
 *  whose interval shows no regression. A `not_improved`/`unresolved` candidate can sit on the
 *  frontier (it may still be cheapest), but selecting it would spend the one proof allocation on
 *  a candidate validation already said does not improve. */
function selectable(c: CandidateRow, ev: ValidationEval | undefined): boolean {
  if (!ev) return false;
  return ev.verdict === "improves" || (c.complexity_delta < 0 && ev.lower >= 0);
}

function computeViewCore(
  candidates: readonly CandidateRow[], evaluations: ReadonlyMap<string, ValidationEval>,
  caseIds: readonly string[], policy: SearchPolicy, manifest: readonly ManifestComponent[],
  runCreatedAt: Date, alreadySelectedId: string | null,
): ViewCore {
  const gen = generationOf(candidates, evaluations);
  const generation = gen.current;
  const wallClockExceeded = Date.now() - runCreatedAt.getTime() >= policy.wallClockHours * 3_600_000;
  const generationsExhausted = gen.settled && gen.validatedGenerations >= policy.maxGenerations;
  const stopped = wallClockExceeded || generationsExhausted;

  const frontierSet = paretoFrontier(buildFrontierInput(candidates, evaluations, caseIds));
  const frontier_ids = [...frontierSet].sort();

  // FR-42's own words: "selects exactly one final candidate FROM THE VALIDATION FRONTIER" —
  // never from every validated candidate. A candidate with a stored evaluation that the Pareto
  // reduction above already excluded (dominated on pass-vector/cost by another candidate) is not
  // a second, independent way to win; it lost the frontier reduction and stays lost here.
  let selected_id = alreadySelectedId;
  if (selected_id === null && stopped) {
    const frontierCandidates = candidates.filter((c) => frontierSet.has(c.id) && selectable(c, evaluations.get(c.id)));
    selected_id = selectFinal(buildSelectionInput(frontierCandidates, evaluations), policy.equivalenceBand);
  }

  const rejected = candidates.filter((c) => c.status === "rejected_precheck")
    .map((c) => ({ id: c.id, reason: rejectionReason(c) }));

  const currentGen = candidates.filter((c) => c.generation === generation);
  const stalled = currentGen.length > 0 && currentGen.every((c) => isTerminalNegative(c, evaluations));
  const explore_components = stalled ? untouchedComponents(manifest, candidates) : [];

  const edit_budget = generationsExhausted ? 0 : Math.max(policy.maxCandidatesPerGeneration - gen.nextCount, 0);
  return { generation, stopped, frontier_ids, rejected, selected_id, explore_components, edit_budget, joins: gen.next };
}

function nextGuidance(view: ViewCore, status: string, policy: SearchPolicy): string {
  if (status === "selected") {
    return `generation ${view.generation}: candidate ${view.selected_id ?? "?"} selected — call ` +
      "candidate_prove next; propose or validate no further against this improvement_run.";
  }
  if (status === "closed") {
    return `generation ${view.generation}: no guardrail-passing candidate that validation found ` +
      "improving (or an accepted pruning) was on the frontier by the liveness bound — this " +
      "improvement_run is closed not_established.";
  }
  if (view.explore_components.length) {
    return `generation ${view.generation} has stalled — every candidate in it is rejected, ` +
      `invalid or not_improved. Propose up to ${policy.maxCandidatesPerGeneration} candidates ` +
      `for generation ${view.generation + 1}, directed at untouched components: ` +
      `${view.explore_components.join(", ")}.`;
  }
  // Named by the generation a new candidate JOINS: once the current one has settled, "this
  // generation" was a generation candidate_record no longer records into, and the count of
  // generations still to validate before selection was nowhere in the answer.
  return `generation ${view.joins}: propose up to ${view.edit_budget} candidate(s) for generation ` +
    `${view.joins} via candidate_record, call candidate_validate on each, then call candidate_search ` +
    `again. Selection runs once ${policy.maxGenerations} generations each hold a validated ` +
    `candidate (the protocol's maxGenerations) or ${policy.wallClockHours}h have passed.`;
}

// -------------------------------------------------------------------------------------------
// The tool's own result shape and orchestrator.

interface CandidateSearchResult {
  readonly generation: number;
  readonly frontier_ids: readonly string[];
  readonly rejected: readonly { readonly id: string; readonly reason: string }[];
  readonly selected_id: string | null;
  readonly status: string;
  readonly explore_components: readonly string[];
  readonly edit_budget: number;
  readonly proposer_bundle: ProposerBundle;
  readonly next: string;
  readonly facts_recorded?: boolean;
  readonly facts?: Record<string, string>;
  readonly facts_refused?: string;
}

const TERMINAL_RUN_STATUSES = new Set([
  "selected", "proofing", "proof_failed", "ready_for_approval", "released", "closed", "cancelled",
]);

/** FR-58 (defect found in I-27, closed here): a search that ends `closed` with `selected_id:
 *  null` selected nothing to promote — no candidate cleared the frontier at all. On an OWNED
 *  base subject (`release_owners` non-empty, `improvement_mode: search`) that is genuinely
 *  nothing left for this initiative: `release_prepare` refuses anything short of `proof_passed`,
 *  and `proposal_prepare` itself refuses an owned subject outright, so left unrecorded this
 *  initiative's `release_mode` never gets set and a finished close hits `branch_undetermined`
 *  forever (`guards.ts`'s `closeCheck`).
 *
 *  Deliberately gated on ownership at the CALL SITE below, not here: a non-owned subject
 *  (`improvement_mode: proposal`) reaching `closed, selected_id: null` still has
 *  `proposal_prepare` open to it — it writes from every candidate that reached validation or
 *  later, whether or not one was ever selected — so writing `not_applicable` here for that
 *  branch would foreclose a proposal search never actually ruled out.
 *
 *  Folded into the response the same soft way `protocol_read` folds a conflict (`facts_refused`,
 *  never a hard refusal): `initiative` is optional and omitting it records nothing, exactly like
 *  every other `writeBranchFacts` caller in this file's own family. A conflict here means the
 *  initiative already stands on a different branch — informational, not this call's business to
 *  enforce, the same reasoning `protocol_read`'s own resumed-read case already documents. */
async function recordNothingToPromote(
  initiative: string | undefined,
): Promise<{ facts_recorded?: boolean; facts?: Record<string, string>; facts_refused?: string }> {
  if (!initiative) return {};
  const written = await writeBranchFacts(initiative, { release_mode: "not_applicable" });
  return typeof written === "string"
    ? { facts_recorded: false, facts_refused: written }
    : { facts_recorded: true, facts: written };
}

interface RunRow {
  readonly id: string; readonly eval_run_id: string; readonly search_policy: unknown;
  readonly status: string; readonly created_at: string;
}

async function loadRun(p: pg.Pool, improvementRunId: string): Promise<RunRow | null> {
  const row = (await p.query<RunRow>(`
    select id::text as id, eval_run_id::text as eval_run_id, search_policy, status,
           created_at::text as created_at
      from zz.improvement_run where id = $1::uuid`, [improvementRunId])).rows[0];
  return row ?? null;
}

interface SubjectRow {
  readonly subject_version_id: string;
  readonly component_manifest: readonly ManifestComponent[];
  readonly release_owners: readonly string[];
}

async function loadSubjectContext(p: pg.Pool, evalRunId: string): Promise<SubjectRow | null> {
  const row = (await p.query<{
    subject_version_id: string; component_manifest: ManifestComponent[] | null;
    release_owners: string[] | null;
  }>(`
    select er.subject_version_id::text as subject_version_id,
           sv.component_manifest as component_manifest, pl.release_owners as release_owners
      from zz.eval_run er
      join zz.eval_subject_version sv on sv.id = er.subject_version_id
      join zz.plugin pl on pl.id = sv.plugin_id
     where er.id = $1::uuid`, [evalRunId])).rows[0];
  if (!row) return null;
  return {
    subject_version_id: row.subject_version_id,
    component_manifest: row.component_manifest ?? [], release_owners: row.release_owners ?? [],
  };
}

async function fullView(
  runner: Runner, improvementRunId: string, createdAt: Date,
  policy: SearchPolicy, manifest: readonly ManifestComponent[],
): Promise<ViewCore> {
  const candidates = await loadCandidates(runner, improvementRunId);
  const caseSetId = await caseSetIdFor(runner, improvementRunId);
  const caseIds = caseSetId ? await loadValidationCaseIds(runner, caseSetId) : [];
  const evaluations = await loadValidationEvaluations(runner, candidates.map((c) => c.id));
  const alreadySelectedId = candidates.find((c) => c.status === "selected")?.id ?? null;
  return computeViewCore(candidates, evaluations, caseIds, policy, manifest, createdAt, alreadySelectedId);
}

/** The tool's own orchestrator (called from `candidates.ts`'s `candidate_search` registration,
 *  the same split `candidate-validate.ts`'s `validateCandidate` keeps from its own tool wrapper).
 */
export async function runCandidateSearch(
  p: pg.Pool, improvementRunId: string, idempotencyKey: string, principal: string,
  initiative?: string,
): Promise<CandidateSearchResult | { error: string }> {
  const run = await loadRun(p, improvementRunId);
  if (!run) return { error: `ERROR: no improvement_run ${improvementRunId}` };

  const subject = await loadSubjectContext(p, run.eval_run_id);
  if (!subject) {
    return { error: `ERROR: improvement_run ${improvementRunId}'s own eval_run names no subject_version_id` };
  }
  const policy = parseSearchPolicy(run.search_policy, improvementRunId);
  if ("error" in policy) return policy;
  const createdAt = new Date(run.created_at);

  // Already at a terminal state: read-only, no ledger row, no re-mutation — a run that has
  // already selected/closed/released stays reportable forever, exactly the way a completed
  // eval_run's own score stays readable after evaluation_score has run.
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    const core = await fullView(p, improvementRunId, createdAt, policy, subject.component_manifest);
    const bundle = await loadProposerBundle(p, improvementRunId);
    if (!bundle) throw new Refusal("ERROR: improvement_run resolves to no proposer bundle it can read back");
    const facts = run.status === "closed" && core.selected_id === null && subject.release_owners.length > 0
      ? await recordNothingToPromote(initiative) : {};
    return {
      generation: core.generation, frontier_ids: core.frontier_ids, rejected: core.rejected,
      selected_id: core.selected_id, status: run.status, explore_components: core.explore_components,
      edit_budget: core.edit_budget, proposer_bundle: bundle,
      next: nextGuidance(core, run.status, policy), ...facts,
    };
  }

  // A candidate whose validating process died mid-call, or whose build lease ran out with nothing
  // recorded, would keep its generation unsettled
  // forever; its lease is released first (candidate-validate.ts).
  await releaseStaleValidating(p, { improvementRunId });

  const outcome: IdempotencyOutcome<{ status: string }> = await withIdempotency(
    principal, "candidate_search", idempotencyKey, { improvement_run_id: improvementRunId },
    async (client): Promise<MutatorOutcome<{ status: string }>> => {
      // The same run lock `recordGenerationFor` takes, first: a composed child and a concurrent
      // candidate_record cannot both take a generation's last slot.
      await client.query("select 1 from zz.improvement_run where id = $1::uuid for update", [improvementRunId]);
      const candidates = await loadCandidates(client, improvementRunId);
      const caseSetId = await caseSetIdFor(client, improvementRunId);
      const caseIds = caseSetId ? await loadValidationCaseIds(client, caseSetId) : [];
      let evaluations = await loadValidationEvaluations(client, candidates.map((c) => c.id));

      // 1. Compose at most one new child from two disjoint, already-valid candidates (FR-39),
      // into the generation a recorded candidate would join — only where `candidate_record`
      // itself could record one (`generationCapRefusal`), so a composed child never fills a
      // full generation or opens one past maxGenerations. Skipped there, never refused.
      const pair = findComposablePair(candidates);
      const gen = generationOf(candidates, evaluations);
      if (pair && generationCapRefusal(gen, policy) === null) {
        const composed = await composeCandidate(
          client, improvementRunId, subject.subject_version_id, subject.component_manifest,
          subject.release_owners, pair[0], pair[1], principal, gen.next);
        candidates.push(composed);
        evaluations = await loadValidationEvaluations(client, candidates.map((c) => c.id));
      }

      // 2. Reduce to generation / frontier / selection.
      const core = computeViewCore(
        candidates, evaluations, caseIds, policy, subject.component_manifest, createdAt, null);

      // 3. Data mapping (this task's own contract): selected candidate -> status = selected,
      // improvement_run.status = selected; no guardrail-passing candidate at the bound ->
      // selected_id = null, run closed with not_established; otherwise still searching.
      const newStatus = core.selected_id ? "selected" : core.stopped ? "closed" : "searching";
      if (core.selected_id) {
        await client.query("update zz.candidate set status = 'selected' where id = $1::uuid", [core.selected_id]);
      }
      await client.query("update zz.improvement_run set status = $2 where id = $1::uuid", [improvementRunId, newStatus]);

      return { result: { status: newStatus }, result_table: "zz.improvement_run", result_id: improvementRunId };
    },
  );

  // Read back the settled state — whether this call just committed it (outcome.replayed: false)
  // or an earlier call with the same idempotency_key already did (true): both read the exact same
  // committed rows, so both compute the exact same view. Never a second, divergent code path.
  const finalStatus = outcome.replayed
    ? (await loadRun(p, improvementRunId))?.status ?? run.status
    : outcome.result.status;
  const core = await fullView(p, improvementRunId, createdAt, policy, subject.component_manifest);
  const bundle = await loadProposerBundle(p, improvementRunId);
  if (!bundle) throw new Refusal("ERROR: improvement_run resolves to no proposer bundle it can read back");
  const facts = finalStatus === "closed" && core.selected_id === null && subject.release_owners.length > 0
    ? await recordNothingToPromote(initiative) : {};

  return {
    generation: core.generation, frontier_ids: core.frontier_ids, rejected: core.rejected,
    selected_id: core.selected_id, status: finalStatus, explore_components: core.explore_components,
    edit_budget: core.edit_budget, proposer_bundle: bundle,
    next: nextGuidance(core, finalStatus, policy), ...facts,
  };
}


/** The generation `candidate_record` records a new candidate into — the run's own
 *  search_policy (never a fallback) and `search-rules.ts`'s generation rule, read over the same
 *  rows `candidate_search` reduces. Throws the refusal: it runs inside `candidate_record`'s
 *  ledger transaction (`client`), so the cap is checked against committed rows under the same
 *  commit that adds one. */
export async function recordGenerationFor(
  client: pg.PoolClient, improvementRunId: string, searchPolicy: unknown,
): Promise<number> {
  const policy = parseSearchPolicy(searchPolicy, improvementRunId);
  if ("error" in policy) throw new Refusal(policy.error);
  // Serialises concurrent records into one run, so two cannot both take a generation's last slot.
  await client.query("select 1 from zz.improvement_run where id = $1::uuid for update", [improvementRunId]);
  const candidates = await loadCandidates(client, improvementRunId);
  const state = generationOf(candidates, await loadValidationEvaluations(client, candidates.map((c) => c.id)));
  const refusal = generationCapRefusal(state, policy);
  if (refusal) throw new Refusal(refusal);
  return state.next;
}
