/**
 * `/api/console/plugins/:plugin/eval` — the read this initiative's dashboard task (I-30, spec v8
 * FR-55) names as coming from "the dashboard's existing server-side data layer". The dashboard
 * has none: every other console page fetches `/api/console/*` straight from the browser
 * (zz-stack-dashboard's own README — "This app holds no credential and calls nothing"). This
 * route IS that data layer for the plugin-eval architecture (Tasks I-1 to I-29): it is the one
 * place spec v8's protocol/evaluation/candidate/release tables are reduced to what a page draws.
 *
 * Teamless, like the rest of `catalog.ts`: a plugin's evaluation is the same fact for every
 * reader, and ownership here is plugin-level (spec v8 decision record 12), not a console team
 * scope — `owner_team`/`release_owners` name who may RELEASE a candidate, which is a fact about
 * the platform, not about who is allowed to read the console.
 *
 * Reads `zz.plugin` by name directly rather than through `diskPlugins()` (catalog.ts): a
 * `plugin_register`ed third-party subject has no catalog directory and would read as "no such
 * plugin" through that walk. The evaluation story has to exist independently of whether the
 * plugin ships from this repository's own catalog.
 *
 * Query shapes mirror `services/zz-core/src/eval/findings-doc.ts` (`loadEvalRun`, `loadSubject`,
 * `loadProtocol`, `loadEvaluatorTrust`, `loadFindings`) — that file is the other reader of this
 * exact evidence, and drifting the two would mean the dashboard and findings.md disagree about
 * what one eval_run means. Candidate/release data has no existing reader to mirror; those
 * queries are new here.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { teamless } from "./shared.js";

interface MeasureScoreRow {
  key: string; evaluator_type: string; weight: number; required: boolean;
  value: number | null; excluded: boolean; excluded_reason: string | null; guardrail: boolean;
}
interface DimensionScoreRow {
  key: string; canonical_kind: string; score: number | null; applicable: boolean;
  not_applicable_reason: string | null; weight: number; required: boolean;
  measures_scored: number; measures_total: number; measures: MeasureScoreRow[];
}
interface GuardrailRow { key: string; threshold: number; value: number | null; status: string }

export function mountPluginEval(app: Express): void {
  app.get("/api/console/plugins/:plugin/eval", teamless("the plugin's evaluation", async (req, res) => {
    const { plugin } = req.params;
    const db = platformDb();

    const pluginRow = (await db.query<{
      id: string; origin: string; owner_team: string | null; evolvable: boolean; release_owners: string[];
    }>(`
      select id::text as id, origin, owner_team, evolvable, release_owners
        from zz.plugin where name = $1`, [plugin])).rows[0];

    if (!pluginRow) {
      // Not a refusal: a name nothing has registered is a legitimate answer, the same "no such
      // plugin" shape the page's existing About/skills panels already read off `/plugins`.
      res.json({ plugin, found: false });
      return;
    }

    // The newest immutable subject identity (FR-1). One plugin can carry many — a released
    // version, a draft one plugin_profile digested since — and the dashboard reads the plugin's
    // CURRENT story, so the newest by capture time, never an average or a list.
    const subject = (await db.query<{
      id: string; declared_version: string; content_digest: string; captured_at: string;
    }>(`
      select id::text as id, declared_version, content_digest,
             to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as captured_at
        from zz.eval_subject_version
       where plugin_id = $1::uuid
       order by captured_at desc limit 1`, [pluginRow.id])).rows[0];

    const ownershipMode = pluginRow.origin === "third_party" ? "evaluation_only" : "owned";
    const base = {
      plugin, found: true, origin: pluginRow.origin, ownerTeam: pluginRow.owner_team,
      evolvable: pluginRow.evolvable, releaseOwners: pluginRow.release_owners ?? [],
      ownershipMode,
    };

    if (!subject) {
      // Registered, never profiled: OBSERVE has not run. Nothing downstream of a subject
      // version can exist yet, so every later section is empty by construction, not by a
      // failed join.
      res.json({ ...base, subjectVersion: null, run: null, evaluatorTrust: [],
        findings: { strengths: [], defects: [], unknowns: [] }, candidates: [] });
      return;
    }
    const subjectVersion = {
      id: subject.id, declaredVersion: subject.declared_version,
      contentDigest: subject.content_digest, capturedAt: subject.captured_at,
    };

    // The newest COMPLETED EVALUATE run against this subject (FR-21–FR-23) — a pending,
    // running, failed or cancelled run has no scores to draw, and showing it would blank a page
    // that has a perfectly good completed run behind it. `dimension_scores` and
    // `guardrails` are already the rich per-measure shape `evaluation_score` computed and stored
    // (evaluate.ts) — reading them back is a select, not a re-join of eval_dimension/eval_measure.
    const run = (await db.query<{
      id: string; run_status: string; score_status: string | null; overall_score: string | null;
      score_interval: unknown; dimension_scores: DimensionScoreRow[] | null;
      guardrail_status: string | null; guardrails: GuardrailRow[] | null; coverage: unknown;
      evidence_snapshot_id: string; protocol_version_id: string; protocol_key: string; protocol_version: number;
      created_at: string;
    }>(`
      select er.id::text as id, er.run_status, er.score_status, er.overall_score::text as overall_score,
             er.score_interval, er.dimension_scores, er.guardrail_status, er.guardrails, er.coverage,
             er.evidence_snapshot_id::text as evidence_snapshot_id,
             er.protocol_version_id::text as protocol_version_id,
             pr.protocol_key as protocol_key, pv.version as protocol_version,
             to_char(er.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
        from zz.eval_run er
        join zz.eval_protocol_version pv on pv.id = er.protocol_version_id
        join zz.eval_protocol pr on pr.id = pv.protocol_id
       where er.subject_version_id = $1::uuid and er.run_status = 'completed'
       order by er.created_at desc limit 1`, [subject.id])).rows[0];

    if (!run) {
      res.json({ ...base, subjectVersion, run: null, evaluatorTrust: [],
        findings: { strengths: [], defects: [], unknowns: [] }, candidates: [] });
      return;
    }

    const [observation, trust, findingRows, improvementRuns] = await Promise.all([
      // Usage: real production evidence this run's evidence snapshot was built from (FR-9,
      // FR-10) — every rate the page shows carries this denominator.
      db.query<{
        usable_run_count: number; total_run_count: number; coverage: { surface?: { observed?: number; total?: number } } | null;
      }>(`
        select os.usable_run_count, os.total_run_count, os.coverage
          from zz.eval_evidence_snapshot es
          join zz.eval_observation_snapshot os on os.id = es.observation_snapshot_id
         where es.id = $1::uuid`, [run.evidence_snapshot_id]),
      // Automation & Trust: every bounded_semantic/generative_critic evaluator this protocol
      // version names, with its newest qualification state — mirrors findings-doc.ts's own
      // loadEvaluatorTrust exactly, so the dashboard and findings.md never disagree.
      db.query<{ stable_key: string; state: string | null; qualified_at: string | null }>(`
        select distinct on (ee.stable_key) ee.stable_key as stable_key,
               q.state as state, to_char(q.qualified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as qualified_at
          from zz.eval_measure m
          join zz.eval_dimension d on d.id = m.dimension_id
          join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
          join zz.eval_evaluator ee on ee.id = ev.evaluator_id
          left join zz.eval_evaluator_qualification q
            on q.evaluator_version_id = ev.id and q.protocol_version_id = $1::uuid
         where d.protocol_version_id = $1::uuid and m.evaluator_version_id is not null
         order by ee.stable_key, q.qualified_at desc nulls last`, [run.protocol_version_id]),
      // Learning: this run's own findings, ownership-classified (FR-12).
      db.query<{
        id: string; kind: string; pattern: string; owner_kind: string | null; owner_ref: string | null;
        evidence_refs: unknown; expected_effect: unknown; decision: string; decision_note: string | null;
      }>(`
        select id::text as id, kind, pattern, owner_kind, owner_ref, evidence_refs, expected_effect,
               decision, decision_note
          from zz.eval_finding where eval_run_id = $1::uuid order by created_at`, [run.id]),
      // Evolution starts here: every improvement search this run's findings seeded (FR-34).
      db.query<{ id: string }>(`
        select id::text as id from zz.improvement_run where eval_run_id = $1::uuid order by created_at`,
        [run.id]),
    ]);

    const findings = {
      strengths: findingRows.rows.filter((f) => f.kind === "strength").map(findingOut),
      defects: findingRows.rows.filter((f) => f.kind === "defect").map(findingOut),
      unknowns: findingRows.rows.filter((f) => f.kind === "unknown").map(findingOut),
    };

    const candidates = improvementRuns.rows.length ? await loadCandidates(db, improvementRuns.rows.map((r) => r.id)) : [];

    res.json({
      ...base, subjectVersion,
      run: {
        id: run.id, runStatus: run.run_status, scoreStatus: run.score_status,
        overallScore: run.overall_score === null ? null : Number(run.overall_score),
        scoreInterval: run.score_interval,
        guardrailStatus: run.guardrail_status, guardrails: run.guardrails ?? [],
        protocol: { key: run.protocol_key, version: run.protocol_version },
        createdAt: run.created_at,
        dimensions: (run.dimension_scores ?? []).map(dimensionOut),
        coverage: {
          usableRunCount: observation.rows[0]?.usable_run_count ?? null,
          totalRunCount: observation.rows[0]?.total_run_count ?? null,
          surfaceObserved: observation.rows[0]?.coverage?.surface?.observed ?? null,
          surfaceTotal: observation.rows[0]?.coverage?.surface?.total ?? null,
        },
      },
      evaluatorTrust: trust.rows.map((t) => ({ stableKey: t.stable_key, state: t.state, qualifiedAt: t.qualified_at })),
      findings, candidates,
    });
  }));
}

/** `eval_run.dimension_scores` is stored exactly as `evaluation_score` (evaluate.ts) wrote it —
 *  `DimensionScoreRow`/`MeasureScoreRow`, snake_case, because that jsonb shape is shared with
 *  `findings-doc.ts`'s own renderer and changing its keys would be a second, disagreeing copy
 *  of the same column. The console's own convention is camelCase everywhere else, so this is
 *  the one remap boundary between the two — read once, here, rather than the dashboard reading
 *  two casing conventions depending which route answered it. */
function dimensionOut(d: DimensionScoreRow) {
  return {
    key: d.key, canonicalKind: d.canonical_kind, score: d.score, applicable: d.applicable,
    notApplicableReason: d.not_applicable_reason, weight: d.weight, required: d.required,
    measuresScored: d.measures_scored, measuresTotal: d.measures_total,
    measures: d.measures.map((m) => ({
      key: m.key, evaluatorType: m.evaluator_type, weight: m.weight, required: m.required,
      value: m.value, excluded: m.excluded, excludedReason: m.excluded_reason, guardrail: m.guardrail,
    })),
  };
}

function findingOut(f: {
  id: string; pattern: string; owner_kind: string | null; owner_ref: string | null;
  evidence_refs: unknown; expected_effect: unknown; decision: string; decision_note: string | null;
}) {
  return {
    id: f.id, pattern: f.pattern, ownerKind: f.owner_kind, ownerRef: f.owner_ref,
    evidenceRefs: Array.isArray(f.evidence_refs) ? f.evidence_refs.length : 0,
    expectedEffect: f.expected_effect, decision: f.decision, decisionNote: f.decision_note,
  };
}

/** Evolution's own evidence: every candidate the run's improvement runs recorded, with how its
 *  local build and gate went, and where its release stands — including the verdict real use
 *  gave it after release (`release_verify`). */
async function loadCandidates(db: ReturnType<typeof platformDb>, improvementRunIds: string[]) {
  const [candidateRows, releaseRows] = await Promise.all([
    db.query<{
      id: string; hypothesis: string; status: string; complexity_delta: number;
      touched_components: unknown; touched_owners: string[]; base_subject_version_id: string;
      build_result: { ok?: boolean; stage?: string } | null; created_at: string;
    }>(`
      select id::text as id, hypothesis, status, complexity_delta, touched_components,
             touched_owners, base_subject_version_id::text as base_subject_version_id, build_result,
             to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
        from zz.candidate where improvement_run_id = any($1::uuid[]) order by created_at`,
      [improvementRunIds]),
    db.query<{
      candidate_id: string; status: string; reason: string | null; release_ref: string | null;
      released_declared_version: string | null; verification: { verdict?: string; reason?: string | null } | null;
      rolled_back: boolean;
    }>(`
      select ra.candidate_id::text as candidate_id, ra.status, ra.reason, ra.release_ref,
             sv.declared_version as released_declared_version, ra.verification, ra.rolled_back
        from zz.release_attempt ra
        left join zz.eval_subject_version sv on sv.id = ra.released_subject_version_id
       where ra.candidate_id in (select id from zz.candidate where improvement_run_id = any($1::uuid[]))
       order by ra.created_at desc`, [improvementRunIds]),
  ]);

  // Newest attempt per candidate: a rebased candidate (FR-49 stale_baseline) can carry more than
  // one, and the page shows where release stands NOW, not its whole history in this tile.
  const releaseByCandidate = new Map<string, (typeof releaseRows.rows)[number]>();
  for (const r of releaseRows.rows) if (!releaseByCandidate.has(r.candidate_id)) releaseByCandidate.set(r.candidate_id, r);

  return candidateRows.rows.map((c) => {
    const release = releaseByCandidate.get(c.id);
    return {
      id: c.id, hypothesis: c.hypothesis, status: c.status,
      complexityDelta: c.complexity_delta, touchedComponents: c.touched_components,
      touchedOwners: c.touched_owners ?? [], createdAt: c.created_at,
      build: c.build_result ? { ok: c.build_result.ok === true, stage: c.build_result.stage ?? null } : null,
      release: release ? {
        status: release.status, reason: release.reason,
        releasedDeclaredVersion: release.released_declared_version, releaseRef: release.release_ref,
        verdict: release.verification?.verdict ?? null, verificationReason: release.verification?.reason ?? null,
        rolledBack: release.rolled_back,
      } : null,
    };
  });
}
