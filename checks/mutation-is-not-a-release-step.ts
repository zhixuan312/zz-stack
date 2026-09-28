#!/usr/bin/env node
// Two things about the mutation suite that are decisions, not accidents, and were neither stated
// nor guarded:
//
//   1. It is the only thing that tests the checks, and it is expensive — 368 plants at about a
//      minute each — so it is NOT part of a release. The gate must not be able to pull it in, and
//      the release script must not learn to run it: an hour added to every release is how a suite
//      stops being run at all.
//   2. It must keep running, or the report it produces is evidence of nothing. The committed report
//      sat at 2026-09-23 with all 423 rows failed and its own baseline red, because nothing ran it.
//      A schedule is what fixes that, and a schedule is one edit away from being deleted.
//
// Asserted structurally — a cron exists, and the release does not name the suite — rather than by
// reading the report's date, because the gate is offline and deterministic and a check that fails
// when the calendar moves would fail on every old checkout too.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const WORKFLOW = ".github/workflows/mutation.yml";
const wf = readFileSync(WORKFLOW, "utf8");

assert.match(wf, /^\s*schedule:/m, `${WORKFLOW} has a schedule — without one, nothing runs the suite`);
assert.match(wf, /cron:\s*"[^"]+"/, "and the schedule names a cron expression");
// `push` or `workflow_run` would make a release able to run it, which is the one thing the split
// exists to prevent. `workflow_dispatch` is the on-demand path a person takes deliberately.
for (const forbidden of ["push:", "workflow_run:", "pull_request:"]) {
  assert.ok(!new RegExp(`^  ${forbidden}`, "m").test(wf),
    `${WORKFLOW} is triggered by ${forbidden} — a release could then run the mutation suite`);
}

// The release half: `scripts/release.ts` and everything under `scripts/release/`.
const releaseFiles = ["scripts/release.ts",
  ...readdirSync("scripts/release").filter((f) => f.endsWith(".ts")).map((f) => `scripts/release/${f}`)];
for (const f of releaseFiles) {
  const src = readFileSync(f, "utf8");
  assert.ok(!/mutation/i.test(src),
    `${f} names the mutation suite; it is on-demand evidence and not a release step`);
}

console.log("ok mutation-is-not-a-release-step");
