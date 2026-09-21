/**
 * PLANTING EACH FAULT THIS PROTOCOL CLAIMS TO CATCH, AND SHOWING THE DETECTOR FIRE.
 *
 * A guard nobody has watched fail is a guard nobody has tested. Two sibling tasks in this
 * initiative built exactly this probe and found detectors that could not detect — a check
 * written against a shape that was already impossible, passing forever and proving nothing.
 * So every rule the evaluation protocol rests on is exercised here twice: once on a healthy
 * subject, where the detector must stay silent, and once with a specific fault planted, where
 * it must fire.
 *
 * THE HEALTHY HALF IS THE HALF THAT MATTERS. The shipped protocol
 * (`eval-protocol-instance.ts`) is deliberately un-activatable — no tolerances, no owner
 * approval, no enumerated inventory — so a probe that only planted faults would be unable to
 * tell "this detector works" from "this detector says no to everything". {@link healthy} below
 * is a fully specified FIXTURE protocol: every tolerance set, every arm faithful, the split
 * pinned and disjoint, the inventory enumerated. It reports `activationAllowed: true`, which
 * is the negative control, and every row's healthy column is read against it.
 *
 * NOTHING HERE IS A MEASUREMENT. The fixture's cases are generated, its rates are invented
 * prices, and the two rows that need a completed outcome table build one by hand. They are
 * labelled fixtures in their names and they never reach the shipped protocol, whose own
 * outcome table stays empty. What this file demonstrates is that the detectors discriminate —
 * not what any arm scored, which nobody knows.
 */
import {
  adjudicate, eligibilityOf, sliceAdequacy, SAMPLE_ADEQUACY_RULE_REF,
  type Adjudicator, type EvalCase, type EvalSlice, type EvidenceRef, type ReviewerLabel,
} from "./eval-case.js";
import { accountFor, costOf, type BackendRun, type RateCard } from "./eval-cost.js";
import { protocol } from "./eval-protocol-instance.js";
import {
  armsOf, assembleProtocol, conclude, outcomesOf, reuseHeldOutForTuning, AGREEMENT_METRIC,
  type ArmSliceOutcome, type ArmSpec, type Conclusion, type EvalArm, type EvaluationProtocol,
  type MethodDescription,
} from "./eval-protocol.js";

/** One detector, watched on a healthy subject and on a faulted one. `fires` is true only when
 *  it stayed silent on the first and spoke on the second — either half failing makes the
 *  detector worthless, and for opposite reasons. */
export interface ProbeRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

const row = (detector: string, healthy: [boolean, string], faulted: [boolean, string]): ProbeRow =>
  Object.freeze({
    detector,
    healthy: `${healthy[0] ? "silent" : "MISFIRED"} — ${healthy[1]}`,
    faulted: `${faulted[0] ? "fires" : "MISSED"} — ${faulted[1]}`,
    fires: healthy[0] && faulted[0],
  });

// ── the healthy fixture ────────────────────────────────────────────────────────────────────

const FIXTURE_INVENTORY = "fixture://assessor-eval/cases";
const DEV_INITIATIVE = "fixture-initiative-dev";
const HELD_INITIATIVE = "fixture-initiative-heldout";
const BROAD: EvalSlice = { language: "en", risk: "low", action: "advance", task_kind: "classify" };
const NARROW: EvalSlice = { language: "zh", risk: "high", action: "escalate", task_kind: "verify" };

/** A run of eligible fixture cases in one slice. Sized to straddle the adequacy rule: at a
 *  tolerance of 0.95 the rule needs 40, so 40 is adequate and 20 is not — the same verdict the
 *  measured en 58 / zh 20 / mixed 20 split in `testing/tenant-info/` produces, which is why
 *  those two sizes and no others. */
const fixtureCases = (
  slice: EvalSlice, n: number, prefix: string, initiative: string, cutoff: string,
): EvalCase[] =>
  Array.from({ length: n }, (_, i) => Object.freeze({
    case_id: `${prefix}-${i}`,
    initiative_id: initiative,
    slice,
    cutoff,
    manifest_ref: `fixture://manifest/${prefix}`,
    historical_context: "recorded_at_cutoff" as const,
    evidence: Object.freeze([{ ref: `${prefix}-${i}.txt`, observed_at: "2025-12-01" }]),
    withheld: Object.freeze([]),
  }));

const FIXTURE_METHOD: MethodDescription = Object.freeze({
  method_ref: "fixture://method/shared-loop",
  capabilities: Object.freeze(["interprets_against_the_answer_spec", "records_signal_origin"]),
  attempt_budget: 3,
  case_set_ref: FIXTURE_INVENTORY,
  cutoff_policy: "each_case_is_judged_as_of_its_own_cutoff",
  evidence_access: "cutoff_visible_evidence_only",
});

const fixtureArm = (id: "A" | "B" | "C", methodRef: string, backend: string): ArmSpec =>
  Object.freeze({
    id,
    label: `fixture arm ${id}`,
    attributed_to: Object.freeze([backend]),
    described: Object.freeze({ ...FIXTURE_METHOD, method_ref: methodRef }),
    baseline: FIXTURE_METHOD,
  });

function healthy(): EvaluationProtocol {
  return assembleProtocol({
    protocol_id: "fixture-healthy",
    inventory: Object.freeze({
      inventory_ref: FIXTURE_INVENTORY,
      digest: "f".repeat(64),
      enumerated: true,
      // DEVELOPMENT FIRST, HELD-OUT AFTER. The cutoffs are what make the split real, and the
      // gap between them is what `separationBlockers` reads.
      cases: Object.freeze([
        ...fixtureCases(BROAD, 40, "broad", DEV_INITIATIVE, "2025-06-01"),
        ...fixtureCases(NARROW, 20, "narrow", HELD_INITIATIVE, "2026-01-01"),
      ]),
    }),
    arms: Object.freeze([
      fixtureArm("A", "fixture://method/legacy-as-performed", "legacy_operator"),
      fixtureArm("B", "fixture://method/general-model", "general_model_assessor"),
      fixtureArm("C", "fixture://method/candidate", "candidate_specialist"),
    ]),
    limits: Object.freeze([
      Object.freeze({
        metric: AGREEMENT_METRIC, direction: "at_least" as const,
        value: 0.95, unit: "proportion_of_eligible_cases", set_by: "fixture-owner",
      }),
    ]),
    dev_initiative_ids: Object.freeze([DEV_INITIATIVE]),
    heldout_initiative_ids: Object.freeze([HELD_INITIATIVE]),
    sample_adequacy_rule_ref: SAMPLE_ADEQUACY_RULE_REF,
    owner_approval_ref: "fixture://approval/owner",
  });
}

const blocked = (p: EvaluationProtocol, fragment: string): boolean =>
  !p.activationAllowed && p.activation_blockers.some((b) => b.includes(fragment));

// ── faults planted in the protocol itself ──────────────────────────────────────────────────

function armRows(): ProbeRow[] {
  const good = healthy();
  const find = (p: EvaluationProtocol): EvalArm | undefined => armsOf(p).find((a) => a.id === "A");
  const goodA = find(good);

  // FAULT: arm A is described without a capability the method it instantiates has. Nothing
  // else changes, and this is what a rigged incumbent actually looks like in a config file.
  const weakened = assembleProtocol({
    ...good,
    arms: good.arms.map((a) => a.id === "A"
      ? { ...a, described: { ...a.described, capabilities: ["interprets_against_the_answer_spec"] } }
      : a),
  });
  const weakA = find(weakened);

  // FAULT: arm A with no recorded baseline — the shipped protocol's own state.
  const unpinned = assembleProtocol({
    ...good,
    arms: good.arms.map((a) => (a.id === "A" ? { ...a, baseline: null } : a)),
  });
  const unpinnedA = find(unpinned);

  // FAULT: arm A measured on a different case set, with every capability intact.
  const swapped = assembleProtocol({
    ...good,
    arms: good.arms.map((a) => a.id === "A"
      ? { ...a, described: { ...a.described, case_set_ref: "fixture://other-cases" } }
      : a),
  });
  const swappedA = find(swapped);

  return [
    row("arm A is a weakened strawman (capability dropped)",
      [goodA?.isStrawman === false, `faithful arm A reports isStrawman=false, faithfulness=${goodA?.faithfulness}`],
      [weakA?.isStrawman === true, `isStrawman=true — ${weakA?.departures.join("; ")}`]),
    row("arm A is rigged by the case set rather than by its capabilities",
      [goodA?.departures.length === 0, "no departure on any dimension"],
      [swappedA?.isStrawman === true, `isStrawman=true — ${swappedA?.departures.join("; ")}`]),
    row("arm A's faithfulness cannot be determined",
      [goodA?.faithfulness === "no_departure_found", "baseline recorded, every dimension compared"],
      [unpinnedA?.faithfulness === "undetermined" && blocked(unpinned, "undetermined"),
        "faithfulness=undetermined and activation is blocked, while isStrawman stays false"]),
  ];
}

function gateRows(): ProbeRow[] {
  const good = healthy();

  const nullTolerance = assembleProtocol({
    ...good,
    limits: good.limits.map((l) => ({ ...l, value: null, set_by: null })),
  });
  const noRule = assembleProtocol({ ...good, sample_adequacy_rule_ref: null });
  const overlapping = assembleProtocol({
    ...good,
    heldout_initiative_ids: [...good.heldout_initiative_ids, DEV_INITIATIVE],
  });
  const unapproved = assembleProtocol({ ...good, owner_approval_ref: null });
  const shipped = protocol();

  return [
    row("a tolerance is null and activation is still allowed",
      [good.activationAllowed, "every tolerance set and owned; activationAllowed=true"],
      [blocked(nullTolerance, "no tolerance is set") && nullTolerance.draftingAllowed,
        "activationAllowed=false, draftingAllowed stays true"]),
    row("no sample-adequacy rule and activation is still allowed",
      [good.sample_adequacy_rule_ref !== null, `rule pinned at ${good.sample_adequacy_rule_ref}`],
      [blocked(noRule, "no sample-adequacy rule"), "activationAllowed=false with the rule named as the blocker"]),
    row("the held-out set is not held out",
      [good.activationAllowed, "development and held-out initiatives are disjoint"],
      [blocked(overlapping, "appears in both"), "the shared initiative is named and activation is blocked"]),
    row("the protocol runs without an owner's approval",
      [good.activationAllowed, "approval recorded"],
      [blocked(unapproved, "no owner approval"), "activation blocked on the missing approval alone"]),
    row("the shipped protocol could activate on absent numbers",
      [good.activationAllowed && good.draftingAllowed, "a fully specified protocol does activate, so the gate is not a blanket refusal"],
      [!shipped.activationAllowed && shipped.draftingAllowed,
        `the real protocol is blocked by ${shipped.activation_blockers.length} named gaps and may still be drafted`]),
    row("a case belongs to neither side of the split, or to both",
      [good.activationAllowed, "every enumerated case sits in exactly one of the two initiative sets"],
      [blocked(assembleProtocol({
        ...good,
        inventory: { ...good.inventory, cases: good.inventory.cases.map((c, i) =>
          (i === 0 ? { ...c, initiative_id: "fixture-initiative-unlisted" } : c)) },
      }), "belong to neither set or to both"),
        "a case whose initiative is in neither list is named and blocks activation"]),
    row("the held-out cases are not time-separated from the development ones",
      [good.activationAllowed, "held-out cutoffs (2026-01-01) all fall after the development ones (2025-06-01)"],
      [blocked(assembleProtocol({
        ...good,
        inventory: { ...good.inventory, cases: good.inventory.cases.map((c) =>
          (c.initiative_id === HELD_INITIATIVE ? { ...c, cutoff: "2025-01-01" } : c)) },
      }), "not time-separated"),
        "held-out cutoffs pulled before the development ones block activation while the two id lists stay disjoint"]),
    row("reusing a held-out initiative to tune leaves it held out",
      [good.heldout_initiative_ids.includes(HELD_INITIATIVE)
        && !good.dev_initiative_ids.includes(HELD_INITIATIVE),
        "the held-out initiative is in one set only"],
      [(() => {
        const after = reuseHeldOutForTuning(good, HELD_INITIATIVE);
        return after.dev_initiative_ids.includes(HELD_INITIATIVE)
          && !after.heldout_initiative_ids.includes(HELD_INITIATIVE);
      })(), "the reused initiative is recorded as a development initiative and leaves the held-out set"]),
  ];
}

// ── faults planted in the cost, the labels and the sample ──────────────────────────────────

const RATES: RateCard = Object.freeze({
  currency: "USD", rate_version: "fixture-tariff-2026-01",
  per_input_token: 0.000001, per_output_token: 0.000002,
});
const USAGE = Object.freeze({
  rule: "no_ancestor_rollup" as const,
  input_tokens: 1000, output_tokens: 500,
  counted: Object.freeze(["r1"]),
  excluded_as_rolled_up: Object.freeze([]),
  excluded_as_unresolvable: Object.freeze([]),
  completeness: "every_record_resolved" as const,
});

function costRows(): ProbeRow[] {
  const known = costOf({ usage: USAGE, rates: RATES });
  const unknown = costOf({ usage: undefined });
  const partial = costOf({ usage: USAGE, rates: { ...RATES, per_output_token: null } });
  const floor = costOf({
    usage: { ...USAGE, completeness: "floor_only", excluded_as_unresolvable: ["r9"] },
    rates: RATES,
  });
  const measuredZero = costOf({ usage: { ...USAGE, input_tokens: 0, output_tokens: 0 }, rates: RATES });

  // PER BACKEND, because the contract's cost output is a line for each one rather than a total
  // for the arm. The thing worth watching is that the NON-monetary facts survive a backend that
  // reported no usage: an arm whose provider is silent about tokens still made attempts and
  // still took time, and losing those alongside the price would turn one gap into three.
  const reporting: BackendRun = {
    backend_id: "candidate_specialist", attempts: 3, duration_ms: 1500,
    actual_identity: "fixture-serving-digest", identity_assurance: "provider_reported",
    usage: USAGE, rates: RATES,
  };
  const silent: BackendRun = { ...reporting, usage: undefined, rates: undefined };
  const reported = accountFor(reporting);
  const unreported = accountFor(silent);

  return [
    row("a backend that reported no usage loses its attempts and duration too",
      [reported.cost.total !== null && reported.attempts === 3 && reported.identity_assurance === "provider_reported",
        `a reporting backend carries attempts=3, duration=1500ms, identity_assurance=provider_reported and a priced cost`],
      [unreported.cost.total === null && unreported.cost.completeness === "unknown"
        && unreported.attempts === 3 && unreported.duration_ms === 1500
        && unreported.actual_identity === "fixture-serving-digest",
        "the silent backend keeps attempts, duration and identity; only the cost goes unknown"]),
    row("unknown usage is encoded as zero cost",
      [known.total !== null && known.completeness === "known",
        `a fully reported run prices to ${known.total} ${known.currency} at ${known.rate_version}`],
      [unknown.total === null && unknown.completeness === "unknown",
        `total=null, completeness=unknown, billing=${unknown.billing_uncertainty} — not 0`]),
    row("a partly priced run is reported as a total",
      [known.known_subtotal === known.total, "subtotal and total agree when nothing is missing"],
      [partial.total === null && partial.completeness === "partial" && partial.known_subtotal !== null,
        `total=null with a known_subtotal of ${partial.known_subtotal} and ${partial.missing.length} named gap(s)`]),
    row("a lower-bound usage total is priced as an exact cost",
      [known.completeness === "known", "a fully resolved usage tree prices exactly"],
      [floor.total === null && floor.completeness === "partial",
        "an unplaceable usage record drops the estimate to partial rather than pricing the floor as the cost"]),
    row("a measured zero is mistaken for an unknown",
      [measuredZero.total === 0 && measuredZero.completeness === "known",
        "a run that genuinely consumed nothing reports total=0, completeness=known"],
      [unknown.total === null, "an unmeasured run reports null, so the two are distinguishable in the same column"]),
  ];
}

const EVIDENCE: readonly EvidenceRef[] = Object.freeze([
  { ref: "visible.txt", observed_at: "2025-11-01" },
  { ref: "later.txt", observed_at: "2026-06-01" },
]);

const CASE: EvalCase = Object.freeze({
  case_id: "fixture-label-case",
  initiative_id: DEV_INITIATIVE,
  slice: BROAD,
  cutoff: "2026-01-01",
  manifest_ref: "fixture://manifest/label",
  historical_context: "recorded_at_cutoff",
  evidence: EVIDENCE,
  withheld: Object.freeze(["secret.txt"]),
});

function labelRows(): ProbeRow[] {
  const onTime: readonly ReviewerLabel[] = [
    { reviewer_id: "r1", value: "yes", evidence_seen: ["visible.txt"] },
    { reviewer_id: "r2", value: "yes", evidence_seen: ["visible.txt"] },
  ];
  const disagreeing: readonly ReviewerLabel[] = [
    { reviewer_id: "r1", value: "yes", evidence_seen: ["visible.txt"] },
    { reviewer_id: "r2", value: "no", evidence_seen: ["visible.txt"] },
  ];
  const clean: Adjudicator = { adjudicator_id: "a1", saw_later_outcome: false, resolves_to: "yes" };

  const agreed = adjudicate(CASE, onTime, null);
  const peeked = adjudicate(CASE, [
    onTime[0], { reviewer_id: "r2", value: "yes", evidence_seen: ["visible.txt", "later.txt"] },
  ], null);
  const settled = adjudicate(CASE, disagreeing, clean);
  const tainted = adjudicate(CASE, disagreeing, { ...clean, saw_later_outcome: true });
  const invented = adjudicate(CASE, disagreeing, { ...clean, resolves_to: "maybe" });
  const onWithheld = adjudicate(CASE, [
    { reviewer_id: "r1", value: "yes", evidence_seen: ["secret.txt"] },
  ], null);

  const eligible = eligibilityOf(CASE);
  const unpinned = eligibilityOf({ ...CASE, manifest_ref: null });
  const reconstructed = eligibilityOf({ ...CASE, historical_context: "only_todays_manifest" });

  return [
    row("a reviewer labelled on material the cutoff hides",
      [agreed.status === "agreed" && agreed.voided_reviewers.length === 0,
        "two reviewers on cutoff-visible evidence agree, and neither is voided"],
      [peeked.voided_reviewers.includes("r2") && peeked.status === "agreed",
        "the post-cutoff label is voided by name; the surviving label still settles the case"]),
    row("withheld evidence is treated as visible",
      [agreed.status === "agreed", "a label citing only released evidence stands"],
      [onWithheld.status === "void" && onWithheld.voided_reviewers.includes("r1"),
        "a label built on withheld material leaves the case with no adjudicated value"]),
    row("an adjudicator resolves with later outcome information",
      [settled.status === "adjudicated" && settled.value === "yes",
        "a clean adjudicator resolves the disagreement to a proposed value"],
      [tainted.status === "disputed" && tainted.value === null,
        "the disagreement stays disputed and no value is written"]),
    row("an adjudicator invents a value no reviewer proposed",
      [settled.value === "yes", "the resolution is one of the two proposed values"],
      [invented.status === "disputed", "resolving to an unproposed value leaves the case disputed"]),
    row("an unreconstructable case is counted anyway",
      [eligible.eligible, "a case with a pinned manifest and recorded context is eligible"],
      [!unpinned.eligible && !reconstructed.eligible,
        `no manifest and today's-manifest-only are both ineligible: ${unpinned.reasons[0]}`]),
  ];
}

function sampleRows(): ProbeRow[] {
  const big = sliceAdequacy(40, 0.95);
  const small = sliceAdequacy(20, 0.95);
  const unenumerated = sliceAdequacy(null, 0.95);
  const noBar = sliceAdequacy(40, null);

  const good = healthy();
  const rows = outcomesOf(good);
  const broad = rows.find((o) => o.arm_id === "C" && o.slice_key.startsWith("en|"));
  const narrow = rows.find((o) => o.arm_id === "C" && o.slice_key.startsWith("zh|"));

  // A FIXTURE OUTCOME TABLE, built by hand so that `eligible` and `negative` can be shown to be
  // reachable at all. These are not measurements of anything and never touch the shipped
  // protocol; a conclusion function nobody has watched return a verdict is the detector this
  // whole file exists to distrust.
  const measured = (o: ArmSliceOutcome, rate: number): ArmSliceOutcome =>
    Object.freeze({ ...o, state: "measured" as const, successes: Math.round(rate * 40), rate, interval: [rate - 0.03, Math.min(1, rate + 0.03)] as readonly [number, number] });
  const passing = rows.map((o) => measured(o, 0.97));
  const oneShort = passing.map((o, i) => (i === 0 ? measured(o, 0.80) : o));
  const oneUnrun = passing.map((o, i) => (i === 0 ? rows[0] : o));

  return [
    row("a slice too small to decide is reported as if it could",
      [big.adequacy === "adequate", `n=40 at 0.95 is adequate (minimum ${big.minimum})`],
      [small.adequacy === "underpowered" && unenumerated.adequacy === "undecidable" && noBar.adequacy === "undecidable",
        `n=20 is underpowered (minimum ${small.minimum}); an unenumerated slice and an unset bar are both undecidable`]),
    row("an unrun cell carries a denominator of zero and a cost of zero",
      [broad?.denominator === 40 && narrow?.denominator === 20,
        "enumerated slices carry their real eligible counts"],
      [broad?.state === "not_run" && broad?.rate === null && broad?.interval === null
        && broad?.cost.completeness === "unknown",
        "every unrun cell reports rate=null, interval=null and an unknown cost, never 0"]),
    row("a verdict is reached on cells nobody measured",
      [conclude(good, passing).kind === "eligible",
        "a fully measured table clearing the bar does reach an eligibility record"],
      [conclude(good, oneUnrun).kind === "inconclusive" && conclude(good, []).kind === "inconclusive",
        "one unrun cell, or an empty table, makes the finding inconclusive rather than eligible"]),
    row("a negative quietly removes the independent-review path",
      [conclude(good, passing).disables_assessment_branch === false,
        "an eligible finding disables nothing"],
      [(() => {
        const bad: Conclusion = conclude(good, oneShort);
        return bad.kind === "negative" && bad.disables_assessment_branch && bad.preserved_path === "independent_review";
      })(), "a missed tolerance disables the assessment branch and names the preserved path"]),
  ];
}

/** Every detector, watched twice. A row whose `fires` is false is a detector that cannot
 *  detect, and is a finding about this module rather than about its subject. */
export function evalProtocolProbe(): readonly ProbeRow[] {
  return Object.freeze([...armRows(), ...gateRows(), ...costRows(), ...labelRows(), ...sampleRows()]);
}
