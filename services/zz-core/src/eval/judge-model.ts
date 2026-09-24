/**
 * Which model answers, and under what name.
 *
 * judge.ts runs the round. This settles which service is asked, what it is called on the row that
 * records the answer, and where the fallback's endpoint lives.
 *
 * A judge's name is part of its identity, so the name and the mode are computed together here
 * rather than assembled at the call site. `zz.eval.judge_model` is what every comparison groups
 * by, so two rounds marked by different models — or by the same model with reasoning off — are two
 * scales, and the column is what lets a reader see that.
 */
import { configured as typedJudgeConfigured } from "../typed-service.js";

/** The reading judge, which is a fallback and not the judge.
 *
 *  Every typed decision goes to the typed judgement service: the qualitative marks against named
 *  levels, the thresholds, the evidence-strength reading. This model answers only when that service has
 *  no key, or when a ruler carries a qualitative dimension with fewer than two named levels — and
 *  either way the name lands in `judge_model`, so a round marked this way never averages with one
 *  marked by the typed service.
 *
 *  A judge that is the platform's base model is exactly as good as the thing it judges, which is
 *  the one property a ruler must not have. `checkJudgeModel` below warns when the two are the same
 *  and the typed service is absent, which is the only combination where that can still do damage.
 *  Warned rather than refused — a deployment that wants one model is allowed to have one. */
export const JUDGE_BASE = process.env.ZZ_JUDGE_MODEL || "deepseek-v4.1-flash";

/** Say so when the fallback judge is the model it would be judging.
 *
 *  Only when the typed service is absent, because that is the only time this model marks
 *  anything. Called at import so an operator sees it in the boot log rather than discovering
 *  it in a round's `judge_model` six weeks later. */
function checkJudgeModel(): void {
  const base = (process.env.PLATFORM_BASE_MODEL ?? "").trim();
  if (base && base === JUDGE_BASE && !typedJudgeConfigured()) {
    console.warn(
      `ZZ_JUDGE_MODEL and PLATFORM_BASE_MODEL are both ${base}, and no TYPESAFE_API_KEY is ` +
      "set — so this deployment judges its own agents' work with the model those agents run " +
      "on, which makes the ruler exactly as good as the thing being measured. Set one of the " +
      "two to a different model, or set TYPESAFE_API_KEY so the typed service marks instead.");
  }
}
checkJudgeModel();

/** Extended reasoning is on.
 *
 * DELIBERATE: a mode change is a judge change. It starts an incomparable series, and there is no
 * measured benefit to buying that — reasoning-off scored no better on any round whose ruler could
 * discriminate at all. The timeout it costs is paid rather than avoided, which the resume design
 * affords: a subject whose call times out is reported skipped, `remaining` does not move, and the
 * next call retries it with a fresh budget.
 *
 * ZZ_JUDGE_THINKING=off is kept so that comparison can be re-run — and because a mode is part of a
 * judge's identity, it records as a different judge name and never averages with these. */
export const THINKING = (process.env.ZZ_JUDGE_THINKING || "on").toLowerCase() === "on";
export const JUDGE_MODEL = THINKING ? JUDGE_BASE : `${JUDGE_BASE}/no-reasoning`;
/** What goes in `judge_model` when the typed service marked the round. Read from the same
 *  environment the client reads, so the recorded name is the model that actually answered. */
export const typedJudgeName = (): string =>
  `typesafe/${(process.env.TYPESAFE_MODEL || "jev-latest").trim()}`;
export const LLM_BASE = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
export const LLM_KEY = process.env.LLM_API_KEY || "";
