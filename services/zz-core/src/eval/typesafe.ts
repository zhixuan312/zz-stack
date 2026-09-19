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

export interface ChoiceQuestion {
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
interface NoulAnswer { type: "noul"; probability: number; confidence: number }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
      throw new Refusal(
        `ERROR: the typed-judgement service answered ${res.status}` +
        `${detail ? ` — ${detail}` : ""}. Nothing was scored from it.`);
    }
    const body = await res.json() as { answers?: Record<string, Answer> };
    const answers = body.answers ?? {};
    // EVERY QUESTION ANSWERED, or the set is not usable. A partial answer would silently drop
    // a dimension and leave a round that looks complete and is one mark short.
    const missing = Object.keys(questions).filter((k) => !answers[k]);
    if (missing.length) {
      throw new Refusal(
        `ERROR: the typed-judgement service answered ${Object.keys(answers).length} of ` +
        `${Object.keys(questions).length} questions — missing ${missing.join(", ")}. ` +
        "A partial set would leave a round one mark short and looking complete.");
    }
    return answers;
  } catch (err) {
    if (err instanceof Refusal) throw err;
    const why = err instanceof Error && err.name === "AbortError"
      ? `did not answer within ${Math.round(TIMEOUT_MS / 1000)}s`
      : `could not be reached — ${err instanceof Error ? err.message : String(err)}`;
    throw new Refusal(`ERROR: the typed-judgement service ${why}. Nothing was scored from it.`);
  } finally {
    clearTimeout(timer);
  }
}

/** A score's position expressed on the platform's own 1-N scale.
 *
 * System One numbers its levels from ZERO and returns a continuous position between them, so a
 * three-level scale answers 0..2. Every mark this platform has ever stored is 1-based, and a
 * round that silently changed base would make one ruler's 1 mean what another's 2 means. */
export function toOneBased(score: number): number {
  return Math.round((score + 1) * 100) / 100;
}
