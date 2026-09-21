/**
 * THE ONE INSTANTIATED PROTOCOL, AND THE HONEST STATE OF EVERY NUMBER IN IT: absent.
 *
 * `eval-protocol.ts` says what a protocol IS. This file is the one the assessor question is
 * actually being evaluated under, and it is separated from the machinery for the reason every
 * instance is: the rules do not change when this evaluation's tolerances are agreed, and the
 * diff that agrees them should touch nothing but the values.
 *
 * READ THIS BEFORE READING THE DATA. No arm has run. There are no measurements here, and there
 * is nothing in this file that could be mistaken for one — no rate, no cost, no denominator,
 * no interval. What is missing is named, case by case, in
 * {@link EvaluationProtocol.activation_blockers} — that list is the count, and a number
 * written beside it here would be a second one to fall out of step. The protocol reports
 * `activationAllowed: false` because of them while reporting `draftingAllowed: true`, which is
 * the state it is supposed to be in. Filling any of these in to make the record look finished
 * is the single failure this module exists to prevent.
 *
 * WHAT IS GENUINELY DECIDED, AND IS THEREFORE WRITTEN DOWN. The comparison design: three arms,
 * all measured on the same pinned inventory, all judged to each case's own cutoff, all given
 * the same cutoff-visible evidence. Those are design decisions, not observations, and making
 * them is what drafting is for. The shared method B and C both instantiate is described from
 * modules that exist in this package today, so "faithful to the shared loop" is a claim a
 * reader can check by opening the files.
 *
 * WHAT IS NOT DECIDED, AND IS THEREFORE NULL.
 *
 *   · ARM A HAS NO METHOD REFERENCE. It is the actual legacy assessment path, and no reference
 *     to it has been pinned in this repository. That makes its faithfulness `undetermined` —
 *     not `departs`, because accusing a design nobody has recorded of being a strawman is as
 *     much an invention as exonerating it. It blocks activation either way, which is correct:
 *     a comparison against an incumbent nobody has written down cannot be run.
 *   · NO ATTEMPT BUDGET. Nobody has decided how many attempts each arm gets, and an arm's
 *     budget is exactly the kind of detail that decides a comparison quietly. Null on both
 *     sides leaves the dimension `unchecked` rather than passed.
 *   · NO TOLERANCES. A bar is an owner's decision, and no owner has recorded one. Choosing
 *     numbers here so the protocol looks runnable would be choosing the bars the candidate
 *     clears.
 *   · NO OWNER APPROVAL, NO ENUMERATED INVENTORY, NO PINNED SPLIT. The inventory is pinned by
 *     reference to a manifest that has still to be written; nothing stands at that locator yet,
 *     which is why its digest is null and its cases are empty. The development and held-out
 *     initiative sets are empty for the same reason: naming initiatives that have not been
 *     assigned would be inventing the separation the split exists to guarantee.
 *
 * THE SLICES THIS WILL REPORT ON are language x risk x action x task_kind. That is a finer cut
 * than anything already judged here — `testing/tenant-info/` judges 600 queries and slices them
 * by language alone — and `sliceAdequacy` in `eval-case.ts` carries what that costs.
 */
import { assembleProtocol, AGREEMENT_METRIC, type ArmSpec, type EvaluationProtocol, type Limit, type MethodDescription } from "./eval-protocol.js";

/** Where the case manifest will be pinned. Nothing stands here yet, which is the honest state
 *  and the reason `enumerated` is false below — a locator is a promise, not an inventory. */
const INVENTORY_REF = "testing/assessor-eval/cases.jsonl";

/**
 * THE SHARED IMPROVED METHOD, described from modules a reader can open.
 *
 * Each capability names something the shared semantic-assessment loop demonstrably does, and
 * the point of listing them is that an arm which quietly drops one is caught by
 * {@link armsOf} rather than by whoever happens to read the configuration. They are the
 * properties the loop was built to have — the refusals in `assessment.ts`'s own header — so an
 * arm missing one is not a variant of the method, it is a different method.
 */
const SHARED_METHOD: MethodDescription = Object.freeze({
  method_ref: "packages/contracts/src/assessment.ts#interpret",
  capabilities: Object.freeze([
    "interprets_the_reply_against_the_questions_own_answer_spec",
    "records_signal_origin_rather_than_constructing_a_distribution",
    "refuses_a_reply_from_an_identity_the_profile_did_not_pin",
    "gates_advance_on_the_recorded_status_alone",
  ]),
  attempt_budget: null,
  case_set_ref: INVENTORY_REF,
  cutoff_policy: "each_case_is_judged_as_of_its_own_cutoff",
  evidence_access: "cutoff_visible_evidence_only",
});

/** B and C differ in the backend and in nothing else, which is what makes the pair a
 *  measurement of the model rather than of the loop around it. */
const sharedArm = (
  id: "B" | "C", label: string, methodRef: string, backend: string,
): ArmSpec => Object.freeze({
  id,
  label,
  attributed_to: Object.freeze([backend]),
  described: Object.freeze({ ...SHARED_METHOD, method_ref: methodRef }),
  baseline: SHARED_METHOD,
});

const ARMS: readonly ArmSpec[] = Object.freeze([
  Object.freeze({
    id: "A" as const,
    label: "the actual legacy assessment path, as it is really performed today",
    attributed_to: Object.freeze([]),
    // NOT A PLACEHOLDER TO BE TIDIED AWAY. Every field here is null or empty because nobody has
    // recorded what the legacy path does. Writing a plausible description would produce an arm
    // that compares cleanly against itself and tells the comparison nothing.
    described: Object.freeze({
      method_ref: null,
      capabilities: Object.freeze([]),
      attempt_budget: null,
      case_set_ref: INVENTORY_REF,
      cutoff_policy: "each_case_is_judged_as_of_its_own_cutoff",
      evidence_access: "cutoff_visible_evidence_only",
    }),
    baseline: null,
  }),
  sharedArm(
    "B",
    "the improved shared method under a separately attributed general-model assessor",
    "packages/contracts/src/label-adapter.ts#labelAdapter",
    "general_model_assessor"),
  sharedArm(
    "C",
    "the improved shared method under the candidate specialist",
    "packages/contracts/src/adapters/jev.ts#jevAdapter",
    "candidate_specialist"),
]);

/**
 * The three tolerances this evaluation would be decided on, every one of them unset.
 *
 * They are listed rather than omitted because a metric nobody has written down is a metric
 * nobody will argue about, and the argument is the work. An empty `limits` array would make
 * the protocol look decided; three nulls make it obvious what is owed and by whom.
 */
const LIMITS: readonly Limit[] = Object.freeze([
  Object.freeze({
    metric: AGREEMENT_METRIC, direction: "at_least" as const,
    value: null, unit: "proportion_of_eligible_cases", set_by: null,
  }),
  Object.freeze({
    metric: "cost_per_decision", direction: "at_most" as const,
    value: null, unit: "currency_minor_units_per_decision", set_by: null,
  }),
  Object.freeze({
    metric: "latency_per_decision", direction: "at_most" as const,
    value: null, unit: "milliseconds", set_by: null,
  }),
]);

const INSTANCE: EvaluationProtocol = assembleProtocol({
  protocol_id: "assessor-eligibility",
  inventory: Object.freeze({
    inventory_ref: INVENTORY_REF,
    digest: null,
    enumerated: false,
    cases: Object.freeze([]),
  }),
  arms: ARMS,
  limits: LIMITS,
  // Empty, and blocking activation because of it. An initiative id written here would be a
  // separation asserted rather than arranged.
  dev_initiative_ids: Object.freeze([]),
  heldout_initiative_ids: Object.freeze([]),
  sample_adequacy_rule_ref: "packages/contracts/src/eval-case.ts#sliceAdequacy",
  owner_approval_ref: null,
});

/** The instantiated protocol. A function rather than the frozen constant so that no caller can
 *  come to depend on module-load order, and so the name reads as "give me the protocol" at
 *  every call site. The value is built once. */
export function protocol(): EvaluationProtocol {
  return INSTANCE;
}
