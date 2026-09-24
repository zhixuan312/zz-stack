/**
 * One response body, read as the set of answers it carries.
 *
 * `./jev-reply.js` answers "what did this assessor say about one question"; this answers "what did
 * one round trip establish". A reply is refused for what it says, a body for what it left out.
 *
 * The identity is on the envelope and is carried onto each answer. The supplier names the version
 * once per body rather than once per answer, so an answer read on its own carries no identity and
 * `parse` would refuse it as unidentified; copying the body's own `model` onto each answer is the
 * supplier's assertion about the very answers it is attached to. DELIBERATE: it is never filled from
 * the request — an identity taken from what we asked for would make the version comparison compare a
 * value to itself. An answer carrying its own `model` keeps it, and a body with none leaves every
 * answer unidentified and therefore refused.
 *
 * A question nothing came back for gets a record, never a gap: the count of records always equals
 * the count of questions asked, so no caller can read a short map as agreement. This is the only
 * place that rule is written.
 */
import {
  asRecord, describe, identityOf, parse, present, rejected,
  type JevParseOptions, type JevParseResult,
} from "./jev-reply.js";

/** Per-question options in a batch: everything about one answer that is not about the call. */
export type JevAnswerOptions = Pick<JevParseOptions, "question" | "legend" | "bounds" | "mapping">;

/** One request's worth. The envelope fields describe the call and are recorded on every answer
 *  it carried; `answers` names each question asked and how its reply is to be validated. */
export interface JevBatchOptions {
  readonly expect: string;
  readonly answers: Readonly<Record<string, JevAnswerOptions>>;
  readonly request_id?: string;
  readonly question_digest?: string;
  readonly evidence_snapshot_id?: string;
  readonly profile_digest?: string;
  readonly interpretation_profile_ref?: string;
}

export interface JevBatchResult {
  /** The version the supplier says served the whole request, from the body's own field. */
  readonly model: string | null;
  readonly usage: { readonly input_tokens: number | null; readonly output_tokens: number | null };
  /** One record per question asked — never per answer received, so a caller cannot read a short
   *  map as agreement. A question nothing came back for gets an `unavailable` record. */
  readonly answers: Readonly<Record<string, JevParseResult>>;
  readonly missing: readonly string[];
  /** Set only when the body is not a batch at all, in which case every answer is refused. */
  readonly failure_reason: string | null;
}

/** A usage figure, or nothing. Not `Number(v)`: a blank field would become a zero, and a zero
 *  token count is a measurement rather than the absence of one. */
const numberOrNull = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Read one whole response body into one record per question asked. See the module header for
 *  where the identity comes from and why a missing answer is still a record. */
export function parseBatch(raw: unknown, opts: JevBatchOptions): JevBatchResult {
  const keys = Object.keys(opts.answers);
  const envelope = {
    request_id: opts.request_id,
    question_digest: opts.question_digest,
    evidence_snapshot_id: opts.evidence_snapshot_id,
    profile_digest: opts.profile_digest,
    interpretation_profile_ref: opts.interpretation_profile_ref,
  };
  const body = asRecord(raw);
  const answers = body !== null && present(body, "answers") ? asRecord(body.answers) : null;
  const failure_reason = body === null
    ? (raw === undefined || raw === null
      ? "the adapter was handed no response body"
      : `the response body is ${describe(raw)}, not an object`)
    : answers === null
      ? `the response carries ${describe(body.answers)} where its answers should be`
      : null;

  const model = body === null ? null : identityOf(body);
  const usageRec = body !== null && present(body, "usage") ? asRecord(body.usage) : null;
  const out: Record<string, JevParseResult> = {};
  const missing: string[] = [];

  for (const key of keys) {
    const per = opts.answers[key];
    const one: JevParseOptions = { ...envelope, ...per, expect: opts.expect, question_id: key };
    if (answers === null || !present(answers, key)) {
      if (answers !== null) missing.push(key);
      // `undefined` reaches `parse` as "no reply and no recorded failure", which is
      // `unavailable` — transport, not a judgement. That is exactly what a missing answer is.
      out[key] = failure_reason !== null
        ? rejected(one, "unavailable", failure_reason, model, "unverified", body, null)
        : parse(undefined, one);
      continue;
    }
    const answer = asRecord(answers[key]);
    // The envelope's identity, attached to the answer it describes. See the header.
    const identified = answer !== null && model !== null && !present(answer, "model")
      ? { ...answer, model }
      : answers[key];
    out[key] = parse(identified, one);
  }

  return Object.freeze({
    model,
    usage: Object.freeze({
      input_tokens: usageRec ? numberOrNull(usageRec.input_tokens) : null,
      output_tokens: usageRec ? numberOrNull(usageRec.output_tokens) : null,
    }),
    answers: Object.freeze(out),
    missing: Object.freeze(missing),
    failure_reason,
  });
}
