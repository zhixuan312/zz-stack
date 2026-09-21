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
 * that made the pinned version eligible was measured against that version and no other. A pin
 * that is an alias rather than an exact version cannot confer even that much: it resolves to
 * whatever the supplier is serving today, so a match against one is recorded `unverified`.
 *
 * ONE DERIVED NUMBER, DECLARED HERE. The supplier's yes/no primitive returns a single
 * probability, and the port's predicate path needs a distribution over the question's declared
 * keys that sums to one. So `{ true: p, false: 1 - p }` is built here. It is the Bernoulli
 * complement of a number the supplier did emit, not a shape invented around a label, and it is
 * the only value in this file the supplier did not send.
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
import type {
  JevAttempt, JevAttemptInput, JevFailureKind, JevRequestIdentity, JevRetryDecision, JevRetryInput,
} from "./jev-retry.js";
import { attemptRecord, classify, idempotencyKey, nextDelay, retryable } from "./jev-retry.js";

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

// ── reading an untrusted reply ─────────────────────────────────────────────────────────────

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

const present = (rec: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(rec, key);

/** A field as a message can name it. `JSON.stringify(undefined)` is `undefined` rather than a
 *  string, so the one value most likely to be in a broken field is the one a template would
 *  have printed as the word "undefined" by accident. It is printed deliberately instead. */
const describe = (value: unknown): string =>
  value === undefined ? "undefined" : JSON.stringify(value) ?? String(value);

/** A real number, and only that. NOT a numeric string: the supplier documents these primitives
 *  as JSON numbers, so a string here is a different reply than the one this adapter knows how
 *  to read, and guessing at it is how a malformed body becomes a measurement. */
const realNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// ── what a caller supplies ─────────────────────────────────────────────────────────────────

interface JevParseOptions {
  /** The EXACT version the approved profile pinned. A reply from any other is refused. */
  readonly expect: string;
  /** The shared question this reply answers. Omitted, the adapter validates against its own
   *  default rendering for whichever primitive came back. */
  readonly question?: AskedQuestion;
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

/** The port's record, plus the reply it was read from. The raw body is kept verbatim so that
 *  everything this adapter DISCARDED — the supplier's own field names, its per-option
 *  probabilities, anything it sends that the port has no column for — is still recoverable
 *  from the one place it was preserved, rather than existing only as whatever survived the
 *  translation. `raw_response_ref` on the record is this body's content digest. */
interface JevParseResult extends SemanticAssessment {
  readonly raw_response: Readonly<Record<string, unknown>> | null;
}

interface JevAdapter {
  readonly parse: (raw: unknown, opts: JevParseOptions) => JevParseResult;
  readonly classify: (status: number | null) => JevFailureKind;
  readonly retryable: (status: number | null) => boolean;
  readonly nextDelay: (input: JevRetryInput) => JevRetryDecision;
  readonly attemptRecord: (input: JevAttemptInput) => JevAttempt;
  readonly idempotencyKey: (identity: JevRequestIdentity) => string;
  /** A declaration backed by `nextDelay`, which never returns a delay shorter than a
   *  `Retry-After` it was handed and refuses outright when honouring one would overrun the
   *  budget. It is true because that code is there, not beside it. */
  readonly honoursRetryAfter: true;
}

// ── refusing, without inventing a record to refuse in ──────────────────────────────────────

/** A REFUSAL IS STILL THE PORT'S RECORD. Every envelope field the caller supplied is carried
 *  so a rejected reply is as traceable as an accepted one; `value` is null and `signals` empty
 *  because nothing was measured; and the status is never `answered`, which is what
 *  `authorizesSemanticAdvance` reads. */
function rejected(
  opts: JevParseOptions, status: AssessmentStatus, reason: string,
  observed: string | null, assurance: IdentityAssurance,
  rec: Readonly<Record<string, unknown>> | null, ref: string | null,
): JevParseResult {
  return Object.freeze({
    request_id: opts.request_id ?? null,
    question_id: opts.question?.question_id ?? PRIMITIVES.choice.question,
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
  });
}

// ── the question a reply is validated against ──────────────────────────────────────────────

/** The caller's question, or the default rendering for the primitive that came back. An
 *  ordinal default takes its levels from the declared legend when there is one, because the
 *  legend IS the scale the caller asked on and validating against a different level count
 *  would refuse a good answer for the wrong reason. */
function questionFor(primitive: Primitive, opts: JevParseOptions): AskedQuestion {
  if (opts.question) return opts.question;
  const declared = PRIMITIVES[primitive];
  if (primitive === "noul") {
    return {
      question_id: declared.question,
      answer_spec: { kind: "predicate", true_means: "yes", false_means: "no" },
    };
  }
  if (primitive === "score") {
    const levels = opts.legend
      ? options(...opts.legend.map((l) => String(l)))
      : DEFAULT_KEYS.score;
    return { question_id: declared.question, answer_spec: { kind: "ordinal", levels } };
  }
  return { question_id: declared.question, answer_spec: { kind: "category", options: DEFAULT_KEYS.choice } };
}

/** How many levels the question declares, or null when it declares none — used only to check
 *  the supplier's echoed legend against the scale that was asked for. */
const levelCount = (spec: AnswerSpec): number | null =>
  spec.kind === "ordinal" ? spec.levels.length : null;

// ── the primitives, translated ─────────────────────────────────────────────────────────────

/** A payload in the port's own shape, or the reason this reply cannot become one. Each branch
 *  reads exactly one primitive and passes the supplier's optional companions through unchanged
 *  for the port to validate: nothing is normalised, rounded or filled in on the way. */
function translate(
  primitive: Primitive, rec: Readonly<Record<string, unknown>>, model: string, question: AskedQuestion,
): { payload: Record<string, unknown> } | { reason: string } {
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
    // different question.
    if (present(rec, "probabilities") && rec.probabilities !== null) {
      payload.native = { distribution: rec.probabilities };
    }
    return { payload };
  }

  if (primitive === "score") {
    const score = rec.score;
    if (!realNumber(score)) {
      return { reason: `the score field is ${describe(score)}, not a finite number on the declared scale` };
    }
    // The echoed scale must be the scale that was asked for. A reply scoring on five levels
    // when four were declared is answering a question nobody asked, and its figure would be
    // read against the wrong scale by everything downstream.
    if (present(rec, "legend") && rec.legend !== null) {
      const echoed = asRecord(rec.legend) ?? (Array.isArray(rec.legend) ? rec.legend : null);
      if (echoed === null) return { reason: `the legend field is ${describe(rec.legend)}, not a set of levels` };
      const size = Array.isArray(echoed) ? echoed.length : Object.keys(echoed).length;
      const declared = levelCount(question.answer_spec);
      if (declared !== null && size !== declared) {
        return { reason: `the reply describes ${size} levels and this question declares ${declared}` };
      }
    }
    // Under the port's native channel: the figure is the supplier's own primitive, a weighted
    // position over its level distribution, rather than a number it wrote out as text.
    payload.native = { score };
    return { payload };
  }

  const p = rec.noul;
  if (!realNumber(p) || p < 0 || p > 1) {
    return { reason: `the noul field is ${describe(p)}, not a probability between 0 and 1` };
  }
  payload.native = { distribution: { true: p, false: 1 - p } };
  return { payload };
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────

/**
 * READ ONE REPLY. The order is the contract's: a body that is not a reply at all, then the
 * identity, then which primitive came back and whether the question admits it, then the
 * primitive's own type, and only then the port — which owns range validation, key membership,
 * distribution arithmetic and the decision about what may become a value.
 *
 * The identity is checked here AND handed to the port as the pinned identity. The duplication
 * is deliberate: this adapter refuses an unidentified reply, which the port cannot, and the
 * port refuses a misidentified one independently of whether this function was correct.
 */
function parse(raw: unknown, opts: JevParseOptions): JevParseResult {
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

  const reported = typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model : null;
  if (reported === null) {
    return refuse("invalid_response",
      `the reply names no model, so the pinned ${opts.expect} cannot be the version that served it`);
  }
  if (reported !== opts.expect) {
    return refuse("invalid_response",
      `the reply came from ${reported}, not the pinned ${opts.expect}`, reported, "provider_reported");
  }
  // MATCHING AN ALIAS ESTABLISHES NOTHING. The alias resolved to something today; the
  // qualification was measured against an exact version, and a match on a moving name does not
  // inherit it. See the header.
  const assurance: IdentityAssurance = EXACT_VERSION.test(opts.expect) ? "provider_reported" : "unverified";

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
    expected_identity: opts.expect,
    resolved_identity: reported,
    identity_assurance: assurance,
    predicate_bounds: opts.bounds,
    score_range: scale,
    ordinal_mapping: opts.mapping,
  };
  return Object.freeze({ ...interpret(question, translated.payload, call), raw_response: rec });
}

/** THE ADAPTER. One object, because every one of these is the same decision seen from a
 *  different side: how this supplier's answers are read, and what to do when it does not
 *  answer. The retry half is in `./jev-retry.js`; the classification table and the backoff are
 *  a subject of their own and this file is about reading a reply. */
export const jevAdapter: JevAdapter = Object.freeze({
  parse,
  classify,
  retryable,
  nextDelay,
  attemptRecord,
  idempotencyKey,
  honoursRetryAfter: true,
});
