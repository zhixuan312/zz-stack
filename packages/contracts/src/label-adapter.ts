/**
 * A LABEL-ONLY ASSESSOR ADAPTER, and the capability it declares ABSENT.
 *
 * The backends this maps onto return a word. They do not expose a probability primitive, and
 * `capabilities.native_distributions` is `false` because that is the truth about them — typed as
 * the literal `false`, so no later edit can flip it without the compiler objecting. Everything
 * else in this file follows from refusing to paper over that one fact:
 *
 *   · A MODEL THAT EMITS `confidence: "0.93"` HAS EMITTED A STRING. It is `self_reported`, and
 *     the port already records it that way. What this adapter adds is the structural half: the
 *     payload handed to {@link interpret} is BUILT FIELD BY FIELD from the fields this adapter
 *     maps, never spread from the reply. There is no `native` key written anywhere below, so a
 *     float in a vendor's body has no route to `native_distribution` even if the vendor sends
 *     one under that name. A capability declared absent is enforced by construction, not by a
 *     promise in a comment.
 *
 *   · AN ECHO OF A MUTABLE MODEL NAME VERIFIES NOTHING. `qwen:7b` is a tag someone can
 *     repoint at different weights between two calls, so the reply's `model` field is recorded
 *     as `requested_model` — what was asked for — and never as the resolved identity. The
 *     identity that counts is the digest of the serving deployment, supplied by the caller that
 *     observed it. `deployment_verified` is claimed ONLY when a bound digest and an observed
 *     digest are both present and equal; every other case, the name-echo included, is
 *     `unverified`.
 *
 *   · A BOUND DIGEST THAT DOES NOT MATCH MEANS THE WEIGHTS THAT ANSWERED ARE NOT THE WEIGHTS
 *     THE PROFILE QUALIFIED. That runs through the port's own pinned-identity rule and comes
 *     back `invalid_response`. So does a bound digest with nothing observed against it: an
 *     unverifiable deployment is not a verified one. Disabling the affected profile is the act
 *     of whoever holds the runs, not of a parse — `profiles.ts` draws that line already ("what
 *     that stops is decided by whoever holds the runs, because stopping work is not a property
 *     of a profile"), and this module stays on its side of it.
 *
 *   · THE FAMILY IS RESOLVED, NEVER DEFAULTED. A caller may name the question outright; a reply
 *     may name its family; otherwise the label is looked up across the declared category and
 *     ordinal families. A label matching none, or more than one, yields `invalid_response`
 *     against a sentinel question whose id says which of the two happened. A default family
 *     would be worse than either: `unclear` is a declared key of two different families, and
 *     picking one would file an answer to a question nobody asked under the name of a question
 *     somebody did.
 *
 * ONE ASSESSMENT TYPE. Everything here produces {@link SemanticAssessment} through
 * {@link interpret}. This module owns a transport mapping and an identity policy; it owns no
 * second notion of what an answer is.
 */
import {
  QUESTION_FAMILIES,
  interpret,
  type AnswerSpec,
  type AskedQuestion,
  type AssessmentCall,
  type SemanticAssessment,
} from "./assessment.js";

// ── the families, rendered as labels ───────────────────────────────────────────────────────

/** One shared family and the answer contract this adapter renders for it. The keys ARE the
 *  labels: the request carries them, the reply is validated against them, and a word outside
 *  the set is refused rather than mapped onto the nearest one. */
interface LabelFamily {
  readonly question_id: string;
  readonly answer_spec: AnswerSpec;
}

const option = (key: string, meaning: string) => ({ key, meaning });

/**
 * THE NINE FAMILIES THIS ADAPTER SUPPLIES — two categories, one ordered set of levels, and six
 * predicates. The option spellings come from the register's own descriptions in
 * `assessment.ts`; the thirteen shipped skills cite the FAMILY names and say "in one of the
 * four shapes" without spelling the keys, so there is one place these are written down and this
 * is it.
 *
 * ORDERED, FOR THE ORDINAL ONE. `actionability`'s levels are listed weakest to strongest and
 * that order is the content of the family — but note what it does NOT buy: a level is chosen by
 * the assessor naming it, never by this adapter turning a number into one. There is no number.
 */
const FAMILIES: readonly LabelFamily[] = Object.freeze([
  {
    question_id: "evidence_relation",
    answer_spec: {
      kind: "category",
      options: [
        option("supports", "the passage demonstrates the claim"),
        option("contradicts", "the passage tells against the claim"),
        option("unclear", "the passage bears on the claim and does not settle it"),
        option("unrelated", "the passage bears no relation to the claim"),
      ],
    },
  },
  {
    question_id: "requirement_coverage",
    answer_spec: {
      kind: "category",
      options: [
        option("covers", "the clause covers the stated requirement"),
        option("partly_covers", "the clause covers part of the stated requirement"),
        option("omits", "the clause omits the stated requirement"),
        option("unclear", "the clause bears on the requirement and does not settle it"),
      ],
    },
  },
  {
    question_id: "actionability",
    answer_spec: {
      kind: "ordinal",
      levels: [
        option("absent", "no repair is proposed at all"),
        option("directional", "a direction is named and no concrete change is"),
        option("incomplete", "a concrete change is named and something needed to carry it out is missing"),
        option("specific", "the proposed repair is specific enough to carry out"),
      ],
    },
  },
  predicate("needs_fact", "the gap needs a fact fetched to resolve it", "the gap does not need a fact fetched"),
  predicate("needs_verification", "the gap needs something verified to resolve it", "the gap does not need anything verified"),
  predicate("needs_analysis", "the gap needs analysis to resolve it", "the gap does not need analysis"),
  predicate("missing_user_input", "an input only the person can supply is still missing", "no input only the person can supply is missing"),
  predicate("changes_commitment", "this would change what was already agreed and committed to", "this changes nothing already committed to"),
  predicate("repeats_finding", "this finding repeats one already recorded", "this finding repeats none already recorded"),
]);

function predicate(question_id: string, true_means: string, false_means: string): LabelFamily {
  return { question_id, answer_spec: { kind: "predicate", true_means, false_means } };
}

const BY_ID = new Map(FAMILIES.map((f) => [f.question_id, f] as const));

/** WHICH FAMILIES A BARE LABEL CAN IDENTIFY. Categories and ordinals only: a predicate's keys
 *  are `true`, `false` and `unknown`, which every predicate family shares, so a predicate reply
 *  that does not name its question is not addressable and must not be guessed at. */
const BY_LABEL = new Map<string, string[]>();
for (const family of FAMILIES) {
  const spec = family.answer_spec;
  const keys = spec.kind === "category" ? spec.options : spec.kind === "ordinal" ? spec.levels : [];
  for (const { key } of keys) {
    const owners = BY_LABEL.get(key) ?? [];
    owners.push(family.question_id);
    BY_LABEL.set(key, owners);
  }
}

// ── what the adapter declares about itself ─────────────────────────────────────────────────

/**
 * THE CAPABILITY DECLARATION, and the two `false` literals are the point of the file.
 *
 * `unmapped_families` is COMPUTED against the shared register rather than asserted. A tenth
 * family added upstream shows up here as a gap a reader can see, instead of throwing at module
 * load in a package every service imports — a coverage gap is not a reason to refuse to start.
 */
const CAPABILITIES = Object.freeze({
  /** No probability primitive. Not "none configured": none exists on this class of backend. */
  native_distributions: false as const,
  /** And no score primitive either, which is why nothing here maps a number onto a level. */
  native_scores: false as const,
  /** The families this adapter renders as labels. */
  families: Object.freeze(FAMILIES.map((f) => f.question_id)),
  /** Registered families this adapter does not yet render. Empty is a statement, not a default. */
  unmapped_families: Object.freeze(QUESTION_FAMILIES.filter((f) => !BY_ID.has(f))),
});

// ── reading an untrusted reply ─────────────────────────────────────────────────────────────

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

const has = (rec: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(rec, key);

/** A question that exists only to carry a refusal. Its id is the sentence: there are no declared
 *  options, so the port rejects whatever label arrives and names it in the reason, while the
 *  `question_id` on the record says why no real family was reached. */
const sentinel = (question_id: string): AskedQuestion =>
  ({ question_id, answer_spec: { kind: "category", options: [] } });

const NO_FAMILY = sentinel("label_names_no_declared_family");
const MANY_FAMILIES = sentinel("label_names_more_than_one_declared_family");

/** What the caller knows and the reply cannot say for itself. */
interface LabelParseOptions {
  /** The question that was actually asked. Wins over anything derived from the reply. */
  readonly question?: AskedQuestion;
  /** The deployment digest the active profile is bound to. */
  readonly boundDigest?: string;
  /** The deployment digest observed serving THIS request. */
  readonly observedDigest?: string;
  /** The envelope the caller recorded — request id, evidence snapshot, profile digest. The four
   *  identity fields are overwritten below: identity is this adapter's policy, not a caller's. */
  readonly envelope?: AssessmentCall;
}

function resolveQuestion(
  rec: Readonly<Record<string, unknown>> | null,
  options: LabelParseOptions | undefined,
): AskedQuestion {
  if (options?.question) return options.question;
  if (rec && typeof rec.question_id === "string") {
    return BY_ID.get(rec.question_id) ?? NO_FAMILY;
  }
  const label = rec && typeof rec.label === "string" ? rec.label : null;
  if (label === null) return NO_FAMILY;
  const owners = BY_LABEL.get(label) ?? [];
  if (owners.length === 1) return BY_ID.get(owners[0]) ?? NO_FAMILY;
  return owners.length === 0 ? NO_FAMILY : MANY_FAMILIES;
}

/**
 * THE TRANSPORT MAPPING, WRITTEN OUT RATHER THAN SPREAD. Four fields cross from the reply into
 * the payload and they are named here one at a time. That is the enforcement: a reply carrying
 * `native.distribution` has nowhere to land, so an adapter declaring `native_distributions:
 * false` cannot be made to contradict itself by a vendor sending the field anyway.
 *
 * `label` is set with `has` rather than a truthiness test, so an explicit `null` reaches the
 * port — where a null category or level key is the assessor saying it could not tell, which is
 * a real judgement and not an absence.
 */
function payloadFor(rec: Readonly<Record<string, unknown>>, spec: AnswerSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (has(rec, "insufficient_evidence")) payload.insufficient_evidence = rec.insufficient_evidence;
  if (has(rec, "confidence")) payload.confidence = rec.confidence;
  if (has(rec, "label")) {
    const field = spec.kind === "predicate" ? "predicate" : spec.kind === "category" ? "category" : "level_key";
    payload[field] = rec.label;
  }
  return payload;
}

/**
 * IDENTITY, AND WHY THE NAME IS NOT IT. The reply's `model` is what was asked for and is filed
 * under `requested_model`. What is compared is the deployment digest: bound against observed.
 *
 *   both present and equal → the pinned deployment served it; `deployment_verified`
 *   both present, different → the port's pinned-identity rule refuses it
 *   bound present, none observed → the same refusal, because unverifiable is not verified
 *   neither present → only a name was echoed; `unverified`, and nothing is compared
 */
function callFor(
  rec: Readonly<Record<string, unknown>> | null,
  options: LabelParseOptions | undefined,
): AssessmentCall {
  const requested = rec && typeof rec.model === "string" ? rec.model : undefined;
  const bound = options?.boundDigest;
  const observed = options?.observedDigest;
  return {
    ...options?.envelope,
    requested_model: requested,
    expected_identity: bound ?? null,
    resolved_identity: observed ?? requested ?? null,
    identity_assurance: bound !== undefined && bound === observed ? "deployment_verified" : "unverified",
  };
}

// ── the adapter ────────────────────────────────────────────────────────────────────────────

function parse(reply: unknown, options?: LabelParseOptions): SemanticAssessment {
  const rec = asRecord(reply);
  const question = resolveQuestion(rec, options);
  const call = callFor(rec, options);
  // A reply that is not an object never reaches the mapping: the port says so itself, and says
  // it against whichever question was resolved, so the record still names what was asked.
  if (rec === null) return interpret(question, reply, call);
  return interpret(question, payloadFor(rec, question.answer_spec), call);
}

/**
 * A SECOND EXECUTABLE ASSESSOR, alongside the one that has a probability primitive, differing
 * from it in exactly the way that matters: this one declares it has none.
 *
 * `questionFor` is how a caller renders a request. Supplying the labels is half of what
 * "supplies categories, predicates and ordered labels" means — the other half is refusing any
 * answer that is not one of them, which `parse` gets from the port.
 */
export const labelAdapter = Object.freeze({
  adapter_id: "label-only",
  capabilities: CAPABILITIES,
  questionFor: (family: string): AskedQuestion | undefined => BY_ID.get(family),
  parse,
});
