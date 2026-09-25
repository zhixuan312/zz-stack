#!/usr/bin/env node
/**
 * The doctor's pre-deploy subset: what a release asks before it deploys.
 *
 * Registers the real layers (registration only; no probe runs and no host is reached) and reads
 * the subset back through `probeNames`:
 *   1. it holds the status-gate probe, whose disagreement rolled 0.76.0 back after a deploy;
 *   2. it holds nothing whose answer the deploy changes — migrations applied, the skill registry,
 *      and nothing from the host, doors or contract layers;
 *   3. the release runs it before the deploy: release.ts calls verifyPredeploy before step 4.
 *
 * Run: node checks/doctor-predeploy.ts
 */
import { readFileSync } from "node:fs";

import "../scripts/doctor/layers/host.ts";
import "../scripts/doctor/layers/doors.ts";
import "../scripts/doctor/layers/contract.ts";
import "../scripts/doctor/layers/data.ts";
import { probeNames } from "../scripts/doctor/run.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const pre = probeNames({ predeploy: true });
const all = probeNames();
is(pre.includes("data/no document carries a status its flow does not gate"),
   "the status-gate probe is not in the pre-deploy subset — the 0.76.0 rollback can happen again");
is(all.includes("data/every migration is applied, and every applied migration still exists"),
   "the migration probe is no longer registered under its name — this check is reading nothing");
is(!pre.includes("data/every migration is applied, and every applied migration still exists"),
   "migration-applied is marked pre-deploy — before the deploy the new migrations are unapplied by definition");
is(!pre.includes("data/the skill registry is not behind the catalog"),
   "the skill registry probe is marked pre-deploy — the deploy step is what writes the registry");
is(pre.every((p) => p.startsWith("data/")), `a probe outside the data layer is marked pre-deploy: ${pre.filter((p) => !p.startsWith("data/")).join(", ")}`);

const rel = readFileSync("scripts/release.ts", "utf8");
const called = rel.indexOf("verifyPredeploy(");
const deploy = rel.indexOf('step(4, "deploy")');
is(called > 0 && deploy > 0 && called < deploy, "release.ts does not run verifyPredeploy before step 4");

if (fail.length) {
  console.error(`doctor-predeploy: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`doctor-predeploy: ${pre.length} pre-deploy probe(s), the status gate among them, migrations not`);
