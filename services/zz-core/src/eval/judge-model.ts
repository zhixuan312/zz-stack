/**
 * Which reading model answers, and under what name.
 *
 * judge.ts makes the call. This settles which model is asked, what it is called on the
 * `zz.model_call` row that records the call, and where its endpoint lives.
 *
 * A judge's name is part of its identity, so the name and the mode are computed together here
 * rather than assembled at the call site: two answers from different models — or from the same
 * model with reasoning off — are two instruments, and the recorded name is what lets a reader see
 * that. `discover.ts` stamps the same name on every description its critic proposes.
 */

/** The reading judge. Every typed decision goes to the typed judgement service; this model is
 *  reached only through judge.ts's `ask`, whose one caller today is `failure_discover`'s
 *  generative critic.
 *
 *  A judge that is the platform's base model is exactly as good as the thing it judges.
 *  `checkJudgeModel` below warns when the two are the same. Warned rather than refused — a
 *  deployment that wants one model is allowed to have one. */
export const JUDGE_BASE = process.env.ZZ_JUDGE_MODEL || "deepseek-v4.1-flash";

/** Say so when the reading judge is the model it would be reading. Called at import so an operator
 *  sees it in the boot log rather than discovering it on a recorded call weeks later. */
function checkJudgeModel(): void {
  const base = (process.env.PLATFORM_BASE_MODEL ?? "").trim();
  if (base && base === JUDGE_BASE) {
    console.warn(
      `ZZ_JUDGE_MODEL and PLATFORM_BASE_MODEL are both ${base}, so this deployment reads its own ` +
      "agents' failures with the model those agents run on, which makes the critic exactly as " +
      "good as the thing being described. Set one of the two to a different model.");
  }
}
checkJudgeModel();

/** Extended reasoning is on.
 *
 * DELIBERATE: a mode change is a judge change. It starts an incomparable series, and there is no
 * measured benefit to buying that — reasoning-off scored no better on any round whose ruler could
 * discriminate at all. The timeout it costs is paid rather than avoided: a caller of `ask` falls
 * back on a throw rather than retrying.
 *
 * ZZ_JUDGE_THINKING=off is kept so that comparison can be re-run — and because a mode is part of a
 * judge's identity, it records as a different judge name and never averages with these. */
export const THINKING = (process.env.ZZ_JUDGE_THINKING || "on").toLowerCase() === "on";
export const JUDGE_MODEL = THINKING ? JUDGE_BASE : `${JUDGE_BASE}/no-reasoning`;
export const LLM_BASE = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
export const LLM_KEY = process.env.LLM_API_KEY || "";
