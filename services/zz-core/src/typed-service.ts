/**
 * TypeSafe System One — typed judgments, for the decisions this flow used to take in prose.
 *
 * A second model service beside the judge this platform pins, for the questions that have a
 * shape: a ruler dimension is an ordered scale between written ends, a recommendation is one
 * word from a closed set, a threshold is a yes/no over a figure. An answer may be wrong; it
 * must not be unparseable or off-vocabulary, because the row it lands in is read by counting.
 *
 * System One answers exactly three shapes and cannot answer outside them:
 *   choice  one option from a named set, with a probability for every option
 *   score   a continuous position on 2-10 ordered levels (a probability-weighted mean)
 *   noul    the probability that a yes/no question is yes
 * Each answer carries `confidence`, the shape of the distribution collapsed to 0-1 — a flat
 * distribution is an uncertain answer even when its top option is the right one.
 *
 * The supplier's vocabulary and every guard over it live in `jevAdapter` in @zz/contracts,
 * which this file calls and never restates. What is declared here is the questions.
 *
 * A refused reply is still an answered call: validation refuses through `Refusal`, which the
 * tool wrapper turns into a plain refusal, and `record()` writes the attempt either way, so a
 * reply the adapter would not read is visible in `zz.model_call` rather than inside a mark.
 *
 * The row that record writes is the call's own: one row per call, carrying what it asked for,
 * what it cost, whether it succeeded and — when it did not — what it failed with. `record`
 * returns that row's id, `ask` hands it to its caller, and the caller is what pairs the call with
 * what it was asked for: a failure reaches `semantic.ts` as a `TypedCallRefusal` carrying the same
 * id, so an `unavailable` reading names the call that could not answer just as an answered one
 * names the call that did.
 *
 * `unsupported` is the ordinary outcome here, not a failure. The kernel turns a number into a
 * level only when a qualified mapping says where the lines are, and this platform has qualified
 * none — the 1-based rebase below and the 0.5 threshold cut next door are this flow's own
 * conventions. So the kernel validates the figures, declines to name a level, and naming it
 * stays here.
 *
 * Not used by `plugin_locate` or `plugin_profile`: those are facts — catalog contents, event
 * counts, deltas — and every ruler on this platform is written from them, so a model there
 * would make the evidence itself a judgement.
 *
 * Absence is an answer, never an error. A deployment with no key reaches `configured() ===
 * false`, and every caller reports the judgement as absent, with the reason, and carries on.
 */
import { jevAdapter, type JevAnswerOptions, type JevParseResult } from "@zz/contracts";
import type pg from "pg";

import { Refusal } from "./refusal.js";
import { db } from "./platform-db.js";

/** Where the service lives. Overridable, because a self-hosted endpoint is the same contract. */
const BASE = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
const KEY = () => (process.env.TYPESAFE_API_KEY || "").trim();
/** `jev-latest` tracks the newest release. Pinned through the environment when a deployment
 *  wants its answers to stop moving — the same argument as ZZ_JUDGE_MODEL next door.
 *
 *  The default is an alias, and the adapter records it as one: the version the supplier says
 *  served the call is kept, and the identity assurance is `unverified`, because a name that
 *  resolves to whatever is newest today cannot carry a qualification measured against a
 *  particular version. A deployment that wants `provider_reported` sets TYPESAFE_MODEL to an
 *  exact version — `jev-1.13.0` — and gets the version comparison as well. */
const MODEL = () => (process.env.TYPESAFE_MODEL || "jev-latest").trim();
/** One request carries every question for one subject: the documentation is explicit that
 *  "adding questions barely changes the response time", so a per-dimension call would pay the
 *  round trip N times for nothing. */
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 60_000);
/** How long the whole ask may take, retries included. Retries make a transient slow call cost
 *  latency instead of a subject.
 *
 *  Bounded, because something between this tool and its caller closes an MCP request at about
 *  two minutes: an unbounded wait becomes a tool that returns nothing at all. 100 seconds
 *  leaves room for the caller to report what happened. */
const BUDGET_MS = Number(process.env.TYPESAFE_BUDGET_MS || 100_000);
/** Attempts. COUPLED: the backoff curve and the supplier's `Retry-After` are
 *  `jevAdapter.nextDelay`'s, not this file's. */
const MAX_ATTEMPTS = Number(process.env.TYPESAFE_ATTEMPTS || 3);

// Not exported: `choice` is one of the three primitives the typed service offers and `ask()`
// still speaks it, but no tool on this platform constructs one.
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option -> what that option means. The model cannot answer outside these keys. */
  criteria: Record<string, string>;
}
interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 2-10 level descriptions, ordered low to high. */
  criteria: string[];
}
interface NoulQuestion {
  type: "noul";
  instructions: string;
}
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** Whether this deployment can ask at all. Every caller checks it and says so in its own
 *  output rather than failing — see the header. */
export function configured(): boolean {
  return KEY() !== "";
}

/** Why it cannot, in the words a report prints. One sentence, no blame. */
export const NOT_CONFIGURED =
  "no TYPESAFE_API_KEY is set on this deployment, so the typed judgement was not taken";

/** What each question's reply is validated against.
 *
 *  A score declares its levels, so the reply's figure is range-validated against `0 .. N - 1`
 *  and its echoed legend against the same count; without that the kernel has no scale to check
 *  a number on. A choice declares its own option keys. A yes/no declares nothing beyond its
 *  shape: a probability is a probability on any question. */
function answerOptions(question_id: string, q: Question): JevAnswerOptions {
  if (q.type === "score") return { legend: q.criteria };
  if (q.type === "choice") {
    return {
      question: {
        question_id,
        answer_spec: {
          kind: "category",
          options: Object.entries(q.criteria).map(([key, meaning]) => ({ key, meaning })),
        },
      },
    };
  }
  return {};
}

/** The supplier's own instruction, in milliseconds. Seconds or an HTTP date, per the header
 *  spec; anything else is no instruction at all rather than a guess at one. Parsing it is the
 *  transport's job — `nextDelay` takes a number and never reads a header. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

/** A reply this file may read. `answered` is a validated value; `unsupported` is a validated
 *  reply the kernel declined to turn into a level, which is the ordinary outcome here.
 *  Everything else — `invalid_response`, `unavailable`, `insufficient_evidence` — is a reply
 *  nothing may be scored from. */
const usable = (a: JevParseResult): boolean => a.status === "answered" || a.status === "unsupported";

/** The model this file asks for, as the row records it — what was requested, not what the
 *  supplier says it ran. The resolved identity is the adapter's and lands on the answer. */
const requestedModel = (): string => `typesafe/${MODEL()}`;

/** Where a `zz.model_call` row is written: the deployment's pool, or a handle the caller hands
 *  over — `checks/judge-usage.ts` passes a fake so it can read the row this module wrote without
 *  a database. */
export type ModelCallRunner = Pick<pg.Pool, "query">;

/** What one answered call hands back: the answers, and the call that produced them.
 *
 *  `model_call_id` is null exactly when no row could be written — this deployment has no
 *  database, or the insert itself failed — because bookkeeping never costs an answer. A caller
 *  that records the pairing (`semantic.ts` writes it as `assessment.model_call_id`) reads that
 *  null and writes no pairing, rather than one naming a row that was never inserted. */
export interface TypedCall {
  model_call_id: number | null;
  /** What this file asked for, in the words the row carries. */
  model: string;
  answers: Record<string, JevParseResult>;
}

/** A call that was made and produced no usable answer, carrying the id of the `zz.model_call`
 *  row that says so — and null when that row could not be written either.
 *
 *  A subclass rather than a flag, so every existing caller that catches `Refusal` (registerTool's
 *  wrapper included) goes on reading it as one; and a carrier rather than a second return, so
 *  `semantic.ts` records an `unavailable` reading that names the call it could not get an answer
 *  from — a record claiming an attribution it does not have is worse than no record. */
export class TypedCallRefusal extends Refusal {
  readonly model_call_id: number | null;
  readonly model: string;
  constructor(message: string, model_call_id: number | null, model: string) {
    super(message);
    this.model_call_id = model_call_id;
    this.model = model;
  }
}

/**
 * Ask one subject a set of questions.
 *
 * Refuses rather than returns a shape nobody can read: a transport failure, a non-2xx, a body
 * whose answers do not match the questions asked, or an answer the adapter will not validate.
 * The caller decides whether that is fatal; `configured()` is checked first, so the ordinary
 * "no key" case never reaches here.
 *
 * Every refusal below is a `TypedCallRefusal` carrying the id of the row the call wrote, because
 * a call that was made was paid for whether or not it answered.
 */
export async function ask(
  state: string, questions: Record<string, Question>, runner?: ModelCallRunner,
): Promise<TypedCall> {
  if (!configured()) throw new Refusal(`ERROR: ${NOT_CONFIGURED}`);
  const asked: Record<string, JevAnswerOptions> = {};
  for (const [key, q] of Object.entries(questions)) asked[key] = answerOptions(key, q);

  const began = Date.now();
  let attempt = 0;
  let lastWhy = "";
  // Retry only what retrying can fix: a timeout, a transport failure and a capacity answer are
  // the endpoint having a bad moment, while a 4xx this caller caused, a 501, and a partial or
  // unreadable answer set are the same answer next time.
  //
  // COUPLED: the table saying which is which is the kernel's, not this file's.
  for (;;) {
    attempt += 1;
    const left = BUDGET_MS - (Date.now() - began);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, Math.max(left, 1)));
    const started = Date.now();
    // Worth another attempt, by both clocks. `nextDelay` refuses a wait that would not fit in
    // the budget; this additionally refuses one leaving too little budget for the attempt after
    // the wait, because a retry scheduled with 100ms left aborts on arrival.
    const again = (status: number | null, retry_after_ms: number | null): number | null => {
      const budget_ms_left = BUDGET_MS - (Date.now() - began);
      if (budget_ms_left <= TIMEOUT_MS / 2) return null;
      const decision = jevAdapter.nextDelay({
        attempt, status, retry_after_ms, budget_ms_left, max_attempts: MAX_ATTEMPTS,
      });
      return decision.retry ? decision.delay_ms : null;
    };
    try {
      const res = await fetch(`${BASE}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
        body: JSON.stringify({ model: MODEL(), state, questions }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The status and the first of the body, which is where this service puts its reason.
        // Not the whole body: an error page is megabytes and this text reaches a document.
        const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ").trim();
        lastWhy = `answered ${res.status}${detail ? ` — ${detail}` : ""}`;
        const wait = again(res.status, retryAfterMs(res.headers.get("retry-after")));
        if (wait !== null) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        const id = await record(runner, attempt, Date.now() - started, false, lastWhy);
        throw new TypedCallRefusal(
          `ERROR: the typed-judgement service ${lastWhy}. Nothing was scored from it.`,
          id, requestedModel());
      }
      // The body is read, not cast. Every guard over it is the adapter's: the identity the
      // supplier claims, which primitive each answer carries, and whether each figure is on the
      // scale this file declared when it asked.
      const body = await res.json().catch(() => undefined);
      const batch = jevAdapter.parseBatch(body, { expect: MODEL(), answers: asked });
      const total = Object.keys(questions).length;
      // Every question answered, or the set is not usable. A partial answer would silently drop
      // a dimension and leave a round that looks complete and is one mark short.
      if (batch.failure_reason !== null || batch.missing.length) {
        lastWhy = batch.failure_reason !== null
          ? `answered with a body that could not be read — ${batch.failure_reason}`
          : `answered ${total - batch.missing.length} of ${total} questions — ` +
            `missing ${batch.missing.join(", ")}`;
        const id = await record(runner, attempt, Date.now() - started, false, lastWhy);
        throw new TypedCallRefusal(
          `ERROR: the typed-judgement service ${lastWhy}. A partial set would leave a round one ` +
          "mark short and looking complete.", id, requestedModel());
      }
      // An answer the adapter refused is a judgement nobody made, and the whole set goes with
      // it: a round one mark short that looks complete is worse than one that says so.
      const broken = Object.entries(batch.answers).filter(([, a]) => !usable(a));
      if (broken.length) {
        lastWhy = `answered ${broken.length} of ${total} questions unreadably — ` +
          broken.map(([name, a]) => `${name}: ${a.failure_reason ?? a.status}`).join("; ");
        const id = await record(runner, attempt, Date.now() - started, false, lastWhy);
        throw new TypedCallRefusal(
          `ERROR: the typed-judgement service ${lastWhy}. Nothing was scored from it, because a ` +
          "figure that cannot be validated is indistinguishable in the record from one that was.",
          id, requestedModel());
      }
      const model_call_id = await record(
        runner, attempt, Date.now() - started, true, null, batch.usage);
      return { model_call_id, model: requestedModel(), answers: batch.answers };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Refusal) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      lastWhy = aborted
        ? `did not answer within ${Math.round(Math.min(TIMEOUT_MS, BUDGET_MS) / 1000)}s`
        : `could not be reached — ${err instanceof Error ? err.message : String(err)}`;
      // A call that produced no status at all is `transport` to the kernel's table, which is
      // retryable -- the same answer this file gave before it had a table.
      const wait = again(null, null);
      if (wait !== null) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const id = await record(runner, attempt, Date.now() - started, false, lastWhy);
      throw new TypedCallRefusal(
        `ERROR: the typed-judgement service ${lastWhy}, after ${attempt} attempt` +
        `${attempt === 1 ? "" : "s"} in ${Math.round((Date.now() - began) / 1000)}s. ` +
        "Nothing was scored from it.", id, requestedModel());
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TypedUsage { input_tokens: number | null; output_tokens: number | null }

/** One row per call, in the table the reading judge already writes to, and the id it landed under.
 *
 *  The model column carries what was asked for, not what the supplier says it ran; the resolved
 *  identity lives on each answer's record.
 *
 *  `error` is where a call that did not answer says why: the column's name since
 *  `002_delivery_telemetry.sql`, which also dropped the judge's `confidence` mark — what a typed
 *  call spends is what this row records now, and the answer's own shape carries what it was worth.
 *
 *  Never throws: this is bookkeeping beside an answer already in hand, and a database hiccup
 *  must not turn a successful judgement into a lost one. It answers with null instead, and the
 *  caller writes no pairing rather than one naming a row that was never inserted. */
async function record(
  runner: ModelCallRunner | undefined, attempts: number, durationMs: number, ok: boolean,
  error: string | null, usage?: TypedUsage,
): Promise<number | null> {
  try {
    const p = runner ?? db();
    if (!p) return null;
    const { rows } = await p.query<{ id: string }>(`
      insert into zz.model_call
        (purpose, model, input_tokens, output_tokens, duration_ms, ok, attempts, error)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning id`,
      ["typed-judge", requestedModel(), usage?.input_tokens ?? null,
       usage?.output_tokens ?? null, durationMs, ok, attempts,
       error ? error.slice(0, 500) : null]);
    const id = rows[0]?.id;
    return id === undefined ? null : Number(id);
  } catch { return null; }
}
