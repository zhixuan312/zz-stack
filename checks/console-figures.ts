#!/usr/bin/env node
/**
 * checks/console-figures.ts — the platform's figures and findings, as pure functions over weeks and days.
 *
 *   node checks/console-figures.ts   # needs a built tree (`npm run build`)
 *
 * Exit 0: every case held. Exit 1: the first case that did not, with what came back.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";

const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const F = await load("services/gateway/dist/console/figures.js");
const N = await load("services/gateway/dist/console/findings.js");

const problems: string[] = [];
const expect = (what: string, ok: boolean, got: unknown) => { if (!ok) problems.push(`${what}: got ${JSON.stringify(got)}`); };

type W = { from: string; to: string; observedFrom: string; observedThrough: string; numerator: number | null; denominator: number | null; value: number | null; samples: number; complete: boolean; available: boolean };
const DAY = 86_400_000;
// A week as the read builds it: instants, starting at Monday 00:00 in the timezone `offsetHours` ahead of UTC.
const week = (monday: string, num: number | null, den: number | null, extra: Partial<W> = {}, offsetHours = 0): W => {
  const start = Date.parse(`${monday}T00:00:00Z`) - offsetHours * 3_600_000;
  const value = num === null || den === null || den === 0 ? null : (1000 * num) / den;
  const from = new Date(start).toISOString(), to = new Date(start + 7 * DAY).toISOString();
  return { from, to, observedFrom: from, observedThrough: to, numerator: num, denominator: den, value, samples: den ?? 0, complete: true, available: true, ...extra };
};
const rate = (weeks: W[], over: Record<string, unknown> = {}) =>
  F.summarise({ key: "malformed_per_1000", better: "down", minSamples: 30, precision: 1, definedFrom: null,
    label: "malformed-call rate", countLabel: "calls refused for their shape", coverageFrom: "2026-09-14",
    timezone: "UTC", weeks, ...over });

// A running week is drawn and never chosen.
{
  const m = rate([week("2026-09-14", 5, 100), week("2026-09-21", 4, 100), week("2026-09-28", 3, 100), week("2026-10-05", 0, 100, { complete: false })]);
  expect("running week kept", m.weeks.length === 4, m.weeks.length);
  expect("running week is not best", m.best?.window.from === "2026-09-28T00:00:00.000Z", m.best);
  expect("running week is not last", m.last?.window.from === "2026-09-28T00:00:00.000Z", m.last);
  expect("observed bounds pass through", m.weeks[3].window.observedThrough === "2026-10-12T00:00:00.000Z", m.weeks[3].window);
  expect("previous is the week before last", m.previous?.window.from === "2026-09-21T00:00:00.000Z", m.previous);
  expect("fewer malformed is improved", m.judgement === "improved", m.judgement);
  expect("the finding travels on the measure", m.finding?.kind === "best_week", m.finding);
}
// A missing week is a point with a reason, never a zero.
{
  const m = rate([week("2026-09-14", 5, 100), week("2026-09-21", null, null, { available: false }), week("2026-09-28", 0, 0)]);
  expect("unavailable week", m.weeks[1].figure.value === null && m.weeks[1].figure.why === "unavailable", m.weeks[1]);
  expect("zero calls is no data", m.weeks[2].figure.value === null && m.weeks[2].figure.why === "no_data", m.weeks[2]);
  expect("no comparison over a gap", m.judgement === "not_comparable", m.judgement);
}
// Fewer than 30 keeps its value, cannot be best, and judges nothing.
{
  const m = rate([week("2026-09-14", 5, 100), week("2026-09-21", 4, 100), week("2026-09-28", 0, 12)]);
  expect("insufficient keeps value", m.last?.figure.why === "insufficient" && m.last?.figure.value === 0, m.last);
  expect("insufficient is never best", m.best?.window.from === "2026-09-21T00:00:00.000Z", m.best);
  expect("insufficient judges nothing", m.judgement === "not_comparable", m.judgement);
  expect("lacks samples: no best-week finding", m.finding.kind !== "best_week", m.finding);
}
// Equal at the printed precision is unchanged; a tie chooses the earliest week and says so.
{
  const m = rate([week("2026-09-14", 3, 1000), week("2026-09-21", 3.04, 1000), week("2026-09-28", 3, 1000)]);
  expect("unchanged at one decimal", m.judgement === "unchanged", m.judgement);
  expect("tie chooses the earliest", m.best?.window.from === "2026-09-14T00:00:00.000Z", m.best);
  expect("every tie is said", m.finding.kind === "best_week" && m.finding.tie === true && / tied with 14 Sept and 21 Sept$/.test(m.finding.text), m.finding);
}
// A neutral measure names highest and lowest, never best, and is never judged.
const neutral = (values: number[], coverageFrom = "2026-09-14") => F.summarise({ key: "sessions", better: "neutral",
  minSamples: 0, precision: 0, definedFrom: null, label: "sessions", countLabel: null, coverageFrom, timezone: "UTC",
  weeks: values.map((v, i) => ({ ...week(["2026-09-14", "2026-09-21", "2026-09-28"][i], v, 1), value: v })) });
{
  const m = neutral([40, 20, 90]);
  expect("neutral has no best", m.best === null, m.best);
  expect("neutral highest", m.highest?.window.from === "2026-09-28T00:00:00.000Z", m.highest);
  expect("neutral lowest", m.lowest?.window.from === "2026-09-21T00:00:00.000Z", m.lowest);
  expect("neutral is not judged", m.judgement === "neutral", m.judgement);
  expect("neutral high week", m.finding.kind === "high_week" && m.finding.text === "Most recorded sessions in a week since 14 Sept", m.finding);
  const low = neutral([40, 90, 20]);
  expect("neutral low week", low.finding.kind === "low_week" && low.finding.text === "Fewest recorded sessions in a week since 14 Sept", low.finding);
  const tied = neutral([40, 90, 40], "2026-09-07");
  expect("neutral tie", tied.finding.kind === "low_week" && tied.finding.tie === true && tied.finding.text === "Fewest recorded sessions in a week since 7 Sept, tied with 14 Sept", tied.finding);
  const middle = neutral([40, 90, 60]);
  expect("no rule holds and no counts: no finding", middle.finding === null, middle.finding);
}
// A neutral rate's week under 30 samples holds no high or low record, and a standing week's stays in place.
{
  const m = F.summarise({ key: "bugs_per_1000", better: "neutral", minSamples: 30, precision: 1, definedFrom: null,
    label: "bug reports per 1,000 calls", countLabel: null, coverageFrom: "2026-09-07", timezone: "UTC",
    weeks: [week("2026-09-07", 0, 3), week("2026-09-14", 4, 100), week("2026-09-21", 2, 100), week("2026-09-28", 1, 5), week("2026-10-05", 9, 100)] });
  expect("an insufficient week is never the highest", m.highest?.window.from === "2026-10-05T00:00:00.000Z", m.highest);
  expect("an insufficient week is never the lowest", m.lowest?.window.from === "2026-09-21T00:00:00.000Z", m.lowest);
  expect("the standing last week keeps its high record",
    m.finding?.kind === "high_week" && m.finding.text === "Most recorded bug reports per 1,000 calls in a week since 7 Sept", m.finding);
}
// A changed definition: weeks before it are unavailable and nothing compares across it.
{
  const m = rate([week("2026-09-14", 5, 100), week("2026-09-21", 4, 100), week("2026-09-28", 3, 100)], { definedFrom: "2026-09-21" });
  expect("before the definition is unavailable", m.weeks[0].figure.why === "unavailable", m.weeks[0]);
  expect("first is on or after the definition", m.first?.window.from === "2026-09-21T00:00:00.000Z", m.first);
  expect("two comparable weeks are not enough for a finding", m.finding.kind === "incomplete", m.finding);
}
// A week that starts at local midnight in Singapore is dated by its local Monday.
{
  const m = rate([week("2026-09-14", 5, 100, {}, 8), week("2026-09-21", 4, 100, {}, 8), week("2026-09-28", 3, 100, {}, 8)], { timezone: "Asia/Singapore" });
  expect("the week starts on the instant before UTC midnight", m.last?.window.from === "2026-09-27T16:00:00.000Z", m.last);
  expect("the finding names the local Monday", m.finding.dates[0] === "2026-09-28" && /, 28 Sept$/.test(m.finding.text), m.finding);
}
// Findings that do not hold.
{
  const not = rate([week("2026-09-14", 3, 100), week("2026-09-21", 4, 100), week("2026-09-28", 5, 100)]);
  expect("best week does not hold", not.finding.kind === "count" && not.finding.text === "5 of 100 calls refused for their shape", not.finding);
  const short = rate([week("2026-09-21", 4, 100), week("2026-09-28", 3, 100)]);
  expect("lacks coverage", short.finding.kind === "incomplete" && short.finding.text === "Not enough complete weeks to compare yet", short.finding);
}
// A run of days: three complete days under 1%, today apart, a day with no calls or unavailable ends it.
{
  const d = (date: string, calls: number | null, toolFailures: number | null, complete = true) => ({ date, calls, toolFailures, complete, available: calls !== null });
  const days = [d("2026-10-08", 100, 0), d("2026-10-09", 0, 0), d("2026-10-10", 100, 0), d("2026-10-11", 100, 0), d("2026-10-12", 200, 1), d("2026-10-13", 50, 5, false)];
  const r = N.runOf(days);
  expect("run of three to the last complete day", r?.days === 3 && r?.through === "2026-10-12" && r?.atLeast === false, r);
  expect("a day at 1% or more ends the run", N.runOf([...days.slice(0, 4), d("2026-10-12", 100, 1)]) === null, N.runOf([...days.slice(0, 4), d("2026-10-12", 100, 1)]));
  // The value is passed as the message's own argument: a failing case that reports the literal
  // `null` says nothing about what came back.
  const unavailable = N.runOf([d("2026-10-09", 10, 0), d("2026-10-10", null, null), d("2026-10-11", 10, 0), d("2026-10-12", 10, 0)]);
  expect("an unavailable day ends the run", unavailable === null, unavailable);
  const all = N.runOf([d("2026-10-10", 10, 0), d("2026-10-11", 10, 0), d("2026-10-12", 1000, 1), d("2026-10-13", 10, 0, false)]);
  expect("reaching the first day kept is at least", all?.atLeast === true && all?.days === 3, all);
  expect("the run sentence", N.runFinding(days).kind === "run" && N.runFinding(days).text === "3 days in a row under 1% tool failures, to 12 Oct", N.runFinding(days));
  const atLeast = N.runFinding([d("2026-10-10", 10, 0), d("2026-10-11", 10, 0), d("2026-10-12", 1000, 1), d("2026-10-13", 10, 0, false)]);
  expect("the at-least sentence", atLeast.text === "At least 3 days in a row under 1% tool failures, to 12 Oct", atLeast);
  const zero = N.runFinding([d("2026-10-10", 10, 0), d("2026-10-11", 20, 0), d("2026-10-12", 30, 0), d("2026-10-13", 5, 0, false)]);
  expect("no tool failure comes first", zero.kind === "no_failure" && zero.text === "No tool failure recorded in 65 calls since 10 Oct", zero);
}

if (problems.length) { console.error(`console-figures: FAILED\n  ${problems.join("\n  ")}`); process.exitCode = 1; }
else console.log("console-figures: weeks, judgements and findings hold their states: ok");
