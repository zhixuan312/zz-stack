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
import { Refusal } from "../refusal.js";
import { db } from "../platform-db.js";

/** Where the service lives. Overridable, because a self-hosted endpoint is the same contract. */
const BASE = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
const KEY = () => (process.env.TYPESAFE_API_KEY || "").trim();
/** `jev-latest` tracks the newest release. Pinned through the environment when a deployment
 *  wants its answers to stop moving — the same argument as ZZ_JUDGE_MODEL next door. */
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
/** Attempts, and why backoff is short. A timeout here is a slow model rather than a rate limit,
 *  and the budget above is the real constraint — a long sleep spends it without asking anything. */
const MAX_ATTEMPTS = Number(process.env.TYPESAFE_ATTEMPTS || 3);
const BACKOFF_MS = 400;

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

interface ChoiceAnswer {
  type: "choice"; choice: string; confidence: number; probabilities: Record<string, number>;
}
interface ScoreAnswer {
  type: "score"; score: number; confidence: number;
  legend: Record<string, string>; probabilities: Record<string, number>;
}
/** NOUL IS THE ONE PRIMITIVE THAT CARRIES NO `confidence`, and the field is `noul` rather than
 *  `probability`. Both were wrong in this file until something finally called it -- written
 *  from the documentation's prose rather than from a response, and never exercised, so
 *  `a.confidence.toFixed(2)` threw on the first real threshold round. Verified against the live
 *  service: a sharp line answers 0.02, a vague one answers 0.41, and neither carries anything
 *  else. For a yes/no the probability IS the shape of the distribution, so there is nothing a
 *  separate confidence could add. */
interface NoulAnswer { type: "noul"; noul: number }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Whether this deployment can ask at all. Every caller checks it and says so in its own
 *  output rather than failing — see the header. */
export function configured(): boolean {
  return KEY() !== "";
}

/** Why it cannot, in the words a report prints. One sentence, no blame. */
export const NOT_CONFIGURED =
  "no TYPESAFE_API_KEY is set on this deployment, so the typed judgement was not taken";

/**
 * Ask one subject a set of questions.
 *
 * REFUSES rather than returns a shape nobody can read: a transport failure, a non-2xx, or a
 * body whose answers do not match the questions asked. The caller decides whether that is fatal
 * — for the recommendation it is not, and `configured()` is checked first so the ordinary
 * "no key" case never reaches here.
 */
export async function ask(
  state: string, questions: Record<string, Question>,
): Promise<Record<string, Answer>> {
  if (!configured()) throw new Refusal(`ERROR: ${NOT_CONFIGURED}`);
  const began = Date.now();
  let attempt = 0;
  let lastWhy = "";
  // RETRY ONLY WHAT RETRYING CAN FIX. A timeout, a transport failure and a 5xx are the endpoint
  // having a bad moment; a 4xx is this caller sending something wrong, and asking again with the
  // same body spends the budget to be told the same thing. A partial answer set is the same
  // class -- the questions did not change between attempts.
  for (;;) {
    attempt += 1;
    const left = BUDGET_MS - (Date.now() - began);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, Math.max(left, 1)));
    const started = Date.now();
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
        if (res.status >= 500 && attempt < MAX_ATTEMPTS && BUDGET_MS - (Date.now() - began) > TIMEOUT_MS / 2) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
          continue;
        }
        await record(attempt, Date.now() - started, false, null, lastWhy);
        throw new Refusal(
          `ERROR: the typed-judgement service ${lastWhy}. Nothing was scored from it.`);
      }
      const body = await res.json() as { answers?: Record<string, Answer>; usage?: TypedUsage };
      const answers = body.answers ?? {};
      // EVERY QUESTION ANSWERED, or the set is not usable. A partial answer would silently drop
      // a dimension and leave a round that looks complete and is one mark short.
      const missing = Object.keys(questions).filter((k) => !answers[k]);
      if (missing.length) {
        lastWhy = `answered ${Object.keys(answers).length} of ${Object.keys(questions).length} ` +
                  `questions — missing ${missing.join(", ")}`;
        await record(attempt, Date.now() - started, false, null, lastWhy);
        throw new Refusal(
          `ERROR: the typed-judgement service ${lastWhy}. A partial set would leave a round one ` +
          "mark short and looking complete.");
      }
      await record(attempt, Date.now() - started, true, meanConfidence(answers), null, body.usage);
      return answers;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Refusal) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      lastWhy = aborted
        ? `did not answer within ${Math.round(Math.min(TIMEOUT_MS, BUDGET_MS) / 1000)}s`
        : `could not be reached — ${err instanceof Error ? err.message : String(err)}`;
      const budgetLeft = BUDGET_MS - (Date.now() - began);
      if (attempt < MAX_ATTEMPTS && budgetLeft > TIMEOUT_MS / 2) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt));
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

interface TypedUsage { input_tokens?: unknown; output_tokens?: unknown }

/** HOW SURE THE SERVICE WAS, averaged across the answers in one call.
 *
 *  CONFUSION IS A MEASUREMENT, NOT AN ERROR. A set of answers at 0.96 and one at 0.11 are
 *  different evidence wearing the same shape, and until this was recorded the difference was
 *  visible only to whoever happened to read that one report. A run of low-confidence calls is a
 *  ruler that has stopped discriminating, and it should be readable as a trend.
 *
 *  `noul` carries no confidence of its own -- for a yes/no the probability IS the shape of the
 *  distribution -- so its distance from the 0.5 cut, doubled, stands in for one on the same
 *  scale the other primitives report. */
function meanConfidence(answers: Record<string, Answer>): number | null {
  const vals = Object.values(answers).map((a) =>
    a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence);
  const real = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return real.length ? Math.round((real.reduce((x, y) => x + y, 0) / real.length) * 100) / 100 : null;
}

/** One row per call, in the table the reading judge already writes to.
 *
 *  THE TYPED SERVICE WROTE NOTHING UNTIL NOW, while making every typed decision on this
 *  platform. Twelve rounds of evidence existed with no record that the calls behind them
 *  happened, how long they took, or whether any had to be retried.
 *
 *  NEVER THROWS. This is bookkeeping beside an answer that is already in hand; a database
 *  hiccup must not turn a successful judgement into a lost one. That is the opposite of the
 *  rule next door in judge.ts, where the insert shares a pool the round needs anyway -- here
 *  the round has its answer and losing it to record-keeping would be the worse trade. */
async function record(
  attempts: number, durationMs: number, ok: boolean,
  confidence: number | null, note: string | null, usage?: TypedUsage,
): Promise<void> {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  try {
    const p = db();
    if (!p) return;
    await p.query(`
      insert into zz.model_call
        (plugin, purpose, model, input_tokens, output_tokens, duration_ms, ok, attempts,
         confidence, note)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [null, "typed-judge", `typesafe/${MODEL()}`, num(usage?.input_tokens),
       num(usage?.output_tokens), durationMs, ok, attempts, confidence,
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
