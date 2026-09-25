/**
 * `improvement.md` (Task I-22, FR-48, AC-48.1): the authority-bearing gate a releasable owned
 * candidate crosses before its patch is ever applied. Written by `release_prepare`
 * (`release.ts`) the SAME way `document_write` writes any document into the initiative store, and
 * the same way `findings-doc.ts`'s `writeFindingsDoc` already does it for `findings.md`:
 * `chainFor` resolves the flow, `envelopeFor` builds the frontmatter, `normalizeSections` renames
 * a near-miss heading, `documentGuards` decides whether the write may land, `persistDocument`
 * lands it. Nothing here invents a second write path.
 *
 * Unlike `writeFindingsDoc`, this module takes no database handle — `release_prepare` has
 * already loaded everything the body needs (the candidate, its base subject, its resolved
 * owners, its sealed proof evaluation) before calling this, so the document write is pure
 * rendering plus the platform's own file-store side effects, nothing else.
 *
 * The body MUST quote `patch_digest` verbatim and cite `release_attempt_id` exactly once (the
 * closing line `renderBody` writes) — `release_apply` (`release-apply.ts`) counts an approval only
 * when the approved body cites THIS attempt and quotes its digest, and only for the owner teams its
 * `approved_by` is a member of (`release-owners.ts`, which `document_approve` also checks before it
 * stamps a signer). COUPLED: `citedReleaseAttempt` parses that closing line's exact shape.
 * The two citations are what tie a page of prose to the exact attempt and immutable patch it was
 * written to describe; an approval of an earlier attempt's document approves nothing.
 *
 * `catalog/zz/zz-plugin-eval/flow.json` declares `improvement.md` gated (`gate: true`), requiring
 * `findings.md`, and applicable when `release_mode` is `promotable` — the branch fact
 * `release_prepare` records before it calls this. `documentGuards` applies that manifest to this
 * write — its `requires` prerequisite and its declared sections — and refuses to write over a
 * document already approved (a revision is `document_revise`).
 */
import { existsSync, readFileSync } from "node:fs";

import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { chainFor } from "../chain.js";
import { documentGuards } from "../guards.js";
import { unopenedRefusal } from "../initiative-record.js";
import { safeName, safePath, userRoot } from "../paths.js";
import { persistDocument } from "../persist.js";
import { teamFor } from "../platform-db.js";
import { envelopeFor, normalizeSections } from "../write-guards.js";

/** The proof-split `zz.candidate_evaluation` row `release_prepare` reads back — the same shape
 *  `candidate-prove.ts`'s own `resolveOutcome` writes, read here rather than re-derived. */
export interface ProofEvaluationRow {
  readonly aggregate_score: {
    proof_status: string; reason: string; release_eligible: boolean;
    mean_delta: number | null; lower: number | null; upper: number | null; verdict: string | null;
  };
  readonly dimension_scores: unknown;
  readonly guardrails: { status?: string } | null;
  readonly statistics: unknown;
}

interface ImprovementDocInput {
  readonly candidate_id: string;
  readonly release_attempt_id: string;
  readonly plugin: string;
  readonly declared_version: string;
  readonly base_subject_version_id: string;
  readonly patch_digest: string;
  readonly hypothesis: string;
  readonly complexity_delta: number;
  readonly required_owners: readonly string[];
  readonly proof: ProofEvaluationRow;
}

function renderBody(initiative: string, data: ImprovementDocInput): string {
  const { aggregate_score, guardrails, dimension_scores, statistics } = data.proof;
  const interval = aggregate_score.lower === null || aggregate_score.upper === null
    ? "not computed"
    : `[${aggregate_score.lower.toFixed(4)}, ${aggregate_score.upper.toFixed(4)}] (mean ${(aggregate_score.mean_delta ?? 0).toFixed(4)})`;
  return [
    `# Improvement — ${data.plugin} ${data.declared_version}`,
    "",
    "## Candidate",
    `- candidate_id: \`${data.candidate_id}\``,
    `- Hypothesis: ${data.hypothesis}`,
    `- Complexity delta: ${data.complexity_delta}`,
    "",
    "## Base subject",
    `- Plugin: ${data.plugin} ${data.declared_version}`,
    `- base_subject_version_id: \`${data.base_subject_version_id}\``,
    "",
    "## Patch",
    `- Patch digest: \`${data.patch_digest}\``,
    "",
    "## Proof result",
    `- Status: **${aggregate_score.proof_status}**`,
    `- Reason: ${aggregate_score.reason}`,
    `- Release eligible: ${aggregate_score.release_eligible ? "yes" : "no"}`,
    `- 95% paired bootstrap interval of the per-case delta: ${interval}, verdict: ${aggregate_score.verdict ?? "—"}`,
    "",
    "## Score change",
    `\`\`\`json\n${JSON.stringify(dimension_scores, null, 2)}\n\`\`\``,
    "",
    "## Guardrails",
    `- Status: **${guardrails?.status ?? "not_established"}**`,
    `\`\`\`json\n${JSON.stringify(statistics, null, 2)}\n\`\`\``,
    "",
    "## Owners",
    `- Required owners: ${data.required_owners.length ? data.required_owners.join(", ") : "none"}`,
    "",
    "## Release plan",
    `Once every required owner above approves this document at the patch digest quoted above ` +
    `(\`${data.patch_digest}\`), \`release_apply\` compares the currently released subject with ` +
    `\`${data.base_subject_version_id}\`; if they differ it refuses \`stale_baseline\` and this ` +
    "candidate must be rebased, re-validated, re-proved and re-approved. Otherwise it applies " +
    "exactly this patch digest, runs the repository/release gates, and records the new subject " +
    "version.",
    "",
    "## Rollback plan",
    "Post-release verification (`release_verify`) runs the approved protocol against the exact " +
    "released subject. A required guardrail failure or a statistically established regression " +
    "(`rollbackDecision`, the same `pairedDecision` machinery this proof used) automatically " +
    "restores the prior released version, recorded as a release event with its own evidence.",
    "",
    `release_attempt_id: \`${data.release_attempt_id}\` — initiative \`${initiative}\`.`,
    "",
  ].join("\n");
}

/** Writes `<initiative>/improvement.md`, gated (FR-48, FR-53: gated whenever `release_mode =
 *  promotable` and a final candidate has established proof — which is exactly the state
 *  `release_prepare` only ever calls this from). Returns the written path and byte count, or a
 *  refusal string — never throws, the same contract `documentGuards` itself answers in. */
export async function writeImprovementDoc(
  initiative: string, data: ImprovementDocInput,
): Promise<{ path: string; chars: number } | string> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) return badInitiative;

  const body = renderBody(initiative, data);
  const root = await userRoot();
  const path = `${initiative}/improvement.md`;
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
    title: `Improvement — ${data.plugin} ${data.declared_version}`,
    fields: { candidate_id: data.candidate_id, release_attempt_id: data.release_attempt_id },
    carry,
  });
  const fixed = normalizeSections(chain, path, content);
  const team = await teamFor(parseCaller(requestHeaders()).email);
  const gate = documentGuards(chain, root, path, fixed.content, team);
  if (gate) return gate;
  const written = persistDocument(chain, root, path, target, fixed.content, "write");
  return { path, chars: written.length };
}
