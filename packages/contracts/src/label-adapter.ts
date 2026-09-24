/**
 * A label-only assessor adapter, and the capability it declares absent.
 *
 * The backends this maps onto return a word. `capabilities.native_distributions` is the literal
 * `false`, so no later edit can flip it without the compiler objecting, and the payload handed
 * to {@link interpret} is built field by field rather than spread from the reply, so a float in
 * a vendor's body has no route to `native_distribution`.
 *
 * Identity comes from the deployment digest, never from the reply's model name, which is a tag
 * that can be repointed between calls. The question family is resolved, never defaulted.
 *
 * Everything here produces {@link SemanticAssessment} through {@link interpret}. This module
 * owns a transport mapping and an identity policy, and no second notion of what an answer is.
 */
import {
  QUESTION_FAMILIES,
  interpret,
  type AnswerSpec,
  type AskedQuestion,
  type AssessmentCall,
  type SemanticAssessment,
} from "./assessment.js";

// The families, rendered as labels

/** One shared family and the answer contract this adapter renders for it. The keys are the
 *  labels: the request carries them, the reply is validated against them, and a word outside
 *  the set is refused rather than mapped onto the nearest one. */
interface LabelFamily {
  readonly question_id: string;
  readonly answer_spec: AnswerSpec;
}

const option = (key: string, meaning: string) => ({ key, meaning });

/**
 * The nine families this adapter supplies: two categories, one ordered set of levels, and six
 * predicates. The option spellings come from the register's own descriptions in `assessment.ts`;
 * the shipped skills cite the family names without spelling the keys, so this is the one place
 * they are written down.
 *
 * `actionability`'s levels are listed weakest to strongest and that order is the content of the
 * family. A level is still chosen by the assessor naming it, never by turning a number into one.
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

/** Which families a bare label can identify: categories and ordinals only. Every predicate
 *  family shares the keys `true`, `false` and `unknown`, so a predicate reply that does not name
 *  its question is not addressable. */
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

// What the adapter declares about itself

/**
 * The capability declaration; the two `false` literals are the point of the file.
 *
 * `unmapped_families` is computed against the shared register rather than asserted, so a tenth
 * family added upstream shows up as a visible gap instead of throwing at module load in a
 * package every service imports.
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

// Reading an untrusted reply

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
  /** The deployment digest observed serving this request. */
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
 * The transport mapping, written out rather than spread. Four fields cross from the reply into
 * the payload and are named here one at a time, so a reply carrying `native.distribution` has
 * nowhere to land.
 *
 * `label` is set with `has` rather than a truthiness test, so an explicit `null` reaches the
 * port, where a null category or level key is the assessor saying it could not tell.
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
 * Identity: the reply's `model` is what was asked for and is filed under `requested_model`. What
 * is compared is the deployment digest, bound against observed.
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

// The adapter

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
 * An executable assessor that declares it has no probability primitive.
 *
 * `questionFor` is how a caller renders a request. Supplying the labels is half of "supplies
 * categories, predicates and ordered labels"; refusing any answer that is not one of them comes
 * from the port, through `parse`.
 */
export const labelAdapter = Object.freeze({
  adapter_id: "label-only",
  capabilities: CAPABILITIES,
  questionFor: (family: string): AskedQuestion | undefined => BY_ID.get(family),
  parse,
});
