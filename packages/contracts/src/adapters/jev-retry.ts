/**
 * What a failed call to the typed assessor was, and whether asking again could help.
 *
 * The one question this module answers is which kind of failure it was; the retry decision
 * reads the kind rather than a status band. A retry helps when the request was fine and the
 * supplier was momentarily unable to serve it, and never when the request itself is the
 * problem.
 *
 * An unlisted status is not retried: a status nobody has classified is not known to be
 * transient, and treating the whole 5xx band as capacity would retry a 501. Widening this
 * policy is a row in the table below, never a band.
 *
 * Nothing here performs a call, waits or reads a clock. Every function is pure: the caller owns
 * the transport, the timer and the budget, and hands in what it observed. `Retry-After` reaches
 * `nextDelay` as a number of milliseconds because parsing a header is the transport's job.
 *
 * DELIBERATE: `idempotencyKey` is a local key. It lets this platform notice that two records
 * describe the same logical decision and keep one; it is not sent to the supplier and does not
 * stop a retried attempt being billed twice. An attempt that was sent and produced no readable
 * answer is billed `uncertain` rather than `not_billed`, because the supplier may have done the
 * work.
 */
import { stableDigest } from "../profiles.js";

// What kind of failure it was

/**
 * `capacity` — the supplier could not serve a well-formed request right now.
 * `transport` — nothing came back, or something between here and there gave up.
 * `authentication` — the credential was missing, rejected or insufficient.
 * `request_schema` — the supplier read the request and says it is wrong.
 * `permanent` — a definite answer that will not change for this request.
 * `unclassified` — nobody has said which of the above this is. Not retried; see the header.
 */
export type JevFailureKind =
  | "capacity" | "transport" | "authentication" | "request_schema" | "permanent" | "unclassified";

/** The table: one row per status, each naming a kind rather than inheriting one from its
 *  hundreds digit. 429 and 529 are capacity; 401 and 422 are not, however often a burst of them
 *  looks like one. 408 and 504 are transport rather than capacity because the request may never
 *  have been served at all, which is why both are billed uncertain below. */
const CLASSIFICATION: Readonly<Record<number, JevFailureKind>> = Object.freeze({
  400: "request_schema",
  401: "authentication",
  403: "authentication",
  404: "permanent",
  408: "transport",
  409: "permanent",
  413: "request_schema",
  422: "request_schema",
  429: "capacity",
  500: "capacity",
  501: "permanent",
  502: "transport",
  503: "capacity",
  504: "transport",
  529: "capacity",
});

/** The kinds a retry can do anything about. A `permanent` or `request_schema` answer is the
 *  same answer next time, and an `authentication` one is a job for a person. */
const RETRYABLE: readonly JevFailureKind[] = Object.freeze(["capacity", "transport"]);

/** What a status means. `null` is "the attempt produced no status at all" — a reset connection,
 *  a name that would not resolve, a client-side abort — which is `transport` and retryable. */
export function classify(status: number | null): JevFailureKind {
  if (status === null) return "transport";
  return CLASSIFICATION[status] ?? "unclassified";
}

/** May this be asked again. Derived from the kind and nothing else, so a caller cannot reach a
 *  retry by reasoning about a status directly. A 2xx classifies as `unclassified` and answers
 *  false. */
export const retryable = (status: number | null): boolean => RETRYABLE.includes(classify(status));

// How long to wait, if at all

/** What the caller observed and what it has left. `attempt` counts attempts already made, so
 *  the first failure arrives as 1. `retry_after_ms` is the supplier's own instruction, already
 *  parsed out of its header by the transport. */
export interface JevRetryInput {
  readonly attempt: number;
  readonly status: number | null;
  readonly retry_after_ms?: number | null;
  readonly budget_ms_left: number;
  readonly max_attempts?: number;
  readonly base_ms?: number;
  readonly cap_ms?: number;
  /** Injected so the policy is testable. Defaults to `Math.random`. */
  readonly jitter?: () => number;
}

/** The decision, with the reason it was reached — the reason is what a caller writes into its
 *  own record, so "we stopped" never has to be reconstructed from a delay of zero. */
export interface JevRetryDecision {
  readonly retry: boolean;
  readonly delay_ms: number;
  readonly kind: JevFailureKind;
  readonly reason: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 8_000;

/**
 * Bounded exponential backoff with full jitter, and the supplier's own instruction on top.
 *
 * Three things stop a retry and each is reported separately: the kind cannot be fixed by
 * retrying, the attempt budget is spent, or the wait would run past the time the caller has
 * left — a `Retry-After` of thirty seconds inside a budget of ten leaves a caller cancelled
 * mid-sleep, reporting nothing at all.
 *
 * `Retry-After` is a floor under the jittered delay rather than a replacement for it. Jitter is
 * full rather than proportional, so a fleet of clients that all failed at the same instant does
 * not stay synchronised.
 */
export function nextDelay(input: JevRetryInput): JevRetryDecision {
  const kind = classify(input.status);
  const named = input.status === null ? "a call that returned no status" : `a ${input.status}`;
  if (!RETRYABLE.includes(kind)) {
    return frozen(false, 0, kind, `${named} is a ${kind} failure, and the same request would be refused again`);
  }
  const max = input.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (input.attempt >= max) {
    return frozen(false, 0, kind, `the attempt budget of ${max} is spent after ${input.attempt}`);
  }
  if (!Number.isFinite(input.budget_ms_left) || input.budget_ms_left <= 0) {
    return frozen(false, 0, kind, "no time is left in the overall budget");
  }
  const base = input.base_ms ?? DEFAULT_BASE_MS;
  const cap = input.cap_ms ?? DEFAULT_CAP_MS;
  const exponential = Math.min(cap, base * 2 ** (input.attempt - 1));
  const random = input.jitter ?? Math.random;
  const jittered = Math.floor(Math.max(0, Math.min(1, random())) * exponential);
  const asked = input.retry_after_ms ?? 0;
  const wait = Math.max(jittered, Number.isFinite(asked) && asked > 0 ? asked : 0);
  if (wait >= input.budget_ms_left) {
    return frozen(false, 0, kind,
      `waiting ${wait}ms would exceed the ${input.budget_ms_left}ms left in the budget`);
  }
  const why = asked > 0 && asked >= jittered
    ? `${named} asked for ${asked}ms and that instruction is honoured`
    : `${named} is a ${kind} failure; attempt ${input.attempt + 1} after ${wait}ms`;
  return frozen(true, wait, kind, why);
}

const frozen = (retry: boolean, delay_ms: number, kind: JevFailureKind, reason: string): JevRetryDecision =>
  Object.freeze({ retry, delay_ms, kind, reason });

// What was attempted, and what it may have cost

/** Whether the supplier charged for the attempt. `uncertain` is not a hedge: it is the only
 *  honest value for an attempt that was sent and whose outcome we could not read. */
type JevBilling = "billed" | "not_billed" | "uncertain";

/** One attempt as the caller observed it. `waited_ms` is what was actually slept before it. */
export interface JevAttemptInput {
  readonly attempt: number;
  readonly idempotency_key: string;
  readonly status: number | null;
  readonly waited_ms: number;
  readonly note?: string | null;
}

/** The row. `kind` is null when the attempt answered, because a success has no failure kind
 *  and `unclassified` there would read as "we could not tell what went wrong". */
export interface JevAttempt {
  readonly attempt: number;
  readonly idempotency_key: string;
  readonly status: number | null;
  readonly kind: JevFailureKind | null;
  readonly waited_ms: number;
  readonly billing: JevBilling;
  readonly note: string | null;
}

/**
 * What the attempt may have cost, decided from what came back. A 4xx is the supplier refusing
 * before it did any work. A 5xx, a timeout and a call that returned nothing at all are attempts
 * where the work may have been done and the answer lost on the way home, so they are
 * `uncertain`.
 */
function billingFor(status: number | null): JevBilling {
  if (status === null) return "uncertain";
  if (status >= 200 && status < 300) return "billed";
  if (status === 408 || status >= 500) return "uncertain";
  return "not_billed";
}

/** Build the record for one attempt. Pure — the caller owns wherever these are kept. */
export function attemptRecord(input: JevAttemptInput): JevAttempt {
  const answered = input.status !== null && input.status >= 200 && input.status < 300;
  return Object.freeze({
    attempt: input.attempt,
    idempotency_key: input.idempotency_key,
    status: input.status,
    kind: answered ? null : classify(input.status),
    waited_ms: input.waited_ms,
    billing: billingFor(input.status),
    note: input.note ?? null,
  });
}

// Naming one logical decision

/** What makes two calls the same logical decision: the same question, against the same pinned
 *  evidence, under the same profile, asking the same exact model. DELIBERATE: not the attempt
 *  number — retries of one request share the key, or it would name attempts rather than
 *  decisions. */
export interface JevRequestIdentity {
  readonly question_id: string;
  readonly question_digest: string | null;
  readonly evidence_snapshot_id: string | null;
  readonly profile_digest: string | null;
  readonly requested_model: string;
}

/** A local key: nothing here reaches the supplier, so this prevents a duplicate decision on
 *  this platform and not a duplicate charge on theirs. */
export const idempotencyKey = (identity: JevRequestIdentity): string =>
  `assessor-call:${stableDigest(identity)}`;
