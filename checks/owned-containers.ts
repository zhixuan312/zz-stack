#!/usr/bin/env node
// Throwaway containers outlive a starter killed with SIGKILL, which runs no `finally` and no signal handler: on
// 2026-10-31 a throwaway PostgreSQL had stood for six days with its volume after its check was killed. Every starter
// labels what it creates with its own pid and sweeps the labels of dead pids first (scripts/owned-containers.ts).
//
//   - `orphans` names exactly the rows whose owner is gone: never this process, never a live one, never a malformed row;
//   - every detached `docker run` and every `docker network create` under scripts/ carries `...owned()`, and each file
//     that creates one sweeps first, so a new starter cannot leak the old way.
//
// Offline: it starts nothing. The sweep's own docker calls run on every throwaway start the gate makes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { OWNER_LABEL, orphans, owned } from "../scripts/owned-containers.ts";

// ── the rule ──
const dead = 2_000_000_001;
const live = 2_000_000_002;
const isAlive = (pid: number) => pid === live;
assert.deepEqual(orphans(`a ${dead}\nb ${live}\nc ${process.pid}\nd\n e notapid\n\nf ${dead}`, isAlive), ["a", "f"]);
assert.deepEqual(orphans("", isAlive), []);
assert.deepEqual(owned(), ["--label", `${OWNER_LABEL}=${process.pid}`]);

// ── every starter under scripts/ labels and sweeps ──
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});
const creates = /\[\s*"run",\s*"-d"|\[\s*"network",\s*"create"/;
const starters: string[] = [];
const problems: string[] = [];
for (const file of walk("scripts")) {
  const lines = readFileSync(file, "utf8").split("\n");
  const sites = lines.flatMap((l, i) => (creates.test(l) ? [i] : []));
  if (sites.length === 0) continue;
  starters.push(file);
  for (const i of sites) if (!lines[i].includes("...owned()")) problems.push(`${file}:${i + 1} creates without ...owned()`);
  if (!lines.some((l) => /\bsweepOrphans\(\)/.test(l))) problems.push(`${file} creates containers and never calls sweepOrphans()`);
}
assert.deepEqual(problems, []);
assert.ok(starters.length >= 5, `expected the five known starters, found ${starters.join(", ")}`);

console.log(`ok owned-containers (${starters.length} starters)`);
