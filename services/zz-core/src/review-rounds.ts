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
import type pg from "pg";

import { ROUND_BUDGET } from "./audit-rounds.js";
import { refusalText } from "./document-details.js";
import { docRows, type DocRow } from "./indexing.js";
import { assessFamily, type Assessment } from "./semantic.js";

/** The answers already recorded for an initiative's sources, keyed by the `about` they were asked
 *  under — `sources/<file>` for a round's own question, `sources/<file>#<finding id>` for the
 *  repeat question that follows it.
 *
 *  COUPLED: these are `zz.assessment` ROWS, and the caller reads them with one query.
 *  `assessFamily` persists every answer as it is taken, so the memo is the record and nothing has
 *  to be written beside it — the `<initiative>/_assessments/*.json` files this used to read were a
 *  second copy of rows that already existed, and a second copy is what drifts.
 *
 *  The map is a PARAMETER and not a query made here, so `reviewMove` stays a pure function of what
 *  its caller holds: the same rule the source rows follow. */
export type RoundAssessments = ReadonlyMap<string, readonly Assessment[]>;

/** Every typed answer recorded against one initiative, keyed by the `about` it was asked under.
 *
 *  COUPLED: `zz.assessment` is where `assessFamily` puts every answer as it takes it, including
 *  the `unavailable` ones — a reading of unavailable is a fact about the service, and a caller
 *  that re-asks on the strength of it is answered by the reading rather than by a missing row. */
export async function assessmentsFor(
  p: pg.Pool, team: string, initiative: string,
): Promise<RoundAssessments> {
  const out = new Map<string, Assessment[]>();
  if (!team) return out;
  const { rows } = await p.query<{
    family: string; instruction_version: number; question_digest: string;
    reading: Assessment["reading"]; probability: string | null;
    resolved_model: string | null; identity_assurance: string | null; reason: string | null;
    initiative: string | null; about: string | null; asked_by: string; asked_at: string;
  }>(
    // COUPLED: `requested_model` is NOT selected, and the column is not there to select. Phase 2
    // retired it from `zz.assessment` — `checks/dropped-columns.ts` still watches for it and
    // reports a statement that reaches for it. `Assessment.requested_model` survives because
    // `assessFamily` sets it in memory from the typed call; a row cannot carry it, so a reader
    // answers null rather than inventing one.
    `select a.family, a.instruction_version, a.question_digest, a.reading,
            a.probability::text as probability, a.resolved_model,
            a.identity_assurance, a.reason, i.slug as initiative, a.about,
            p.email as asked_by, a.asked_at::text as asked_at
       from zz.assessment a
       join zz.initiative i on i.id = a.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.principal p on p.id = a.asked_by
      where t.slug = $1 and i.slug = $2 and a.about is not null
      order by a.asked_at, a.id`, [team, initiative]);
  for (const r of rows) {
    const list = out.get(r.about as string) ?? [];
    list.push({ ...r, requested_model: null,
                probability: r.probability === null ? null : Number(r.probability) });
    out.set(r.about as string, list);
  }
  return out;
}
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
interface Ledger {
  round: number; scope: { base: string; head: string };
  findings: Finding[]; resolved: Resolution[];
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** The source rows a review reads. `stage` is the revision's own envelope payload, `added_at`
 *  the day `source_add` stamped, `supports` the `doc_link` rows the revision filed, and `body`
 *  the revision's bytes. */
const stageOf = (d: DocRow): string => (d.fields?.stage ?? "").trim();
const addedAtOf = (d: DocRow): string => d.fields?.added_at ?? d.updated_at;
const sourceName = (d: DocRow): string => d.path.slice("sources/".length);
const supportsOf = (d: DocRow): string[] => d.supports;

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
  const read = inspectLedger(content);
  return "error" in read ? read.error : read.bad.length ? read.bad.join("; ") : read.ledger;
}

/** The ledger a round's content carries as far as it can be read, and every shape problem in it —
 *  or, when there is not exactly one ledger, why. What reads as a round number and a `resolved`
 *  list is kept even beside shape problems, so the checks on those still run. */
function inspectLedger(content: string): { error: string } | { ledger: Ledger; bad: string[] } {
  const blocks = [...content.matchAll(/```json[ \t]*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const parsed = blocks.map((b) => { try { return JSON.parse(b) as unknown; } catch { return undefined; } })
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && "round" in v);
  if (parsed.length !== 1) {
    return { error: `a review round carries exactly one fenced \`\`\`json ledger with a "round" field; ` +
                    `this content has ${parsed.length}` };
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
  return { bad, ledger: { round: j.round as number, scope: { base: String(scope?.base), head: String(scope?.head) },
                          findings: findings as unknown as Finding[], resolved: resolved as unknown as Resolution[] } };
}

/** Why `source_add` refuses this round, or null. Checked before the source is written: sources
 *  are immutable, so a malformed ledger that landed could never be corrected. */
export function ledgerRefusal(content: string, earlier: Ledger[], document: string): string | null {
  const read = inspectLedger(content);
  const lead = `ERROR: this ${document} review round is not recorded — `;
  const skill = ". The ledger's shape is in the sdlc-review skill.";
  if ("error" in read) return lead + read.error + skill;
  // Every shape problem, and the round number and the ids it resolves as far as they read: none
  // of these depends on another, so a ledger with several is refused once, with all of them.
  const { ledger: l, bad } = read;
  const shape = bad.length;
  if (Number.isInteger(l.round) && l.round !== earlier.length + 1) {
    bad.push(`it says round ${l.round}, and ${earlier.length} round(s) are already recorded, so this is round ${earlier.length + 1}`);
  }
  const known = new Set(earlier.flatMap((e) => e.findings.map((f) => f.id)));
  const unknown = l.resolved.map((r) => r.id).filter((id) => str(id) && !known.has(id));
  if (unknown.length) bad.push(`\`resolved\` names ${unknown.join(", ")}, which no earlier round reported`);
  return bad.length ? refusalText([{ lead, label: "problems", items: bad, sep: "; ", tail: shape ? skill : "" }]) : null;
}

interface ReviewRound { file: string; added_at: string; ledger: Ledger }

/** The recorded rounds of one review, oldest first. A source that names the stage but whose
 *  ledger no longer parses (it cannot have landed through source_add) is skipped. */
export function reviewRounds(sources: readonly DocRow[], stage: string, document: string): ReviewRound[] {
  const out: ReviewRound[] = [];
  for (const d of sources) {
    // DELIBERATE: the STAGE identifies a round, and a `supports` link only corroborates it. A stage
    // writes one verifying document, and `source_add` refuses a round that does not name it — but
    // round 1 is recorded before that document exists, and a support for a document not yet
    // written files no link (`doc_link` needs a row to point at). Keyed on the link, every first
    // round counted as none, so round 2 was refused as round 1 and `next_move` asked for round 1
    // forever (bug c92d1bb1). A link naming ANOTHER document still rules the source out.
    const links = supportsOf(d);
    if (stageOf(d) !== stage || (links.length > 0 && !links.includes(document))) continue;
    const ledger = parseLedger(d.body);
    if (typeof ledger !== "string") {
      out.push({ file: sourceName(d), added_at: addedAtOf(d), ledger });
    }
  }
  return out.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.file.localeCompare(b.file));
}

interface StakeholderSource { file: string; added_at: string; body: string }

/** Material supporting the document that no stage produced: a stakeholder's decision, their
 *  acceptance of a residual finding, their deferral of a criterion. */
export function stakeholderSources(sources: readonly DocRow[], document: string): StakeholderSource[] {
  return sources
    .filter((d) => !stageOf(d) && supportsOf(d).includes(document))
    .map((d) => ({ file: sourceName(d), added_at: addedAtOf(d), body: d.body }))
    .sort((a, b) => a.added_at.localeCompare(b.added_at));
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
export async function assessReviewRound(p: pg.Pool, team: string, initiative: string, rel: string,
                                        stage: string, document: string, by: string): Promise<string> {
  const file = rel.split("/").pop() ?? rel;
  const rounds = reviewRounds(await docRows(p, team, initiative), stage, document);
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
  // Persisted by `assessFamily` itself as each answer was taken, so the memo IS the record.
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
export function reviewMove(initiative: string, stage: string, document: string,
                           sources: readonly DocRow[], answers: RoundAssessments): ReviewMove | null {
  const rounds = reviewRounds(sources, stage, document);
  const repeats = (file: string, id: string) => answers.get(`sources/${file}#${id}`)
    ?.find((a) => a.family === "repeats_finding")?.reading;
  return routeReview(initiative, stage, document, rounds, repeats, stakeholderSources(sources, document));
}

/** The out-of-scope findings still open that `## Backlog` in the document does not name. */
export function unbackloggedFindings(stage: string, document: string,
                                     body: string, sources: readonly DocRow[]): string[] {
  const rounds = reviewRounds(sources, stage, document);
  if (!rounds.length) return [];
  const backlog = /^##[ \t]+Backlog[ \t]*$([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const decisions = stakeholderSources(sources, document);
  return findingStates(rounds, () => undefined, decisions)
    .filter((s) => s.open && !s.accepted && !s.finding.introduced_by_scope && !names(backlog, s.finding.id))
    .map((s) => `${s.finding.id} (${s.finding.impact})`);
}
