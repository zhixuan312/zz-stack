/**
 * The first provider adapter: one supplier's three answer primitives, read into the shared
 * assessment record and into nothing else.
 *
 * The provider's vocabulary stops at this file. `choice`, `score` and `noul` are its words for
 * its own primitives; the platform's words are the question families and the answer shapes in
 * `../assessment.js`. The whole mapping lives in `PRIMITIVES` and the three payload builders
 * below, so nothing downstream of `interpret` has heard of a primitive. Nothing here builds a
 * `SemanticAssessment`: the port does that, from a payload this adapter translates first.
 *
 * Two rules the guards below enforce: no default is substituted for a field that was present
 * and unreadable — every primitive is read by a guard that answers only for the exact
 * JavaScript type the supplier documents — and no figure is clamped into range, so a 7 on a
 * two-level scale is `invalid_response` rather than the nearest legal value.
 *
 * Identity is an assertion and is recorded as one: a reply matching an exactly pinned version
 * is `provider_reported` and never anything stronger, and one naming a different version is
 * `invalid_response`. An alias pin is not an identity to compare against — the supplier
 * resolves `jev-latest` server side and reports the concrete version it ran — so the comparison
 * is made only when the pin is an exact version. Under an alias the reported version is
 * recorded as the resolved identity, the assurance is `unverified`, and the alias is not handed
 * to the port as an expected identity, because the port would make the same
 * guaranteed-to-fail comparison. Under either pin a reply naming no version at all is refused.
 *
 * `{ true: p, false: 1 - p }` is the only value in this file the supplier did not send: its
 * yes/no primitive returns a single probability, and the port's predicate path needs a
 * distribution over the question's declared keys summing to one.
 *
 * `readings` carries the supplier's own numbers beside the record — the per-level
 * `probabilities` of a score and the `legend`, which the port has no column for and this
 * adapter validates itself, together with the numbers read back out of the port's signals. It
 * decides nothing: `status` and `value` remain the port's, and `authorizesSemanticAdvance`
 * reads the status alone.
 *
 * DELIBERATE: the score distribution does not go through the port's native channel, which
 * requires a distribution to sum to one within its rounding bound (0.005 per key). The supplier's
 * per-level probabilities are carried as readings, not as the port's distribution. The
 * shape is checked here instead — every key a level this question declared, every value a
 * probability — and the map is carried verbatim, unsummed and unnormalised.
 *
 * `rejected` below builds the port's own record type for a reply this adapter refuses:
 * `interpret` accepts a reply with no model field against an exactly pinned version.
 */
import type {
  AnswerOption, AnswerSpec, AskedQuestion, AssessmentCall, AssessmentStatus,
  IdentityAssurance, SemanticAssessment,
} from "../assessment.js";
import { interpret } from "../assessment.js";
import { stableDigest } from "../profiles.js";

// The supplier's three primitives, and what each one answers here

type Primitive = "choice" | "score" | "noul";

/** Which shared answer shape each primitive may answer, and the default question the adapter
 *  renders it for. The default is a request shape, not a claim about what was asked: a caller
 *  that asked something else passes its own question and the reply is validated against that
 *  instead. What the default buys is that a key is always checked against a declared set. */
const PRIMITIVES: Readonly<Record<Primitive, { readonly kind: AnswerSpec["kind"]; readonly question: string }>> =
  Object.freeze({
    choice: Object.freeze({ kind: "category" as const, question: "evidence_relation" }),
    score: Object.freeze({ kind: "ordinal" as const, question: "actionability" }),
    noul: Object.freeze({ kind: "predicate" as const, question: "needs_fact" }),
  });

const ORDER: readonly Primitive[] = Object.freeze(["choice", "score", "noul"]);

const options = (...keys: readonly string[]): readonly AnswerOption[] =>
  Object.freeze(keys.map((key) => Object.freeze({ key, meaning: "" })));

/** The declared keys of each default question. Ordered low to high for the ordinal one, which
 *  is the order the supplier's level scale is numbered in. */
const DEFAULT_KEYS: Readonly<Record<Primitive, readonly AnswerOption[]>> = Object.freeze({
  choice: options("supports", "contradicts", "unclear", "unrelated"),
  score: options("absent", "directional", "incomplete", "specific"),
  noul: Object.freeze([]),
});

/** An exact version: a name and three numbered parts. Anything else — a bare name, a moving
 *  tag, a two-part version — is an alias, and the header says what an alias cannot confer. */
const EXACT_VERSION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+\.\d+\.\d+$/;

/** A level as the supplier names one: its index in the declared order, as a string. Its scales
 *  are numbered from zero, so this is the key its `probabilities` and `legend` maps carry. */
const LEVEL_INDEX = /^\d+$/;

// Reading an untrusted reply

export function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

export const present = (rec: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(rec, key);

/** A field as a message can name it. `JSON.stringify(undefined)` is `undefined` rather than a
 *  string, so the one value most likely to be in a broken field is the one a template would
 *  have printed as the word "undefined" by accident. It is printed deliberately instead. */
export const describe = (value: unknown): string =>
  value === undefined ? "undefined" : JSON.stringify(value) ?? String(value);

/** A real number, and only that. Not a numeric string: the supplier documents these primitives
 *  as JSON numbers, so a string here is a different reply than this adapter knows how to
 *  read. */
const realNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A non-empty model name, or null. Used for the reply's own field and for the envelope's. */
export const identityOf = (rec: Readonly<Record<string, unknown>>): string | null =>
  typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model : null;

// What a caller supplies

export interface JevParseOptions {
  /** The version the approved profile pinned. An exact version is compared against the reply;
   *  an alias is not — see the header for what an alias can and cannot establish. */
  readonly expect: string;
  /** The shared question this reply answers. Omitted, the adapter validates against its own
   *  default rendering for whichever primitive came back. */
  readonly question?: AskedQuestion;
  /** What the record should call the question, when the caller passed no whole question. The
   *  adapter's default rendering names its own default question, which is a request shape
   *  rather than the thing that was asked; a batch supplies the key it asked under. */
  readonly question_id?: string;
  /** The ordered levels of the supplier's score scale, low to high. Its scores are continuous
   *  positions numbered from zero, so N levels declare the range `0 .. N - 1` — which is what
   *  makes an out-of-range figure detectable at all. */
  readonly legend?: readonly (string | number)[];
  /** A qualified mapping from a probability to yes/no/unknown. Without one a probability stays
   *  a probability and the port records `unsupported`. */
  readonly bounds?: { readonly no_le: number; readonly yes_ge: number };
  /** A qualified mapping from a score to one of the question's levels. Same rule. */
  readonly mapping?: AssessmentCall["ordinal_mapping"];
  readonly request_id?: string;
  readonly question_digest?: string;
  readonly evidence_snapshot_id?: string;
  readonly profile_digest?: string;
  readonly interpretation_profile_ref?: string;
}

/**
 * The supplier's own numbers, validated, beside the record rather than inside it.
 *
 * Four are read back out of the port's signals, so they are the numbers it validated rather
 * than a second reading of the body. `distribution` and `legend` are the companions the port
 * has no column for and this adapter checks itself. Every field is null when the supplier did
 * not send it or when the reply was refused: null means "not established", never zero and never
 * a default.
 */
interface JevReadings {
  /** The score's position on its declared `0 .. N - 1` scale. Null unless a scale was declared,
   *  because a figure nothing could range-validate is not a reading. */
  readonly score: number | null;
  /** The yes/no primitive's probability, as the port validated it. */
  readonly probability: number | null;
  /** The supplier's own confidence, when it sent one. */
  readonly confidence: number | null;
  /** The supplier's per-level `probabilities`, keyed as it keys them and carried unsummed —
   *  see the header for why. */
  readonly distribution: Readonly<Record<string, number>> | null;
  /** The supplier's echoed `legend`: what it understood each level to mean. */
  readonly legend: Readonly<Record<string, string>> | null;
}

const NO_READINGS: JevReadings = Object.freeze({
  score: null, probability: null, confidence: null, distribution: null, legend: null,
});

/** The port's record, plus the reply it was read from. The raw body is kept verbatim so that
 *  everything this adapter discarded — the supplier's own field names, anything it sends that
 *  the port has no column for — is still recoverable. `raw_response_ref` on the record is this
 *  body's content digest. */
export interface JevParseResult extends SemanticAssessment {
  readonly raw_response: Readonly<Record<string, unknown>> | null;
  readonly readings: JevReadings;
}
// Refusing, without inventing a record to refuse in

/** A refusal is still the port's record. Every envelope field the caller supplied is carried
 *  so a rejected reply is as traceable as an accepted one; `value` is null, `signals` empty and
 *  every reading null because nothing was measured; and the status is never `answered`, which
 *  is what `authorizesSemanticAdvance` reads. */
export function rejected(
  opts: JevParseOptions, status: AssessmentStatus, reason: string,
  observed: string | null, assurance: IdentityAssurance,
  rec: Readonly<Record<string, unknown>> | null, ref: string | null,
): JevParseResult {
  return Object.freeze({
    request_id: opts.request_id ?? null,
    question_id: opts.question?.question_id ?? opts.question_id ?? PRIMITIVES.choice.question,
    question_digest: opts.question_digest ?? null,
    evidence_snapshot_id: opts.evidence_snapshot_id ?? null,
    profile_digest: opts.profile_digest ?? null,
    status,
    value: null,
    signals: Object.freeze([]),
    raw_response_ref: ref,
    interpretation_profile_ref: opts.interpretation_profile_ref ?? null,
    requested_model: opts.expect,
    resolved_identity: observed,
    identity_assurance: assurance,
    failure_reason: reason,
    raw_response: rec,
    readings: NO_READINGS,
  });
}

// The question a reply is validated against

/** The caller's question, or the default rendering for the primitive that came back. An
 *  ordinal default takes its levels from the declared legend when there is one, because the
 *  legend is the scale the caller asked on and validating against a different level count
 *  would refuse a good answer. */
function questionFor(primitive: Primitive, opts: JevParseOptions): AskedQuestion {
  if (opts.question) return opts.question;
  const question_id = opts.question_id ?? PRIMITIVES[primitive].question;
  if (primitive === "noul") {
    return { question_id, answer_spec: { kind: "predicate", true_means: "yes", false_means: "no" } };
  }
  if (primitive === "score") {
    const levels = opts.legend
      ? options(...opts.legend.map((l) => String(l)))
      : DEFAULT_KEYS.score;
    return { question_id, answer_spec: { kind: "ordinal", levels } };
  }
  return { question_id, answer_spec: { kind: "category", options: DEFAULT_KEYS.choice } };
}

/** How many levels the question declares, or null when it declares none — used to check the
 *  supplier's echoed legend and its per-level distribution against the scale that was asked. */
const levelCount = (spec: AnswerSpec): number | null =>
  spec.kind === "ordinal" ? spec.levels.length : null;

// The primitives, translated

interface Translated {
  readonly payload: Record<string, unknown>;
  readonly distribution: Readonly<Record<string, number>> | null;
  readonly legend: Readonly<Record<string, string>> | null;
}

/** The supplier's per-level distribution. Every key must be a level this question declared and
 *  every value a probability; nothing is summed, renormalised or filled in. See the header for
 *  why the sum is not checked here. */
function levelDistribution(
  raw: unknown, declared: number | null,
): { values: Readonly<Record<string, number>> } | { reason: string } {
  const rec = asRecord(raw);
  if (rec === null) {
    return { reason: `the probabilities field is ${describe(raw)}, not a map of levels to probabilities` };
  }
  const values: Record<string, number> = {};
  for (const key of Object.keys(rec)) {
    if (!LEVEL_INDEX.test(key) || (declared !== null && Number(key) >= declared)) {
      return { reason: `the probabilities map carries the level ${key}, which this question never declared` };
    }
    const n = rec[key];
    if (!realNumber(n) || n < 0 || n > 1) {
      return { reason: `the probability for level ${key} is ${describe(n)}, not a probability between 0 and 1` };
    }
    values[key] = n;
  }
  return { values: Object.freeze(values) };
}

/** The echoed scale. It must be the scale that was asked for and readable as one: a level
 *  index against the words that level meant. A reply scoring on five levels when four were
 *  declared is answering a different question, and its figure would be read against the wrong
 *  scale downstream. */
function echoedLegend(
  raw: unknown, declared: number | null,
): { values: Readonly<Record<string, string>> } | { reason: string } {
  const rec = asRecord(raw);
  if (rec === null) return { reason: `the legend field is ${describe(raw)}, not a set of levels` };
  const keys = Object.keys(rec);
  if (declared !== null && keys.length !== declared) {
    return { reason: `the reply describes ${keys.length} levels and this question declares ${declared}` };
  }
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (!LEVEL_INDEX.test(key) || (declared !== null && Number(key) >= declared)) {
      return { reason: `the legend describes the level ${key}, which this question never declared` };
    }
    const meaning = rec[key];
    if (typeof meaning !== "string") {
      return { reason: `the legend for level ${key} is ${describe(meaning)}, not what that level means` };
    }
    values[key] = meaning;
  }
  return { values: Object.freeze(values) };
}

/** A payload in the port's own shape, or the reason this reply cannot become one. Each branch
 *  reads exactly one primitive and passes the supplier's optional companions through unchanged
 *  for the port to validate: nothing is normalised, rounded or filled in on the way. */
function translate(
  primitive: Primitive, rec: Readonly<Record<string, unknown>>, model: string, question: AskedQuestion,
): Translated | { reason: string } {
  const payload: Record<string, unknown> = { model };
  // `confidence` travels as the port's own confidence field, which records it `self_reported`.
  // The supplier computes it from its distribution, so this understates where the number came
  // from — the port has one channel for it, and overstating would make a derived scalar read as
  // a measured one.
  if (present(rec, "confidence") && rec.confidence !== null) payload.confidence = rec.confidence;

  if (primitive === "choice") {
    const key = rec.choice;
    if (typeof key !== "string" || key.trim() === "") {
      return { reason: `the choice field is ${describe(key)}, not one of this question's declared keys` };
    }
    payload.category = key;
    // The supplier's own distribution, copied. The port checks every key against the question
    // and the sum against one; a key nobody declared makes the whole reply invalid there, which
    // is right — a distribution over options the question never offered describes a different
    // question. A choice names one of a declared set, so its keys are those names and the port
    // can read them; only the ordinal scale is numbered, and only that one is read below.
    if (present(rec, "probabilities") && rec.probabilities !== null) {
      payload.native = { distribution: rec.probabilities };
    }
    return { payload, distribution: null, legend: null };
  }

  if (primitive === "score") {
    const score = rec.score;
    if (!realNumber(score)) {
      return { reason: `the score field is ${describe(score)}, not a finite number on the declared scale` };
    }
    const declared = levelCount(question.answer_spec);
    let legend: Readonly<Record<string, string>> | null = null;
    if (present(rec, "legend") && rec.legend !== null) {
      const echoed = echoedLegend(rec.legend, declared);
      if ("reason" in echoed) return echoed;
      legend = echoed.values;
    }
    let distribution: Readonly<Record<string, number>> | null = null;
    if (present(rec, "probabilities") && rec.probabilities !== null) {
      const read = levelDistribution(rec.probabilities, declared);
      if ("reason" in read) return read;
      distribution = read.values;
    }
    // Under the port's native channel: the figure is the supplier's own primitive, a weighted
    // position over its level distribution, rather than a number it wrote out as text.
    payload.native = { score };
    return { payload, distribution, legend };
  }

  const p = rec.noul;
  if (!realNumber(p) || p < 0 || p > 1) {
    return { reason: `the noul field is ${describe(p)}, not a probability between 0 and 1` };
  }
  payload.native = { distribution: { true: p, false: 1 - p } };
  return { payload, distribution: null, legend: null };
}

// Parsing

/** One number the port validated, read back out of its own signals. Reading it back rather
 *  than re-deriving it is the point: a reading and the record can never disagree. */
function signalValue(assessed: SemanticAssessment, name: string, key: string): number | null {
  const signal = assessed.signals.find((s) => s.name === name);
  const value = signal?.values[key];
  return typeof value === "number" ? value : null;
}

/**
 * Read one reply. The order is the contract's: a body that is not a reply at all, then the
 * identity, then which primitive came back and whether the question admits it, then the
 * primitive's own type, and only then the port — which owns range validation, key membership,
 * distribution arithmetic and the decision about what may become a value.
 *
 * The identity is checked here and handed to the port as the pinned identity, but only when the
 * pin is an exact version. DELIBERATE: the duplication — this adapter refuses an unidentified
 * reply, which the port cannot, and the port refuses a misidentified one independently of
 * whether this function was correct. Under an alias neither comparison is made.
 */
export function parse(raw: unknown, opts: JevParseOptions): JevParseResult {
  const rec = asRecord(raw);
  const ref = raw === undefined || raw === null ? null : `assessor-raw:${stableDigest(raw)}`;
  const refuse = (status: AssessmentStatus, reason: string, observed: string | null = null,
                  assurance: IdentityAssurance = "unverified"): JevParseResult =>
    rejected(opts, status, reason, observed, assurance, rec, ref);

  if (typeof opts.expect !== "string" || opts.expect.trim() === "") {
    return refuse("invalid_response", "no version was pinned for this call, so no reply to it can be eligible");
  }
  if (rec === null) {
    // Nothing at all is transport, a non-object is a broken reply, and the port draws the same
    // line: the first is `unavailable` because nobody assessed anything, the second is
    // `invalid_response` because something answered and what it said cannot be read.
    return raw === undefined || raw === null
      ? refuse("unavailable", "the adapter was handed no reply and no recorded failure")
      : refuse("invalid_response", `the reply is ${describe(raw)}, not an object`);
  }

  const reported = identityOf(rec);
  if (reported === null) {
    return refuse("invalid_response",
      `the reply names no model, so the pinned ${opts.expect} cannot be the version that served it`);
  }
  // An exact pin is exact; an alias is not a version to match. See the header.
  const pinned = EXACT_VERSION.test(opts.expect);
  if (pinned && reported !== opts.expect) {
    return refuse("invalid_response",
      `the reply came from ${reported}, not the pinned ${opts.expect}`, reported, "provider_reported");
  }
  const assurance: IdentityAssurance = pinned ? "provider_reported" : "unverified";

  const found = ORDER.filter((p) => present(rec, p));
  if (found.length === 0) {
    return refuse("invalid_response", "the reply carries none of the answer primitives this adapter reads",
      reported, assurance);
  }
  if (found.length > 1) {
    return refuse("invalid_response",
      `the reply carries ${found.length} answer primitives at once, and one question has one answer`,
      reported, assurance);
  }
  const primitive = found[0];
  if (present(rec, "type") && rec.type !== primitive) {
    return refuse("invalid_response",
      `the reply is labelled ${describe(rec.type)} and carries a ${primitive} answer`, reported, assurance);
  }

  const question = questionFor(primitive, opts);
  const admits = PRIMITIVES[primitive].kind;
  if (question.answer_spec.kind !== admits) {
    return refuse("invalid_response",
      `this question takes a ${question.answer_spec.kind} answer and the reply carries a ${primitive} one`,
      reported, assurance);
  }

  // Two declarations of one scale have to agree. A caller passing both a question and a legend
  // has said the same thing twice; if the two disagree the figure would be range-validated
  // against one scale and mapped against the other.
  if (opts.question && opts.legend && levelCount(question.answer_spec) !== opts.legend.length) {
    return refuse("invalid_response",
      `the question declares ${levelCount(question.answer_spec)} levels and the call declares a legend of ` +
      `${opts.legend.length}`, reported, assurance);
  }

  const translated = translate(primitive, rec, reported, question);
  if ("reason" in translated) return refuse("invalid_response", translated.reason, reported, assurance);

  // The scale, declared or not declared. N ordered levels are the range `0 .. N - 1`, and they
  // come from whichever of the two the caller supplied — the question's own levels, or the
  // legend the default question was built from. Nothing is declared when the caller declared
  // nothing: the adapter's default level set is a request shape, not a scale somebody agreed
  // to. The port answers that with `unsupported`, keeping the figure and refusing the level.
  const declared = opts.question || opts.legend ? levelCount(question.answer_spec) : null;
  const scale = declared !== null && declared >= 2 ? { min: 0, max: declared - 1 } : undefined;
  const call: AssessmentCall = {
    request_id: opts.request_id,
    question_digest: opts.question_digest,
    evidence_snapshot_id: opts.evidence_snapshot_id,
    profile_digest: opts.profile_digest,
    interpretation_profile_ref: opts.interpretation_profile_ref,
    raw_response_ref: ref ?? undefined,
    requested_model: opts.expect,
    // An alias is not handed over as an expected identity: the port compares it literally, so
    // passing one would refuse the concrete version the alias resolved to.
    expected_identity: pinned ? opts.expect : null,
    resolved_identity: reported,
    identity_assurance: assurance,
    predicate_bounds: opts.bounds,
    score_range: scale,
    ordinal_mapping: opts.mapping,
  };
  const assessed = interpret(question, translated.payload, call);
  const readings: JevReadings = Object.freeze({
    score: signalValue(assessed, "score", "score"),
    probability: primitive === "noul" ? signalValue(assessed, "distribution", "true") : null,
    confidence: signalValue(assessed, "confidence", "confidence"),
    distribution: translated.distribution,
    legend: translated.legend,
  });
  return Object.freeze({ ...assessed, raw_response: rec, readings });
}
