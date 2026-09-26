/**
 * The qualification ladder's pure decision (Task I-11, FR-16): evidence counts and a protocol's
 * own `QualificationPolicy.thresholds` in, one of `EVAL_STATE_ENUMS.qualificationState` out. No
 * database, no model call, no randomness — `qualify.ts` is the only caller that gathers real
 * evidence and hands it here, and `checks/eval-qualification-ladder.ts` (this task's own check,
 * not plan-authored — the plan's boundary leaves final deliverable content to this task) pins
 * every rung of this function against fixed evidence, offline.
 *
 * The ladder is EARNED bottom-up, never scored top-down: a rung's own bar clearing is not enough
 * — every rung below it must already hold, so `human_calibrated` with a thin anchor pass rate is
 * a broken pipeline reported honestly as `unqualified`, never a calibrated label papering over
 * an evaluator that cannot even answer a fact it was handed.
 *
 * `LADDER_THRESHOLD_KEYS` names every key this function reads off `thresholds` (a `FreeformRecord`
 * — spec v8 fixes no shape for it) — the vocabulary Task I-29's bootstrap protocol writes into
 * `catalog/zz/zz-plugin-eval/protocols/zz-core.v1.json` has to match, so it is exported rather
 * than left implicit in this file's own reads.
 */
import type { EVAL_STATE_ENUMS } from "@zz/contracts";

// Not exported: nothing outside this file names the type, only the state strings it produces —
// `qualify.ts` reads `qualificationState(...).state` structurally, never `QualificationState`
// by name.
type QualificationState = (typeof EVAL_STATE_ENUMS)["qualificationState"][number];

/** One category of evidence: how many of how many came out the way qualification needed —
 *  an anchor answered correctly, a planted fault killed, a control that failed as expected, a
 *  repeated ask that agreed with the others. The response shape names each category's `passed`
 *  differently (`killed`, `failed_as_expected`, `agreeing`) — that renaming is `qualify.ts`'s
 *  presentation job; this file reads only the ratio. */
export interface LadderCounts {
  readonly passed: number;
  readonly total: number;
}

export interface LadderLabels {
  readonly n: number;
  readonly tpr: number;
  readonly tnr: number;
}

export interface LadderEvidence {
  readonly anchors: LadderCounts;
  readonly planted_faults: LadderCounts;
  readonly controls: LadderCounts;
  readonly stability: LadderCounts;
  readonly labels: LadderLabels | null;
}

/** Every threshold key this ladder reads, one array entry per key — the same "one source, both
 *  directions" convention `EVAL_STATE_ENUMS` itself uses: a key added to `LadderThresholds` and
 *  missed here is a key `resolveThresholds` cannot default, and a key read here that is not in
 *  this list is a key nobody can find by reading this file's own exports. */
export const LADDER_THRESHOLD_KEYS = [
  "anchorPassRate", "stabilityRate", "faultKillRate", "controlCatchRate",
  "labelMinN", "labelTprMin", "labelTnrMin",
] as const;
// Not exported, same reason as QualificationState above: `qualify.ts` and the check both take
// `resolveThresholds`'s return value structurally, never these two type names.
type LadderThresholdKey = (typeof LADDER_THRESHOLD_KEYS)[number];
type LadderThresholds = Readonly<Record<LadderThresholdKey, number>>;

/** This platform's own bar, used for any threshold key a protocol's `QualificationPolicy` leaves
 *  out — never a silent 0, which would qualify an evaluator on evidence nobody actually asked
 *  for. A protocol that wants a stricter (or looser) bar names the key explicitly; leaving all
 *  seven out reproduces this ladder exactly. */
const DEFAULT_THRESHOLDS: LadderThresholds = {
  anchorPassRate: 0.8, stabilityRate: 1, faultKillRate: 0.8, controlCatchRate: 0.8,
  labelMinN: 20, labelTprMin: 0.7, labelTnrMin: 0.7,
};

/** A protocol's freeform `qualification.thresholds` object, narrowed and defaulted key by key.
 *  Never throws: a missing or non-numeric key falls back to `DEFAULT_THRESHOLDS` rather than
 *  refusing the whole qualification over one bad number in an otherwise-usable policy —
 *  `defaulted` names which keys fell back, so a caller can still report it. */
export function resolveThresholds(
  raw: Readonly<Record<string, unknown>> | undefined,
): { thresholds: LadderThresholds; defaulted: readonly LadderThresholdKey[] } {
  const defaulted: LadderThresholdKey[] = [];
  const resolved = {} as Record<LadderThresholdKey, number>;
  for (const key of LADDER_THRESHOLD_KEYS) {
    const v = raw?.[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      resolved[key] = v;
    } else {
      resolved[key] = DEFAULT_THRESHOLDS[key];
      defaulted.push(key);
    }
  }
  return { thresholds: resolved, defaulted };
}

const rate = (c: LadderCounts): number => (c.total > 0 ? c.passed / c.total : 0);

/** The ladder itself. Bottom-up:
 *
 *   1. `anchors.total === 0` refuses the climb entirely — the contract's own Errors clause:
 *      "no anchors derivable -> mechanically_qualified cannot be reached -> unqualified with
 *      reason no_anchors". Checked first and unconditionally: a protocol with generous
 *      thresholds cannot turn zero evidence into a passing rate.
 *   2. `mechanically_qualified` needs the anchor pass rate AND the stability agreement rate each
 *      at or above their threshold (below either, `reason` names each failing key, its rate, its
 *      bar and its counts) — an evaluator that cannot repeat itself is not mechanically
 *      sound even if its first answer happened to be right.
 *   3. `operationally_qualified` additionally needs BOTH planted-fault and control evidence to
 *      exist (`total > 0` — a threshold cleared against zero attempts is not evidence) and each
 *      rate at or above its own threshold (short of it, `mechanically_qualified` names why).
 *   4. `human_calibrated` additionally needs non-null `labels` with `n` at or above its minimum
 *      and both `tpr` and `tnr` at or above their thresholds.
 *
 * Pure: same inputs, same output, every time — `qualify.ts` is what turns a live database and a
 * stubbed or real typed service into the `LadderEvidence` this function reads. */
export function qualificationState(
  evidence: LadderEvidence, thresholds: LadderThresholds,
): { state: QualificationState; reason: string | null } {
  if (evidence.anchors.total === 0) {
    return { state: "unqualified", reason: "no_anchors" };
  }
  const below = (key: LadderThresholdKey, c: LadderCounts): string | null => (
    rate(c) >= thresholds[key] ? null : `${key} ${rate(c).toFixed(2)} < ${thresholds[key].toFixed(2)} (${c.passed}/${c.total})`
  );
  const mechanical = [below("anchorPassRate", evidence.anchors), below("stabilityRate", evidence.stability)]
    .filter((r): r is string => r !== null);
  if (mechanical.length) return { state: "unqualified", reason: mechanical.join("; ") };

  const operational = [
    evidence.planted_faults.total === 0 ? "no planted faults asked" : below("faultKillRate", evidence.planted_faults),
    evidence.controls.total === 0 ? "no controls asked" : below("controlCatchRate", evidence.controls),
  ].filter((r): r is string => r !== null);
  if (operational.length) return { state: "mechanically_qualified", reason: operational.join("; ") };

  const labels = evidence.labels;
  const humanCalibrated =
    labels !== null && labels.n >= thresholds.labelMinN &&
    labels.tpr >= thresholds.labelTprMin && labels.tnr >= thresholds.labelTnrMin;
  if (!humanCalibrated) return { state: "operationally_qualified", reason: null };

  return { state: "human_calibrated", reason: null };
}
