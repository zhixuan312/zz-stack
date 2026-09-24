#!/usr/bin/env node
/**
 * doctor — where does the deployment stop matching what this checkout declares?
 *
 * Not "is it healthy": the answer carries a location. Six layers, each with one source of
 * truth on the repository side and one on the deployment side, reported in the order that
 * makes a diagnosis, because the first layer that disagrees usually explains the rest.
 *
 *   repo      does this checkout agree with itself
 *   image     is what the registry holds what this checkout declares
 *   host      is the host running those images, files and schedules
 *   doors     does every door answer
 *   contract  is the live surface the one the source declares
 *   data      are the migrations and the registry the shape this checkout expects
 *
 * This file is an order, not a list: a layer missing from the imports below does not run, and
 * the import order is the diagnosis order. `repo` is first because every later comparison is
 * against what it settles.
 *
 * DELIBERATE: it changes nothing. No flag deploys, restarts, migrates or writes, which is
 * what makes it safe to run while something is broken.
 *
 *   node scripts/doctor.ts                      every layer
 *   node scripts/doctor.ts --layer repo,image   offline only; no host needed
 *   node scripts/doctor.ts --since 0.26.0       and what changed since that version
 *   node scripts/doctor.ts --json               for the console, or for an agent
 */
import "./doctor/layers/repo.ts";
import "./doctor/layers/image.ts";
import "./doctor/layers/host.ts";
import "./doctor/layers/doors.ts";
import "./doctor/layers/contract.ts";
import "./doctor/layers/data.ts";

import { HOST, errMessage } from "./deployment.ts";
import { diagnose, findings, layerNames, report } from "./doctor/run.ts";
import { since } from "./doctor/since.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  // A flag given with nothing after it is refused, never read as absent: `--layer` followed by
  // nothing would otherwise run every layer and report a clean bill for a question nobody
  // asked.
  const next = args[args.indexOf(hit) + 1];
  if (!next || next.startsWith("--")) {
    console.error(`\n\x1b[31m--${name} was given with no value.\x1b[0m`);
    process.exit(2);
  }
  return next;
};

const json = args.includes("--json");
const only = flag("layer")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const known = flag("since");

if (!json) {
  console.log(`\n\x1b[1m── doctor · ${HOST}\x1b[0m` +
              `\n  \x1b[2mwhere the deployment stops matching what this checkout declares. ` +
              `Nothing here changes anything.\x1b[0m`);
}

try {
  diagnose({ only });
} catch (err) {
  // A bad --layer name, or a failure in the runner itself. Not a verdict about the platform,
  // and the exit code says so differently from a disagreement.
  console.error(`\n\x1b[31mthe doctor could not run: ${errMessage(err)}\x1b[0m\n`);
  process.exit(2);
}

const code = report({ json });

if (known && !json) {
  const bad = [...new Set(findings.filter((f) => f.verdict !== "ok").map((f) => f.layer))];
  const look = bad.length ? bad : layerNames();
  console.log(`\x1b[1m  what changed since ${known}\x1b[0m` +
              `\n  \x1b[2m${bad.length ? "for the layers that disagree" : "nothing disagrees, so: every layer"}` +
              ` — suspects, not causes. A layer's paths are where its claim comes from, not the` +
              ` only place a change can break it.\x1b[0m\n`);
  for (const line of since(known, look)) console.log(line);
  console.log("");
}

process.exit(code);
