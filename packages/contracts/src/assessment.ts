/**
 * The semantic-assessment port: what a bounded question is, what an answer to one is, and the
 * one function that turns a provider's raw reply into a record this platform may act on.
 *
 * Nothing here invents a number:
 *
 *   · a label with no probability yields `signals: []`, never zero and never 0.5;
 *   · a distribution is only ever copied from a channel the adapter declares native — no code
 *     path in this file builds a one-hot vector;
 *   · a confidence the model generated, whether it arrives as "0.91" or as 0.91, is
 *     `self_reported`. Only the adapter knows which channel carried it.
 *
 * A timeout is `unavailable`: the transport failed and nobody assessed anything. Semantic
 * uncertainty is `unknown` for a predicate and `null` for a category or ordinal. `value` is
 * null for every status but `answered`.
 *
 * `interpret` reads the raw reply as untrusted data — `unknown`, validated field by field — and
 * applies the question's own `answer_spec`. An undeclared key is `invalid_response`, not a new
 * option; an out-of-range score is `invalid_response`, not a clamped one; a reply from a model
 * other than the pinned identity is `invalid_response`, not a substitution.
 * `authorizesSemanticAdvance` derives actionability from the recorded status alone.
 *
 * DELIBERATE: six envelope fields the approved contract declares `string` are `string | null`
 * here — `request_id`, `question_digest`, `evidence_snapshot_id`, `profile_digest`,
 * `interpretation_profile_ref`, `requested_model`. They are facts about an invocation, which
 * interpretation does not know, and `""` in a digest column reads exactly like a real identity.
 * The adapter supplies them through `AssessmentCall`; null means "interpreted without a call
 * envelope".
 */

// The registered question families

/**
 * The nine shared question families. Every checkpoint any method declares names one of these,
 * and shipped skills cite them by these exact spellings.
 *
 * DELIBERATE: typed `readonly string[]` rather than `as const`. A caller testing membership
 * holds a `string`, and `readonly ["a", "b"].includes(s)` rejects a `string` argument outright
 * — the literal union narrows `includes`'s own parameter. `Object.freeze` gives the
 * immutability; the widened type gives the question.
 *
 * Nine names, not six: the approved table groups three rows by shared meaning, and it is the
 * names a checkpoint cites and an adapter renders.
 */
export const QUESTION_FAMILIES: readonly string[] = Object.freeze([
  /** Does a passage support, contradict, leave unclear, or bear no relation to a claim. */
  "evidence_relation",
  /** Does a clause cover, partly cover, omit, or leave unclear a stated requirement. */
  "requirement_coverage",
  /** Does one named gap need a fact fetched to resolve it. */
  "needs_fact",
  /** Does one named gap need something verified to resolve it. */
  "needs_verification",
  /** Does one named gap need analysis to resolve it. */
  "needs_analysis",
  /** Is an input only the person can supply still missing. */
  "missing_user_input",
  /** Would this change what was already agreed and committed to. */
  "changes_commitment",
  /** Does this finding repeat one already recorded. */
  "repeats_finding",
  /** Is the proposed repair absent, directional, incomplete, or specific enough to carry out. */
  "actionability",
]);

// The question

/** What shape of answer a question admits, and the exact keys that answer may use. The keys
 *  are the question's own: an adapter may render them however its transport requires, but it
 *  may not return one the question never declared. */
export type AnswerSpec =
  | { readonly kind: "predicate"; readonly true_means: string; readonly false_means: string }
  | { readonly kind: "category"; readonly options: readonly AnswerOption[] }
  | { readonly kind: "ordinal"; readonly levels: readonly AnswerOption[] };

/** One declared key and what it means. `meaning` is rendered into the request, so a key with
 *  an empty meaning is a key the assessor was asked to choose blind. */
export interface AnswerOption {
  readonly key: string;
  readonly meaning: string;
}

/** A registered, immutable question: what is being asked, about which subjects, from which
 *  pinned evidence, and in what shape the answer must come back. */
export interface SemanticQuestion {
  readonly question_id: string;
  readonly question_digest: string;
  readonly subject_ids: readonly string[];
  readonly evidence_ids: readonly string[];
  readonly instruction: string;
  readonly answer_spec: AnswerSpec;
}

/**
 * The half of a question interpretation depends on. `interpret` maps a payload onto declared
 * keys; the digest, the subjects, the evidence ids and the instruction belong to the request
 * that was sent and are recorded by the adapter that sent it. A full `SemanticQuestion` is
 * accepted unchanged.
 */
export type AskedQuestion = Pick<SemanticQuestion, "question_id" | "answer_spec">;

// The assessment

/** The normalized answer. `unknown` for a predicate and `null` for a category or ordinal are
 *  semantic uncertainty — the assessor answered and could not tell — and never a transport
 *  failure, which is `unavailable` with no value at all. */
export type SemanticValue =
  | { readonly kind: "predicate"; readonly value: "true" | "false" | "unknown" }
  | { readonly kind: "category"; readonly key: string | null }
  | { readonly kind: "ordinal"; readonly level_key: string | null };

/** Where a number came from. The channel declares this, never the JavaScript type of the
 *  field: a float in the model's own JSON is still a token the model generated, so it is
 *  `self_reported`. `native_distribution` and `native_score` are reserved for a channel the
 *  adapter reports as the provider's own primitive, and `empirical_calibration` for a number a
 *  separately validated calibration supplied. */
export type SignalOrigin = "native_distribution" | "native_score" | "self_reported" | "empirical_calibration";

/** One numeric reading that accompanied an answer. Every value is finite and range-validated
 *  before it gets here; a number nothing could validate is not recorded at all. */
export interface StatisticalSignal {
  readonly name: string;
  readonly origin: SignalOrigin;
  readonly meaning: string;
  readonly values: Readonly<Record<string, number>>;
  readonly calibration_ref: string | null;
}

/**
 * `answered` — a value was produced from a validated reply.
 * `insufficient_evidence` — the assessor declared the evidence would not support an answer.
 * `unsupported` — the reply was well formed but this profile is not qualified to turn it into
 *   a value: a raw score with no qualified mapping is retained, not rounded.
 * `invalid_response` — the reply broke the question's contract. Never a semantic answer.
 * `unavailable` — the call did not produce a reply. Transport, not semantics.
 */
export type AssessmentStatus = "answered" | "insufficient_evidence" | "unsupported" | "invalid_response" | "unavailable";

/** How much the resolved model identity is worth. A hosted provider asserting its own exact
 *  version is `provider_reported`; a deployment whose binding was checked is
 *  `deployment_verified`; everything else, including a call nobody checked, is `unverified`. */
export type IdentityAssurance = "provider_reported" | "deployment_verified" | "unverified";

/** The record. See the file header for why six envelope fields are nullable here. */
export interface SemanticAssessment {
  readonly request_id: string | null;
  readonly question_id: string;
  readonly question_digest: string | null;
  readonly evidence_snapshot_id: string | null;
  readonly profile_digest: string | null;
  readonly status: AssessmentStatus;
  readonly value: SemanticValue | null;
  readonly signals: readonly StatisticalSignal[];
  readonly raw_response_ref: string | null;
  readonly interpretation_profile_ref: string | null;
  readonly requested_model: string | null;
  readonly resolved_identity: string | null;
  readonly identity_assurance: IdentityAssurance;
  readonly failure_reason: string | null;
}

/** Why no reply arrived. Every one is a transport fact rather than a reading, and all of them
 *  are `unavailable`: the absence of an answer is not an answer.
 *
 *  A question a reply left out is not on this list. The supplier adapter records one result per
 *  question asked and names what is missing; this port has no way to write such a variant. */
export type CallFailure = "timeout" | "network" | "rate_limited" | "server_error" | "cancelled";

/**
 * What the adapter knows and the interpreter cannot: the envelope it recorded, the identity it
 * observed, and the mappings the approved profile qualified it to apply. Nothing here is
 * derived from the reply.
 *
 * The two mappings are the reason a raw number is ever turned into a value. Without them a
 * score stays a score and the status is `unsupported`.
 */
export interface AssessmentCall {
  /** Set when no reply arrived. Wins over any payload: a partial body after a timeout is not
   *  an assessment. */
  readonly failure?: CallFailure;
  readonly failure_detail?: string;
  readonly request_id?: string;
  readonly question_digest?: string;
  readonly evidence_snapshot_id?: string;
  readonly profile_digest?: string;
  readonly interpretation_profile_ref?: string;
  readonly raw_response_ref?: string;
  readonly requested_model?: string;
  /** The exact identity the approved profile pinned. When set, a reply reporting anything else
   *  is `invalid_response`: alias drift never inherits eligibility. */
  readonly expected_identity?: string | null;
  readonly resolved_identity?: string | null;
  readonly identity_assurance?: IdentityAssurance;
  /** A qualified predicate mapping: `0 <= no_le < yes_ge <= 1`, unknown between the bounds.
   *  A profile strategy, not the definition of every assessor. */
  readonly predicate_bounds?: { readonly no_le: number; readonly yes_ge: number };
  /** The declared scale of a numeric score. Without it a score cannot be range-validated, so
   *  it is neither recorded as a signal nor mapped. */
  readonly score_range?: { readonly min: number; readonly max: number };
  /** A qualified score-to-level mapping: the highest `at` a score reaches names the level. */
  readonly ordinal_mapping?: {
    readonly qualification_ref: string;
    readonly thresholds: readonly { readonly at: number; readonly level_key: string }[];
  };
}

// Reading an untrusted payload

/** A plain decimal, and nothing else. `Number("")` and `Number(" ")` are both 0, so parsing a
 *  confidence with `Number` alone invents a zero for any reply that left the field blank. */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

function asRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Readonly<Record<string, unknown>>;
}

function has(rec: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(rec, key);
}

/** Present and carrying something. JSON `null` is how a provider says a field is absent, so a
 *  null confidence is a confidence nobody reported — not a malformed number and not a zero.
 *  The one place null is an answer is a category or ordinal key, where the value type declares
 *  it to mean the assessor could not tell; those two branches read the field directly. */
const given = (rec: Readonly<Record<string, unknown>>, key: string): boolean =>
  has(rec, key) && rec[key] !== null;

/** A finite number, from a number or from a strictly formatted decimal string. `null` means
 *  the field was present and is not one — never that it was absent; callers test presence. */
function finite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && DECIMAL.test(v.trim())) return Number(v.trim());
  return null;
}

/** The keys this question declares. A predicate's are its two truth keys; `unknown` is a
 *  value the interpreter may produce but not a key a distribution may carry. */
function declaredKeys(spec: AnswerSpec): readonly string[] {
  if (spec.kind === "category") return spec.options.map((o) => o.key);
  if (spec.kind === "ordinal") return spec.levels.map((l) => l.key);
  return ["true", "false"];
}

// Building the record

const NO_SIGNALS: readonly StatisticalSignal[] = Object.freeze([]);

interface Envelope {
  readonly question: AskedQuestion;
  readonly call: AssessmentCall | undefined;
  readonly observed: string | null;
}

function record(
  env: Envelope,
  status: AssessmentStatus,
  value: SemanticValue | null,
  signals: readonly StatisticalSignal[],
  failure_reason: string | null,
): SemanticAssessment {
  const call = env.call;
  return Object.freeze({
    request_id: call?.request_id ?? null,
    question_id: env.question.question_id,
    question_digest: call?.question_digest ?? null,
    evidence_snapshot_id: call?.evidence_snapshot_id ?? null,
    profile_digest: call?.profile_digest ?? null,
    status,
    // The invariant, enforced here rather than in every branch: only `answered` carries a
    // value. Any other status with one would read as a judgement that was never made.
    value: status === "answered" ? value : null,
    signals: Object.freeze(signals.slice()),
    raw_response_ref: call?.raw_response_ref ?? null,
    interpretation_profile_ref: call?.interpretation_profile_ref ?? null,
    requested_model: call?.requested_model ?? null,
    resolved_identity: env.observed,
    identity_assurance: call?.identity_assurance ?? "unverified",
    failure_reason,
  });
}

/** The numeric readings that accompanied a reply, or the contract violation that stops it.
 *  Confidence is always self-reported; a distribution is copied from the adapter's declared
 *  native channel and validated against the question's own keys. */
function readSignals(
  question: AskedQuestion,
  rec: Readonly<Record<string, unknown>>,
): { signals: StatisticalSignal[]; distribution: Readonly<Record<string, number>> | null; error: string | null } {
  const signals: StatisticalSignal[] = [];
  let distribution: Readonly<Record<string, number>> | null = null;

  if (given(rec, "confidence")) {
    const n = finite(rec.confidence);
    if (n === null) return { signals, distribution, error: "the confidence field is not a finite number" };
    if (n < 0 || n > 1) return { signals, distribution, error: `the confidence ${n} is outside 0..1` };
    signals.push({
      name: "confidence",
      // Never `native_distribution`, whatever its JavaScript type: a number the model wrote
      // is a number the model wrote.
      origin: "self_reported",
      meaning: "the assessor's own stated confidence, generated as part of its reply",
      values: Object.freeze({ confidence: n }),
      calibration_ref: null,
    });
  }

  const native = given(rec, "native") ? asRecord(rec.native) : null;
  if (given(rec, "native") && native === null) {
    return { signals, distribution, error: "the native channel is not an object" };
  }
  if (native && given(native, "distribution")) {
    const raw = asRecord(native.distribution);
    if (raw === null) return { signals, distribution, error: "the native distribution is not an object" };
    const allowed = declaredKeys(question.answer_spec);
    const values: Record<string, number> = {};
    let total = 0;
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) {
        return { signals, distribution, error: `the native distribution carries the key ${key}, which this question never declared` };
      }
      const n = finite(raw[key]);
      if (n === null || n < 0 || n > 1) {
        return { signals, distribution, error: `the native distribution value for ${key} is not a finite probability` };
      }
      values[key] = n;
      total += n;
    }
    // A supplier that rounds each key to two decimals without renormalising (Jev does) is off by
    // at most 0.005 per key, so a well-formed four-key reply can sum to 0.99. That much is
    // rounding; anything beyond it is a distribution that is wrong. The values are kept as sent.
    if (Math.abs(total - 1) > Math.max(1e-3, 0.005 * Object.keys(values).length)) {
      return { signals, distribution, error: `the native distribution sums to ${total}, not to 1` };
    }
    distribution = Object.freeze(values);
    signals.push({
      name: "distribution",
      origin: "native_distribution",
      meaning: "the provider's own distribution over this question's declared keys, copied unchanged",
      values: distribution,
      calibration_ref: typeof native.calibration_ref === "string" ? native.calibration_ref : null,
    });
  }
  return { signals, distribution, error: null };
}

// Interpretation

/**
 * Turn one raw reply into one record. The raw reply is `unknown` on purpose: it is vendor
 * output, and the validation below is what has to hold.
 *
 * The order of the decisions is the contract's own: a recorded failure outranks any payload,
 * an identity mismatch outranks a well-formed answer from the wrong model, and a key the
 * question never declared is rejected before anything is read from it.
 */
export function interpret(question: AskedQuestion, raw?: unknown, call?: AssessmentCall): SemanticAssessment {
  const rec = raw === undefined || raw === null ? null : asRecord(raw);
  const reported = rec !== null && typeof rec.model === "string" ? rec.model : null;
  const env: Envelope = { question, call, observed: reported ?? call?.resolved_identity ?? null };

  // A timeout is transport, not semantics, and it is decided before the payload is looked at:
  // a body that arrived after the call was abandoned describes nothing this run may use.
  if (call?.failure) {
    const why = call.failure_detail ? `${call.failure}: ${call.failure_detail}` : call.failure;
    return record(env, "unavailable", null, NO_SIGNALS, why);
  }
  if (rec === null) {
    const why = raw === undefined || raw === null
      ? "the call recorded neither a reply nor a failure"
      : "the reply was not an object";
    return record(env, raw === undefined || raw === null ? "unavailable" : "invalid_response", null, NO_SIGNALS, why);
  }

  // An exact identity is exact. A profile that pinned one and got another was served by a
  // model whose qualification nothing here establishes, so the reply is invalid however well
  // formed.
  if (call?.expected_identity && env.observed !== null && env.observed !== call.expected_identity) {
    return record(env, "invalid_response", null, NO_SIGNALS,
      `the reply came from ${env.observed}, not the pinned ${call.expected_identity}`);
  }

  if (rec.insufficient_evidence === true) {
    return record(env, "insufficient_evidence", null, NO_SIGNALS, "the assessor declared the evidence insufficient");
  }

  const read = readSignals(question, rec);
  if (read.error) return record(env, "invalid_response", null, NO_SIGNALS, read.error);
  const signals = read.signals;
  const spec = question.answer_spec;

  if (spec.kind === "predicate") return predicate(env, rec, signals, read.distribution);
  if (spec.kind === "category") return category(env, rec, spec, signals, read.distribution);
  return ordinal(env, rec, spec, signals);
}

function predicate(
  env: Envelope,
  rec: Readonly<Record<string, unknown>>,
  signals: readonly StatisticalSignal[],
  distribution: Readonly<Record<string, number>> | null,
): SemanticAssessment {
  if (has(rec, "predicate")) {
    const v = rec.predicate;
    // `null` and `"unknown"` are the same claim — the assessor answered and could not tell —
    // and neither is a transport failure. Only a value that is none of the four is malformed.
    const primitive = v === true ? "true"
      : v === false ? "false"
      : v === null ? "unknown"
      : v === "true" || v === "false" || v === "unknown" ? v
      : null;
    if (primitive === null) {
      return record(env, "invalid_response", null, NO_SIGNALS,
        `the predicate field is ${JSON.stringify(v)}, not true, false or unknown`);
    }
    return record(env, "answered", { kind: "predicate", value: primitive }, signals, null);
  }

  // A distribution is not an answer until a qualified mapping says where the lines are.
  // Picking them here would be this module making the profile's decision.
  if (distribution && Object.prototype.hasOwnProperty.call(distribution, "true")) {
    const bounds = env.call?.predicate_bounds;
    if (!bounds) {
      return record(env, "unsupported", null, signals,
        "a native probability arrived and no qualified mapping declares its decision bounds");
    }
    if (!(bounds.no_le >= 0 && bounds.no_le < bounds.yes_ge && bounds.yes_ge <= 1)) {
      return record(env, "unsupported", null, signals,
        `the declared bounds ${bounds.no_le}..${bounds.yes_ge} are not a valid qualified mapping`);
    }
    const p = distribution["true"];
    const value = p >= bounds.yes_ge ? "true" : p <= bounds.no_le ? "false" : "unknown";
    return record(env, "answered", { kind: "predicate", value }, signals, null);
  }
  return record(env, "invalid_response", null, NO_SIGNALS, "the reply carries no predicate and no native probability");
}

function category(
  env: Envelope,
  rec: Readonly<Record<string, unknown>>,
  spec: Extract<AnswerSpec, { kind: "category" }>,
  signals: readonly StatisticalSignal[],
  distribution: Readonly<Record<string, number>> | null,
): SemanticAssessment {
  if (has(rec, "category")) {
    const key = rec.category;
    // The one null that is an answer: the value type declares a null key to mean the assessor
    // could not tell, so discarding it as malformed would lose a real judgement.
    if (key === null) return record(env, "answered", { kind: "category", key: null }, signals, null);
    if (typeof key !== "string" || !spec.options.some((o) => o.key === key)) {
      return record(env, "invalid_response", null, NO_SIGNALS,
        `the category ${JSON.stringify(key)} is not one this question declared`);
    }
    return record(env, "answered", { kind: "category", key }, signals, null);
  }
  // Taking the largest probability as the answer is rounding a distribution into a label. It
  // is a mapping, it has to be qualified, and none is defined for categories.
  if (distribution) {
    return record(env, "unsupported", null, signals,
      "only a distribution arrived, and no qualified mapping turns one into a declared key");
  }
  return record(env, "invalid_response", null, NO_SIGNALS, "the reply carries no category key");
}

function ordinal(
  env: Envelope,
  rec: Readonly<Record<string, unknown>>,
  spec: Extract<AnswerSpec, { kind: "ordinal" }>,
  signals: readonly StatisticalSignal[],
): SemanticAssessment {
  if (has(rec, "level_key") || has(rec, "level")) {
    const key = has(rec, "level_key") ? rec.level_key : rec.level;
    // Null is semantic uncertainty here too, for the reason the category branch gives.
    if (key === null) return record(env, "answered", { kind: "ordinal", level_key: null }, signals, null);
    if (typeof key !== "string" || !spec.levels.some((l) => l.key === key)) {
      return record(env, "invalid_response", null, NO_SIGNALS,
        `the level ${JSON.stringify(key)} is not one this question declared`);
    }
    return record(env, "answered", { kind: "ordinal", level_key: key }, signals, null);
  }

  const native = given(rec, "native") ? asRecord(rec.native) : null;
  const fromNative = native !== null && given(native, "score");
  if (!fromNative && !given(rec, "score")) {
    return record(env, "invalid_response", null, NO_SIGNALS, "the reply carries no level and no score");
  }
  const n = finite(fromNative && native ? native.score : rec.score);
  if (n === null) return record(env, "invalid_response", null, NO_SIGNALS, "the score is not a finite number");

  const range = env.call?.score_range;
  if (!range) {
    // An unvalidatable number is not recorded: a figure with no declared scale beside figures
    // that have one, with nothing on the row to say which.
    return record(env, "unsupported", null, NO_SIGNALS,
      "a raw score arrived and no profile declares the scale it is on, so it cannot be validated");
  }
  if (n < range.min || n > range.max) {
    return record(env, "invalid_response", null, NO_SIGNALS,
      `the score ${n} is outside the declared range ${range.min}..${range.max}`);
  }
  const scored: readonly StatisticalSignal[] = [...signals, {
    name: "score",
    origin: fromNative ? "native_score" : "self_reported",
    meaning: `the assessor's score on the declared ${range.min}..${range.max} scale`,
    values: Object.freeze({ score: n }),
    calibration_ref: native !== null && typeof native.calibration_ref === "string" ? native.calibration_ref : null,
  }];

  const mapping = env.call?.ordinal_mapping;
  // The raw score is retained rather than rounded. Without a qualified mapping the number is
  // real and the level is not.
  if (!mapping) {
    return record(env, "unsupported", null, scored,
      "a score arrived and no qualified mapping turns it into one of this question's levels");
  }
  const reached = [...mapping.thresholds].sort((a, b) => b.at - a.at).find((t) => n >= t.at);
  if (!reached) {
    return record(env, "unsupported", null, scored,
      `the qualified mapping declares no level for a score of ${n}`);
  }
  if (!spec.levels.some((l) => l.key === reached.level_key)) {
    return record(env, "unsupported", null, scored,
      `the qualified mapping names the level ${reached.level_key}, which this question never declared`);
  }
  return record(env, "answered", { kind: "ordinal", level_key: reached.level_key }, scored, null);
}

// What the host may do with one

/**
 * May this assessment carry a semantic advance. Derived from the recorded status and nothing
 * else, so the answer is a property of what was established rather than a flag on the reply.
 *
 * Enumerated positively: only `answered` may be consumed, so an unrecognised status added
 * later refuses. What an `unknown` predicate or a null key then means for a particular advance
 * is the trusted host's policy, decided against its qualification records.
 */
export function authorizesSemanticAdvance(assessment: SemanticAssessment): boolean {
  return assessment.status === "answered" && assessment.value !== null;
}
