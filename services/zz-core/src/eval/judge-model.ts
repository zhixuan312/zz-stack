/**
 * WHICH MODEL ANSWERS, AND UNDER WHAT NAME.
 *
 * SPLIT OUT OF judge.ts BY SUBJECT, the third such cut after judge-trace.ts and judge-pair.ts.
 * That file runs the round. This one settles a different question and settles it once: which
 * service is asked, what it is called on the row that records the answer, and where the
 * fallback's endpoint lives.
 *
 * A JUDGE'S NAME IS PART OF ITS IDENTITY, which is why the name and the mode are computed
 * together here rather than assembled at the call site. `zz.eval.judge_model` is what every
 * comparison groups by, so two rounds marked by different models -- or by the same model with
 * reasoning off -- are two scales, and the column is what lets a reader see that rather than
 * discover it.
 */
import { configured as typedJudgeConfigured } from "./typesafe.js";

/** THE READING JUDGE, WHICH IS NOW A FALLBACK AND NOT THE JUDGE.
 *
 *  Every typed decision goes to the typed judgement service: the qualitative marks against
 *  named levels, the thresholds, the recommendation enum. Measured on this deployment, twelve
 *  of twelve rounds since the switch carry `typesafe/jev-latest` in `judge_model`. This model
 *  answers only when that service has no key, or when a ruler carries a qualitative dimension
 *  with fewer than two named levels — and either way the name lands in `judge_model`, so a
 *  round marked this way never averages with one marked by the typed service.
 *
 *  THE RULE IT USED TO CARRY STILL HOLDS AND IS NO LONGER ENFORCED BY THIS DEFAULT. A judge
 *  that IS the platform's base model is exactly as good as the thing it judges, which is the
 *  one property a ruler must not have. This defaulted to the full model where the agents ran
 *  on the flash one, and that separation is now a deployment's own decision: `checkJudgeModel`
 *  below warns when the two are the same AND the typed service is absent, which is the only
 *  combination where it can still do damage. Warned rather than refused — a deployment that
 *  wants one model is allowed to have one, and being told is what it is owed. */
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

/** EXTENDED REASONING IS ON, and the control is why.
 *
 * It was turned off for a good reason and put back for a better one. With it on, a control
 * call ran past 95 seconds and timed out three times in a row, storing nothing — and a lost
 * control costs a round the only number that establishes the judge was reading rather than
 * rewarding confident prose. Off, the same call answered in five seconds. That looked like a
 * clear trade.
 *
 * Then the control judged the change, and THE CONCLUSION DRAWN FROM IT WAS WRONG. It read:
 * under the fast judge using-the block's gap fell from 1.67 to 1.00 and
 * writing-case-queries went to minus 0.33, therefore the fast judge is broken.
 *
 * Both of those rounds have `subject: body`, and no body round has EVER cleared the collapse
 * line, under any judge, with reasoning on or off. Measured across the whole store on
 * 2026-09-06: using-casebox is -1.83 with reasoning and -1.00 without;
 * writing-case-queries is 0.00 with and +0.33 without. Reasoning-off scored BETTER on both.
 * The "1.67" was a gap that was already negative, reported as though it were positive and
 * shrinking.
 *
 * The cause is the ruler, not the mode. A body rubric asks generic questions about a skill's
 * text, the control is another skill's text, and a decent one answers them — so the control
 * cannot fail and the comparison measures nothing about the judge. Turning reasoning off made
 * a meaningless number noisier; it did not make it meaningless.
 *
 * Reasoning stays ON, and the reason is now the honest one: a mode change is a judge change,
 * it starts an incomparable series, and there is no measured benefit to buying that. The
 * timeout is paid rather than avoided, which the resume design affords — a subject whose call
 * times out is reported skipped, `remaining` does not move, and the next call retries it with
 * a fresh budget.
 *
 * ZZ_JUDGE_THINKING=off is kept, because the comparison above is worth being able to re-run —
 * and because a mode is part of a judge's identity, it records as a different judge name and
 * never averages with these. */
export const THINKING = (process.env.ZZ_JUDGE_THINKING || "on").toLowerCase() === "on";
export const JUDGE_MODEL = THINKING ? JUDGE_BASE : `${JUDGE_BASE}/no-reasoning`;
/** What goes in `judge_model` when the typed service marked the round. Read from the same
 *  environment the client reads, so the recorded name is the model that actually answered. */
export const typedJudgeName = (): string =>
  `typesafe/${(process.env.TYPESAFE_MODEL || "jev-latest").trim()}`;
export const LLM_BASE = (process.env.LLM_BASE_URL || "").replace(/\/+$/, "");
export const LLM_KEY = process.env.LLM_API_KEY || "";
