/**
 * `findings.md` (Task I-13, AC-22.1): a measurement output, generated from what `evaluation_score`
 * stored and what `finding_record` has recorded against one `eval_run_id`, and written the SAME
 * way `document_write` writes any document into the initiative's documents — `chainFor` resolves the
 * flow, `envelopeFor` builds the frontmatter, `normalizeSections` renames a near-miss heading,
 * `documentGuards` decides whether the write may land, `saveDocument` lands it. Nothing here
 * invents a second write path: `artifacts.ts`'s `document_write` is the only place this platform
 * writes a governed document, and this file calls the same internals it does.
 *
 * `catalog/zz/zz-plugin-eval/flow.json` declares `findings.md` with `gate: false`, `requires:
 * protocol.md` and its eight sections, so a write that satisfies those guards is finished by being
 * written — exactly as `write-guards.ts`'s own `sectionCheck` treats an ungated document. The
 * manifest carried `gate: true` while this file was being built and Task I-28 changed it;
 * `documentGuards` reads whatever manifest is live, so nothing here depends on that history.
 *
 * On a freeform initiative (no flow declared) `chainFor` returns `EMPTY_CHAIN`,
 * `chain.documents` is empty, and every guard above no-ops — which is the shape the live
 * end-to-end check for this task exercises.
 */

import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";
import type pg from "pg";

import {
  guardrailsOfMeasures, reduceMeasureAnswers,
  type MeasureAnswer,
} from "./evaluate-measures.js";
import { loadDimensions, STORED_ANSWERS_SQL } from "./evaluate-run.js";
import { chainFor } from "../chain.js";
import { documentGuards } from "../guards.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safeName, safePath } from "../paths.js";
import { sealOf } from "../indexing.js";
import { loadDocument, saveDocument } from "../versions.js";
import { stampEnvelope } from "../write-guards.js";
import { teamFor } from "../platform-db.js";
import { envelopeFor, normalizeSections } from "../write-guards.js";

/** One run, as this document reads it back. Nothing here is a second copy of a fact: the subject
 *  release is reached through the observation snapshot the run is bound to (FR-27), the score is
 *  the run's own published columns, and the per-dimension results come from
 *  `zz.eval_run_dimension` — the jsonb array the run used to carry is gone. */
interface EvalRunRow {
  id: string; plugin_version_id: string; protocol_version_id: string;
  score_status: string | null; overall_score: string | null;
  score_lower: number | null; score_upper: number | null;
  measure_coverage: number | null;
  establishment_blocked_by: string[] | null;
  guardrail_status: string | null;
}

export interface MeasureScoreRow {
  key: string; evaluator_type: string; weight: number; required: boolean;
  value: number | null; excluded: boolean; excluded_reason: string | null; guardrail: boolean;
}

export interface DimensionScoreRow {
  key: string; canonical_kind: string; score: number | null; coverage: number | null; applicable: boolean;
  not_applicable_reason: string | null; weight: number; required: boolean;
  measures_scored: number; measures_total: number; measures: MeasureScoreRow[];
}

export interface FindingRow {
  id: string; kind: "strength" | "defect" | "unknown"; pattern: string;
  owner_kind: string | null; owner_ref: string | null;
  evidence_refs: unknown[];
  /** Null exactly when the kind is `strength` — a strength is terminal at insert, so it carries no
   *  decision, and the render below leaves it out rather than printing one. */
  decision: string | null; decision_note: string | null;
  /** The finding that corrected this one — a superseded finding is not rendered, its correction
   *  is, naming it. */
  superseded_by: string | null;
}

interface EvaluatorTrustRow { stable_key: string; state: string | null; qualified_at: string | null }

/** The run's own published result. The subject release is reached through the observation
 *  snapshot the run is bound to — the run carries no second copy of it — and the per-dimension
 *  results are rows of `zz.eval_run_dimension`, read separately below. */
async function loadEvalRun(p: pg.Pool, evalRunId: string): Promise<EvalRunRow | null> {
  const row = (await p.query<EvalRunRow>(`
    select er.id::text as id, os.plugin_version_id::text as plugin_version_id,
           er.protocol_version_id::text as protocol_version_id, er.score_status,
           er.overall_score::text as overall_score, er.score_lower::float8 as score_lower,
           er.score_upper::float8 as score_upper, er.measure_coverage::float8 as measure_coverage,
           er.establishment_blocked_by, er.guardrail_status
      from zz.eval_run er
      join zz.eval_observation_snapshot os on os.id = er.observation_snapshot_id
     where er.id = $1::uuid`, [evalRunId])).rows[0];
  return row ?? null;
}

/** The subject release, as `plugin_locate` reads it back: `plugin_version` joined to its plugin,
 *  with the owner team and the release-owner teams resolved through the relations that replaced
 *  the `owner_team` text column, `evolvable` and the `release_owners` jsonb. */
async function loadSubject(p: pg.Pool, pluginVersionId: string) {
  return (await p.query<{
    plugin: string; declared_version: string; origin: string; owner_team: string | null;
    release_owners: string[];
  }>(`
    select pl.name as plugin, pv.version as declared_version, pl.origin, t.slug as owner_team,
           owners.slugs as release_owners
      from zz.plugin_version pv
      join zz.plugin pl on pl.id = pv.plugin_id
      left join zz.team t on t.id = pl.owner_team_id
      left join lateral (
        select coalesce(array_agg(t2.slug order by t2.slug), '{}'::text[]) as slugs
          from zz.plugin_release_owner r
          join zz.team t2 on t2.id = r.team_id
         where r.plugin_id = pl.id) owners on true
     where pv.id = $1::uuid`, [pluginVersionId])).rows[0];
}

/** The protocol version this run was scored under. The `eval_protocol` header folded into the
 *  version row, so the key is a column of the one table and this is a single-table read. */
async function loadProtocol(p: pg.Pool, protocolVersionId: string) {
  return (await p.query<{ protocol_key: string; version: number }>(`
    select protocol_key, version from zz.eval_protocol_version where id = $1::uuid`,
    [protocolVersionId])).rows[0];
}

/** Every distinct evaluator a model-backed measure of this protocol version names, with its
 *  newest qualification state against THIS protocol version — read live off
 *  `zz.eval_evaluator_qualification`, never off `eval_run`, which stores no evaluator-trust
 *  column of its own. A qualification is a property of a MEASURE now (it is the measure row that
 *  names both the evaluator version and the protocol version), so the join is on `measure_id` and
 *  the evaluator version it is about is reached through that row. */
async function loadEvaluatorTrust(p: pg.Pool, protocolVersionId: string): Promise<EvaluatorTrustRow[]> {
  return (await p.query<EvaluatorTrustRow>(`
    select distinct on (ev.stable_key) ev.stable_key as stable_key,
           q.state as state, q.qualified_at::text as qualified_at
      from zz.eval_measure m
      join zz.eval_dimension d on d.id = m.dimension_id
      join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
      left join zz.eval_evaluator_qualification q on q.measure_id = m.id
     where d.protocol_version_id = $1::uuid and m.evaluator_version_id is not null
     order by ev.stable_key, q.qualified_at desc nulls last`, [protocolVersionId])).rows;
}

async function loadFindings(p: pg.Pool, evalRunId: string): Promise<FindingRow[]> {
  return (await p.query<FindingRow>(`
    select id::text as id, kind, pattern, owner_kind, owner_ref, evidence_refs, decision, decision_note,
           superseded_by::text as superseded_by
      from zz.eval_finding where eval_run_id = $1::uuid order by created_at`, [evalRunId])).rows;
}

/** The run's per-dimension result, rebuilt from the rows the reshape left. The published
 *  `zz.eval_run_dimension` row carries the score and the coverage that were scored; the protocol's
 *  own `eval_dimension`/`eval_measure` rows carry the keys, the weights and the bars; and each
 *  measure's value is reduced from the run's stored answers by the same `reduceMeasureAnswers`
 *  `evaluation_score` scored with — a scored run is terminal, so re-deriving a figure reproduces
 *  the one that was published rather than replacing it. */
async function loadDimensionScores(p: pg.Pool, run: EvalRunRow): Promise<DimensionScoreRow[]> {
  const dims = await loadDimensions(p, run.protocol_version_id);
  if (!dims.length) return [];
  const published = new Map((await p.query<{
    dimension_id: string; score: number | null; coverage: number | null;
  }>(`
    select dimension_id::text as dimension_id, score::float8 as score, coverage::float8 as coverage
      from zz.eval_run_dimension where eval_run_id = $1::uuid`, [run.id])).rows
    .map((r) => [r.dimension_id, r]));

  const answers = new Map<string, MeasureAnswer[]>();
  for (const a of (await p.query<{ measure_id: string; answer: MeasureAnswer }>(
    `${STORED_ANSWERS_SQL} where a.eval_run_id = $1::uuid`, [run.id])).rows) {
    const list = answers.get(a.measure_id);
    if (list) list.push(a.answer); else answers.set(a.measure_id, [a.answer]);
  }
  // A measure is a guardrail exactly when its own `guardrail_threshold` is set — the same
  // derivation `evaluation_score` reduces the run's guardrail status from, read off the run's own
  // measures rather than parsed out of a policy object.
  const critical = new Set(guardrailsOfMeasures(dims.flatMap((d) => d.measures)).map((g) => g.key));

  return dims.map((d): DimensionScoreRow => {
    // A dimension that does not apply was never assessed; its measures carry its reason, not an
    // exclusion that reads as missing evidence.
    const measured = d.applicable ? undefined : `not applicable: ${d.not_applicable_reason ?? "the protocol says so"}`;
    const measures = d.measures.map((m): MeasureScoreRow => {
      const mine = answers.get(m.id) ?? [];
      const value = reduceMeasureAnswers(mine);
      return {
        key: m.key, evaluator_type: m.evaluator_type, weight: m.weight, required: m.required,
        value, excluded: value === null, guardrail: critical.has(m.key),
        excluded_reason: value === null ? (measured ?? mine[0]?.excluded_reason ?? "no assessment recorded") : null,
      };
    });
    return {
      key: d.key, canonical_kind: d.canonical_kind,
      score: published.get(d.id)?.score ?? null, coverage: published.get(d.id)?.coverage ?? null,
      applicable: d.applicable, not_applicable_reason: d.not_applicable_reason,
      weight: d.weight, required: d.required,
      measures_scored: measures.filter((m) => !m.excluded).length, measures_total: measures.length,
      measures,
    };
  });
}

function renderDimensions(dims: DimensionScoreRow[]): string {
  if (!dims.length) return "No dimension was scored.";
  return dims.map((d) => {
    const head = d.applicable
      ? `- **${d.key}** (${d.canonical_kind}) — ${d.score === null ? "not scored" : d.score.toFixed(4)}, ` +
        `${d.measures_scored}/${d.measures_total} measure(s) scored` +
        `${d.coverage === null || d.coverage === undefined ? "" : ` (${pct(d.coverage)} of its weight)`}, weight ${d.weight}` +
        `${d.required ? ", required" : ""}`
      : `- **${d.key}** (${d.canonical_kind}) — not applicable: ${d.not_applicable_reason ?? "no reason recorded"}`;
    const measures = d.measures.map((m) =>
      `  - \`${m.key}\` (${m.evaluator_type}) — ${m.excluded ? `excluded (${m.excluded_reason ?? "no reason"})`
        : `${m.value?.toFixed(4) ?? "—"}`}${m.guardrail ? " — guardrail" : ""}`).join("\n");
    return measures ? `${head}\n${measures}` : head;
  }).join("\n");
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** The stored interval, as a sentence: bounds, level and how many subjects it resampled — or why
 *  there is no real interval. Never the raw JSON.
 *
 *  A run scored under the reshaped family carries only its two bounds
 *  (`zz.eval_run.score_lower`/`score_upper`): the level, the resample count and the subject count
 *  were fields of the `score_interval` jsonb this phase drops, so there is nothing to report but
 *  the interval itself. That shape is rendered as the bounds alone — a level printed as `?` and a
 *  resample count printed as zero would be two figures nobody measured. */
export function renderInterval(i: Record<string, unknown> | null): string {
  if (!i) return "not computed";
  const n = typeof i.n_subjects === "number" ? i.n_subjects : 0;
  const bound = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : null);
  const bounds = [bound(i.lower), bound(i.upper)];
  if (typeof i.level !== "number" && typeof i.iterations !== "number" && !("n_subjects" in i)) {
    const said = bounds[0] === null && bounds[1] === null
      ? "not computed — this run published no interval bounds"
      : `${bounds[0] ?? "—"}–${bounds[1] ?? "—"}`;
    return i.note ? `${said} — ${String(i.note)}` : said;
  }
  const level = typeof i.level === "number" ? pct(i.level) : "?";
  if (i.degenerate) {
    return n === 0 ? `none — ${String(i.note ?? "no subject was scored")}`
      : `${bounds[0] ?? "—"} (one subject; ${String(i.note ?? "nothing to resample")})`;
  }
  const iterations = typeof i.iterations === "number" ? `, ${i.iterations} resamples` : "";
  return `${bounds[0] ?? "—"}–${bounds[1] ?? "—"} (${level} bootstrap over ${n} subjects${iterations})` +
    (i.note ? ` — ${String(i.note)}` : "");
}

/** The interval a run published, in the shape `renderInterval` reads it: the two bounds it stores
 *  and nothing else — see that function's own note on why the rest is absent rather than zero. */
function storedInterval(run: EvalRunRow): Record<string, unknown> | null {
  if (run.score_lower === null && run.score_upper === null) return null;
  return { lower: run.score_lower, upper: run.score_upper };
}

/** Why a score is not established, as `evaluation_score` recorded it — nothing when it is. */
function blockedBy(reasons: unknown): string {
  if (!Array.isArray(reasons) || !reasons.length) return "";
  return ` — not established because: ${reasons.map(String).join("; ")}`;
}

function renderGuardrails(dims: DimensionScoreRow[], status: string | null): string {
  const flagged = dims.flatMap((d) => d.measures.filter((m) => m.guardrail).map((m) => ({ ...m, dimension: d.key })));
  const lines = [`Overall guardrail status: **${status ?? "not_established"}**.`];
  if (flagged.length) {
    lines.push(...flagged.map((m) =>
      `- \`${m.dimension}.${m.key}\`: ${m.excluded ? `excluded (${m.excluded_reason ?? "no reason"})` : (m.value?.toFixed(4) ?? "—")}`));
  } else {
    lines.push("No measure in this protocol is flagged as a guardrail.");
  }
  return lines.join("\n");
}

function renderTrust(rows: EvaluatorTrustRow[]): string {
  if (!rows.length) return "This protocol names no model-backed evaluator.";
  return rows.map((r) => `- \`${r.stable_key}\`: ${r.state ?? "never qualified against this protocol version"}` +
    (r.qualified_at ? ` (as of ${r.qualified_at})` : "")).join("\n");
}

/** One kind's CURRENT findings — a superseded one is left out, and the finding that corrected it
 *  says so, with what it replaced, so the correction is visible without the wrong figure standing. */
export function renderFindings(findings: FindingRow[], kind: FindingRow["kind"]): string {
  const replaced = new Map(findings.filter((f) => f.superseded_by).map((f) => [f.superseded_by as string, f]));
  const rows = findings.filter((f) => f.kind === kind && !f.superseded_by);
  if (!rows.length) return `No ${kind} is recorded against this run.`;
  // The id is printed because IMPROVE's `improvement_start` names findings by it, and a fresh
  // conversation has this document, not EXPLAIN's `finding_record` responses.
  return rows.map((f) =>
    `- ${f.pattern} (id: \`${f.id}\`, owner: ${f.owner_kind ?? "unknown"}${f.owner_ref ? ` ${f.owner_ref}` : ""}` +
    // A strength is not open work: it is not IMPROVE's to act on, so it carries no decision.
    `${f.kind === "strength" ? "" : `, decision: ${f.decision}`})` +
    (replaced.has(f.id) ? ` — corrects \`${replaced.get(f.id)!.id}\`, which said: "${replaced.get(f.id)!.pattern}"` : "")).join("\n");
}

function renderBody(
  run: EvalRunRow, subject: { plugin: string; declared_version: string; origin: string;
    owner_team: string | null; release_owners: string[] },
  dims: DimensionScoreRow[],
  protocol: { protocol_key: string; version: number },
  trust: EvaluatorTrustRow[], findings: FindingRow[],
): string {
  return [
    `# Findings — ${subject.plugin} ${subject.declared_version}`,
    "",
    "## Score",
    `- Status: **${run.score_status ?? "not_established"}**` + blockedBy(run.establishment_blocked_by),
    `- Overall: ${run.overall_score === null ? "—" : Number(run.overall_score).toFixed(2)} / 10`,
    `- Protocol: \`${protocol.protocol_key}\` version ${protocol.version}`,
    `- Interval: ${renderInterval(storedInterval(run))}`,
    `- Coverage: ${run.measure_coverage === null
      ? "not recorded"
      : `${pct(run.measure_coverage)} of the protocol's measure weight scored`}`,
    `- eval_run_id: \`${run.id}\``,
    "",
    "## Dimensions",
    renderDimensions(dims),
    "",
    "## Guardrails",
    renderGuardrails(dims, run.guardrail_status),
    "",
    "## Evaluator trust",
    renderTrust(trust),
    "",
    "## Strengths",
    renderFindings(findings, "strength"),
    "",
    "## Defects",
    renderFindings(findings, "defect"),
    "",
    "## Unknowns",
    renderFindings(findings, "unknown"),
    "",
    "## Ownership",
    `- Origin: ${subject.origin}`,
    `- Owner team: ${subject.owner_team ?? "none recorded"}`,
    // `evolvable` is gone with the flag it held: whether this subject can be promoted follows from
    // whose release owners it has (FR-47), which is the same derivation `plugin_locate` answers
    // `release_mode` with one table over. `not_applicable` is not reachable here — it belongs to
    // an initiative that never reached a release stage, which a scored run is not.
    `- Release mode: ${subject.release_owners.length ? "promotable" : "proposal_only"}`,
    `- Release owners: ${subject.release_owners.length ? subject.release_owners.join(", ") : "none"}`,
    "",
  ].join("\n");
}

/** Regenerates `<initiative>/findings.md` from what this eval_run's score and findings currently
 *  hold — called by `finding_record` (`plugin-record.ts`) whenever a caller names `initiative`,
 *  so the document a reader opens is never behind the last finding recorded against the run it
 *  describes. Returns the written path and byte count, or a refusal string — never throws, the
 *  same contract `documentGuards` itself answers in. */
export async function writeFindingsDoc(
  p: pg.Pool, initiative: string, evalRunId: string,
): Promise<{ path: string; chars: number } | string> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) return badInitiative;

  const run = await loadEvalRun(p, evalRunId);
  if (!run) return `ERROR: no eval_run ${evalRunId}`;
  const [subject, protocol, trust, findings, dims] = await Promise.all([
    loadSubject(p, run.plugin_version_id), loadProtocol(p, run.protocol_version_id),
    loadEvaluatorTrust(p, run.protocol_version_id), loadFindings(p, evalRunId),
    loadDimensionScores(p, run),
  ]);
  if (!subject || !protocol) return `ERROR: eval_run ${evalRunId} names a subject or protocol version this call cannot read back`;

  const body = renderBody(run, subject, dims, protocol, trust, findings);
  const team = await teamFor(parseCaller(requestHeaders()).email);
  if (!team) {
    return "ERROR: this caller resolves to no team, so the document has no shelf to be filed on";
  }
  const path = `${initiative}/findings.md`;
  const unopened = await unopenedRefusal(p, team, path);
  if (unopened) return unopened;
  await safePath(path);
  const chain = await chainFor(p, team, path, body);
  const existing = await loadDocument(team, path);
  // The carry is read from the document's own current revision — the rows a document IS
  // — rather than from a file the store used to hold. A document this team does not have
  // yet carries nothing, which is the same answer a missing file gave.
  const onDisk = existing.ok ? parseEnvelope(existing.text) : {};
  const carry: Record<string, string> = {};
  for (const k of [...PLATFORM_OWNED, "version"]) {
    if (onDisk[k]) carry[k] = onDisk[k];
  }
  const content = envelopeFor(chain, path, body, {
    title: `Findings — ${subject.plugin} ${subject.declared_version}`,
    fields: { eval_run_id: evalRunId }, carry,
  });
  const fixed = normalizeSections(chain, path, content);
  const gate = await documentGuards(chain, path, fixed.content, team);
  if (gate) return gate;
  // The ONE insert path: `saveDocument`, which stamps, files the row and its revision. Not a
  // second one here — two writers for one row shape drift, and these two already had.
  //
  // `chars` is the stamped document's length, so the count this returns is the bytes that were
  // filed rather than the bytes that were passed in.
  const stamped = stampEnvelope(chain, path, fixed.content);
  const actor = parseCaller(requestHeaders()).email;
  const saved = await saveDocument({
    team, relPath: path, initiative: path.split("/")[0], text: stamped, by: actor,
    flow: chain.name ?? undefined, act: "write", mode: "rewrite", seal: sealOf(stamped),
  });
  if ("refusal" in saved) return saved.refusal;
  return { path, chars: stamped.length };
}
