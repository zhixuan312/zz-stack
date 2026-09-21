/**
 * THE FIRST PROVIDER ADAPTER — the door onto one supplier, and nothing but the door.
 *
 * THREE SUBJECTS, THREE MODULES, ONE OBJECT. Every function this adapter exposes is the same
 * decision seen from a different side — how this supplier's answers are read, and what to do
 * when it does not answer — so they belong on one object. They do not belong in one file:
 *
 *   `./jev-reply.js`   what did this assessor say about ONE question, and may it be believed:
 *                      the supplier's three primitives, the question each is validated
 *                      against, the identity it claims, and the readings its reply carries.
 *   `./jev-batch.js`   what did ONE round trip establish: the response envelope, the identity
 *                      it names once for every answer in it, and the questions it left out.
 *   `./jev-retry.js`   what kind of failure was that, and could asking again possibly help.
 *
 * The split is by what a reader comes here to ask, not by size. A reply is refused for what it
 * SAYS; a body is refused for what it LEFT OUT; a failed call is classified by what it WAS.
 * Putting all three in one file made the middle one look like a helper of the first, which is
 * how the batch — the shape every real caller actually receives — came to be the half nobody
 * had written.
 *
 * THE PROVIDER'S VOCABULARY STOPS AT THESE FILES. `choice`, `score` and `noul` are its words
 * for its own primitives; the platform's words are the question families and the answer shapes
 * in `../assessment.js`. Nothing downstream of `interpret` has ever heard of a primitive, and
 * nothing here builds a `SemanticAssessment` for an answer: the port does that, from a payload
 * the reply reader translates and validates first.
 */
import { parseBatch, type JevBatchOptions, type JevBatchResult } from "./jev-batch.js";
import { parse, type JevParseOptions, type JevParseResult } from "./jev-reply.js";
import type {
  JevAttempt, JevAttemptInput, JevFailureKind, JevRequestIdentity, JevRetryDecision, JevRetryInput,
} from "./jev-retry.js";
import { attemptRecord, classify, idempotencyKey, nextDelay, retryable } from "./jev-retry.js";

interface JevAdapter {
  readonly parse: (raw: unknown, opts: JevParseOptions) => JevParseResult;
  readonly parseBatch: (raw: unknown, opts: JevBatchOptions) => JevBatchResult;
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

/** THE ADAPTER. Assembled here and declared nowhere else, so there is exactly one answer to
 *  "which object does this platform ask a typed judgement through". */
export const jevAdapter: JevAdapter = Object.freeze({
  parse,
  parseBatch,
  classify,
  retryable,
  nextDelay,
  attemptRecord,
  idempotencyKey,
  honoursRetryAfter: true,
});

export type { JevAnswerOptions } from "./jev-batch.js";
export type { JevParseResult } from "./jev-reply.js";
