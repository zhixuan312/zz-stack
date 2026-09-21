/**
 * THE FIRST PROVIDER ADAPTER: one supplier's three answer primitives, read into the shared
 * assessment record and into nothing else.
 *
 * THE PROVIDER'S VOCABULARY STOPS AT THIS FILE. `choice`, `score` and `noul` are its words for
 * its own primitives; the platform's words are the question families and the answer shapes in
 * `../assessment.js`. The whole mapping between the two lives in `PRIMITIVES` and the three
 * payload builders below, so a second supplier is a second file rather than a condition
 * threaded through the port — and so nothing downstream of `interpret` has ever heard of a
 * primitive. Nothing here builds a `SemanticAssessment` for an answer either: the port does
 * that, from a payload this adapter translates and validates first.
 *
 * WHAT IT IS ACTUALLY GUARDING. Two specific ways a judgement nobody made gets written down as
 * one that was:
 *
 *   · AN ABSENT FIELD COERCED INTO A VALUE. `score` present and carrying `undefined` is not a
 *     score of zero, and it is emphatically not a score of one — which is what it becomes the
 *     moment anything reaches for `Number(v)`, `v ?? 1`, or a level index plus one. Every
 *     primitive is read by its own typed guard, a guard that answers only for the exact
 *     JavaScript type the supplier documents, and a field that fails one stops the parse. No
 *     default is ever substituted for a field that was present and unreadable.
 *   · AN OUT-OF-RANGE FIGURE CLAMPED INTO RANGE. A 7 on a two-level scale is not a 1. It is a
 *     reply that broke the contract, and the port records it as `invalid_response` rather than
 *     as the nearest legal value, because a clamped figure is indistinguishable one table later
 *     from a figure the assessor actually produced.
 *
 * IDENTITY IS AN ASSERTION, AND IS RECORDED AS ONE. A hosted supplier saying which version
 * served a request is that supplier's word for it: there is no signature, no attestation, and
 * nothing this adapter could check the claim against. So a reply matching an exactly pinned
 * version is `provider_reported` and never anything stronger. A reply naming a DIFFERENT
 * version is `invalid_response` — not a warning, not a substitution — because the qualification
 * that made the pinned version eligible was measured against that version and no other.
 *
 * AN ALIAS PIN IS NOT AN IDENTITY TO COMPARE AGAINST, and this is the correction that made the
 * adapter usable. `jev-latest` is a name for whatever the supplier is serving today; the
 * supplier resolves it server side and reports the CONCRETE version it ran. Requiring the
 * reported version to equal the alias therefore refuses every real reply on any deployment that
 * pins one — which is what this file did while nothing called it. So the comparison is made
 * only when the pin is an exact version. Under an alias the reported version is recorded as the
 * resolved identity, the assurance is `unverified`, and the alias is NOT handed to the port as
 * an expected identity, because the port would make the same guaranteed-to-fail comparison. An
 * alias confers no eligibility and now says so by recording nothing rather than by refusing
 * everything. What is refused under either pin is a reply naming NO version at all: the
 * supplier documents an identity on every response body, so its absence is a malformed reply.
 *
 * ONE DERIVED NUMBER, DECLARED HERE. The supplier's yes/no primitive returns a single
 * probability, and the port's predicate path needs a distribution over the question's declared
 * keys that sums to one. So `{ true: p, false: 1 - p }` is built here. It is the Bernoulli
 * complement of a number the supplier did emit, not a shape invented around a label, and it is
 * the only value in this file the supplier did not send.
 *
 * WHAT `readings` IS FOR, AND WHY IT IS NOT A SECOND ANSWER SHAPE. The port keeps what it can
 * validate against a question: a value, a confidence, a distribution over declared keys, a
 * score on a declared range. The supplier also sends two companions the port has no column for
 * — the per-level `probabilities` of a score, and the `legend` echoing what each level meant.
 * A caller that needs those otherwise reads them off an untrusted body itself, which is the
 * casting this module exists to replace. So they are validated HERE and carried in `readings`
 * beside the record, together with the numbers the port already validated, read back out of its
 * own signals rather than re-derived. `readings` decides nothing: `status` and `value` remain
 * the port's, and `authorizesSemanticAdvance` still reads the status alone.
 *
 * THE SCORE DISTRIBUTION IS NOT PUT THROUGH THE PORT'S NATIVE CHANNEL, deliberately, and the
 * reason is measured rather than assumed. That channel requires a distribution to sum to one
 * within 1e-3. Of 556 real score replies this platform has stored, 7 sum to 0.99 — the
 * supplier rounds each level to two decimals and does not renormalise. Routing them through
 * the port would make a well-formed reply `invalid_response` about once in eighty, discarding
 * a score that is itself valid because a companion field was rounded. So the shape is checked
 * here — every key a level this question declared, every value a probability — and the map is
 * carried verbatim, unsummed and unnormalised. Anyone tempted to "fix" this by adding the sum
 * rule should re-run that count first.
 *
 * WHY A REJECTION IS BUILT HERE RATHER THAN BY THE PORT. `interpret` refuses a reply from the
 * wrong model, but only when the reply named one: a reply with NO model field, against an
 * exactly pinned version, reaches its answer branches and is accepted. That is a gap in the
 * port worth closing there; this adapter cannot close it from outside, so it rejects the
 * unidentified reply itself, through `rejected` below. `rejected` builds the port's own
 * exported record type — there is no second assessment shape in this file.
 */
import type {
  AnswerOption, AnswerSpec, AskedQuestion, AssessmentCall, AssessmentStatus,
  IdentityAssurance, SemanticAssessment,
} from "../assessment.js";
import { interpret } from "../assessment.js";
import { stableDigest } from "../profiles.js";

// ── the supplier's three primitives, and what each one answers here ────────────────────────

type Primitive = "choice" | "score" | "noul";

/** Which shared answer shape each primitive may answer, and the default question the adapter
 *  renders it for. THE DEFAULT IS A REQUEST SHAPE, NOT A CLAIM ABOUT WHAT WAS ASKED: a caller
 *  that asked something else passes its own question and the reply is validated against that
 *  instead. What the default buys is that a key is always checked against a declared set —
 *  there is no path here on which an arbitrary string becomes an answer. */
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

// ── reading an untrusted reply ─────────────────────────────────────────────────────────────

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

/** A real number, and only that. NOT a numeric string: the supplier documents these primitives
 *  as JSON numbers, so a string here is a different reply than the one this adapter knows how
 *  to read, and guessing at it is how a malformed body becomes a measurement. */
const realNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A non-empty model name, or null. Used for the reply's own field and for the envelope's. */
export const identityOf = (rec: Readonly<Record<string, unknown>>): string | null =>
  typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model : null;

// ── what a caller supplies ─────────────────────────────────────────────────────────────────

export interface JevParseOptions {
  /** The version the approved profile pinned. An EXACT version is compared against the reply;
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
 * THE SUPPLIER'S OWN NUMBERS, VALIDATED, beside the record rather than inside it.
 *
 * Four of these are read back out of the port's signals, so they are the very numbers it
 * validated and not a second reading of the body. Two — `distribution` and `legend` — are the
 * companions the port has no column for and this adapter checks itself. Every field is null
 * when the supplier did not send it or when the reply was refused: null here means "not
 * established", never zero and never a default.
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
   *  see the header for the 7-in-556 measurement behind that. */
  readonly distribution: Readonly<Record<string, number>> | null;
  /** The supplier's echoed `legend`: what it understood each level to mean. */
  readonly legend: Readonly<Record<string, string>> | null;
}

const NO_READINGS: JevReadings = Object.freeze({
  score: null, probability: null, confidence: null, distribution: null, legend: null,
});

/** The port's record, plus the reply it was read from. The raw body is kept verbatim so that
 *  everything this adapter DISCARDED — the supplier's own field names, anything it sends that
 *  the port has no column for — is still recoverable from the one place it was preserved,
 *  rather than existing only as whatever survived the translation. `raw_response_ref` on the
 *  record is this body's content digest. */
export interface JevParseResult extends SemanticAssessment {
  readonly raw_response: Readonly<Record<string, unknown>> | null;
  readonly readings: JevReadings;
}
// ── refusing, without inventing a record to refuse in ──────────────────────────────────────

/** A REFUSAL IS STILL THE PORT'S RECORD. Every envelope field the caller supplied is carried
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

// ── the question a reply is validated against ──────────────────────────────────────────────

/** The caller's question, or the default rendering for the primitive that came back. An
 *  ordinal default takes its levels from the declared legend when there is one, because the
 *  legend IS the scale the caller asked on and validating against a different level count
 *  would refuse a good answer for the wrong reason. */
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

// ── the primitives, translated ─────────────────────────────────────────────────────────────

interface Translated {
  readonly payload: Record<string, unknown>;
  readonly distribution: Readonly<Record<string, number>> | null;
  readonly legend: Readonly<Record<string, string>> | null;
}

/** THE SUPPLIER'S PER-LEVEL DISTRIBUTION. Every key must be a level this question declared and
 *  every value a probability; nothing is summed, renormalised or filled in. See the header for
 *  why the sum is not checked here and why it must not be added. */
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

/** THE ECHOED SCALE. It must be the scale that was asked for, and it must be readable as one:
 *  a level index against the words that level meant. A reply scoring on five levels when four
 *  were declared is answering a question nobody asked, and its figure would be read against the
 *  wrong scale by everything downstream. */
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
  // The supplier computes it from its distribution rather than writing it as prose, so this is
  // an UNDERSTATEMENT of where the number came from — and understating provenance is the only
  // direction that is safe, since the port has one channel for it and overstating would make a
  // derived scalar read as a measured one.
  if (present(rec, "confidence") && rec.confidence !== null) payload.confidence = rec.confidence;

  if (primitive === "choice") {
    const key = rec.choice;
    if (typeof key !== "string" || key.trim() === "") {
      return { reason: `the choice field is ${describe(key)}, not one of this question's declared keys` };
    }
    payload.category = key;
    // THE SUPPLIER'S OWN DISTRIBUTION, COPIED. The port checks every key against the question
    // and the sum against one; a key nobody declared makes the whole reply invalid there, which
    // is the right outcome — a distribution over options the question never offered describes a
    // different question. A choice names one of a declared set, so its keys are those names and
    // the port can read them; only the ordinal scale is numbered, and only that one is read
    // below instead.
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

// ── parsing ────────────────────────────────────────────────────────────────────────────────

/** One number the port validated, read back out of its own signals. Reading it back rather
 *  than re-deriving it is the point: a reading and the record can never disagree. */
function signalValue(assessed: SemanticAssessment, name: string, key: string): number | null {
  const signal = assessed.signals.find((s) => s.name === name);
  const value = signal?.values[key];
  return typeof value === "number" ? value : null;
}

/**
 * READ ONE REPLY. The order is the contract's: a body that is not a reply at all, then the
 * identity, then which primitive came back and whether the question admits it, then the
 * primitive's own type, and only then the port — which owns range validation, key membership,
 * distribution arithmetic and the decision about what may become a value.
 *
 * The identity is checked here AND handed to the port as the pinned identity, but only when the
 * pin is an exact version. The duplication is deliberate: this adapter refuses an unidentified
 * reply, which the port cannot, and the port refuses a misidentified one independently of
 * whether this function was correct. Under an alias neither comparison is made, for the reason
 * the header gives.
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
    // NOTHING AT ALL IS TRANSPORT, A NON-OBJECT IS A BROKEN REPLY, and the port draws the same
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
  // AN EXACT PIN IS EXACT; AN ALIAS IS NOT A VERSION TO MATCH. See the header.
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

  // TWO DECLARATIONS OF ONE SCALE HAVE TO AGREE. A caller passing both a question and a legend
  // has said the same thing twice; if the two disagree the figure would be range-validated
  // against one scale and mapped against the other, which is the quietest way a valid-looking
  // level comes out of an invalid comparison.
  if (opts.question && opts.legend && levelCount(question.answer_spec) !== opts.legend.length) {
    return refuse("invalid_response",
      `the question declares ${levelCount(question.answer_spec)} levels and the call declares a legend of ` +
      `${opts.legend.length}`, reported, assurance);
  }

  const translated = translate(primitive, rec, reported, question);
  if ("reason" in translated) return refuse("invalid_response", translated.reason, reported, assurance);

  // THE SCALE, DECLARED OR NOT DECLARED. N ordered levels are the range `0 .. N - 1`, and they
  // come from whichever of the two the caller supplied — the question's own levels, or the
  // legend the default question was built from. NOTHING IS DECLARED WHEN THE CALLER DECLARED
  // NOTHING: the adapter's default level set is a request shape, not a scale somebody agreed
  // to, and validating a figure against it would put a number with no declared scale beside
  // numbers that have one. The port answers that with `unsupported`, keeping the figure and
  // refusing the level, which is the smaller and truer claim.
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
    // AN ALIAS IS NOT HANDED OVER AS AN EXPECTED IDENTITY. The port compares it literally, so
    // passing one would refuse the concrete version the alias resolved to — see the header.
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
