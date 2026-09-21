/**
 * WHETHER A STEP MAY ADVANCE, DECIDED ON EVIDENCE AND RECORDED GATES AND ON NOTHING ELSE.
 *
 * This module knows nothing about which step it is scoring. It is handed outcome evidence,
 * the gaps still open against that outcome, and whether the gates the step is subject to were
 * recorded — and it answers whether that is enough. It has no list of steps, no order, and no
 * vocabulary belonging to any one flow, which is the whole reason it can live below the layer
 * that binds a flow's declared steps to a contract: a scorer that recognised the step would be
 * a scorer that could treat one step's thin evidence as another step's sufficiency.
 *
 * FOUR OBSERVATIONS ARE RECORDED AND NEVER CONSULTED. Bytes added, rounds elapsed, a model's
 * own confidence, an aggregate score. Each is a real measurement of something, and not one of
 * them is a measurement of whether the work is done. Half a megabyte of added text with a gap
 * still open is half a megabyte with a gap still open; a score of 98 is a number a scorer
 * produced, not a fact anybody verified. They arrive on the same input because the callers
 * have them and hiding them would only mean they were consulted somewhere with no record —
 * so they are carried into {@link ReadinessVerdict.disregarded} by name, with the reason each
 * was set aside, and a reader can see that they were seen and refused.
 *
 * AND THE CONVERSE, WHICH IS THE HALF THAT IS EASY TO LOSE. A twelve-byte correction that
 * carries its evidence and closes its gap ADVANCES. A rule written as "enough has changed"
 * fails in both directions at once — it passes padding and it blocks the one-line fix that was
 * the entire finding. Volume is not the measure in either direction.
 *
 * AN EPISODE IS KEYED BY WHAT IT AUDITS, NOT BY WHAT IT IS CALLED. {@link episodeKey} digests
 * the subject and the criteria and deliberately drops the label, so renaming an audit and
 * running it again lands on the same key and spends the same attempt budget. A caller's own
 * assertion that a run is "a retry" is an assertion, not recognition; it is carried as a
 * disregarded observation like the other four. A budget that resets because somebody typed a
 * new name is not a budget.
 *
 * EXHAUSTION IS NEVER A PASS, and it is not a failure either — it is a budget reaching its end
 * with the question still open. {@link ReadinessVerdict.exhausted} says so in its own field and
 * adds a blocker rather than touching `advance`, because the two are different facts and a
 * caller that conflates them will ship on the day it runs out of attempts.
 */
import { createHash } from "node:crypto";

/** What an audit episode is ABOUT. The label is what somebody called this run of it, and it is
 *  excluded from the key on purpose — see {@link episodeKey}. */
export interface AuditEpisode {
  readonly subjectRef: string;
  readonly criteriaRef: string;
  readonly label?: string;
}

/** Measurements that are real and are not grounds. Every one of these is recorded on the
 *  verdict and consulted by nothing. */
export interface ObservedSignals {
  readonly bytesAdded?: number;
  readonly roundsElapsed?: number;
  readonly modelConfidence?: number;
  readonly aggregateScore?: number;
  readonly renamedRetry?: boolean;
}

/** The episode an audit-bearing step is spending attempts inside.
 *
 *  `auditFindings` left undefined means NO COMPLETE AUDIT HAS REPORTED, which is a different
 *  state from an audit that reported zero findings, and neither is defaulted into the other.
 *  Zero findings from a complete audit is the strongest result available; no audit at all is
 *  the absence of a result. */
export interface AuditContext {
  readonly episode?: AuditEpisode;
  readonly priorEpisode?: AuditEpisode;
  readonly auditRoundsUsed?: number;
  readonly auditFindings?: number;
  readonly attemptBudget?: number;
}

/** Everything the judgement is made from. The three required fields are the grounds; the rest
 *  are context and observations. */
export interface ReadinessInput extends ObservedSignals, AuditContext {
  readonly evidence: readonly string[];
  readonly gaps: readonly string[];
  readonly gatesRecorded: boolean;
}

/** An observation that reached the judgement and was set aside, with the reason. Named so a
 *  reader can tell "nobody passed this" from "this was passed and refused". */
export interface DisregardedObservation {
  readonly observation: string;
  readonly value: string;
  readonly why: string;
}

/** What the evidence supports, what it does not, and what was ignored getting there. */
export interface ReadinessVerdict {
  readonly advance: boolean;
  readonly grounds: readonly string[];
  readonly blockers: readonly string[];
  readonly disregarded: readonly DisregardedObservation[];
  /** True only while a complete audit's findings are still open AND attempts remain. A clean
   *  audit is never made to burn the rest of its budget to prove it was clean. */
  readonly mustSpendRemainingRounds: boolean;
  /** True only when the episode's SUBJECT changed. A rename never resets a budget. */
  readonly budgetReset: boolean;
  /** Whether a complete audit has reported at all, and what it found. `not_reported` is not
   *  `clean`: the distinction is only real if it is observable, and this is where it is
   *  observed. A reader — or a probe — that could not tell them apart could not tell an
   *  implementation that defaults a missing count to zero from one that does not. */
  readonly audit: "not_reported" | "clean" | "findings";
  readonly episodeKey: string | null;
  /** Null when either the budget or the attempts used is unknown — never zero by default. */
  readonly attemptsRemaining: number | null;
  readonly exhausted: boolean;
}

/** The digest an episode's attempts are counted under: subject and criteria, never the label.
 *
 *  The separator is a newline and both halves are length-prefixed, so a subject ending in the
 *  separator cannot be re-split into a different pair — the same ambiguity a plain join has
 *  whenever the parts are caller-supplied text. */
export function episodeKey(episode: AuditEpisode): string {
  const part = (s: string): string => `${s.length}:${s}\n`;
  return createHash("sha256")
    .update(part(episode.subjectRef))
    .update(part(episode.criteriaRef))
    .digest("hex")
    .slice(0, 32);
}

const WHY: Readonly<Record<string, string>> = Object.freeze({
  bytesAdded:
    "byte delta observes bytes. It is not semantic progress, and a step that added nothing " +
    "but volume has established nothing",
  roundsElapsed:
    "rounds elapsed are a budget being spent, not a question being answered",
  modelConfidence:
    "a model's confidence in its own output is the output speaking about itself",
  aggregateScore:
    "an aggregate score is a number somebody produced from the work, never evidence about it",
  renamedRetry:
    "an episode is keyed by what it audits, so a rename or a retry of an equivalent audit " +
    "lands on the same key and spends the same budget whatever a caller asserts",
});

/**
 * The judgement. `advance` is COMPUTED from three things and three things only: that outcome
 * evidence exists, that no gap is still open against it, and that the gates this step is
 * subject to were recorded. Every other field on the input either explains the budget or is
 * recorded as disregarded.
 */
export function readiness(input: ReadinessInput): ReadinessVerdict {
  const grounds: string[] = [];
  const blockers: string[] = [];

  if (input.evidence.length === 0) {
    blockers.push("no outcome evidence is recorded, so there is nothing for the step to rest on");
  } else {
    for (const e of input.evidence) grounds.push(`outcome evidence ${e}`);
  }

  if (input.gatesRecorded) grounds.push("the gates this step is subject to are recorded");
  else blockers.push("the gates this step is subject to are not recorded");

  if (input.gaps.length > 0) {
    blockers.push(`${input.gaps.length} gap(s) still open: ${input.gaps.join(", ")}`);
  }

  // COMPUTED HERE, before anything about budgets is appended below. `advance` is the answer to
  // "is the evidence sufficient", and a budget cannot make insufficient evidence sufficient or
  // sufficient evidence insufficient.
  const advance = blockers.length === 0;

  const key = input.episode ? episodeKey(input.episode) : null;
  const priorKey = input.priorEpisode ? episodeKey(input.priorEpisode) : null;
  const budgetReset = key !== null && priorKey !== null && key !== priorKey;

  const attemptsRemaining =
    input.attemptBudget !== undefined && input.auditRoundsUsed !== undefined
      ? Math.max(0, input.attemptBudget - input.auditRoundsUsed)
      : null;
  const exhausted = attemptsRemaining === 0;
  if (exhausted && !advance) {
    blockers.push(
      "the attempt budget is spent with the question still open — exhaustion is a budget " +
      "reaching its end and is never a pass");
  }

  // Open findings from a COMPLETE audit are work still owed, and another attempt is how it
  // gets done — so the remaining attempts are owed too, while any remain. A clean audit owes
  // nothing, and neither does an episode with no attempts left.
  const mustSpendRemainingRounds =
    input.auditFindings !== undefined && input.auditFindings > 0
    && input.gaps.length > 0 && attemptsRemaining !== 0;

  const audit = input.auditFindings === undefined
    ? "not_reported" as const
    : input.auditFindings === 0 ? "clean" as const : "findings" as const;

  const disregarded: DisregardedObservation[] = [];
  const note = (observation: string, value: number | boolean | undefined): void => {
    if (value !== undefined) {
      disregarded.push(Object.freeze({ observation, value: String(value), why: WHY[observation] }));
    }
  };
  note("bytesAdded", input.bytesAdded);
  note("roundsElapsed", input.roundsElapsed);
  note("modelConfidence", input.modelConfidence);
  note("aggregateScore", input.aggregateScore);
  note("renamedRetry", input.renamedRetry);

  return Object.freeze({
    advance,
    grounds: Object.freeze(grounds),
    blockers: Object.freeze(blockers),
    disregarded: Object.freeze(disregarded),
    mustSpendRemainingRounds,
    budgetReset,
    audit,
    episodeKey: key,
    attemptsRemaining,
    exhausted,
  });
}
