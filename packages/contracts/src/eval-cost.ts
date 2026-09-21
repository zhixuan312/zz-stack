/**
 * WHAT AN ARM COST, AND THE ONE ANSWER THIS MODULE REFUSES TO GIVE: zero, for something nobody
 * measured.
 *
 * THE DEFECT IS SPECIFIC AND IT IS THE REASON THIS FILE EXISTS. A comparison between three
 * methods is decided as much on price as on accuracy, and price arrives from a provider that
 * may report usage late, partially, or not at all. The tempting shape is a `number` column
 * with a `?? 0` behind it, because every consumer downstream — a sum, a mean, a bar on a
 * console — wants a number and none of them want a null. But a zero in a cost column is a
 * CLAIM: it says this arm consumed nothing. One table later it is indistinguishable from an
 * arm that genuinely ran free, and the cheapest method in the report is then whichever
 * backend reported least about itself. That is the opposite of what the measurement is for.
 *
 * SO: {@link CostEstimate.total} is `number | null`, and null means nobody can say. The same
 * rule this initiative applies everywhere else — a missing measurement is blocked, never 0.
 *
 * A MEASURED ZERO IS STILL ZERO, and this is not a contradiction. A usage record carrying
 * `input_tokens: 0` priced against a complete rate card yields `total: 0` with completeness
 * `known`, because somebody looked and the answer was nothing. What can never happen is a
 * zero arriving because a field was absent. The two are told apart by `completeness`, which
 * is why it is not optional and why no consumer should read `total` without it.
 *
 * THREE STATES, NOT TWO, and the middle one is where most real runs land. `partial` is a run
 * where SOME component could be priced — input tokens against a rate card missing its output
 * rate, say. The priced part is reported as {@link CostEstimate.known_subtotal}, and it is
 * deliberately NOT called a total: a subtotal presented as a total is the same fabrication as
 * a zero, differing only in being harder to spot. `total` stays null until every component is
 * priced.
 *
 * AND PRICING IS NOT BILLING. Token counts multiplied by a published rate are an estimate of
 * what the provider will charge, not a reading of what it did charge — rounding, minimums,
 * cached-prefix discounts and plan-level credits all sit between the two, and none of them
 * are visible from a usage record. {@link BillingUncertainty} carries that gap explicitly, so
 * an estimate nobody has reconciled against an invoice cannot be read as one that has been.
 *
 * USAGE IS NOT RE-DERIVED HERE. `adapters/usage.ts` already owns the one hard question about
 * consumption records — which of them double-count a delegated run — and this module takes
 * its {@link UsageTotal} as the input. Its `floor_only` completeness propagates: a total that
 * is a lower bound cannot price to an exact cost, so it prices to `partial` and says why.
 */
import type { UsageTotal } from "./adapters/usage.js";
import type { IdentityAssurance } from "./assessment.js";

/** Whether every component of a cost could be priced. `unknown` means nothing could; `partial`
 *  means some could and {@link CostEstimate.known_subtotal} holds that part. */
export type CostCompleteness = "known" | "partial" | "unknown";

/** A published price list, pinned by the identifier of the tariff it came from.
 *
 *  `rate_version` IS NOT A RELEASE NUMBER and is never written as one. It names the tariff in
 *  force — a dated identifier the provider publishes — because a cost is only reproducible
 *  against the prices that applied when the run happened. A rate that cannot be named is a
 *  rate nobody can check, so it is `null` per component rather than guessed at. */
export interface RateCard {
  /** ISO 4217, carried on every estimate whether or not a number was produced. */
  readonly currency: string;
  readonly rate_version: string;
  /** Price per input token. `null` is a component this card does not price. */
  readonly per_input_token: number | null;
  readonly per_output_token: number | null;
}

/** How far a monetary figure is from what the provider will actually charge.
 *
 *  `unpriced` is not a degree of uncertainty — it says there is no figure to be uncertain
 *  about. It is kept in the same type so that no reader can hold a cost without holding the
 *  answer to "has anyone checked this against a bill?". */
export type BillingUncertainty =
  | "unpriced"
  | "provider_invoice_not_reconciled"
  | "reconciled_to_provider_invoice";

/** A monetary estimate and everything a reader needs to refuse it.
 *
 *  `currency` and `rate_version` are present even when `total` is null, because knowing which
 *  tariff FAILED to price something is how the gap gets closed. */
export interface CostEstimate {
  /** The whole cost, or null when any component could not be priced. Never 0 for absence. */
  readonly total: number | null;
  /** The part that could be priced. A floor, never to be printed as the cost. */
  readonly known_subtotal: number | null;
  readonly currency: string | null;
  readonly rate_version: string | null;
  readonly completeness: CostCompleteness;
  /** What was absent, named so the gap is actionable rather than merely reported. */
  readonly missing: readonly string[];
  /** The consumption this figure was computed from, carried alongside it. A price with the
   *  usage behind it stripped off cannot be re-derived, re-priced against a later tariff, or
   *  argued with — and a reader who cannot check an estimate has to take it on faith. `null`
   *  is a run that reported no usage at all. */
  readonly priced_usage: { readonly input_tokens: number; readonly output_tokens: number } | null;
  readonly billing_uncertainty: BillingUncertainty;
}

/** What {@link costOf} is given. Every field is optional because every one of them is
 *  genuinely absent in some real run, and an absent field must reach the function as absent
 *  rather than as a stand-in a caller invented to satisfy a type. */
export interface CostInput {
  readonly usage?: UsageTotal | undefined;
  readonly rates?: RateCard | undefined;
  /** True only when somebody compared this figure against a provider invoice. Absent is not
   *  false-with-confidence; it is the ordinary case, and it reads as not reconciled. */
  readonly invoice_reconciled?: boolean | undefined;
}

/**
 * Prices a run, and says how much of it is a real price.
 *
 * The one invariant worth stating in a sentence: `total` is a number exactly when `missing` is
 * empty. Everything else follows from that.
 */
export function costOf(input: CostInput): CostEstimate {
  const { usage, rates, invoice_reconciled } = input;
  const missing: string[] = [];
  if (!usage) missing.push("usage was not reported for this backend");
  if (!rates) missing.push("no rate card was pinned for this backend");
  if (usage && usage.completeness === "floor_only") {
    missing.push(
      `${usage.excluded_as_unresolvable.length} usage record(s) could not be placed in the ` +
      "run tree, so the token counts are a lower bound rather than a total");
  }
  if (usage && rates && rates.per_input_token === null) missing.push("the rate card prices no input token");
  if (usage && rates && rates.per_output_token === null) missing.push("the rate card prices no output token");

  // COMPONENT BY COMPONENT, so that a card pricing one side and not the other produces a
  // subtotal rather than either a total or nothing. `null` here means this component could not
  // be priced at all — distinct from a component that priced to 0.
  const components: (number | null)[] = [
    usage && rates && rates.per_input_token !== null ? usage.input_tokens * rates.per_input_token : null,
    usage && rates && rates.per_output_token !== null ? usage.output_tokens * rates.per_output_token : null,
  ];
  const priced = components.filter((c): c is number => c !== null);
  const known_subtotal = priced.length ? priced.reduce((a, b) => a + b, 0) : null;

  // THE ONLY PLACE A NUMBER BECOMES A TOTAL. Guarding on `missing` rather than on the subtotal
  // is what keeps a fully-priced zero honest and an unpriced run null: a run whose every
  // component priced to 0 has an empty `missing` and reports 0, and a run with nothing to
  // price has a non-empty one and reports null.
  const completeness: CostCompleteness =
    missing.length === 0 ? "known" : known_subtotal === null ? "unknown" : "partial";

  return Object.freeze({
    total: completeness === "known" ? known_subtotal : null,
    known_subtotal,
    currency: rates?.currency ?? null,
    rate_version: rates?.rate_version ?? null,
    completeness,
    missing: Object.freeze(missing),
    priced_usage: usage
      ? Object.freeze({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens })
      : null,
    billing_uncertainty:
      known_subtotal === null ? "unpriced"
        : invoice_reconciled === true ? "reconciled_to_provider_invoice"
          : "provider_invoice_not_reconciled",
  });
}

/** What one backend did during an arm, before any of it is priced.
 *
 *  `attempts` and `duration_ms` are nullable for the same reason the cost is: a run whose
 *  attempt count was not recorded did not make zero attempts. `actual_identity` is what
 *  answered, which is not what was requested — `identity_assurance` says how much that claim
 *  is worth, and the semantic-assessment port already owns that distinction. */
export interface BackendRun {
  readonly backend_id: string;
  readonly attempts: number | null;
  readonly duration_ms: number | null;
  readonly actual_identity: string | null;
  readonly identity_assurance: IdentityAssurance;
  readonly usage?: UsageTotal | undefined;
  readonly rates?: RateCard | undefined;
  readonly invoice_reconciled?: boolean | undefined;
}

/** One backend's line in an arm's account: what it did, who answered, and what it cost. */
export interface BackendAccount {
  readonly backend_id: string;
  readonly attempts: number | null;
  readonly duration_ms: number | null;
  readonly actual_identity: string | null;
  readonly identity_assurance: IdentityAssurance;
  readonly cost: CostEstimate;
}

/** Turns what a backend did into the line an arm's account carries. Nothing is summed across
 *  backends here on purpose: two backends priced in two currencies, or one priced and one
 *  unknown, have no meaningful sum, and the arm-level reader is the one who has to decide what
 *  to do about that rather than be handed a figure that hid it. */
export function accountFor(run: BackendRun): BackendAccount {
  return Object.freeze({
    backend_id: run.backend_id,
    attempts: run.attempts,
    duration_ms: run.duration_ms,
    actual_identity: run.actual_identity,
    identity_assurance: run.identity_assurance,
    cost: costOf({ usage: run.usage, rates: run.rates, invoice_reconciled: run.invoice_reconciled }),
  });
}
