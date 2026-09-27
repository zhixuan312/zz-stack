/**
 * EVALUATE's first two acts, and the evidence every act reads through: `evaluation_start` binds
 * one protocol version to one observation snapshot as a single run, and `evaluation_assess` runs
 * every measure the protocol's dimensions name against what the run is bound to.
 *
 * `evaluation_start` opens exactly one `zz.eval_run`, carrying the team and the initiative it was
 * opened in and the principal who opened it. There is no second evidence table: the run names the
 * observation snapshot it was bound to, and the subject release is that snapshot's own
 * `plugin_version_id` (FR-27, FR-29).
 *
 * `evaluation_assess` writes the rows `planAssessment` (evaluate-measures.ts) routes:
 * `deterministic`/`outcome` read a named fact off the run's own bound observation snapshot, by a
 * dotted `definition.factPath`, ONCE per run under the run-level ref; `bounded_semantic`/
 * `generative_critic` ask the measure's bound evaluator only about refs of the kind the measure
 * judges, and only when that evaluator is qualified — otherwise one run-level row records the
 * exclusion by name and no model is called; `human` is recorded as excluded (no ingestion
 * pipeline yet). Each row names its subject by the TYPED contract `zz.eval_assessment` carries
 * (FR-30): `subject_kind` plus the one child key that kind requires, and never a free-text ref.
 *
 * The loaders and the stored-row projection below are shared with `evaluate.ts`'s own
 * `evaluation_score`, which reduces the rows this file writes and reads the same run back —
 * `loadRunContext`, `loadDimensions`, `loadSnapshotFacts`, `latestQualification` and
 * `STORED_ANSWERS_SQL`. They are exported for it rather than duplicated: one run read two ways
 * is the bug this file exists not to have.
 */
import type pg from "pg";

import {
  answerMeasure, excludedAnswer, isRunLevelRef, planAssessment, recordMeasureAnswer, runLevelRef,
  type AnsweredMeasure, type DimensionRow, type MeasureAnswer, type MeasureRow, type SnapshotFacts,
  type SubjectKind,
} from "./evaluate-measures.js";
import { decideBeforeWork, withIdempotency, type IdempotencyOutcome, type MutatorOutcome } from "./idempotency.js";
import { resolveProtocol, unaffirmedRefusal } from "./qualify.js";
import { resolveSubjectRef } from "./subject-ref.js";
import { teamFor } from "../platform-db.js";
import { Refusal } from "../refusal.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function pluginNameOf(p: pg.Pool, pluginVersionId: string): Promise<string | null> {
  if (!UUID_RE.test(pluginVersionId)) return null;
  const row = (await p.query<{ plugin: string; declared_version: string }>(`
    select pl.name as plugin, pv.version as declared_version
      from zz.plugin_version pv join zz.plugin pl on pl.id = pv.plugin_id
     where pv.id = $1::uuid`, [pluginVersionId])).rows[0];
  return row ? `${row.plugin}@${row.declared_version}` : null;
}

/** One run, as every act here reads it back. The subject release is reached through the
 *  observation snapshot the run is bound to (its own `plugin_version_id`) — the run carries no
 *  second copy of it. `scored_at` is the terminal marker; `score_status` is what was
 *  established. */
export interface RunContext {
  readonly id: string; readonly protocol_version_id: string; readonly observation_snapshot_id: string;
  readonly plugin_version_id: string; readonly score_status: string | null; readonly scored_at: string | null;
  readonly protocol_version: number;
}

export async function loadRunContext(p: pg.Pool, evalRunId: string): Promise<RunContext | null> {
  if (!UUID_RE.test(evalRunId)) return null;
  const row = (await p.query<RunContext>(`
    select er.id::text as id, er.protocol_version_id::text as protocol_version_id,
           er.observation_snapshot_id::text as observation_snapshot_id,
           os.plugin_version_id::text as plugin_version_id,
           er.score_status, er.scored_at::text as scored_at,
           pv.version as protocol_version
      from zz.eval_run er
      join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
      join zz.eval_protocol_version pv on pv.id = er.protocol_version_id
     where er.id = $1::uuid`, [evalRunId])).rows[0];
  return row ?? null;
}

export async function loadDimensions(p: pg.Pool, protocolVersionId: string): Promise<DimensionRow[]> {
  const dims = (await p.query<Omit<DimensionRow, "measures">>(`
    select id::text as id, key, canonical_kind, weight::float8 as weight, required, applicable,
           not_applicable_reason
      from zz.eval_dimension where protocol_version_id = $1::uuid order by key`, [protocolVersionId])).rows;
  if (!dims.length) return [];
  const measures = (await p.query<MeasureRow & { dimension_id: string }>(`
    select m.id::text as id, m.dimension_id::text as dimension_id, m.key, m.evaluator_type,
           m.weight::float8 as weight, m.required, m.definition,
           m.evaluator_version_id::text as evaluator_version_id, m.subject_kind,
           m.guardrail_threshold::float8 as guardrail_threshold, ev.question
      from zz.eval_measure m
      left join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
     where m.dimension_id = any($1::uuid[]) order by m.key`,
    [dims.map((d) => d.id)])).rows;
  return dims.map((d) => ({ ...d, measures: measures.filter((m) => m.dimension_id === d.id) }));
}

export async function loadSnapshotFacts(p: pg.Pool, observationSnapshotId: string): Promise<SnapshotFacts> {
  // The snapshot's `coverage` jsonb is gone; the surface it held is three columns of its own, so
  // the one shape still named here is rebuilt from them rather than answered as null.
  const row = (await p.query<SnapshotFacts>(`
    select usable_run_count, total_run_count, facts,
           jsonb_build_object('surface', jsonb_build_object(
             'observed', surface_observed, 'total', surface_total)) as coverage
      from zz.eval_observation_snapshot where id = $1::uuid`, [observationSnapshotId])).rows[0];
  return row ?? { usable_run_count: 0, total_run_count: 0, coverage: null, facts: null };
}

/** The newest qualification of the evaluator bound to a measure of THIS protocol version. A
 *  qualification is about a MEASURE now: `zz.eval_evaluator_qualification` carries no
 *  `evaluator_version_id` and no `protocol_version_id` of its own, so both are reached through
 *  the measure row it names. */
export async function latestQualification(
  p: pg.Pool, evaluatorVersionId: string, protocolVersionId: string,
): Promise<{ id: string; state: string } | null> {
  const row = (await p.query<{ id: string; state: string }>(`
    select q.id::text as id, q.state
      from zz.eval_evaluator_qualification q
      join zz.eval_measure m on m.id = q.measure_id
     where m.evaluator_version_id = $1::uuid and m.protocol_version_id = $2::uuid
     order by q.qualified_at desc limit 1`, [evaluatorVersionId, protocolVersionId])).rows[0];
  return row ?? null;
}

// -------------------------------------------------------------------------------------------
// The typed subject (FR-30). One `zz.eval_assessment` row names its subject by `subject_kind`
// and the ONE child key that kind requires; the table's own kind-shape CHECK refuses any other
// combination, so a writer that guessed a column would be refused by the database rather than
// recorded. `run_level` names no child at all: it is about the parent run's own observation
// snapshot, which the run already carries.

interface SubjectColumns {
  readonly subject_kind: "run_level" | SubjectKind;
  readonly run_id: string | null;
  readonly doc_id: string | null;
  /** AC-6.7's pin, and the only one of these that is not a foreign key. A `document` subject
   *  records the EXACT revision it judged alongside the document identity, so the row stays
   *  joined to those bytes after a later revision — `zz.eval_assessment`'s composite key is
   *  `(doc_id, doc_revision)`, and the table's own check refuses a document subject without one.
   *  Every other kind leaves it absent: a run, a bug, a call and a knowledge node are judged as
   *  they stand, and there is no revision of them to pin. */
  readonly doc_revision?: number | null;
  readonly knowledge_node_id: string | null;
  readonly bug_id: string | null;
  readonly event_id: string | null;
}

const NO_CHILD = { run_id: null, doc_id: null, knowledge_node_id: null, bug_id: null, event_id: null };

/** The typed columns one non-run-level ref names. Resolved by the SAME rules the phase-3
 *  migration applied to the rows it carried forward: a document by `initiative || '/' || path`
 *  in the caller's own team's index, a knowledge node by its path under `_knowledge/`, a run by
 *  its `skill_run` row, a bug and a call by the id the ref spells. A ref that resolves to no row
 *  is refused BY NAME rather than written with a null in the column its kind requires — a subject
 *  with nothing behind it is a claim the table's own check would reject anyway, and refusing here
 *  says which ref and why. */
async function subjectColumnsOf(
  p: pg.Pool, team: string | null, ref: string, kind: SubjectKind,
): Promise<SubjectColumns | { readonly error: string }> {
  if (kind === "run") {
    const row = (await p.query<{ id: string }>(
      "select id::text as id from zz.skill_run where id = $1::uuid", [ref])).rows[0];
    if (!row) return { error: `ERROR: subject_ref "${ref}" names no run — nothing was run under it` };
    return { subject_kind: "run", ...NO_CHILD, run_id: row.id };
  }
  if (kind === "bug") {
    const id = ref.slice("bug:".length);
    const row = UUID_RE.test(id)
      ? (await p.query<{ id: string }>("select id::text as id from zz.bug where id = $1::uuid", [id])).rows[0]
      : undefined;
    if (!row) return { error: `ERROR: subject_ref "${ref}" names no bug report — nothing to judge` };
    return { subject_kind: "bug", ...NO_CHILD, bug_id: row.id };
  }
  if (kind === "event") {
    const id = ref.slice("event:".length);
    const row = (await p.query<{ id: string }>(
      "select id::text as id from zz.event where id = $1::bigint", [id])).rows[0];
    if (!row) return { error: `ERROR: subject_ref "${ref}" names no tool call — nothing to judge` };
    return { subject_kind: "event", ...NO_CHILD, event_id: id };
  }
  if (!team) {
    return {
      error: `ERROR: subject_ref "${ref}" names a ${kind} subject and this caller resolves to no ` +
        "team — such a subject can only be resolved in the caller's own team's index",
    };
  }
  if (kind === "document") {
    // The ref is `<initiative>/<path>`, and the two are compared as the two columns they are:
    // an initiative slug carries no separator, so the first `/` is the split.
    const cut = ref.indexOf("/");
    if (cut < 0) return { error: `ERROR: subject_ref "${ref}" names no document — a document ref is <initiative>/<path>` };
    const row = (await p.query<{ id: string; current_revision: number | null }>(`
      select d.id::text as id, d.current_revision
        from zz.doc d
        join zz.initiative i on i.id = d.initiative_id
        join zz.team t on t.id = i.team_id
       where t.slug = $1 and i.slug = $2 and d.path = $3`,
      [team, ref.slice(0, cut), ref.slice(cut + 1)])).rows[0];
    if (!row) return { error: `ERROR: subject_ref "${ref}" names no document in team "${team}"'s index — nothing to record` };
    // AC-6.7: the pin is exact or the row is refused. A null here reads back as "no revision
    // known", and the truth would be "this run did not record one" — the two are different
    // facts, and only the first is what a reader without the row would assume. The check on
    // `zz.eval_assessment` refuses it anyway; refusing here says which ref and why.
    if (row.current_revision === null) {
      return {
        error: `ERROR: subject_ref "${ref}" names a document whose exact revision the platform ` +
          "cannot resolve — the row carries no current revision, so this assessment would pin " +
          "nothing and read back as a revision nobody recorded. Nothing was recorded.",
      };
    }
    return { subject_kind: "document", ...NO_CHILD, doc_id: row.id, doc_revision: row.current_revision };
  }
  // A knowledge node is addressed by the two halves its file's name carries: `node_ordinal` and
  // `slug`, which is what the reshape left where one address column used to be. The ref arrives
  // as `_knowledge/nodes/<ordinal>-<slug>.md`, so both are read out of it and compared to their
  // own columns; a ref of any other shape names no node.
  const named = /^_knowledge\/nodes\/([0-9]+)-(.+)\.md$/.exec(ref);
  const row = named
    ? (await p.query<{ id: string }>(`
        select k.id::text as id
          from zz.knowledge_node k
          join zz.team t on t.id = k.team_id
         where t.slug = $1 and k.node_ordinal = $2 and k.slug = $3`,
      [team, named[1], named[2]])).rows[0]
    : undefined;
  if (!row) return { error: `ERROR: subject_ref "${ref}" names no knowledge node in team "${team}"'s index — nothing to record` };
  return { subject_kind: "knowledge", ...NO_CHILD, knowledge_node_id: row.id };
}

/** The ref label a stored row is read back under — the same spelling `evaluate-measures.ts`'s own
 *  `runLevelRef` produces for the run-level rows, so `isRunLevelRef` keeps recognising them.
 *
 *  A knowledge node's address is reassembled from the two columns the file's name splits into;
 *  `zz.knowledge_node` has held no single address column since the reshape. */
const SUBJECT_REF_SQL = `
  case a.subject_kind
    when 'run_level' then 'observation_snapshot:' || er.observation_snapshot_id::text
    when 'run' then a.run_id::text
    when 'bug' then 'bug:' || a.bug_id::text
    when 'event' then 'event:' || a.event_id::text
    when 'knowledge' then '_knowledge/nodes/' || k.node_ordinal || '-' || k.slug || '.md'
    when 'document' then i.slug || '/' || d.path
  end`;

/** The stored rows of one run, in the shape `readingsOf`/`reduceMeasureAnswers` read: the ref
 *  label above, and the four figures the row now holds as columns, rebuilt into the answer bag
 *  those functions already take. `excluded` is `value is null` — the table's own
 *  `(value is null) = (excluded_reason is not null)` invariant is what makes that equivalent. */
export const STORED_ANSWERS_SQL = `
  select a.measure_id::text as measure_id, ${SUBJECT_REF_SQL} as subject_ref,
         jsonb_build_object(
           'value', a.value, 'excluded', a.value is null,
           'excluded_reason', a.excluded_reason, 'assessment_id', a.assessment_id,
           'detail', jsonb_build_object('raw_value', a.raw_value)) as answer
    from zz.eval_assessment a
    join zz.eval_run er on er.id = a.eval_run_id
    left join zz.doc d on d.id = a.doc_id
    left join zz.initiative i on i.id = d.initiative_id
    left join zz.knowledge_node k on k.id = a.knowledge_node_id`;

/** A jsonb column takes the JSON text or nothing — never the string "undefined" and never a
 *  quoted null, which would read back as a value where there is none. */
const jsonbOf = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/** An integer column takes an integer or nothing: a figure that is not a whole number is not one
 *  this column can hold, and a fractional one reaching it would fail the insert at runtime. */
const intOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/** `evaluation_start`, as a function of the pool and the caller rather than of an HTTP request:
 *  the handler in `evaluate.ts` is its only production caller, and it is exported so a check can
 *  drive the same code against a throwaway database, where the request headers a handler reads do
 *  not exist. */
export async function startEvaluation(
  p: pg.Pool, principal: string,
  args: {
    subject_version_id: string; protocol_version_id: string; observation_snapshot_id: string;
    idempotency_key: string; initiative?: string;
  },
): Promise<{ eval_run_id: string; observation_snapshot_id: string; replayed: boolean }
  | { readonly error: string }> {
  const { subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key, initiative } = args;
  if (!UUID_RE.test(subject_version_id)) return { error: "ERROR: unknown subject_version_id" };

  const snapshot = (await p.query<{ id: string; plugin_version_id: string }>(`
    select id::text as id, plugin_version_id::text as plugin_version_id from zz.eval_observation_snapshot where id = $1::uuid`,
    [observation_snapshot_id])).rows[0];
  if (!snapshot) return { error: "ERROR: unknown observation_snapshot_id — call plugin_profile first" };
  // The run's subject release IS the snapshot's observed release (FR-29): a call naming a
  // different one would open a run whose two halves disagree about what is being evaluated.
  if (snapshot.plugin_version_id !== subject_version_id) {
    const [given, actual] = await Promise.all([
      pluginNameOf(p, subject_version_id), pluginNameOf(p, snapshot.plugin_version_id)]);
    return {
      error: `ERROR: observation snapshot belongs to subject ${actual ?? snapshot.plugin_version_id}, ` +
        `not ${given ?? subject_version_id}`,
    };
  }
  const protocol = await resolveProtocol(p, protocol_version_id);
  if (!protocol) return { error: "ERROR: unknown protocol_version_id" };
  const unaffirmed = unaffirmedRefusal(protocol_version_id, protocol);
  if (unaffirmed) return { error: unaffirmed };

  // A run carries its team and its starter, neither nullable, so a caller either resolves both or
  // is refused by name. This resolves BEFORE the ledger transaction, so a refusal anchors nothing.
  const team = await teamFor(principal);
  if (!team) {
    return {
      error: `ERROR: "${principal}" resolves to no team, and a run is opened in one — a run with no ` +
        "team is an evaluation of nothing anybody can read back",
    };
  }
  const opener = (await p.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(email) = $1", [principal])).rows[0];
  if (!opener) return { error: `ERROR: "${principal}" resolves to no principal, so the run would name no starter` };

  let initiativeId: string | null = null;
  if (initiative) {
    const row = (await p.query<{ id: string }>(`
      select i.id::text as id from zz.initiative i join zz.team t on t.id = i.team_id
       where t.slug = $1 and i.slug = $2`, [team, initiative])).rows[0];
    if (!row) return { error: `ERROR: no initiative "${initiative}" in team "${team}" — nothing to open a run in` };
    initiativeId = row.id;
  }

  const outcome: IdempotencyOutcome<{ eval_run_id: string; observation_snapshot_id: string; replayed: boolean }> =
    await withIdempotency(
      principal, "evaluation_start", idempotency_key,
      { subject_version_id, protocol_version_id, observation_snapshot_id },
      async (client): Promise<MutatorOutcome<{ eval_run_id: string; observation_snapshot_id: string; replayed: boolean }>> => {
        const ins = await client.query<{ id: string }>(`
          insert into zz.eval_run
            (team_id, initiative_id, protocol_version_id, observation_snapshot_id, started_by, created_at)
          values ((select id from zz.team where slug = $1), $2::uuid, $3::uuid, $4::uuid, $5::uuid, now())
          returning id::text as id`,
          [team, initiativeId, protocol_version_id, observation_snapshot_id, opener.id]);
        const evalRunId = ins.rows[0]?.id;
        if (!evalRunId) throw new Error("insert into zz.eval_run produced no row");
        return {
          result: { eval_run_id: evalRunId, observation_snapshot_id, replayed: false },
          result_table: "zz.eval_run", result_id: evalRunId,
        };
      },
    );

  if (outcome.replayed) {
    const row = (await p.query<{ id: string; observation_snapshot_id: string }>(`
      select id::text as id, observation_snapshot_id::text as observation_snapshot_id
        from zz.eval_run where id = $1::uuid`, [outcome.result_id])).rows[0];
    if (!row) throw new Refusal("ERROR: idempotency ledger points at an eval_run this call cannot read back");
    return { eval_run_id: row.id, observation_snapshot_id: row.observation_snapshot_id, replayed: true };
  }
  return outcome.result;
}

/** `evaluation_assess`, as a function of the pool and the caller rather than of an HTTP request —
 *  the same reason `startEvaluation` above is exported. */
export async function assessEvaluation(
  p: pg.Pool, principal: string,
  args: { eval_run_id: string; subject_refs: string[]; idempotency_key: string },
): Promise<{
  assessment_count: number; measures_assessed: number; model_calls: number;
  excluded: { measure: string; subject_ref: string; reason: string | null }[]; replayed: boolean;
} | { readonly error: string }> {
  const { eval_run_id, subject_refs, idempotency_key } = args;
  const run = await loadRunContext(p, eval_run_id);
  if (!run) return { error: "ERROR: unknown eval_run_id" };
  // `scored_at` is the terminal marker: a scored run's assessments are the evidence behind a
  // published result, so no later call may add to them. A re-assessment is a new eval_run.
  if (run.scored_at !== null) {
    return {
      error: `ERROR: eval_run ${eval_run_id} is already scored — its result is published and its ` +
        "evidence is closed. Assessing it again would add evidence to a result nobody would " +
        "re-read; a re-assessment is a new eval_run — call evaluation_start",
    };
  }

  const dims = await loadDimensions(p, run.protocol_version_id);
  // A dimension the protocol marks not applicable has nothing to assess: its measures are
  // named for a reader, and reporting each as excluded read as missing evidence.
  const measures = dims.filter((d) => d.applicable).flatMap((d) => d.measures);
  const snapshot = await loadSnapshotFacts(p, run.observation_snapshot_id);

  // Resolved BEFORE withIdempotency, the same order the door already established: a subject_ref
  // that resolves to nothing refuses the whole call and writes no ledger row, rather than being
  // discovered mid-transaction after some measures already ran against a real ref.
  const team = await teamFor(principal);
  const resolvedRefs = new Map<string, { text: string; columns: SubjectColumns }>();
  for (const subjectRef of subject_refs) {
    const resolved = await resolveSubjectRef(p, team, subjectRef);
    if ("error" in resolved) return { error: resolved.error };
    const columns = await subjectColumnsOf(p, team, subjectRef, resolved.kind);
    if ("error" in columns) return { error: columns.error };
    resolvedRefs.set(subjectRef, { text: resolved.text, columns });
  }

  // Every model is asked BEFORE the transaction opens (evaluate-measures.ts's module note): an
  // evaluator call can take ~100s, and a transaction held across it pins a pool connection. A
  // replay is recognised first, so a retried call never re-asks a model.
  const ledgerArgs = { eval_run_id, subject_refs };
  const prior = await decideBeforeWork(principal, "evaluation_assess", idempotency_key, ledgerArgs);
  const answered: { subjectRef: string; measure: MeasureRow; answer: AnsweredMeasure }[] = [];
  if (!prior.replayed) {
    const runLevel = runLevelRef(run.observation_snapshot_id);
    const qualification = new Map<string, { id: string; state: string } | null>();
    for (const m of measures) {
      if (m.evaluator_version_id && !qualification.has(m.evaluator_version_id)) {
        qualification.set(m.evaluator_version_id, await latestQualification(p, m.evaluator_version_id, run.protocol_version_id));
      }
    }
    const alreadyAssessed = new Set((await p.query<{ measure_id: string }>(
      `select distinct measure_id::text as measure_id from zz.eval_assessment
        where eval_run_id = $1::uuid`, [eval_run_id])).rows.map((r) => r.measure_id));
    const plan = planAssessment({
      measures, subjectRefs: subject_refs, runLevel, alreadyAssessed,
      textOf: (ref) => resolvedRefs.get(ref)?.text,
      qualified: (m) => {
        const q = m.evaluator_version_id ? qualification.get(m.evaluator_version_id) : null;
        return !!q && q.state !== "unqualified";
      },
    });
    for (const item of plan) {
      const q = item.measure.evaluator_version_id ? qualification.get(item.measure.evaluator_version_id) ?? null : null;
      const answer: AnsweredMeasure = item.ask
        ? await answerMeasure({
            measure: item.measure, snapshot, subjectRef: item.subjectRef, principal,
            subjectText: resolvedRefs.get(item.subjectRef)?.text,
            qualificationOf: async () => q,
          })
        : { ...excludedAnswer(item.excluded_reason ?? "excluded"), evaluator_version_id: item.measure.evaluator_version_id,
            qualification_id: q?.id ?? null, qualification_state: q?.state ?? null, pending: null };
      answered.push({ subjectRef: item.subjectRef, measure: item.measure, answer });
    }
  }

  type Assessed = {
    assessment_count: number; measures_assessed: number; model_calls: number;
    excluded: { measure: string; subject_ref: string; reason: string | null }[]; replayed: boolean;
  };
  const outcome: IdempotencyOutcome<Assessed> = prior.replayed
    ? prior
    : await withIdempotency(
      principal, "evaluation_assess", idempotency_key, ledgerArgs,
      async (client): Promise<MutatorOutcome<Assessed>> => {
        for (const { subjectRef, measure, answer: pending } of answered) {
          const answer: MeasureAnswer = await recordMeasureAnswer(client, pending);
          const columns: SubjectColumns = isRunLevelRef(subjectRef)
            ? { subject_kind: "run_level", ...NO_CHILD }
            : resolvedRefs.get(subjectRef)!.columns;
          // The table's own invariant, enforced here too: a value and the reason it is absent are
          // exclusive, and an excluded row carries a reason rather than a silent null.
          const value = answer.excluded ? null : answer.value;
          const excludedReason = value === null ? (answer.excluded_reason ?? "excluded") : null;
          await client.query(`
            insert into zz.eval_assessment
              (eval_run_id, measure_id, assessment_id, qualification_id, subject_kind,
               run_id, doc_id, doc_revision, knowledge_node_id, bug_id, event_id,
               value, raw_value, numerator, denominator, excluded_reason, created_at)
            values ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::uuid, $7::uuid, $8::int, $9::uuid,
                    $10::uuid, $11::bigint, $12, $13::jsonb, $14, $15, $16, now())`,
            [eval_run_id, measure.id, answer.assessment_id, answer.qualification_id, columns.subject_kind,
             columns.run_id, columns.doc_id, columns.doc_revision ?? null, columns.knowledge_node_id,
             columns.bug_id, columns.event_id,
             value, jsonbOf(answer.detail.raw_value), intOf(answer.detail.numerator), intOf(answer.detail.denominator),
             excludedReason]);
        }
        return {
          result: {
            assessment_count: answered.length, measures_assessed: measures.length,
            model_calls: answered.filter((a) => a.answer.pending !== null).length,
            excluded: answered.filter((a) => a.answer.excluded)
              .map((a) => ({ measure: a.measure.key, subject_ref: a.subjectRef, reason: a.answer.excluded_reason })),
            replayed: false,
          },
          result_table: "zz.eval_run", result_id: eval_run_id,
        };
      },
    );

  // A replay answers from the rows this run holds — the same fields, read back, never re-asked.
  if (outcome.replayed) {
    const stored = (await p.query<{ key: string; subject_ref: string; answer: MeasureAnswer }>(`
      select m.key, ${SUBJECT_REF_SQL} as subject_ref, jsonb_build_object(
               'value', a.value, 'excluded', a.value is null,
               'excluded_reason', a.excluded_reason, 'assessment_id', a.assessment_id,
               'detail', jsonb_build_object('raw_value', a.raw_value)) as answer
        from zz.eval_assessment a
        join zz.eval_measure m on m.id = a.measure_id
        join zz.eval_run er on er.id = a.eval_run_id
        left join zz.doc d on d.id = a.doc_id
        left join zz.initiative i on i.id = d.initiative_id
        left join zz.knowledge_node k on k.id = a.knowledge_node_id
       where a.eval_run_id = $1::uuid`, [eval_run_id])).rows;
    return {
      assessment_count: stored.length, measures_assessed: measures.length,
      model_calls: stored.filter((r) => r.answer.assessment_id !== null).length,
      excluded: stored.filter((r) => r.answer.excluded)
        .map((r) => ({ measure: r.key, subject_ref: r.subject_ref, reason: r.answer.excluded_reason })),
      replayed: true,
    };
  }
  return outcome.result;
}
