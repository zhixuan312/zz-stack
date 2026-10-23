#!/usr/bin/env node
/**
 * An audit stage declares its own round budget and what owes another round, and only an audit
 * stage may.
 *
 *   1. a source stage accepts `round_budget` 1..3 and a non-empty `continue_on` of the four weights
 *   2. it refuses a budget outside 1..3 or not an integer, an empty `continue_on`, and a weight
 *      that is not one of the four
 *   3. a stage that produces a document, a record or nothing refuses both fields
 *   4. sdlc-flow declares `round_budget: 2` and `continue_on: ["critical", "high"]` on
 *      sdlc-plan-audit, and on no other stage; sdlc-spec-audit declares neither
 *
 * Run: node checks/stage-round-policy.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";

import { FlowStage } from "../packages/contracts/dist/index.js";

const fail: string[] = [];
const audit = { name: "a", produces: "source", supports: "plan.md" };
const parses = (stage: Record<string, unknown>): boolean => FlowStage.safeParse(stage).success;

// 1. What a source stage accepts.
for (const round_budget of [1, 2, 3]) {
  if (!parses({ ...audit, round_budget })) fail.push(`round_budget: ${round_budget} refused on a source stage`);
}
for (const continue_on of [["critical"], ["critical", "high"], ["critical", "high", "medium", "low"]]) {
  if (!parses({ ...audit, continue_on })) fail.push(`continue_on: ${JSON.stringify(continue_on)} refused on a source stage`);
}
if (!parses(audit)) fail.push("a source stage declaring neither field is refused");

// 2. What it refuses.
for (const round_budget of [0, 4, 1.5, "2"]) {
  if (parses({ ...audit, round_budget })) fail.push(`round_budget: ${JSON.stringify(round_budget)} accepted`);
}
for (const continue_on of [[], ["severe"], ["Critical"], "critical"]) {
  if (parses({ ...audit, continue_on })) fail.push(`continue_on: ${JSON.stringify(continue_on)} accepted`);
}

// 3. Only an audit stage may declare them.
for (const produces of ["plan.md", "record", "nothing"]) {
  if (parses({ name: "s", produces, round_budget: 2 })) fail.push(`round_budget accepted on a stage producing ${produces}`);
  if (parses({ name: "s", produces, continue_on: ["high"] })) fail.push(`continue_on accepted on a stage producing ${produces}`);
}

// 4. What sdlc-flow declares.
const manifest = JSON.parse(readFileSync("catalog/sdlc/sdlc-flow/flow.json", "utf8")) as
  { stages?: Record<string, unknown>[] };
const stages = manifest.stages ?? [];
const byName = (n: string) => stages.find((s) => s.name === n);
const planAudit = byName("sdlc-plan-audit");
if (!planAudit) fail.push("sdlc-flow declares no sdlc-plan-audit stage");
else {
  if (planAudit.round_budget !== 2) fail.push(`sdlc-plan-audit round_budget is ${JSON.stringify(planAudit.round_budget)}, not 2`);
  if (JSON.stringify(planAudit.continue_on) !== JSON.stringify(["critical", "high"])) {
    fail.push(`sdlc-plan-audit continue_on is ${JSON.stringify(planAudit.continue_on)}, not ["critical","high"]`);
  }
  if (!parses(planAudit)) fail.push("sdlc-flow's sdlc-plan-audit stage does not parse");
}
for (const s of stages) {
  if (s.name === "sdlc-plan-audit") continue;
  if ("round_budget" in s || "continue_on" in s) fail.push(`${String(s.name)} declares a round policy; only sdlc-plan-audit may`);
}
if (!byName("sdlc-spec-audit")) fail.push("sdlc-flow declares no sdlc-spec-audit stage — the control above checks nothing");

if (fail.length) {
  for (const f of fail) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log("stage-round-policy: an audit stage declares its budget and threshold; sdlc-plan-audit declares 2 and critical/high");
