/**
 * PLANTING EACH FAULT THIS CONTROLLER CLAIMS TO CATCH, AND WATCHING THE DETECTOR FIRE.
 *
 * A sibling task in this initiative shipped a detector that shared its mechanism's assumption,
 * and so fell silent at exactly the moment the mechanism broke — green forever, proving
 * nothing. Every rule below is therefore exercised twice: once on a subject where the detector
 * must stay SILENT, and once with a specific fault planted, where it must FIRE. A row whose
 * `fires` is false is a finding about this module, not about its subject.
 *
 * THE SILENT HALF IS THE HALF THAT MATTERS HERE, and more than usually so. This controller's
 * job is mostly refusal, and a controller that refused everything would satisfy every faulted
 * column in the table while being completely useless. So the healthy column of the four
 * volume rows is the twelve-byte evidenced correction: the smallest possible change, which
 * ADVANCES, because it carries its evidence and closed its gap. A rule that let half a
 * megabyte through would also block that fix, and both halves are the same defect.
 *
 * THE FIXTURE PROFILE IS SEVEN GENERIC STEPS AND THAT IS DELIBERATE. This package is below the
 * layer that binds a flow's declared steps to contracts, and it has no step vocabulary of its
 * own — the profile here is built out of `s1`..`s7` to show that a seven-step profile resolves
 * every one of its contracts through the one controller, without this file knowing or being
 * able to know what any real flow calls them. What the real flow declares is checked where the
 * declaration lives, against the catalog, not here.
 *
 * NOTHING HERE IS A MEASUREMENT. The byte counts, the confidence and the score are invented
 * inputs chosen to be individually enormous, so that "each is insufficient ON ITS OWN" is what
 * the table actually shows.
 */
import {
  episodeKey,
  readiness,
  type AuditEpisode,
  type DisregardedObservation,
  type ReadinessInput,
} from "./readiness.js";
import {
  createController,
  type ExecutionIdentity,
  type ControlState,
  type ExecutionProfile,
  type OutcomeState,
  type RefusalKind,
  type StageAdmission,
  type StageController,
  type StageEntry,
  type StageOutcome,
  type StageRefusal,
  type StageSettlement,
  type StageSettlementResult,
  type StepContract,
} from "./stage-control.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface StageControlProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (
  detector: string,
  healthy: [boolean, string],
  faulted: [boolean, string],
): StageControlProbeRow => Object.freeze({
  detector,
  healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
  faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
  fires: healthy[0] && faulted[0],
});

// ── the fixtures ───────────────────────────────────────────────────────────────────────────

const PROFILE_REF = "fixture://profile/seven-step";

/** Seven bound contracts. Each step after the first requires the one before it to have left
 *  evidence behind, which is what makes the missing-entry-evidence row a real entry and not a
 *  contrived one. */
const STEP_CONTRACTS: readonly StepContract[] = Object.freeze(
  Array.from({ length: 7 }, (_, i): StepContract => Object.freeze({
    step: `s${i + 1}`,
    intendedChange: `the change step ${i + 1} is bound to make`,
    entryEvidence: i === 0 ? Object.freeze([]) : Object.freeze([`ground-from-s${i}`]),
    gates: Object.freeze([`gate-s${i + 1}`]),
  })),
);

const PROFILE: ExecutionProfile = Object.freeze({ profileRef: PROFILE_REF, steps: STEP_CONTRACTS });
const IDENTITY: ExecutionIdentity = Object.freeze({ executionRef: "fixture://execution/1", profileRef: PROFILE_REF });

/** The grounds base every noise row is built on: no evidence, one open gap, no gate recorded.
 *  Whatever is spread on top of it, the answer is no. */
const NO_GROUNDS: ReadinessInput = Object.freeze({
  evidence: Object.freeze([]), gaps: Object.freeze(["g1"]), gatesRecorded: false,
});

/** Twelve bytes, evidenced, gap closed, gates recorded. The smallest thing that advances. */
const SMALL_CORRECTION = readiness({
  evidence: ["e1"], gaps: [], gatesRecorded: true, bytesAdded: 12,
});

const SUBJECT: AuditEpisode = Object.freeze({ subjectRef: "fixture://doc/7", criteriaRef: "fixture://criteria/a" });

// ── the rows ───────────────────────────────────────────────────────────────────────────────

/** The four observations that are not grounds, each planted alone. */
function noiseRows(): StageControlProbeRow[] {
  const noise = [
    ["half a megabyte of added text", { bytesAdded: 500_000 }],
    ["three rounds elapsed", { roundsElapsed: 3 }],
    ["a model's own confidence of 0.99", { modelConfidence: 0.99 }],
    ["an aggregate score of 98", { aggregateScore: 98 }],
  ] as const;
  return noise.map(([label, signal]) => {
    const r = readiness({ ...NO_GROUNDS, ...signal });
    const [name] = Object.keys(signal);
    const noted: DisregardedObservation | undefined = r.disregarded.find((d) => d.observation === name);
    return row(
      `${label} stands in for evidence`,
      [SMALL_CORRECTION.advance,
        "a twelve-byte evidenced correction that closed its gap advances on its evidence"],
      [!r.advance && noted !== undefined,
        `with an open gap and no recorded gate it does not advance, and ${name} is recorded ` +
        "as disregarded rather than dropped"],
    );
  });
}

/** The budget rules: a clean audit owes nothing, a renamed one resets nothing, and running out
 *  of attempts is not an answer. */
function budgetRows(): StageControlProbeRow[] {
  const clean = readiness({
    evidence: ["e1"], gaps: [], gatesRecorded: true, auditRoundsUsed: 1, auditFindings: 0,
  });
  const owing = readiness({
    ...NO_GROUNDS, auditRoundsUsed: 1, auditFindings: 2, attemptBudget: 3,
  });
  const renamed = readiness({
    ...NO_GROUNDS,
    auditRoundsUsed: 3,
    renamedRetry: true,
    episode: { ...SUBJECT, label: "a new name for the same audit" },
    priorEpisode: SUBJECT,
  });
  const moved = readiness({
    ...NO_GROUNDS,
    episode: { subjectRef: "fixture://doc/8", criteriaRef: "fixture://criteria/a" },
    priorEpisode: SUBJECT,
  });
  const spent = readiness({ ...NO_GROUNDS, auditRoundsUsed: 3, attemptBudget: 3 });
  const remaining = readiness({
    evidence: ["e1"], gaps: [], gatesRecorded: true, auditRoundsUsed: 1, attemptBudget: 3,
  });
  const unaudited = readiness({ ...NO_GROUNDS, auditRoundsUsed: 1, attemptBudget: 3 });

  return [
    row("a clean audit is made to spend its remaining attempts",
      [!clean.mustSpendRemainingRounds && clean.advance,
        "a complete audit with no findings advances and owes no further attempt"],
      [owing.mustSpendRemainingRounds,
        "two open findings with attempts left do owe another attempt, so the flag is computed " +
        "and not a constant"]),
    row("no complete audit is read as a clean one",
      [clean.audit === "clean" && !clean.mustSpendRemainingRounds,
        "auditFindings: 0 is reported as a complete audit that found nothing"],
      [unaudited.audit === "not_reported" && !unaudited.mustSpendRemainingRounds,
        "auditFindings left undefined is reported as no audit at all — an implementation " +
        "that defaulted the missing count to zero would say clean here and this row would " +
        "MISS, which is the only reason the distinction is observable"]),
    row("a renamed retry resets the episode's budget",
      [!renamed.budgetReset && renamed.episodeKey === episodeKey(SUBJECT),
        "relabelling the same subject and criteria keeps the same episode key, so the budget " +
        "carries"],
      [moved.budgetReset,
        "a genuinely different subject is a different episode and does reset, so the flag is " +
        "computed from the key rather than from the caller's claim"]),
    row("exhausted attempts read as a pass",
      [remaining.advance && !remaining.exhausted,
        "an episode with attempts left is decided on its evidence, not on its budget"],
      [spent.exhausted && !spent.advance
        && spent.blockers.some((b) => b.includes("never a pass")),
        "a spent budget with the question open is reported as exhausted, does not advance, " +
        "and says so in a blocker"]),
  ];
}

/** What a settlement concluded, or null where it was refused — so a row can assert the state
 *  without re-testing the discriminant each time. */
const stateOf = (r: StageSettlementResult): OutcomeState | null => (r.settled ? r.outcome.state : null);

/** Why an entry was turned away, or null where it was admitted. */
const refusalOf = (a: StageAdmission): StageRefusal | null => (a.admitted ? null : a.refusal);

/** Just the reason, for the rows that assert which refusal came back and nothing more. */
const kindOf = (a: StageAdmission): RefusalKind | null => refusalOf(a)?.kind ?? null;

/** The controller's own refusals, and the state it computes rather than accepts. */
function controllerRows(): StageControlProbeRow[] {
  const c: StageController = createController(PROFILE);
  const first = c.admit({ identity: IDENTITY, step: "s1", revision: 0, evidenceHeld: [] });
  const ungrounded = c.admit({ identity: IDENTITY, step: "s2", revision: 0, evidenceHeld: [] });
  const grounded = c.admit({ identity: IDENTITY, step: "s2", revision: 0, evidenceHeld: ["ground-from-s1"] });
  const unknown = c.admit({ identity: IDENTITY, step: "s8", revision: 0, evidenceHeld: [] });
  const foreign = c.admit({
    identity: { executionRef: IDENTITY.executionRef, profileRef: "fixture://profile/other" },
    step: "s1", revision: 0, evidenceHeld: [],
  });

  // Every bound step resolved through this one controller, each at the revision the last one
  // left behind — which is also what shows the revision moving.
  const resolved: StageOutcome[] = [];
  for (const step of c.steps) {
    const at = c.state().revision;
    const request: StageEntry = {
      identity: IDENTITY, step, revision: at,
      evidenceHeld: STEP_CONTRACTS.flatMap((s) => [...s.entryEvidence]),
    };
    if (!c.admit(request).admitted) continue;
    const conclusion: StageSettlement = {
      identity: IDENTITY, step, revision: at,
      evidence: [`e-${step}`], gaps: [], gatesRecorded: true,
      verification: [`verified-${step}`],
    };
    const settled = c.settle(conclusion);
    if (settled.settled && settled.outcome.state === "established") resolved.push(settled.outcome);
  }

  const after: ControlState = c.state();
  const afterRun = after.revision;
  const stale = c.settle({
    identity: IDENTITY, step: "s7", revision: afterRun - 1,
    evidence: ["e-late"], gaps: [], gatesRecorded: true, verification: [],
  });
  const reopened = c.settle({
    identity: IDENTITY, step: "s7", revision: afterRun,
    evidence: ["e-late"], gaps: ["g-new"], gatesRecorded: true, verification: [],
  });
  const fresh = createController(PROFILE).settle({
    identity: IDENTITY, step: "s1", revision: 0,
    evidence: [], gaps: ["g1"], gatesRecorded: false, verification: [],
  });

  return [
    row("a step is entered without its entry evidence",
      [first.admitted && grounded.admitted,
        "the first step needs no ground, and the second is admitted once it holds it"],
      [kindOf(ungrounded) === "missing_entry_evidence"
        && (refusalOf(ungrounded)?.missingEvidence.includes("ground-from-s1") ?? false),
        "entering without the ground returns the missing evidence by name rather than " +
        "proceeding on a default"]),
    row("a step nobody bound resolves anyway",
      [c.steps.length === 7 && resolved.length === 7 && after.outcomes.length === 7,
        "all seven bound contracts resolve and settle through this one controller, and the " +
        "control state holds an outcome for each"],
      [kindOf(unknown) === "unknown_step" && kindOf(foreign) === "unbound_profile",
        "an unbound step and an execution carrying another profile's ref are both refused"]),
    row("a stale control revision proceeds on a default",
      [reopened.settled, "a settlement at the current revision is accepted"],
      [!stale.settled && stale.refusal.kind === "stale_revision"
        && stale.refusal.currentRevision === afterRun,
        "a settlement one revision behind is refused and carries the current revision"]),
    row("an established outcome survives a reopened gap",
      [resolved.some((o) => o.step === "s7"), "the step was established while its gaps were closed"],
      [stateOf(reopened) === "needs_revisit" && stateOf(fresh) === "not_established",
        "settling it again with a gap open computes needs_revisit, while a step that never " +
        "held stays not_established"]),
  ];
}

/** Every detector in this subject, watched twice. */
export function stageControlProbe(): readonly StageControlProbeRow[] {
  return Object.freeze([...noiseRows(), ...budgetRows(), ...controllerRows()]);
}
