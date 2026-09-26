#!/usr/bin/env node
/**
 * The qualification ladder's pure decision (Task I-11): evidence counts + thresholds -> state,
 * pinned offline with no database and no model call — `qualify-ladder.ts` exports it for exactly
 * this reason.
 *
 * NOT plan-authored: I-11's own task text says "final deliverable content is not in this plan",
 * so this check (and its registration in scripts/gate/checks/suites-surface.ts) is this task's
 * own, written the same way every other `checks/eval-*.ts` file pins its own task's pure surface.
 *
 * Run: node checks/eval-qualification-ladder.ts   (also run by scripts/gate.ts)
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const {
  qualificationState, resolveThresholds, LADDER_THRESHOLD_KEYS,
} = await load("services/zz-core/dist/eval/qualify-ladder.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const counts = (passed: number, total: number) => ({ passed, total });
const evidence = (over: Partial<{
  anchors: { passed: number; total: number }; planted_faults: { passed: number; total: number };
  controls: { passed: number; total: number }; stability: { passed: number; total: number };
  labels: { n: number; tpr: number; tnr: number } | null;
}> = {}) => ({
  anchors: counts(4, 5), planted_faults: counts(4, 5), controls: counts(4, 5), stability: counts(3, 3),
  labels: null,
  ...over,
});

// 1. resolveThresholds: every LADDER_THRESHOLD_KEYS entry is defaulted when the policy names
// none of them, and named back in `defaulted`.
{
  const { thresholds, defaulted } = resolveThresholds(undefined);
  is(LADDER_THRESHOLD_KEYS.length === 7, `LADDER_THRESHOLD_KEYS has ${LADDER_THRESHOLD_KEYS.length} entries, expected 7`);
  for (const k of LADDER_THRESHOLD_KEYS) {
    is(typeof thresholds[k] === "number", `resolveThresholds(undefined) leaves ${k} non-numeric`);
    is(defaulted.includes(k), `resolveThresholds(undefined) does not report ${k} as defaulted`);
  }
  const { thresholds: t2, defaulted: d2 } = resolveThresholds({ anchorPassRate: 0.5, faultKillRate: "nope" as unknown as number });
  is(t2.anchorPassRate === 0.5, "an explicit numeric threshold overrides the default");
  is(!d2.includes("anchorPassRate"), "an explicit numeric threshold is not reported as defaulted");
  is(d2.includes("faultKillRate"), "a non-numeric threshold value falls back to default and is reported as defaulted");
}

// 2. anchors.total === 0 -> unqualified/no_anchors, unconditionally — the contract's own Errors
// clause, checked ahead of every other rung regardless of how generous the thresholds are.
{
  const { thresholds } = resolveThresholds({
    anchorPassRate: 0, stabilityRate: 0, faultKillRate: 0, controlCatchRate: 0,
    labelMinN: 0, labelTprMin: 0, labelTnrMin: 0,
  });
  const r = qualificationState(evidence({ anchors: counts(0, 0) }), thresholds);
  is(r.state === "unqualified" && r.reason === "no_anchors",
     `zero anchors with every threshold at 0 still refuses to qualify: ${JSON.stringify(r)}`);
}

// 3. Perfect anchors + stability, no faults/controls attempted -> mechanically_qualified.
{
  const { thresholds } = resolveThresholds({ anchorPassRate: 0.8, stabilityRate: 1 });
  const r = qualificationState(
    evidence({ anchors: counts(5, 5), stability: counts(3, 3), planted_faults: counts(0, 0), controls: counts(0, 0) }),
    thresholds);
  is(r.state === "mechanically_qualified" && r.reason === "no planted faults asked; no controls asked",
     `perfect anchors+stability with no fault/control evidence should stop at mechanically_qualified, naming both gaps: ${JSON.stringify(r)}`);
}

// 4. 50% anchor pass rate under an 0.8 bar -> unqualified, even with perfect stability.
{
  const { thresholds } = resolveThresholds({ anchorPassRate: 0.8, stabilityRate: 1 });
  const r = qualificationState(evidence({ anchors: counts(2, 4), stability: counts(3, 3) }), thresholds);
  is(r.state === "unqualified" && r.reason === "anchorPassRate 0.50 < 0.80 (2/4)",
     `a 50% anchor pass rate under a 0.8 bar must not qualify, and the reason names only the threshold that failed: ${JSON.stringify(r)}`);
}

// 5. One of three stability answers agreeing (a third) under a 1.0 bar -> unqualified, even with
// a perfect anchor rate.
{
  const { thresholds } = resolveThresholds({ anchorPassRate: 0.8, stabilityRate: 1 });
  const r = qualificationState(evidence({ anchors: counts(5, 5), stability: counts(1, 3) }), thresholds);
  is(r.state === "unqualified" && r.reason === "stabilityRate 0.33 < 1.00 (1/3)",
     `1/3 stability agreement under a 1.0 bar must not qualify, naming stability alone: ${JSON.stringify(r)}`);
}

// 6. Mechanically sound + faults killed + controls caught -> operationally_qualified, with no
// labels evidence.
{
  const { thresholds } = resolveThresholds({ anchorPassRate: 0.8, stabilityRate: 1, faultKillRate: 0.8, controlCatchRate: 0.8 });
  const r = qualificationState(
    evidence({ anchors: counts(5, 5), stability: counts(3, 3), planted_faults: counts(4, 5), controls: counts(4, 5), labels: null }),
    thresholds);
  is(r.state === "operationally_qualified" && r.reason === null,
     `operational evidence clearing its bars with labels: null should reach operationally_qualified, not further: ${JSON.stringify(r)}`);
}

// 7. Operationally sound evidence with faults/controls at 0 total (a threshold cleared against
// no attempts is not evidence) must NOT advance past mechanically_qualified.
{
  const { thresholds } = resolveThresholds({ anchorPassRate: 0.8, stabilityRate: 1, faultKillRate: 0, controlCatchRate: 0 });
  const r = qualificationState(
    evidence({ anchors: counts(5, 5), stability: counts(3, 3), planted_faults: counts(0, 0), controls: counts(0, 0) }),
    thresholds);
  is(r.state === "mechanically_qualified",
     `a 0-total fault/control category must not count as cleared even against a 0 threshold: ${JSON.stringify(r)}`);
}

// 8. Perfect evidence including labels clearing every bar -> human_calibrated, the top rung.
{
  const { thresholds } = resolveThresholds({
    anchorPassRate: 0.8, stabilityRate: 1, faultKillRate: 0.8, controlCatchRate: 0.8,
    labelMinN: 10, labelTprMin: 0.7, labelTnrMin: 0.7,
  });
  const r = qualificationState(
    evidence({
      anchors: counts(5, 5), stability: counts(3, 3), planted_faults: counts(5, 5), controls: counts(5, 5),
      labels: { n: 20, tpr: 0.9, tnr: 0.9 },
    }),
    thresholds);
  is(r.state === "human_calibrated" && r.reason === null,
     `perfect evidence with labels clearing every bar should reach the top rung: ${JSON.stringify(r)}`);
}

// 9. Otherwise-perfect evidence with labels.n below labelMinN stays at operationally_qualified —
// the top rung needs enough labelled examples, not just a good rate on a handful.
{
  const { thresholds } = resolveThresholds({
    anchorPassRate: 0.8, stabilityRate: 1, faultKillRate: 0.8, controlCatchRate: 0.8,
    labelMinN: 50, labelTprMin: 0.7, labelTnrMin: 0.7,
  });
  const r = qualificationState(
    evidence({
      anchors: counts(5, 5), stability: counts(3, 3), planted_faults: counts(5, 5), controls: counts(5, 5),
      labels: { n: 5, tpr: 1, tnr: 1 },
    }),
    thresholds);
  is(r.state === "operationally_qualified",
     `labels.n below labelMinN must not reach human_calibrated even at a perfect rate: ${JSON.stringify(r)}`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-qualification-ladder");
