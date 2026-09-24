/**
 * The door onto one supplier, and nothing but the door. Every function this adapter exposes is
 * one decision seen from a different side, so they sit on one object across three modules:
 *
 *   `./jev-reply.js`   what this assessor said about one question, and whether it may be
 *                      believed: the supplier's three primitives, the question each is
 *                      validated against, the identity it claims, and the readings it carries.
 *   `./jev-batch.js`   what one round trip established: the response envelope, the identity it
 *                      names once for every answer in it, and the questions it left out.
 *   `./jev-retry.js`   what kind of failure that was, and whether asking again could help.
 *
 * The provider's vocabulary stops at these files. `choice`, `score` and `noul` are its words for
 * its own primitives; the platform's words are the question families and answer shapes in
 * `../assessment.js`. Nothing downstream of `interpret` has heard of a primitive, and nothing
 * here builds a `SemanticAssessment`: the port does that, from a payload the reply reader
 * translates and validates first.
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
  /** Backed by `nextDelay`, which never returns a delay shorter than a `Retry-After` it was
   *  handed and refuses outright when honouring one would overrun the budget. */
  readonly honoursRetryAfter: true;
}

/** The adapter, assembled here and declared nowhere else, so there is one answer to which object
 *  this platform asks a typed judgement through. */
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
