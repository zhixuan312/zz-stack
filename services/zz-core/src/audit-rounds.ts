/**
 * Audit rounds: which sources are rounds, what each round read, and what the next move is once
 * a round has landed.
 *
 * A flow declares an audit as a stage that produces a source supporting the document it audits
 * (sdlc-flow: `sdlc-spec-audit` supports spec.md, `sdlc-plan-audit` supports plan.md). A source is
 * a round of that stage only when it names the stage — `source_add(..., stage)` — and supports
 * that document. Everything else supporting the document is material: a stakeholder's answers,
 * a decision taken elsewhere.
 *
 * How many rounds is a question of evidence, not of a count. `ROUND_BUDGET` is a resource limit
 * and never a pass criterion:
 *   - no round yet                         -> the first round is owed
 *   - the latest round read an older version -> the revision it caused is checked by another round,
 *     unless the stage declares `continue_on` and that round raised none of those weights: the
 *     revision answered findings that owe no further reading, and the audit is settled
 *   - the latest round reopens an agreement  -> the stakeholder decides, before anything proceeds
 *   - the budget is spent and the latest revision is unaudited -> the stakeholder decides
 *   - the latest round read the current version and reopened nothing -> the audit is settled
 * A stakeholder's decision is recorded as material supporting the document after the round,
 * which is what settles the two waiting states.
 */
import { ENVELOPE_BLOCK } from "@zz/contracts";
import type pg from "pg";

import { assessFamily } from "./semantic.js";
import { docRows, isCapturedCause, type DocRow } from "./indexing.js";
import type { RoundAssessments } from "./review-rounds.js";
import type { Chain } from "./write-guards.js";

const stripEnvelope = (s: string): string => s.replace(ENVELOPE_BLOCK, "");

/** The source rows an audit reads, as the fields this module routes on. The two live in the
 *  revision's own envelope payload — `stage` and `supports` name which round a source is, and
 *  `audits_version` says which PUBLIC version it read — so both are read off the row rather than
 *  parsed out of a file. */
const stageOf = (d: DocRow): string => (d.fields?.stage ?? "").trim();
const auditsVersionOf = (d: DocRow): number => Number(d.fields?.audits_version) || 1;
const addedAtOf = (d: DocRow): string => d.fields?.added_at ?? d.updated_at;
const sourceName = (d: DocRow): string => d.path.slice("sources/".length);

/** Rounds an audit may use before the stakeholder decides. The approved control-loop design:
 *  "up to three independent auditor dispatches as a provisional resource limit, never as a
 *  pass criterion". */
export const ROUND_BUDGET = 3;

/** The audit stage and audited document this source is a round of, or null when it is not a
 *  round: no stage named, or a stage that is not one producing a source supporting a listed
 *  document. */
export function auditRoundOf(chain: Chain, stage: string | undefined,
                             supports: string[]): { stage: string; document: string } | null {
  if (!stage) return null;
  const st = chain.stages.find((s) => s.name === stage && s.produces === "source");
  const doc = st && "supports" in st ? st.supports : undefined;
  return doc && supports.includes(doc) ? { stage, document: doc } : null;
}

interface Round { file: string; version: number; added_at: string; body: string }

type AuditWeight = "critical" | "high" | "medium" | "low";

/** What a flow declares about how an audit stage is routed: the rounds it may use, and the finding
 *  weights that owe another round once the document is revised (null: any revision owes one). */
interface AuditPolicy { budget: number; continueOn: readonly AuditWeight[] | null }

const NO_POLICY: AuditPolicy = { budget: ROUND_BUDGET, continueOn: null };

/** The policy a stage's manifest entry declares; a stage declaring neither field routes on `ROUND_BUDGET`. */
export const auditPolicyOf = (stage: { round_budget?: number; continue_on?: readonly AuditWeight[] }): AuditPolicy =>
  ({ budget: stage.round_budget ?? ROUND_BUDGET, continueOn: stage.continue_on ?? null });

const WEIGHTS: readonly string[] = ["critical", "high", "medium", "low"];
const LEDGER_BLOCK = /^```json\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** The weights a round's ledger raised, or null when it has no readable ledger: not exactly one
 *  ```json block, a block that does not parse, a `findings` that is not an array, or a weight
 *  outside the four lowercase values. */
function weightsRaised(round: Round): Set<string> | null {
  const blocks = [...stripEnvelope(round.body).matchAll(LEDGER_BLOCK)];
  if (blocks.length !== 1) return null;
  let ledger: unknown;
  try { ledger = JSON.parse(blocks[0][1]); } catch { return null; }
  const findings = ledger && typeof ledger === "object" ? (ledger as { findings?: unknown }).findings : undefined;
  if (!Array.isArray(findings)) return null;
  const out = new Set<string>();
  for (const f of findings) {
    const w = f && typeof f === "object" ? (f as { weight?: unknown }).weight : undefined;
    if (typeof w !== "string" || !WEIGHTS.includes(w)) return null;
    out.add(w);
  }
  return out;
}

/** The `continue_on` weights a round raised, in the manifest's order. An unreadable ledger is read
 *  as raising all of them: the conservative reading, which is today's behaviour. `readable` says
 *  which. */
function seriousOf(round: Round, continueOn: readonly AuditWeight[]): { raised: AuditWeight[]; readable: boolean } {
  const w = weightsRaised(round);
  return w ? { raised: continueOn.filter((c) => w.has(c)), readable: true }
           : { raised: [...continueOn], readable: false };
}

/** The documents a source bears on — the `doc_link` rows of kind `supports` its revision
 *  filed, which `docRows` reads onto the row. */
const supportsOf = (d: DocRow): string[] => d.supports;

/** The rounds of one audit stage on one document that read a version after `since`, oldest first. */
function roundsOf(sources: readonly DocRow[], stage: string, document: string, since: number): Round[] {
  const out: Round[] = [];
  for (const d of sources) {
    if (stageOf(d) !== stage || !supportsOf(d).includes(document) || auditsVersionOf(d) <= since) continue;
    out.push({ file: sourceName(d), version: auditsVersionOf(d), added_at: addedAtOf(d), body: d.body });
  }
  return out.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.file.localeCompare(b.file));
}

/** Material supporting the document that landed after a given moment and is neither a round nor a
 *  change's own cause: where a stakeholder's decision on a round is recorded. */
function decidedSince(sources: readonly DocRow[], document: string, since: string): boolean {
  return sources.some((d) =>
    !stageOf(d) && !isCapturedCause(d) && supportsOf(d).includes(document) && addedAtOf(d) > since);
}

/** An instant as milliseconds, from an ISO string or from a `timestamptz` column's own text
 *  (`2026-10-19 08:00:00.5+00`), which a string comparison with an ISO one would misorder. */
const msOf = (s: string): number => Date.parse(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));

/** Material supporting the document, neither a round nor a change's own cause, filed after the
 *  document's current version was approved: where a stakeholder accepts an approved version no round
 *  has read. */
function waivedAfter(sources: readonly DocRow[], document: string, approvedAt: string): boolean {
  const sealed = msOf(approvedAt);
  return sources.some((d) => !stageOf(d) && !isCapturedCause(d) && supportsOf(d).includes(document) &&
    msOf(addedAtOf(d)) > sealed);
}

/**
 * Ask the one question an audit round's routing depends on — does it reopen something already
 * agreed — record it, and say what came back. Runs inside `source_add`; an unavailable service is
 * recorded as such and the deterministic rule routes alone.
 *
 * DELIBERATE: `repeats_finding` is not asked. No move depends on it: a round on the current
 * version that reopens nothing already settles, and a new version after the last round owes a round
 * whether or not that round repeated the one before — its findings are what the version answered.
 */
export async function assessRound(p: pg.Pool, team: string, initiative: string,
                                  rel: string, document: string, content: string, by: string): Promise<string> {
  const file = rel.split("/").pop() ?? rel;
  const rows = await docRows(p, team, initiative);
  const agreed = rows.find((d) => d.path === document)?.body ?? "";
  // Persisted by `assessFamily` itself as the answer was taken: the `zz.assessment` row IS the
  // memo, and the `<initiative>/_assessments/*.json` file this used to write was a second copy of
  // it. A second copy is what drifts.
  // DELIBERATE: the recovery is `assess`, never the same `source_add`: the round is filed, and
  // sending it again files a second round of the same version.
  const answer = await assessFamily({ family: "changes_commitment", subject: content, context: stripEnvelope(agreed),
                                      initiative, about: `sources/${file}`, askedBy: by,
                                      recover: `Record it with \`assess\`: family "changes_commitment", initiative ` +
                                               `"${initiative}", about "sources/${file}", subject the \`content\` this ` +
                                               `call sent, and context ${document} as document_read answers it. Do not ` +
                                               "send this source again: it is filed, and a second would be a second round." });
  return `assessed: ${answer.family} = ${answer.reading}` +
    (answer.probability !== null ? ` (p=${answer.probability.toFixed(2)})` : "") +
    (answer.reason ? ` — ${answer.reason}` : "");
}

interface AuditMove { action: string; document: string; waiting_on: string; why: string }

/**
 * The next move an audited document owes, or null when its audit is settled.
 * `version` is the document's public version as it stands — the number a round records as
 * `audits_version` — never a stored row number, which also moves on a same-version draft.
 * `since` is the version the rounds count from: a plan's latest approved version before the
 * current one, because each phase is audited on its own budget and an approved phase's rounds
 * are spent on that phase; 0 for every other document. Asked of an approved document, and of the plan while it
 * is a draft: a plan phase is audited before its approval, so the round is owed before that gate
 * (`initiative_status`'s `auditedWhile`). `approvedAt` is the current version's own seal when it is
 * approved, null otherwise: what a stakeholder's acceptance of it unaudited must come after.
 * `policy` is what the stage's manifest declares; absent, the round budget is `ROUND_BUDGET` and any
 * revision owes a round.
 */
export function auditMove(initiative: string, stage: string, document: string,
                          version: number, sources: readonly DocRow[],
                          answers: RoundAssessments, since = 0, approvedAt: string | null = null,
                          policy: AuditPolicy = NO_POLICY): AuditMove | null {
  const rounds = roundsOf(sources, stage, document, since);
  const call = `source_add(initiative: "${initiative}", title, content, supports: ["${document}"], stage: "${stage}")`;
  if (!rounds.length) {
    // An approved version no round has read still owes its round (checks/document-version-causes.ts):
    // approving without the audit does not settle it. The stakeholder may accept it unaudited, as a
    // spent budget's decision does, by material filed after that approval (bug 12ec9d99). Material
    // from before it, such as the phase's execution report, is not that decision.
    if (approvedAt && waivedAfter(sources, document, approvedAt)) return null;
    // NOT A TOOL: `add_source` is next_move's own vocabulary; the call is source_add, named in `why`.
    return { action: "add_source", document, waiting_on: "agent",
             why: `${stage} is the next stage this flow declares and ` +
                  (since ? `no round of it has read a version after v${since}, the last one approved — ` +
                           "this phase is audited on its own budget. "
                         : "no round of it exists yet. ") +
                  `Dispatch round 1 on ${document} v${version}, then record it with ${call}. ` +
                  "Only a source naming its stage counts as a round." +
                  (approvedAt ? ` v${version} is approved: if the stakeholder accepts it unaudited, record their ` +
                                `decision with source_add(supports: ["${document}"]) and no stage instead.` : "") };
  }
  const last = rounds[rounds.length - 1];
  const n = rounds.length;
  const a = answers.get(`sources/${last.file}`)?.find((x) => x.family === "changes_commitment");
  const reopens = a?.reading === "yes";
  const decided = decidedSince(sources, document, last.added_at);
  if (reopens && last.version === version && !decided) {
    return { action: "decide", document, waiting_on: "stakeholder",
             why: `round ${n} (${last.file}) reopens something ${document} records as agreed ` +
                  `(changes_commitment p=${a?.probability?.toFixed(2)}). That is the ` +
                  `stakeholder's to decide, not the audit's: if they change the agreement, ` +
                  `document_edit ${document} with sources/${last.file} as its cause; if they keep it, record ` +
                  `their decision with source_add(supports: ["${document}"]) and the audit continues.` };
  }
  if (last.version < version) {
    const serious = policy.continueOn ? seriousOf(last, policy.continueOn) : null;
    // The revision answered findings that owe no further reading: settled (`auditSettledNote` says so).
    if (serious && !serious.raised.length) return null;
    if (n < policy.budget) {
      // NOT A TOOL: `add_source` is next_move's own vocabulary; the call is source_add, named in `why`.
      return { action: "add_source", document, waiting_on: "agent",
               why: serious
                 ? `round ${n} ${serious.readable ? `raised ${serious.raised.join(" and ")}` : "carries no readable ledger"}; ` +
                   `round ${n + 1} reads only what changed to answer it — dispatch it on ` +
                   `${document} v${version}, then ${call}.`
                 : `${document} is v${version}; round ${n} read v${last.version}. ` +
                   `Round ${n + 1} checks the new version — dispatch it, then ${call}.` };
    }
    if (!decided) {
      return { action: "decide", document, waiting_on: "stakeholder",
               why: `${policy.budget} rounds of ${stage} are spent and ${document} v${version} — the ` +
                    `version after round ${n} — has not been audited. The budget is a resource ` +
                    "limit, not a pass: the stakeholder decides whether v" + version + " proceeds " +
                    `unaudited or ${document} goes back to its stage. Record the decision with ` +
                    `source_add(supports: ["${document}"]).` };
    }
  }
  return null;
}

/**
 * The sentence that says why an audit needs no further round, or null. Returned only when the
 * stage declares `continue_on`, its latest round read a version before the current one, and that
 * round's ledger raised none of those weights (the first branch of `auditMove`'s third rule).
 * The stage name and the weights come from the manifest, never from this code.
 */
export function auditSettledNote(stage: string, document: string, version: number,
                                 sources: readonly DocRow[], policy: AuditPolicy, since = 0): string | null {
  if (!policy.continueOn) return null;
  const rounds = roundsOf(sources, stage, document, since);
  const last = rounds[rounds.length - 1];
  if (!last || last.version >= version || seriousOf(last, policy.continueOn).raised.length) return null;
  return `${stage} settled after round ${rounds.length}: it raised no ${policy.continueOn.join(" or ")} finding.`;
}
