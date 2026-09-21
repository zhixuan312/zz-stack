/**
 * TypeSafe System One — typed judgments, for the decisions this flow used to take in prose.
 *
 * WHY A SECOND MODEL SERVICE, beside the judge this platform already pins. They are asked
 * different kinds of question and only one of them is a free-text question.
 *
 * A ruler dimension IS an ordered scale between written ends; a recommendation IS one word from
 * a closed set; a threshold IS a yes/no over a figure. Every one of those has a shape, and a
 * prompt-and-parse step against a general model can return something outside it — a sixth
 * outcome word, a mark of "4.5 (but see caveat)", a recommendation hedged into a paragraph. It
 * can also be *wrong*, and that is fine and expected; what it must not be is UNPARSEABLE or
 * OFF-VOCABULARY, because the row it lands in is read by counting.
 *
 * System One answers exactly three shapes and cannot answer outside them:
 *   choice  one option from a named set, with a probability for every option
 *   score   a position on 2-10 ordered levels, CONTINUOUS (a probability-weighted mean)
 *   noul    the probability that a yes/no question is yes
 * Each answer carries `confidence`, which is the shape of the distribution collapsed to 0-1 —
 * a flat distribution is an uncertain answer even when its top option is the right one.
 *
 * THIS FILE NO LONGER DECIDES WHAT THOSE SHAPES ARE. It used to declare its own answer union
 * and then not check it: `res.json() as {...}` is a compile-time cast over an untrusted body,
 * which is a description of what an honest supplier sends rather than a guard against what
 * arrives. What arrived went straight into a mark. A `score` of null became a stored 1, a 7 on
 * a four-level scale became a clamped 5, a `noul` of null became an unmet line recorded at
 * maximum confidence — four judgements nobody made, written down as four that were. The
 * supplier's vocabulary and every guard over it now live in ONE place, `jevAdapter` in
 * @zz/contracts, which this file calls and no longer restates. What is declared here is what is
 * genuinely this file's: the QUESTIONS, because building a request is not reading a reply.
 *
 * A REFUSED REPLY IS STILL AN ANSWERED CALL. Validation refuses more than this file used to,
 * and it refuses through the one channel the partial-answer case already used: `Refusal`, which
 * the tool wrapper turns into a plain refusal a caller can read and act on. Nothing new can
 * throw past a caller, and `record()` still writes the attempt either way, so a reply the
 * adapter would not read is now visible in `zz.model_call` instead of being invisible in a mark.
 *
 * `unsupported` IS NOT A FAILURE HERE, AND THAT IS THE HONEST READING. The kernel turns a
 * number into a LEVEL only when a qualified mapping says where the lines are, and this platform
 * has qualified none: the 1-based rebase below and the 0.5 threshold cut next door are this
 * flow's own conventions, not measured mappings, so handing them over as qualified would be
 * claiming a qualification nobody did. So the kernel validates the figures and declines to name
 * a level, which is `unsupported` with every number intact — and naming the level stays here,
 * where it always was and where it is written down.
 *
 * WHERE IT IS NOT USED, which matters as much. `plugin_locate` and `plugin_profile` are facts:
 * catalog contents, event counts, deltas. Their whole value is that no model is anywhere in the
 * derivation, because every ruler on this platform is written FROM them. A model there would
 * make the evidence itself a judgement, and nothing downstream could tell the two apart.
 *
 * ABSENCE IS AN ANSWER, NEVER AN ERROR. A deployment with no key reaches `configured() ===
 * false` and every caller reports the judgement as absent, with the reason, and carries on. An
 * evaluation that cannot produce a recommendation is still an evaluation; one that refuses to
 * produce a REPORT because a third party is down is a dependency nobody agreed to.
 */
import { jevAdapter, type JevAnswerOptions, type JevParseResult } from "@zz/contracts";

import { Refusal } from "../refusal.js";
import { db } from "../platform-db.js";

/** Where the service lives. Overridable, because a self-hosted endpoint is the same contract. */
const BASE = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
const KEY = () => (process.env.TYPESAFE_API_KEY || "").trim();
/** `jev-latest` tracks the newest release. Pinned through the environment when a deployment
 *  wants its answers to stop moving — the same argument as ZZ_JUDGE_MODEL next door.
 *
 *  AN ALIAS IS WHAT THE DEFAULT IS, and the adapter records exactly that: the version the
 *  supplier says served the call is kept, and the identity assurance is `unverified`, because a
 *  name that resolves to whatever is newest today cannot carry a qualification measured against
 *  a particular version. That is a true statement about a default deployment rather than a
 *  fault in it. A deployment that wants `provider_reported` sets TYPESAFE_MODEL to an exact
 *  version — `jev-1.13.0` — and gets the version comparison as well. */
const MODEL = () => (process.env.TYPESAFE_MODEL || "jev-latest").trim();
/** One request carries every question for one subject: the documentation is explicit that
 *  "adding questions barely changes the response time", so a per-dimension call would pay the
 *  round trip N times for nothing. */
const TIMEOUT_MS = Number(process.env.TYPESAFE_TIMEOUT_MS || 60_000);
/** HOW LONG THE WHOLE ASK MAY TAKE, retries included.
 *
 *  A TIMEOUT MUST NOT LOSE AN ANSWER, which is what one attempt with a hard deadline does. A
 *  slow call and a dead endpoint are different facts and a single `AbortError` reported them
 *  identically: the subject was skipped, and a round paid for the prompt twice to learn the
 *  same thing. Retries make a transient slow call cost latency instead of a subject.
 *
 *  BOUNDED, BECAUSE THE REQUEST CARRYING IT IS. Something between this tool and its caller
 *  closes an MCP request at about two minutes, so an unbounded wait does not become patience —
 *  it becomes a tool that returns nothing at all, which is strictly worse than one that says it
 *  ran out of time. 100 seconds leaves room for the caller to report what happened. */
const BUDGET_MS = Number(process.env.TYPESAFE_BUDGET_MS || 100_000);
/** Attempts. The BACKOFF is no longer decided here: `jevAdapter.nextDelay` owns the curve and
 *  the supplier's own `Retry-After`, for the same reason the parse moved — a second copy of a
 *  policy is a second policy. */
const MAX_ATTEMPTS = Number(process.env.TYPESAFE_ATTEMPTS || 3);

// NOT EXPORTED ANY MORE, and kept rather than deleted. `choice` is one of the three primitives
// the typed service offers and `ask()` still speaks it — what changed is that no tool on this
// platform constructs one: round_score stopped asking for a recommendation when that question
// turned out to have one permanent answer. The shape stays because it describes the SERVICE,
// which did not change; the export goes because nothing builds one here.
interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option -> what that option means. The model cannot answer outside these keys. */
  criteria: Record<string, string>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** 2-10 level descriptions, ORDERED low to high. */
  criteria: string[];
}
export interface NoulQuestion {
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

/** WHAT EACH QUESTION'S REPLY IS VALIDATED AGAINST, which is the question this file asked.
 *
 *  A score declares its levels, so the reply's figure is range-validated against `0 .. N - 1`
 *  and its echoed legend against the same count — without that the kernel has no scale to check
 *  a number on and keeps it unvalidated, which is the one thing worse than checking it here.
 *  A choice declares its own option keys for the same reason. A yes/no declares nothing beyond
 *  its shape: a probability is a probability on any question. */
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

/** A REPLY THIS FILE MAY READ. `answered` is a validated value; `unsupported` is a validated
 *  reply the kernel declined to turn into a level, which is the ordinary outcome here and is
 *  explained in the header. Everything else — `invalid_response`, `unavailable`,
 *  `insufficient_evidence` — is a reply nothing may be scored from. */
const usable = (a: JevParseResult): boolean => a.status === "answered" || a.status === "unsupported";

/**
 * Ask one subject a set of questions.
 *
 * REFUSES rather than returns a shape nobody can read: a transport failure, a non-2xx, a body
 * whose answers do not match the questions asked, or an answer the adapter will not validate.
 * The caller decides whether that is fatal — for the recommendation it is not, and
 * `configured()` is checked first so the ordinary "no key" case never reaches here.
 */
export async function ask(
  state: string, questions: Record<string, Question>,
): Promise<Record<string, JevParseResult>> {
  if (!configured()) throw new Refusal(`ERROR: ${NOT_CONFIGURED}`);
  const asked: Record<string, JevAnswerOptions> = {};
  for (const [key, q] of Object.entries(questions)) asked[key] = answerOptions(key, q);

  const began = Date.now();
  let attempt = 0;
  let lastWhy = "";
  // RETRY ONLY WHAT RETRYING CAN FIX, and the table that says which is the kernel's, not this
  // file's. A timeout, a transport failure and a capacity answer are the endpoint having a bad
  // moment; a 4xx this caller caused, and a 501, are the same answer next time however long we
  // wait. A partial or unreadable answer set is the same class -- the questions did not change
  // between attempts.
  for (;;) {
    attempt += 1;
    const left = BUDGET_MS - (Date.now() - began);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, Math.max(left, 1)));
    const started = Date.now();
    // WORTH ANOTHER ATTEMPT, by both clocks. `nextDelay` refuses a wait that would not fit in
    // the budget; this file additionally refuses one that would leave too little budget for the
    // ATTEMPT after the wait, which is its own long-standing rule and not something the kernel
    // can know -- a retry scheduled with 100ms left is an attempt that aborts on arrival.
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
        // NOT the whole body: an error page is megabytes and this text reaches a document.
        const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ").trim();
        lastWhy = `answered ${res.status}${detail ? ` — ${detail}` : ""}`;
        const wait = again(res.status, retryAfterMs(res.headers.get("retry-after")));
        if (wait !== null) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        await record(attempt, Date.now() - started, false, null, lastWhy);
        throw new Refusal(
          `ERROR: the typed-judgement service ${lastWhy}. Nothing was scored from it.`);
      }
      // THE BODY IS NOT CAST, IT IS READ. Every guard over it is the adapter's -- the identity
      // the supplier claims, which primitive each answer carries, and whether each figure is on
      // the scale this file declared when it asked.
      const body = await res.json().catch(() => undefined);
      const batch = jevAdapter.parseBatch(body, { expect: MODEL(), answers: asked });
      const total = Object.keys(questions).length;
      // EVERY QUESTION ANSWERED, or the set is not usable. A partial answer would silently drop
      // a dimension and leave a round that looks complete and is one mark short.
      if (batch.failure_reason !== null || batch.missing.length) {
        lastWhy = batch.failure_reason !== null
          ? `answered with a body that could not be read — ${batch.failure_reason}`
          : `answered ${total - batch.missing.length} of ${total} questions — ` +
            `missing ${batch.missing.join(", ")}`;
        await record(attempt, Date.now() - started, false, null, lastWhy);
        throw new Refusal(
          `ERROR: the typed-judgement service ${lastWhy}. A partial set would leave a round one ` +
          "mark short and looking complete.");
      }
      // AND EVERY ANSWER READABLE. An answer the adapter refused is a judgement nobody made,
      // and the whole set goes with it for the reason above: a round one mark short that looks
      // complete is worse than a round that says what happened.
      const broken = Object.entries(batch.answers).filter(([, a]) => !usable(a));
      if (broken.length) {
        lastWhy = `answered ${broken.length} of ${total} questions unreadably — ` +
          broken.map(([name, a]) => `${name}: ${a.failure_reason ?? a.status}`).join("; ");
        await record(attempt, Date.now() - started, false, null, lastWhy);
        throw new Refusal(
          `ERROR: the typed-judgement service ${lastWhy}. Nothing was scored from it, because a ` +
          "figure that cannot be validated is indistinguishable in the record from one that was.");
      }
      await record(attempt, Date.now() - started, true, meanConfidence(batch.answers), null, batch.usage);
      return batch.answers;
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
      await record(attempt, Date.now() - started, false, null, lastWhy);
      throw new Refusal(
        `ERROR: the typed-judgement service ${lastWhy}, after ${attempt} attempt` +
        `${attempt === 1 ? "" : "s"} in ${Math.round((Date.now() - began) / 1000)}s. ` +
        "Nothing was scored from it.");
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TypedUsage { input_tokens: number | null; output_tokens: number | null }

/** HOW SURE THE SERVICE WAS, averaged across the answers in one call.
 *
 *  CONFUSION IS A MEASUREMENT, NOT AN ERROR. A set of answers at 0.96 and one at 0.11 are
 *  different evidence wearing the same shape, and until this was recorded the difference was
 *  visible only to whoever happened to read that one report. A run of low-confidence calls is a
 *  ruler that has stopped discriminating, and it should be readable as a trend.
 *
 *  `noul` carries no confidence of its own -- for a yes/no the probability IS the shape of the
 *  distribution -- so its distance from the 0.5 cut, doubled, stands in for one on the same
 *  scale the other primitives report.
 *
 *  THE NUMBERS ARE THE ADAPTER'S READINGS, which is what stops this from averaging a confidence
 *  nobody reported. A `noul` of null used to reach `Math.abs(null - 0.5) * 2` and record 1.0 --
 *  maximum confidence for an answer that was not given -- in the column a run of rounds is read
 *  by. Such a reply no longer reaches this function at all. */
function meanConfidence(answers: Record<string, JevParseResult>): number | null {
  const vals = Object.values(answers).map((a) =>
    a.readings.probability !== null
      ? Math.abs(a.readings.probability - 0.5) * 2
      : a.readings.confidence);
  const real = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return real.length ? Math.round((real.reduce((x, y) => x + y, 0) / real.length) * 100) / 100 : null;
}

/** One row per call, in the table the reading judge already writes to.
 *
 *  THE TYPED SERVICE WROTE NOTHING UNTIL NOW, while making every typed decision on this
 *  platform. Twelve rounds of evidence existed with no record that the calls behind them
 *  happened, how long they took, or whether any had to be retried.
 *
 *  THE MODEL COLUMN CARRIES WHAT WAS ASKED FOR, not what the supplier says it ran. The adapter
 *  now knows the resolved version, but `judge-model.ts` matches these rows by rebuilding this
 *  same string from the environment, so writing the resolved version here would orphan every
 *  row from the query that reads them. The resolved identity lives on each answer's record.
 *
 *  NEVER THROWS. This is bookkeeping beside an answer that is already in hand; a database
 *  hiccup must not turn a successful judgement into a lost one. That is the opposite of the
 *  rule next door in judge.ts, where the insert shares a pool the round needs anyway -- here
 *  the round has its answer and losing it to record-keeping would be the worse trade. */
async function record(
  attempts: number, durationMs: number, ok: boolean,
  confidence: number | null, note: string | null, usage?: TypedUsage,
): Promise<void> {
  try {
    const p = db();
    if (!p) return;
    await p.query(`
      insert into zz.model_call
        (plugin, purpose, model, input_tokens, output_tokens, duration_ms, ok, attempts,
         confidence, note)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [null, "typed-judge", `typesafe/${MODEL()}`, usage?.input_tokens ?? null,
       usage?.output_tokens ?? null, durationMs, ok, attempts, confidence,
       note ? note.slice(0, 500) : null]);
  } catch { /* bookkeeping never costs an answer — see above */ }
}

/** A score's position expressed on the platform's own 1-N scale.
 *
 * System One numbers its levels from ZERO and returns a continuous position between them, so a
 * three-level scale answers 0..2. Every mark this platform has ever stored is 1-based, and a
 * round that silently changed base would make one ruler's 1 mean what another's 2 means. */
export function toOneBased(score: number): number {
  return Math.round((score + 1) * 100) / 100;
}
