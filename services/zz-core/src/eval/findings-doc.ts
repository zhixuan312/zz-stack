/**
 * `findings.md` (Task I-13, AC-22.1): a measurement output, generated from what `evaluation_score`
 * stored and what `finding_record` has recorded against one `eval_run_id`, and written the SAME
 * way `document_write` writes any document into the initiative store — `chainFor` resolves the
 * flow, `envelopeFor` builds the frontmatter, `normalizeSections` renames a near-miss heading,
 * `documentGuards` decides whether the write may land, `persistDocument` lands it. Nothing here
 * invents a second write path: `artifacts.ts`'s `document_write` is the only place this platform
 * writes a governed document, and this file calls the same internals it does rather than
 * `writeFileSync`ing around them the way `source_add`'s immutable, ungated material does — a
 * source names nothing else in the store and answers to no gate; findings.md names its initiative
 * and, once `catalog/zz/zz-plugin-eval/flow.json` is updated (Task I-28, this task's own
 * dependent) to declare `findings.md` with `gate: false`, is finished by being written, exactly
 * as `write-guards.ts`'s own `sectionCheck` already treats an ungated document.
 *
 * `catalog/zz/zz-plugin-eval/flow.json` at the time this task lands still carries the OLD
 * five-section, `gate: true`, `requiredForClose: true` declaration for `findings.md` — the
 * legacy round-based report Task I-28 replaces. `documentGuards` reads whatever manifest is
 * live, so on an initiative governed by that stale manifest this write still asks for
 * `protocol.md` to be approved first and still stamps `status: draft` (a gated document's own
 * stamp) rather than being un-stamped outright. That is exactly and only what "findings.md is
 * ungated" is waiting on Task I-28 for: this file's own writing path already imposes no gate of
 * its own — the source is the one place the intended headings and the "written by being
 * written" behaviour are decided; `flow.json` merely has to catch up to it. On a freeform
 * initiative (no flow declared) `chainFor` returns `EMPTY_CHAIN`, `chain.documents` is empty, and
 * every guard above no-ops — which is the shape the live end-to-end check for this task actually
 * exercises.
 */
import { existsSync, readFileSync } from "node:fs";

import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";
import type pg from "pg";

import { chainFor } from "../chain.js";
import { documentGuards } from "../guards.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safeName, safePath, userRoot } from "../paths.js";
import { persistDocument } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { envelopeFor, normalizeSections } from "../write-guards.js";

interface EvalRunRow {
  id: string; subject_version_id: string; protocol_version_id: string;
  run_status: string; score_status: string | null; overall_score: string | null;
  score_interval: Record<string, unknown> | null;
  dimension_scores: DimensionScoreRow[] | null;
  guardrail_status: string | null; coverage: Record<string, unknown>;
}

export interface MeasureScoreRow {
  key: string; evaluator_type: string; weight: number; required: boolean;
  value: number | null; excluded: boolean; excluded_reason: string | null; guardrail: boolean;
}

export interface DimensionScoreRow {
  key: string; canonical_kind: string; score: number | null; applicable: boolean;
  not_applicable_reason: string | null; weight: number; required: boolean;
  measures_scored: number; measures_total: number; measures: MeasureScoreRow[];
}

interface FindingRow {
  id: string; kind: "strength" | "defect" | "unknown"; pattern: string;
  owner_kind: string | null; owner_ref: string | null;
  evidence_refs: unknown[]; decision: string; decision_note: string | null;
}

interface EvaluatorTrustRow { stable_key: string; state: string | null; qualified_at: string | null }

async function loadEvalRun(p: pg.Pool, evalRunId: string): Promise<EvalRunRow | null> {
  const row = (await p.query<EvalRunRow>(`
    select id::text as id, subject_version_id::text as subject_version_id,
           protocol_version_id::text as protocol_version_id, run_status,
           score_status, overall_score::text as overall_score, score_interval, dimension_scores,
           guardrail_status, coverage
      from zz.eval_run where id = $1::uuid`, [evalRunId])).rows[0];
  return row ?? null;
}

async function loadSubject(p: pg.Pool, subjectVersionId: string) {
  return (await p.query<{
    plugin: string; declared_version: string; origin: string; owner_team: string | null;
    evolvable: boolean; release_owners: string[];
  }>(`
    select pl.name as plugin, sv.declared_version, pl.origin, pl.owner_team, pl.evolvable, pl.release_owners
      from zz.eval_subject_version sv join zz.plugin pl on pl.id = sv.plugin_id
     where sv.id = $1::uuid`, [subjectVersionId])).rows[0];
}

async function loadProtocol(p: pg.Pool, protocolVersionId: string) {
  return (await p.query<{ protocol_key: string; version: number }>(`
    select pr.protocol_key as protocol_key, pv.version as version
      from zz.eval_protocol_version pv join zz.eval_protocol pr on pr.id = pv.protocol_id
     where pv.id = $1::uuid`, [protocolVersionId])).rows[0];
}

/** Every distinct evaluator a bounded_semantic/generative_critic measure of this protocol
 *  version names, with its newest qualification state against THIS protocol version — read live
 *  off `zz.eval_evaluator_qualification`, never off `eval_run`, which stores no evaluator-trust
 *  column of its own: qualification is a property of (evaluator version, protocol version), not
 *  of a run. */
async function loadEvaluatorTrust(p: pg.Pool, protocolVersionId: string): Promise<EvaluatorTrustRow[]> {
  return (await p.query<EvaluatorTrustRow>(`
    select distinct on (ee.stable_key) ee.stable_key as stable_key,
           q.state as state, q.qualified_at::text as qualified_at
      from zz.eval_measure m
      join zz.eval_dimension d on d.id = m.dimension_id
      join zz.eval_evaluator_version ev on ev.id = m.evaluator_version_id
      join zz.eval_evaluator ee on ee.id = ev.evaluator_id
      left join zz.eval_evaluator_qualification q
        on q.evaluator_version_id = ev.id and q.protocol_version_id = $1::uuid
     where d.protocol_version_id = $1::uuid and m.evaluator_version_id is not null
     order by ee.stable_key, q.qualified_at desc nulls last`, [protocolVersionId])).rows;
}

async function loadFindings(p: pg.Pool, evalRunId: string): Promise<FindingRow[]> {
  return (await p.query<FindingRow>(`
    select id::text as id, kind, pattern, owner_kind, owner_ref, evidence_refs, decision, decision_note
      from zz.eval_finding where eval_run_id = $1::uuid order by created_at`, [evalRunId])).rows;
}

function renderDimensions(dims: DimensionScoreRow[]): string {
  if (!dims.length) return "No dimension was scored.";
  return dims.map((d) => {
    const head = d.applicable
      ? `- **${d.key}** (${d.canonical_kind}) — ${d.score === null ? "not scored" : d.score.toFixed(4)}, ` +
        `${d.measures_scored}/${d.measures_total} measure(s) scored, weight ${d.weight}` +
        `${d.required ? ", required" : ""}`
      : `- **${d.key}** (${d.canonical_kind}) — not applicable: ${d.not_applicable_reason ?? "no reason recorded"}`;
    const measures = d.measures.map((m) =>
      `  - \`${m.key}\` (${m.evaluator_type}) — ${m.excluded ? `excluded (${m.excluded_reason ?? "no reason"})`
        : `${m.value?.toFixed(4) ?? "—"}`}${m.guardrail ? " — guardrail" : ""}`).join("\n");
    return measures ? `${head}\n${measures}` : head;
  }).join("\n");
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

function renderFindings(findings: FindingRow[], kind: FindingRow["kind"]): string {
  const rows = findings.filter((f) => f.kind === kind);
  if (!rows.length) return `No ${kind} is recorded against this run.`;
  return rows.map((f) =>
    `- ${f.pattern} (owner: ${f.owner_kind ?? "unknown"}${f.owner_ref ? ` ${f.owner_ref}` : ""}, ` +
    `decision: ${f.decision})`).join("\n");
}

function renderBody(
  run: EvalRunRow, subject: { plugin: string; declared_version: string; origin: string;
    owner_team: string | null; evolvable: boolean; release_owners: string[] },
  protocol: { protocol_key: string; version: number },
  trust: EvaluatorTrustRow[], findings: FindingRow[],
): string {
  const dims = run.dimension_scores ?? [];
  return [
    `# Findings — ${subject.plugin} ${subject.declared_version}`,
    "",
    "## Score",
    `- Status: **${run.score_status ?? "not_established"}**`,
    `- Overall: ${run.overall_score === null ? "—" : Number(run.overall_score).toFixed(2)} / 10`,
    `- Protocol: \`${protocol.protocol_key}\` version ${protocol.version}`,
    `- Interval: ${run.score_interval ? JSON.stringify(run.score_interval) : "not computed"}`,
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
    `- Evolvable: ${subject.evolvable ? "yes" : "no"}`,
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
  const [subject, protocol, trust, findings] = await Promise.all([
    loadSubject(p, run.subject_version_id), loadProtocol(p, run.protocol_version_id),
    loadEvaluatorTrust(p, run.protocol_version_id), loadFindings(p, evalRunId),
  ]);
  if (!subject || !protocol) return `ERROR: eval_run ${evalRunId} names a subject or protocol version this call cannot read back`;

  const body = renderBody(run, subject, protocol, trust, findings);
  const root = await userRoot();
  const path = `${initiative}/findings.md`;
  const unopened = unopenedRefusal(root, path);
  if (unopened) return unopened;
  const target = await safePath(path);
  const chain = chainFor(root, path, body);
  const onDisk = existsSync(target) ? parseEnvelope(readFileSync(target, "utf8")) : {};
  const carry: Record<string, string> = {};
  for (const k of [...PLATFORM_OWNED, "version"]) {
    if (onDisk[k]) carry[k] = onDisk[k];
  }
  const content = envelopeFor(chain, path, body, {
    title: `Findings — ${subject.plugin} ${subject.declared_version}`,
    fields: { eval_run_id: evalRunId }, carry,
  });
  const fixed = normalizeSections(chain, path, content);
  const team = await teamFor(parseCaller(requestHeaders()).email);
  const gate = documentGuards(chain, root, path, fixed.content, team);
  if (gate) return gate;
  const written = persistDocument(chain, root, path, target, fixed.content, "write");
  return { path, chars: written.length };
}
