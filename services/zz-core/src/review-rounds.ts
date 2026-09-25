/**
 * Review rounds: the bounded defect sweep a verifying document owes before it is approved.
 *
 * A flow declares a verifying document by giving it `verifies` (sdlc-flow: review.md verifies
 * spec.md and plan.md). A source is a round of that document's review when it names the stage
 * that writes the document — `source_add(..., stage)` — and supports it. Every round carries its
 * findings as one fenced ```json ledger, validated on `source_add` and refused by name when it
 * is malformed, because the next move is computed from it:
 *
 *   {"round": n, "scope": {"base": "<commit>", "head": "<commit>"},
 *    "findings": [{"id", "locator", "claim", "impact": "S1|S2|S3|S4",
 *                  "evidence": "reproduced|cited|inferred", "reproducer": "<check>|null",
 *                  "introduced_by_scope": true|false}],
 *    "resolved": [{"id", "by": "<commit or check>", "how": "fixed|not_reproduced"}]}
 *
 * A finding is resolved when a LATER round lists its id under `resolved`; restating an id in a
 * later round replaces what was said about it (an inferred finding that was reproduced is
 * restated with `evidence: "reproduced"`). A stakeholder source — material supporting the
 * document with no stage — that names a finding's id after it was stated accepts it as residual.
 *
 * A finding blocks when it is open, not accepted, S1 or S2, not read as a repeat of an earlier
 * round, and inside the round's declared scope — or S1 and reproduced, which blocks wherever it
 * is. S3 and S4 never open a round: they are fixed in a batch and the gate verifies them.
 *
 *   - no round yet                              -> dispatch round 1, the whole change
 *   - an evidenced (reproduced|cited) blocker   -> fix it, then a round over the fix diff only
 *   - only inferred blockers                    -> write the reproducer first (run_experiment)
 *   - ROUND_BUDGET rounds since the last stakeholder material, and the latest round raised no
 *     fewer new evidenced blockers than the one before (not converging) -> decide
 *   - nothing blocks                            -> settled; the acceptance evidence is next
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENVELOPE_BLOCK, parseEnvelope } from "@zz/contracts";

import { ROUND_BUDGET } from "./audit-rounds.js";
import { assessFamily, readRoundAssessmentList, writeRoundAssessments } from "./semantic.js";
import type { Chain } from "./write-guards.js";

const IMPACTS = ["S1", "S2", "S3", "S4"] as const;
const EVIDENCE_KINDS = ["reproduced", "cited", "inferred"] as const;
const RESOLUTIONS = ["fixed", "not_reproduced"] as const;

export interface Finding {
  id: string; locator: string; claim: string;
  impact: (typeof IMPACTS)[number]; evidence: (typeof EVIDENCE_KINDS)[number];
  reproducer: string | null; introduced_by_scope: boolean;
}
export interface Resolution { id: string; by: string; how: (typeof RESOLUTIONS)[number] }
export interface Ledger {
  round: number; scope: { base: string; head: string };
  findings: Finding[]; resolved: Resolution[];
}

const stripEnvelope = (s: string): string => s.replace(ENVELOPE_BLOCK, "");
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const supportsOf = (env: Record<string, string>) =>
  (env.supports || "").split(",").map((x) => x.trim()).filter(Boolean);

/** The verifying document this source is a review round of, or null: a stage that writes a
 *  document declaring `verifies`, and a source supporting that document. */
export function reviewRoundOf(chain: Chain, stage: string | undefined,
                              supports: string[]): { stage: string; document: string } | null {
  if (!stage) return null;
  const doc = chain.documents.find((d) => d.verifies?.length && d.stage === stage);
  return doc && supports.includes(doc.name) ? { stage, document: doc.name } : null;
}

/** The one ledger a round's content carries, or why it cannot be read. */
function parseLedger(content: string): Ledger | string {
  const blocks = [...content.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const parsed = blocks.map((b) => { try { return JSON.parse(b) as unknown; } catch { return undefined; } })
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && "round" in v);
  if (parsed.length !== 1) {
    return `a review round carries exactly one fenced \`\`\`json ledger with a "round" field; ` +
           `this content has ${parsed.length}`;
  }
  const j = parsed[0];
  const bad: string[] = [];
  if (!Number.isInteger(j.round) || (j.round as number) < 1) bad.push("`round` is not a positive integer");
  const scope = j.scope as Record<string, unknown> | undefined;
  if (!scope || !str(scope.base) || !str(scope.head)) bad.push("`scope` needs a `base` and a `head` commit");
  if (!Array.isArray(j.findings)) bad.push("`findings` is not an array (an empty round is `[]`)");
  if (j.resolved !== undefined && !Array.isArray(j.resolved)) bad.push("`resolved` is not an array");
  const findings = (Array.isArray(j.findings) ? j.findings : []) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  findings.forEach((f, i) => {
    const at = str(f.id) ? `finding ${f.id}` : `finding #${i + 1}`;
    if (!str(f.id)) bad.push(`${at} has no \`id\``);
    else if (seen.has(f.id)) bad.push(`${at} appears twice`);
    else seen.add(f.id);
    if (!str(f.locator)) bad.push(`${at} has no \`locator\``);
    if (!str(f.claim)) bad.push(`${at} has no \`claim\``);
    if (!IMPACTS.includes(f.impact as never)) bad.push(`${at}: \`impact\` must be one of ${IMPACTS.join(", ")}`);
    if (!EVIDENCE_KINDS.includes(f.evidence as never)) {
      bad.push(`${at}: \`evidence\` must be one of ${EVIDENCE_KINDS.join(", ")}`);
    }
    if (f.reproducer !== null && !str(f.reproducer)) bad.push(`${at}: \`reproducer\` is a check or command, or null`);
    if (f.evidence === "reproduced" && !str(f.reproducer)) {
      bad.push(`${at} says reproduced and names no \`reproducer\` — name the check or command that reproduced it`);
    }
    if (typeof f.introduced_by_scope !== "boolean") bad.push(`${at}: \`introduced_by_scope\` is true or false`);
  });
  const resolved = (Array.isArray(j.resolved) ? j.resolved : []) as Array<Record<string, unknown>>;
  resolved.forEach((r, i) => {
    const at = str(r.id) ? `resolved ${r.id}` : `resolved #${i + 1}`;
    if (!str(r.id)) bad.push(`${at} has no \`id\``);
    else if (seen.has(r.id)) bad.push(`${at} is also a finding of this round — restate it or resolve it, not both`);
    if (!str(r.by)) bad.push(`${at} has no \`by\` (the fixing commit, or the check that failed to reproduce it)`);
    if (!RESOLUTIONS.includes(r.how as never)) bad.push(`${at}: \`how\` must be one of ${RESOLUTIONS.join(", ")}`);
  });
  if (bad.length) return bad.join("; ");
  return { round: j.round as number, scope: { base: String(scope?.base), head: String(scope?.head) },
           findings: findings as unknown as Finding[], resolved: resolved as unknown as Resolution[] };
}

/** Why `source_add` refuses this round, or null. Checked before the source is written: sources
 *  are immutable, so a malformed ledger that landed could never be corrected. */
export function ledgerRefusal(content: string, earlier: Ledger[], document: string): string | null {
  const l = parseLedger(content);
  const lead = `ERROR: this ${document} review round is not recorded — `;
  if (typeof l === "string") return lead + l + ". The ledger's shape is in the sdlc-review skill.";
  const bad: string[] = [];
  if (l.round !== earlier.length + 1) {
    bad.push(`it says round ${l.round}, and ${earlier.length} round(s) are already recorded, so this is round ${earlier.length + 1}`);
  }
  const known = new Set(earlier.flatMap((e) => e.findings.map((f) => f.id)));
  const unknown = l.resolved.map((r) => r.id).filter((id) => !known.has(id));
  if (unknown.length) bad.push(`\`resolved\` names ${unknown.join(", ")}, which no earlier round reported`);
  return bad.length ? lead + bad.join("; ") : null;
}

interface ReviewRound { file: string; added_at: string; ledger: Ledger }

/** The recorded rounds of one review, oldest first. A source that names the stage but whose
 *  ledger no longer parses (it cannot have landed through source_add) is skipped. */
export function reviewRounds(dir: string, stage: string, document: string): ReviewRound[] {
  const src = join(dir, "sources");
  if (!existsSync(src)) return [];
  const out: ReviewRound[] = [];
  for (const f of readdirSync(src).filter((x) => x.endsWith(".md"))) {
    const text = readFileSync(join(src, f), "utf8");
    const env = parseEnvelope(text);
    if (env.stage !== stage || !supportsOf(env).includes(document)) continue;
    const ledger = parseLedger(stripEnvelope(text));
    if (typeof ledger !== "string") out.push({ file: f, added_at: env.added_at || "", ledger });
  }
  return out.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.file.localeCompare(b.file));
}

interface StakeholderSource { file: string; added_at: string; body: string }

/** Material supporting the document that no stage produced: a stakeholder's decision, their
 *  acceptance of a residual finding, their deferral of a criterion. */
export function stakeholderSources(dir: string, document: string): StakeholderSource[] {
  const src = join(dir, "sources");
  if (!existsSync(src)) return [];
  return readdirSync(src).filter((x) => x.endsWith(".md")).flatMap((f) => {
    const text = readFileSync(join(src, f), "utf8");
    const env = parseEnvelope(text);
    return !env.stage && supportsOf(env).includes(document)
      ? [{ file: f, added_at: env.added_at || "", body: stripEnvelope(text) }] : [];
  }).sort((a, b) => a.added_at.localeCompare(b.added_at));
}

/** Whether `text` names `id` as a whole token — `R1-C1` is not named by `R1-C10`. */
export function names(text: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}(?![A-Za-z0-9_])`).test(text);
}

/**
 * Ask `repeats_finding` of each S1/S2 finding this round introduces (a new id), against every
 * earlier round's findings. S3/S4 answers would route nothing, so they are not asked. Runs
 * inside `source_add`, after the round is written.
 */
export async function assessReviewRound(root: string, initiative: string, rel: string,
                                        stage: string, document: string, by: string): Promise<string> {
  const dir = join(root, initiative);
  const file = rel.split("/").pop() ?? rel;
  const rounds = reviewRounds(dir, stage, document);
  const own = rounds.find((r) => r.file === file);
  if (!own) return "";
  const earlier = rounds.filter((r) => r.file !== file);
  const known = new Set(earlier.flatMap((r) => r.ledger.findings.map((f) => f.id)));
  const asked = own.ledger.findings.filter((f) => (f.impact === "S1" || f.impact === "S2") && !known.has(f.id));
  if (!earlier.length || !asked.length) return "";
  const context = earlier.map((r) => `## Round ${r.ledger.round}\n` + r.ledger.findings
    .map((f) => `- ${f.id} [${f.impact}] ${f.locator}: ${f.claim}`).join("\n")).join("\n\n");
  const answers = await Promise.all(asked.map((f) => assessFamily({
    family: "repeats_finding", subject: `${f.id} [${f.impact}] ${f.locator}: ${f.claim}`, context,
    initiative, about: `sources/${file}#${f.id}`, askedBy: by })));
  writeRoundAssessments(root, initiative, file, answers);
  return "assessed: " + answers.map((a, i) => `repeats_finding(${asked[i].id}) = ${a.reading}` +
    (a.probability !== null ? ` (p=${a.probability.toFixed(2)})` : "")).join("; ");
}

interface FindingState {
  finding: Finding; round: number; open: boolean; accepted: boolean; repeat: boolean; blocking: boolean;
}

/**
 * What each finding stands at after every round, in the order first reported. Pure: the rounds,
 * the `repeats_finding` reading of each introduced id, and the stakeholder material are given.
 */
function findingStates(rounds: ReviewRound[], repeats: (file: string, id: string) => string | undefined,
                              decisions: StakeholderSource[]): FindingState[] {
  const latest = new Map<string, { finding: Finding; index: number; at: string; introduced: string }>();
  const resolvedAt = new Map<string, number>();
  rounds.forEach((r, i) => {
    for (const f of r.ledger.findings) {
      latest.set(f.id, { finding: f, index: i, at: r.added_at, introduced: latest.get(f.id)?.introduced ?? r.file });
    }
    for (const x of r.ledger.resolved) resolvedAt.set(x.id, i);
  });
  return [...latest.values()].map(({ finding: f, index, at, introduced }) => {
    const open = !((resolvedAt.get(f.id) ?? -1) > index);
    const accepted = decisions.some((d) => d.added_at > at && names(d.body, f.id));
    const repeat = repeats(introduced, f.id) === "yes";
    const serious = f.impact === "S1" || f.impact === "S2";
    const inScope = f.introduced_by_scope || (f.impact === "S1" && f.evidence === "reproduced");
    return { finding: f, round: rounds[index].ledger.round, open, accepted, repeat,
             blocking: open && !accepted && !repeat && serious && inScope };
  });
}

interface ReviewMove { action: string; document: string; waiting_on: string; why: string }

/** The next move a review owes, from what is recorded. Pure: `reviewMove` reads the store and
 *  hands it everything it decides on. */
function routeReview(initiative: string, stage: string, document: string, rounds: ReviewRound[],
                            repeats: (file: string, id: string) => string | undefined,
                            decisions: StakeholderSource[]): ReviewMove | null {
  const call = `source_add(initiative: "${initiative}", title, content, supports: ["${document}"], stage: "${stage}")`;
  if (!rounds.length) {
    // NOT A TOOL: `add_source` is next_move's own vocabulary; the call is source_add, named in `why`.
    return { action: "add_source", document, waiting_on: "agent",
             why: `once the plan is built — building leaves nothing the platform can see — ${stage} ` +
                  `owes round 1 on ${document}: a full-scope sweep of the whole change since the ` +
                  `plan's base, by a reader who did not write it. Record it with ${call}, its ` +
                  "content carrying the round's ```json ledger. Only a source naming its stage counts as a round." };
  }
  const n = rounds.length;
  const states = findingStates(rounds, repeats, decisions);
  const blocking = states.filter((s) => s.blocking);
  if (!blocking.length) return null;
  const lastDecision = decisions.length ? decisions[decisions.length - 1].added_at : "";
  const sinceDecision = rounds.filter((r) => r.added_at > lastDecision).length;
  const ids = (xs: FindingState[]) => xs.map((s) => `${s.finding.id} (${s.finding.impact}, ${s.finding.evidence})`).join(", ");
  // Convergence: how many evidenced blockers each round raised for the first time. A review whose
  // rounds keep finding fewer is converging and is let run; the budget stops one that is not —
  // three rounds since the stakeholder last decided, and the latest raised at least as many new
  // evidenced blockers as the round before it.
  const seen = new Set<string>();
  const raised = rounds.map((r) => r.ledger.findings.filter((f) => {
    const fresh = !seen.has(f.id);
    seen.add(f.id);
    return fresh && (f.impact === "S1" || f.impact === "S2") && f.evidence !== "inferred" &&
      (f.introduced_by_scope || (f.impact === "S1" && f.evidence === "reproduced")) &&
      repeats(r.file, f.id) !== "yes";
  }).length);
  const last = raised[n - 1];
  const stalled = last > 0 && (n < 2 || last >= raised[n - 2]);
  if (sinceDecision >= ROUND_BUDGET && stalled) {
    return { action: "decide", document, waiting_on: "stakeholder",
             why: `${sinceDecision} rounds of ${stage} since the stakeholder last decided, round ${n} raised ` +
                  `${last} new evidenced blocker(s) — no fewer than the round before, so the review is not ` +
                  `converging — and ${ids(blocking)} still block. The budget is a resource limit, not a pass: the ` +
                  "stakeholder decides. Record it with " +
                  `source_add(initiative: "${initiative}", title, content, supports: ["${document}"]): ` +
                  "any such source renews the budget, and one naming a finding's id also accepts it as residual." };
  }
  const evidenced = blocking.filter((s) => s.finding.evidence !== "inferred");
  if (evidenced.length) {
    return { action: "fix", document, waiting_on: "agent",
             why: `round ${n} leaves ${ids(evidenced)} open. Fix them, then dispatch round ${n + 1} ` +
                  "whose scope is ONLY the fix diff and its blast radius, listing each fixed id under " +
                  `\`resolved\` with the fixing commit; record it with ${call}.` };
  }
  return { action: "run_experiment", document, waiting_on: "agent",
           why: `${ids(blocking)} ${blocking.length === 1 ? "is" : "are"} inferred, not shown. A ` +
                "verification gap is closed by running, not by another reading: write the reproducer " +
                `(a failing check) first, then dispatch round ${n + 1} over it — restate the finding ` +
                "with evidence `reproduced` and its reproducer, or list it under `resolved` as " +
                `\`not_reproduced\` by that check; record it with ${call}.` };
}

/** The next move a verifying document's review owes, or null when the rounds are settled. */
export function reviewMove(root: string, initiative: string, stage: string, document: string): ReviewMove | null {
  const dir = join(root, initiative);
  const rounds = reviewRounds(dir, stage, document);
  const readings = new Map(rounds.map((r) => [r.file, readRoundAssessmentList(root, initiative, r.file)]));
  const repeats = (file: string, id: string) => readings.get(file)
    ?.find((a) => a.family === "repeats_finding" && a.about === `sources/${file}#${id}`)?.reading;
  return routeReview(initiative, stage, document, rounds, repeats, stakeholderSources(dir, document));
}

/** The out-of-scope findings still open that `## Backlog` in the document does not name. */
export function unbackloggedFindings(root: string, initiative: string, stage: string, document: string,
                                     body: string): string[] {
  const dir = join(root, initiative);
  const rounds = reviewRounds(dir, stage, document);
  if (!rounds.length) return [];
  const backlog = /^##[ \t]+Backlog[ \t]*$([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const decisions = stakeholderSources(dir, document);
  return findingStates(rounds, () => undefined, decisions)
    .filter((s) => s.open && !s.accepted && !s.finding.introduced_by_scope && !names(backlog, s.finding.id))
    .map((s) => `${s.finding.id} (${s.finding.impact})`);
}
