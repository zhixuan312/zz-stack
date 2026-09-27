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
import { EVAL_STATE_ENUMS } from "@zz/contracts";
import type { Express } from "express";

import { platformDb } from "../db.js";
import { teamless } from "./shared.js";

/** The attempt state a rollback leaves behind — taken from the shared vocabulary every writer
 *  takes its state values from (`EVAL_STATE_ENUMS`), sixth of six, rather than spelled: the
 *  boolean column of that name is gone, and `checks/release-relations.ts` reads this file's text
 *  for the retired COLUMN spelling. */
const ROLLBACK_STATE = EVAL_STATE_ENUMS.releaseAttemptStatus[5];

interface MeasureScoreRow {
  key: string; evaluator_type: string; weight: number; required: boolean;
  value: number | null; excluded: boolean; excluded_reason: string | null; guardrail: boolean;
}
interface DimensionScoreRow {
  key: string; canonical_kind: string; score: number | null; coverage: number | null; applicable: boolean;
  not_applicable_reason: string | null; weight: number; required: boolean;
  measures_scored: number; measures_total: number; measures: MeasureScoreRow[];
}

export function mountPluginEval(app: Express): void {
  app.get("/api/console/plugins/:plugin/eval", teamless("the plugin's evaluation", async (req, res) => {
    const { plugin } = req.params;
    const db = platformDb();

    const pluginRow = (await db.query<{
      id: string; origin: string; owner_team_id: string | null; owner_team: string | null; release_owners: string[];
    }>(`
      select p.id::text as id, p.origin, p.owner_team_id::text as owner_team_id, t.slug as owner_team,
             coalesce(owners.slugs, '{}'::text[]) as release_owners
        from zz.plugin p
        left join zz.team t on t.id = p.owner_team_id
        -- Release authority is the relation 'plugin_release_owner' (FR-23): one row per owner
        -- team, joined to the team that names it. 'plugin.evolvable' is gone with the flag.
        left join lateral (
          select array_agg(t2.slug order by t2.slug) as slugs
            from zz.plugin_release_owner r
            join zz.team t2 on t2.id = r.team_id
           where r.plugin_id = p.id) owners on true
       where p.name = $1`, [plugin])).rows[0];

    if (!pluginRow) {
      // Not a refusal: a name nothing has registered is a legitimate answer, the same "no such
      // plugin" shape the page's existing About/skills panels already read off `/plugins`.
      res.json({ plugin, found: false });
      return;
    }

    // The plugin's newest release identity (FR-1/FR-24). One plugin can carry many released
    // versions — the one shipping now, an earlier one still worth reading — and the dashboard
    // reads the plugin's CURRENT story, so the newest by `released_at`, never an average or a
    // list. A subject version IS a `plugin_version` row, which is where the version, the digest
    // and the moment it was registered all live.
    const subject = (await db.query<{
      id: string; declared_version: string; content_digest: string; captured_at: string;
    }>(`
      select pv.id::text as id, pv.version as declared_version, pv.digest as content_digest,
             to_char(pv.released_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as captured_at
        from zz.plugin_version pv
       where pv.plugin_id = $1::uuid
       order by pv.released_at desc, pv.version desc limit 1`, [pluginRow.id])).rows[0];

    const ownershipMode = pluginRow.origin === "third_party" ? "evaluation_only" : "owned";
    const base = {
      plugin, found: true, origin: pluginRow.origin, ownerTeam: pluginRow.owner_team,
      releaseOwners: pluginRow.release_owners ?? [],
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

    // The newest SCORED EVALUATE run against this subject (FR-21–FR-23) — an open run has
    // published no result, and showing it would blank a page that has a perfectly good scored run
    // behind it. The run names the observation snapshot it was bound to rather than a second
    // evidence table, so the subject release it evaluated is that snapshot's own
    // `plugin_version_id`; `scored_at is not null` is what makes a run one with a published
    // result. The per-dimension results are rows in `zz.eval_run_dimension` now, joined below.
    //
    // The protocol's key is a column of the version: `zz.eval_protocol` carried a plugin and
    // a key and no other fact, so the phase-3 migration folded both onto `eval_protocol_version`.
    const run = (await db.query<{
      id: string; score_status: string | null; overall_score: string | null;
      score_lower: string | null; score_upper: string | null; measure_coverage: string | null;
      establishment_blocked_by: string[] | null; guardrail_status: string | null; scorer_version: string | null;
      scored_at: string | null; observation_snapshot_id: string; protocol_version_id: string;
      protocol_key: string; protocol_version: number; created_at: string;
    }>(`
      select er.id::text as id, er.score_status, er.overall_score::text as overall_score,
             er.score_lower::text as score_lower, er.score_upper::text as score_upper,
             er.measure_coverage::text as measure_coverage, er.establishment_blocked_by,
             er.guardrail_status, er.scorer_version,
             to_char(er.scored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as scored_at,
             er.observation_snapshot_id::text as observation_snapshot_id,
             er.protocol_version_id::text as protocol_version_id,
             pv.protocol_key as protocol_key, pv.version as protocol_version,
             to_char(er.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
        from zz.eval_run er
        join zz.eval_protocol_version pv on pv.id = er.protocol_version_id
        join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
       where os.plugin_version_id = $1::uuid and er.scored_at is not null
       order by er.created_at desc limit 1`, [subject.id])).rows[0];

    if (!run) {
      res.json({ ...base, subjectVersion, run: null, evaluatorTrust: [],
        findings: { strengths: [], defects: [], unknowns: [] }, candidates: [] });
      return;
    }

    const [observation, dimensions, trust, findingRows, improvementRuns] = await Promise.all([
      // Usage: real production evidence this run's observation snapshot was built from (FR-9,
      // FR-10) — every rate the page shows carries this denominator. The surface is three columns
      // of the observation snapshot now (`surface_observed`/`surface_total`/`surface_source`):
      // the `coverage` jsonb it used to be stored in is gone, and so is the evidence table that
      // used to sit between a run and its snapshot.
      db.query<{
        usable_run_count: number; total_run_count: number;
        surface_observed: number | null; surface_total: number | null;
      }>(`
        select os.usable_run_count, os.total_run_count, os.surface_observed, os.surface_total
          from zz.eval_observation_snapshot os
         where os.id = $1::uuid`, [run.observation_snapshot_id]),
      // The run's published per-dimension results: one row per dimension of the protocol, with
      // the dimension's own key, weight and applicability from `zz.eval_dimension`, and each
      // measure's reduced value rebuilt from the assessments the run holds — the same reduction
      // `evaluation_score` performed (the mean of the measure's non-excluded answers).
      loadDimensions(db, run.id, run.protocol_version_id),
      // Automation & Trust: every bounded_semantic/generative_critic evaluator this protocol
      // version names, with its newest qualification state — mirrors findings-doc.ts's own
      // loadEvaluatorTrust exactly, so the dashboard and findings.md never disagree.
      //
      // The evaluator's stable key is on its own version now (`zz.eval_evaluator` was a header
      // carrying the key and a kind nothing read), and a qualification is about a MEASURE: the
      // row it reads is the one qualified for this measure.
      db.query<{ stable_key: string; state: string | null; qualified_at: string | null }>(`
        select distinct on (ev.stable_key) ev.stable_key as stable_key,
               q.state as state, to_char(q.qualified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as qualified_at
          from zz.eval_measure m
          join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
          left join zz.eval_evaluator_qualification q on q.measure_id = m.id
         where m.protocol_version_id = $1::uuid and m.evaluator_version_id is not null
         order by ev.stable_key, q.qualified_at desc nulls last`, [run.protocol_version_id]),
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
        id: run.id, scoreStatus: run.score_status,
        overallScore: run.overall_score === null ? null : Number(run.overall_score),
        scoreInterval: {
          lower: run.score_lower === null ? null : Number(run.score_lower),
          upper: run.score_upper === null ? null : Number(run.score_upper),
        },
        measureCoverage: run.measure_coverage === null ? null : Number(run.measure_coverage),
        establishmentBlockedBy: run.establishment_blocked_by ?? [],
        guardrailStatus: run.guardrail_status, scorerVersion: run.scorer_version,
        protocol: { key: run.protocol_key, version: run.protocol_version },
        createdAt: run.created_at, scoredAt: run.scored_at,
        dimensions: dimensions.map(dimensionOut),
        coverage: {
          usableRunCount: observation.rows[0]?.usable_run_count ?? null,
          totalRunCount: observation.rows[0]?.total_run_count ?? null,
          surfaceObserved: observation.rows[0]?.surface_observed ?? null,
          surfaceTotal: observation.rows[0]?.surface_total ?? null,
        },
      },
      evaluatorTrust: trust.rows.map((t) => ({ stableKey: t.stable_key, state: t.state, qualifiedAt: t.qualified_at })),
      findings, candidates,
    });
  }));
}

/** The run's published per-dimension results, rebuilt from the rows that hold them.
 *
 *  `evaluation_score` writes one `zz.eval_run_dimension` row per dimension of the protocol — the
 *  dimension's own score and coverage, and nothing else, because everything else about a
 *  dimension is a fact about the protocol version rather than about this run. So the page's
 *  richer shape is a read: the dimension's key, kind, weight and applicability from
 *  `zz.eval_dimension`, and each of its measures' reduced value from the assessments the run
 *  holds. The measure value is the same plain mean over the measure's non-excluded answers the
 *  reducer computes, so the number on the page is the number that was scored. */
async function loadDimensions(
  db: ReturnType<typeof platformDb>, evalRunId: string, protocolVersionId: string,
): Promise<DimensionScoreRow[]> {
  const dims = (await db.query<{
    id: string; key: string; canonical_kind: string; score: number | null; coverage: number | null;
    applicable: boolean; not_applicable_reason: string | null; weight: number; required: boolean;
  }>(`
    select d.id::text as id, d.key, d.canonical_kind, rd.score::float8 as score, rd.coverage::float8 as coverage,
           d.applicable, d.not_applicable_reason, d.weight::float8 as weight, d.required
      from zz.eval_run_dimension rd
      join zz.eval_dimension d on d.id = rd.dimension_id
     where rd.eval_run_id = $1::uuid order by d.key`, [evalRunId])).rows;
  if (!dims.length) return [];
  const measures = (await db.query<MeasureScoreRow & { dimension_id: string }>(`
    select m.dimension_id::text as dimension_id, m.key, m.evaluator_type, m.weight::float8 as weight,
           m.required, m.guardrail_threshold is not null as guardrail,
           (select avg(a.value)::float8 from zz.eval_assessment a
             where a.eval_run_id = $1::uuid and a.measure_id = m.id and a.value is not null) as value,
           (select min(a.excluded_reason) from zz.eval_assessment a
             where a.eval_run_id = $1::uuid and a.measure_id = m.id and a.value is null) as excluded_reason
      from zz.eval_measure m
     where m.protocol_version_id = $2::uuid order by m.key`, [evalRunId, protocolVersionId])).rows;
  return dims.map((d) => {
    const own = measures.filter((m) => m.dimension_id === d.id).map((m) => ({
      key: m.key, evaluator_type: m.evaluator_type, weight: m.weight, required: m.required,
      value: m.value, excluded: m.value === null, guardrail: m.guardrail,
      // A dimension that does not apply was never assessed; its measures carry its reason rather
      // than an absence that reads as missing evidence.
      excluded_reason: d.applicable ? m.excluded_reason
        : `not applicable: ${d.not_applicable_reason ?? "the protocol says so"}`,
    }));
    return {
      key: d.key, canonical_kind: d.canonical_kind, score: d.score, coverage: d.coverage,
      applicable: d.applicable, not_applicable_reason: d.not_applicable_reason,
      weight: d.weight, required: d.required,
      measures_scored: own.filter((m) => !m.excluded).length, measures_total: own.length,
      measures: own,
    };
  });
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
      touched_components: unknown; base_plugin_version_id: string; release_owners: string[];
      build_result: { ok?: boolean; stage?: string } | null; created_at: string;
    }>(`
      select c.id::text as id, c.hypothesis, c.status, c.complexity_delta, c.touched_components,
             c.base_plugin_version_id::text as base_plugin_version_id, c.build_result,
             -- Who may release this candidate's plugin: the plugin_release_owner relation,
             -- which is where candidate_record derived the owner list it used to record on the
             -- candidate itself (that copy is gone — see release_attempt_owner).
             coalesce(owners.slugs, '{}'::text[]) as release_owners,
             to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
        from zz.candidate c
        join zz.plugin_version pv on pv.id = c.base_plugin_version_id
        left join lateral (
          select array_agg(t.slug order by t.slug) as slugs
            from zz.plugin_release_owner r
            join zz.team t on t.id = r.team_id
           where r.plugin_id = pv.plugin_id) owners on true
       where c.improvement_run_id = any($1::uuid[]) order by c.created_at`,
      [improvementRunIds]),
    db.query<{
      candidate_id: string; status: string; reason: string | null; release_ref: string | null;
      released_declared_version: string | null; verification: unknown; verdict: string | null;
    }>(`
      select ra.candidate_id::text as candidate_id, ra.status, ra.reason, ra.release_ref,
             pv.version as released_declared_version, ra.verification, ra.verdict
        from zz.release_attempt ra
        left join zz.plugin_version pv on pv.id = ra.released_plugin_version_id
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
      touchedOwners: c.release_owners ?? [], createdAt: c.created_at,
      build: c.build_result ? { ok: c.build_result.ok === true, stage: c.build_result.stage ?? null } : null,
      release: release ? {
        status: release.status, reason: release.reason,
        releasedDeclaredVersion: release.released_declared_version, releaseRef: release.release_ref,
        // The verdict is its own column now and `verification` keeps only the evidence it rests
        // on, so the verdict's own prose reason is no longer a fact this row carries; the page
        // shows the attempt's recorded reason (a refusal's reason, the operator's rollback reason,
        // an accepted override) beside the verdict instead of inventing one.
        verdict: release.verdict, verificationReason: release.reason,
        rolledBack: release.status === ROLLBACK_STATE,
      } : null,
    };
  });
}
