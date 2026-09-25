/**
 * `proposal.md` (Task I-25, FR-51, FR-53, AC-51.1): the ungated, owner-facing document a
 * non-owned (`release_mode: proposal_only`, `subject.ts`'s own field) subject's IMPROVE loop
 * ends on instead of `improvement.md`. FR-51's own boundary: "a plugin for which the current
 * principal lacks release authority may still proceed through evaluation, diagnosis and
 * isolated proposal generation... It produces an owner-facing proposal with patch/evidence
 * where possible and stops before promotion." Written the SAME way `document_write` writes any
 * document into the initiative store — `chainFor` resolves the flow, `envelopeFor` builds the
 * frontmatter, `normalizeSections` renames a near-miss heading, `documentGuards` decides whether
 * the write may land, `persistDocument` lands it — exactly the path `findings-doc.ts`'s own
 * `writeFindingsDoc` and `improvement-doc.ts`'s own `writeImprovementDoc` already take. Nothing
 * here invents a second write path.
 *
 * EXPLICIT GUARD (the task's own words: "a non-owned subject never causes a repository write,
 * ever — make that an explicit guard"): this file imports nothing that can touch a real
 * checkout — no `node:child_process`, no `release-apply.js`, no `release-verify.js`. Its only
 * two side effects are a database READ and a document WRITE into this platform's own governed
 * store; whatever a candidate's own `patchset.diff` contains is rendered as inert fenced
 * markdown, never applied, never `git apply`-ed, never passed to anything that executes it.
 * `release.ts`'s own `proposal_prepare` tool refuses outright before this module is ever reached
 * when the subject actually carries `release_owners` — see that file's own module note — so this
 * module never even has to decide "should I apply this"; there is no path into it for an owned
 * subject at all.
 *
 * "A subject with no source" (the task's own words) is read off `subject.source_locator.kind`,
 * never re-resolved by cloning/reading the locator again at proposal time — a third-party
 * subject always names a concrete, already-validated `local_dir`/`git`/`package` locator at
 * `plugin_register` time (FR-3's own required argument; `resolveSource` in `subject.ts` refuses
 * an unreadable one before the row is ever written), so `kind` is one of those three for every
 * subject `plugin_register` actually captured. `"unrecorded"` (`subject.ts`'s own catalog-path
 * fallback for an entry the manifest no longer carries) or a missing/malformed locator is the
 * only shape this call ever sees for "no source" — when it is, the Candidates section renders
 * findings-only behavioural proposals and says so, rather than an empty section pretending
 * nothing was found.
 *
 * Distinct from "no source" is "no built candidate yet": a subject WITH a real source_locator
 * whose improvement_run never got a candidate through its build (still building, or every
 * candidate invalid) — that case is reported on its own terms ("no candidate has been built"),
 * never folded into the "no source" framing, because a later call against the same
 * improvement_run_id can still pick up a built candidate once one lands.
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

interface ImprovementRunRow {
  readonly id: string; readonly eval_run_id: string;
}

interface ProposalSubjectRow {
  readonly plugin: string; readonly declared_version: string; readonly origin: string;
  readonly owner_team: string | null; readonly release_owners: readonly string[];
  readonly source_locator: { kind?: string; locator?: string } | null;
}

interface FindingRow {
  readonly id: string; readonly kind: "strength" | "defect" | "unknown"; readonly pattern: string;
  readonly owner_kind: string | null; readonly owner_ref: string | null; readonly decision: string;
}

interface CandidateRow {
  readonly id: string; readonly status: string; readonly hypothesis: string;
  readonly complexity_delta: number; readonly patch_digest: string; readonly diff: string;
  readonly touched_components: unknown; readonly touched_owners: readonly string[];
  readonly build_result: { ok?: boolean; stage?: string; commands?: string[] } | null;
}

/** Every candidate status worth showing a reader: one whose patch was built and checked
 *  (`valid`) — never a bare `recorded`/`awaiting_build` candidate, which carries no tested
 *  evidence, or an `invalid` one, whose patch did not even apply or build. */
const REPORTABLE_STATUSES = new Set(["valid"]);

async function loadImprovementRun(p: pg.Pool, id: string): Promise<ImprovementRunRow | null> {
  const row = (await p.query<ImprovementRunRow>(`
    select id::text as id, eval_run_id::text as eval_run_id
      from zz.improvement_run where id = $1::uuid`, [id])).rows[0];
  return row ?? null;
}

export async function loadSubjectForEvalRun(p: pg.Pool, evalRunId: string): Promise<ProposalSubjectRow | null> {
  return (await p.query<ProposalSubjectRow>(`
    select pl.name as plugin, sv.declared_version, pl.origin, pl.owner_team, pl.release_owners,
           sv.source_locator
      from zz.eval_run er
      join zz.eval_subject_version sv on sv.id = er.subject_version_id
      join zz.plugin pl on pl.id = sv.plugin_id
     where er.id = $1::uuid`, [evalRunId])).rows[0] ?? null;
}

async function loadFindings(p: pg.Pool, evalRunId: string): Promise<FindingRow[]> {
  return (await p.query<FindingRow>(`
    select id::text as id, kind, pattern, owner_kind, owner_ref, decision
      from zz.eval_finding where eval_run_id = $1::uuid order by created_at`, [evalRunId])).rows;
}

async function loadCandidates(p: pg.Pool, improvementRunId: string): Promise<CandidateRow[]> {
  return (await p.query<CandidateRow>(`
    select id::text as id, status, hypothesis, complexity_delta, patch_digest,
           coalesce(patchset->>'diff', '') as diff, touched_components, touched_owners, build_result
      from zz.candidate where improvement_run_id = $1::uuid order by created_at`,
    [improvementRunId])).rows;
}

/** `subject.source_locator.kind` is `"unrecorded"`, missing, or the column itself is null — see
 *  this module's own note on why that is the only shape "no source" ever takes. */
function hasSource(sourceLocator: ProposalSubjectRow["source_locator"]): boolean {
  const kind = sourceLocator?.kind;
  return typeof kind === "string" && kind.length > 0 && kind !== "unrecorded";
}

function renderFindings(findings: readonly FindingRow[]): string {
  if (!findings.length) return "No finding is recorded against this run.";
  return findings.map((f) =>
    `- **${f.kind}** — ${f.pattern} (owner: ${f.owner_kind ?? "unknown"}` +
    `${f.owner_ref ? ` ${f.owner_ref}` : ""}, decision: ${f.decision})`).join("\n");
}

function renderBuild(b: CandidateRow["build_result"]): string {
  if (!b) return "not built";
  const commands = b.commands?.length ? ` (${b.commands.join("; ")})` : "";
  return b.ok ? `passed${commands}` : `failed at ${b.stage ?? "an unnamed stage"}${commands}`;
}

/** A fence the diff cannot close: CommonMark ends a fenced block at the first line of at least
 *  as many backticks as opened it, so a diff that itself contains ``` (a patch to a Markdown
 *  skill, say) would end a three-backtick fence early and spill the rest of the patch into the
 *  document as prose. One backtick longer than the longest run inside, never fewer than three. */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function renderCandidate(c: CandidateRow): string {
  const diff = c.diff || "(no diff recorded)";
  const fence = fenceFor(diff);
  return [
    `### Candidate \`${c.id}\` (${c.status})`,
    `- Hypothesis: ${c.hypothesis}`,
    `- Complexity delta: ${c.complexity_delta}`,
    `- Patch digest: \`${c.patch_digest}\``,
    `- Touched components: ${JSON.stringify(c.touched_components ?? [])}`,
    `- Touched owners (recorded at candidate_record time): ${c.touched_owners.length ? c.touched_owners.join(", ") : "none"}`,
    `- Build (npm run candidate-build): ${renderBuild(c.build_result)}`,
    "- Patch (inert — never applied by this platform):",
    `${fence}diff`,
    diff,
    fence,
  ].join("\n");
}

function renderCandidatesSection(sourceAvailable: boolean, reportable: readonly CandidateRow[]): string {
  if (!sourceAvailable) {
    return "No source was available for this subject (`source_locator` names no readable " +
      "local_dir/git/package origin), so IMPROVE stopped after diagnosis. The findings above " +
      "are **behavioural proposals only** — a description of the change wanted, with no tested " +
      "patch, because there was nothing to check out and test one against.";
  }
  if (!reportable.length) {
    return "No candidate from this improvement_run has been built and checked yet. The findings " +
      "above stand on their own until one is.";
  }
  return reportable.map((c) => renderCandidate(c)).join("\n\n");
}

function renderBody(
  initiative: string, improvementRunId: string, evalRunId: string, subject: ProposalSubjectRow,
  findings: readonly FindingRow[], sourceAvailable: boolean, reportable: readonly CandidateRow[],
): string {
  return [
    `# Proposal — ${subject.plugin} ${subject.declared_version} — not released by ZZ Stack`,
    "",
    "**Not released by ZZ Stack.** This is an owner-facing proposal only (FR-51): evaluation, " +
    "diagnosis and, where source access permitted it, a candidate patch checked in an isolated " +
    "build. Nothing described here has been applied to any repository, and " +
    "this platform has no authority to apply it.",
    "",
    "## Subject",
    `- Plugin: ${subject.plugin} ${subject.declared_version}`,
    `- Origin: ${subject.origin}`,
    `- Owner team (recorded on this platform): ${subject.owner_team ?? "none recorded"}`,
    "- Release owners: none — release_mode: `proposal_only`",
    `- Source: ${sourceAvailable ? JSON.stringify(subject.source_locator) : "not recorded (no source)"}`,
    `- improvement_run_id: \`${improvementRunId}\``,
    `- eval_run_id: \`${evalRunId}\``,
    "",
    "## Findings",
    renderFindings(findings),
    "",
    "## Candidates",
    renderCandidatesSection(sourceAvailable, reportable),
    "",
    "## Ownership and promotion",
    "- Release owners: none recorded — this subject cannot be promoted through this platform. " +
    "`release_prepare` and `release_apply` both refuse it with `no_release_owners`.",
    "- Promotion, if it ever happens, is an act by whoever actually owns this plugin, outside " +
    "this platform's own release path. This document applies no patch and writes to no real " +
    "repository — it only records what was found and what a fix could look like.",
    "",
    `improvement_run_id: \`${improvementRunId}\` — initiative \`${initiative}\`.`,
    "",
  ].join("\n");
}

interface WriteProposalDocResult {
  readonly path: string; readonly chars: number; readonly candidates_included: string[];
}

/** Writes `<initiative>/proposal.md`, ungated (FR-53: "A `proposal_only` branch writes ungated
 *  `proposal.md`"). Returns the written path, byte count and the candidate ids actually
 *  included, or a refusal string — never throws, the same contract `documentGuards` itself
 *  answers in. Called only after `release.ts`'s own `registerProposalPrepare` has already
 *  confirmed this subject carries no `release_owners` — see that file's module note. */
export async function writeProposalDoc(
  p: pg.Pool, initiative: string, improvementRunId: string,
): Promise<WriteProposalDocResult | string> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) return badInitiative;

  const run = await loadImprovementRun(p, improvementRunId);
  if (!run) return `ERROR: no improvement_run ${improvementRunId}`;
  const subject = await loadSubjectForEvalRun(p, run.eval_run_id);
  if (!subject) {
    return `ERROR: improvement_run ${improvementRunId}'s own eval_run ${run.eval_run_id} names ` +
      "a subject this call cannot read back";
  }

  const [findings, candidates] = await Promise.all([
    loadFindings(p, run.eval_run_id), loadCandidates(p, improvementRunId),
  ]);
  const reportable = candidates.filter((c) => REPORTABLE_STATUSES.has(c.status));
  const sourceAvailable = hasSource(subject.source_locator);
  const candidatesIncluded = sourceAvailable ? reportable.map((c) => c.id) : [];

  const body = renderBody(
    initiative, improvementRunId, run.eval_run_id, subject, findings, sourceAvailable,
    sourceAvailable ? reportable : []);
  const root = await userRoot();
  const path = `${initiative}/proposal.md`;
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
    title: `Proposal — ${subject.plugin} ${subject.declared_version} — not released by ZZ Stack`,
    fields: { improvement_run_id: improvementRunId, eval_run_id: run.eval_run_id },
    carry,
  });
  const fixed = normalizeSections(chain, path, content);
  const team = await teamFor(parseCaller(requestHeaders()).email);
  const gate = documentGuards(chain, root, path, fixed.content, team);
  if (gate) return gate;
  const written = persistDocument(chain, root, path, target, fixed.content, "write");
  return { path, chars: written.length, candidates_included: candidatesIncluded };
}
