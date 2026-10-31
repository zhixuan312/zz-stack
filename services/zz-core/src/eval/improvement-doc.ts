/**
 * `improvement.md` (Task I-22, FR-48, AC-48.1): the authority-bearing gate a releasable owned
 * candidate crosses before its patch is ever applied. Written by `release_prepare`
 * (`release.ts`) through `generated-doc.ts`'s `writeGeneratedDoc`, as `findings.md` and
 * `proposal.md` are — the same internals `document_write` calls.
 *
 * Unlike `writeFindingsDoc`, this module takes no database handle — `release_prepare` has
 * already loaded everything the body needs (the candidate and its build, its base subject and
 * that subject's own score, its resolved owners, the protocol's release policy) before calling
 * this, so the document write is pure rendering plus the platform's own side effects (the guard,
 * the envelope and the rows), nothing else.
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
 * document already approved (a change to one is `document_edit`'s).
 */


import { safeName } from "../paths.js";
import { writeGeneratedDoc } from "./generated-doc.js";
import { db } from "../platform-db.js";
import { evaluateGuardrails } from "./evaluate-measures.js";

/** One critical-guardrail reading, AS `evaluateGuardrails` produces it. The type is derived from
 *  the derivation rather than restated: a guardrail's bar is a MEASURE's own
 *  (`eval_measure.guardrail_threshold`), so the list is `guardrailsOfMeasures` evaluated against
 *  what each of those measures reduced to, and a second hand-written shape here is how this
 *  document and the score it quotes would come to describe two different things. Not exported:
 *  every caller names it through `BaseScore`. */
type GuardrailReading = ReturnType<typeof evaluateGuardrails>[number];

/** What the base subject scored in the evaluation this improvement was proposed from — the
 *  number `release_verify` compares the released subject against. */
export interface BaseScore {
  readonly eval_run_id: string;
  readonly overall_score: number | null;
  readonly score_status: string | null;
  readonly guardrails: readonly GuardrailReading[];
}

interface ImprovementDocInput {
  readonly candidate_id: string;
  readonly release_attempt_id: string;
  readonly plugin: string;
  readonly declared_version: string;
  readonly base_plugin_version_id: string;
  readonly patch_digest: string;
  readonly hypothesis: string;
  readonly complexity_delta: number;
  readonly required_owners: readonly string[];
  readonly build: { ok?: boolean; stage?: string; commands?: readonly string[] } | null;
  readonly base: BaseScore;
  readonly policy: { readonly minPostReleaseRuns: number; readonly regressionBand: number };
}

function renderBody(initiative: string, data: ImprovementDocInput): string {
  const commands = data.build?.commands?.length ? data.build.commands.map((c) => `\`${c}\``).join(", ") : "none recorded";
  const guardrails = data.base.guardrails.length
    ? data.base.guardrails.map((g) =>
      `- \`${g.key}\` — must stay at or above ${g.threshold}; the base scored ${g.value ?? "—"} (${g.status})`).join("\n")
    : "- This protocol names no critical guardrail.";
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
    `- base_plugin_version_id: \`${data.base_plugin_version_id}\``,
    "",
    "## Patch",
    `- Patch digest: \`${data.patch_digest}\``,
    "",
    "## Build",
    `- Result: **${data.build?.ok ? "passed" : "not passed"}** — the patch applied to the base release, ` +
    "installed, built and passed the repository's own gate inside an OS sandbox (`npm run candidate-build`).",
    `- Commands: ${commands}`,
    "",
    "## Baseline score",
    `- eval_run_id: \`${data.base.eval_run_id}\``,
    `- Overall: ${data.base.overall_score ?? "not established"} (${data.base.score_status ?? "no status"})`,
    "",
    "## Guardrails",
    guardrails,
    "",
    "## Owners",
    `- Required owners: ${data.required_owners.length ? data.required_owners.join(", ") : "none"}`,
    "",
    "## Release plan",
    `Once every required owner above approves this document at the patch digest quoted above ` +
    `(\`${data.patch_digest}\`), \`release_apply\` compares the currently released subject with ` +
    `\`${data.base_plugin_version_id}\`; if they differ it refuses \`stale_baseline\` and this ` +
    "candidate must be rebased, rebuilt and re-approved. Otherwise it applies exactly this patch " +
    "digest, runs the repository/release gates, and records the new subject version.",
    "",
    "## Rollback plan",
    `The release is judged on real use (\`release_verify\`). Once the released subject has ` +
    `${data.policy.minPostReleaseRuns} real runs, they are evaluated under the same protocol version ` +
    "as the baseline score above. A failed critical guardrail, or an overall score more than " +
    `${data.policy.regressionBand} below the baseline, rolls the release back to ` +
    `${data.plugin} ${data.declared_version}; otherwise the release is established.`,
    "",
    `release_attempt_id: \`${data.release_attempt_id}\` — initiative \`${initiative}\`.`,
    "",
  ].join("\n");
}

/** Writes `<initiative>/improvement.md`, gated (FR-48, FR-53: gated whenever `release_mode =
 *  promotable` and a candidate is built and gated — which is exactly the state `release_prepare`
 *  only ever calls this from). Returns the written path and byte count, or a
 *  refusal string — never throws, the same contract `documentGuards` itself answers in. */
export async function writeImprovementDoc(
  initiative: string, data: ImprovementDocInput,
): Promise<{ path: string; chars: number } | string> {
  const badInitiative = safeName(initiative, "initiative");
  if (badInitiative) return badInitiative;

  const body = renderBody(initiative, data);
  // DELIBERATE: the pool is resolved here rather than taken as an argument. This writer is
  // called from outside any transaction — `release_prepare` has already committed by the time it
  // asks for the document — so there is no caller's client to borrow, and a parameter would be
  // one more thing every caller has to have in hand to write a document.
  const p = db();
  if (!p) return "ERROR: no platform database — there is nowhere to write this document.";
  return writeGeneratedDoc(p, `${initiative}/improvement.md`, body, {
    title: `Improvement — ${data.plugin} ${data.declared_version}`,
    fields: { candidate_id: data.candidate_id, release_attempt_id: data.release_attempt_id },
  });
}
