/**
 * Whether a step may advance, decided on evidence and recorded gates and nothing else.
 *
 * This module knows nothing about which step it is scoring. It is handed outcome evidence, the
 * gaps still open against that outcome, and whether the gates the step is subject to were
 * recorded. It has no list of steps, no order, and no vocabulary belonging to any one flow, so
 * it cannot treat one step's thin evidence as another step's sufficiency.
 *
 * Four observations are recorded and never consulted: bytes added, rounds elapsed, a model's
 * own confidence, an aggregate score. None measures whether the work is done. They arrive on
 * the same input because the callers have them, and they are carried into
 * {@link ReadinessVerdict.disregarded} by name with the reason each was set aside.
 *
 * Volume is not the measure in either direction: a twelve-byte correction that carries its
 * evidence and closes its gap advances.
 *
 * An episode is keyed by what it audits, not by what it is called. {@link episodeKey} digests
 * the subject and the criteria and drops the label, so renaming an audit and running it again
 * lands on the same key and spends the same attempt budget.
 *
 * Exhaustion is never a pass and is not a failure: {@link ReadinessVerdict.exhausted} says so
 * in its own field and adds a blocker rather than touching `advance`.
 */
import { createHash } from "node:crypto";

/** What an audit episode is about. The label is what somebody called this run of it, and it is
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
 *  `auditFindings` left undefined means no complete audit has reported, which is a different
 *  state from an audit that reported zero findings. Neither is defaulted into the other. */
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
  /** True only when the episode's subject changed. A rename never resets a budget. */
  readonly budgetReset: boolean;
  /** Whether a complete audit has reported at all, and what it found. `not_reported` is not
   *  `clean`, and this is where that distinction becomes observable — including to a probe
   *  telling an implementation that defaults a missing count to zero from one that does not. */
  readonly audit: "not_reported" | "clean" | "findings";
  readonly episodeKey: string | null;
  /** Null when either the budget or the attempts used is unknown — never zero by default. */
  readonly attemptsRemaining: number | null;
  readonly exhausted: boolean;
}

/** The digest an episode's attempts are counted under: subject and criteria, never the label.
 *
 *  The separator is a newline and both halves are length-prefixed, so a subject ending in the
 *  separator cannot be re-split into a different pair. */
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
 * The judgement. `advance` is computed from three things only: that outcome evidence exists,
 * that no gap is still open against it, and that the gates this step is subject to were
 * recorded. Every other input field either explains the budget or is recorded as disregarded.
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

  // Computed before anything about budgets is appended below: a budget cannot make
  // insufficient evidence sufficient, or sufficient evidence insufficient.
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

  // Open findings from a complete audit are work still owed, so the remaining attempts are
  // owed too while any remain. A clean audit owes nothing, and neither does an episode with no
  // attempts left.
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
