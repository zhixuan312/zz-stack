#!/usr/bin/env node
/**
 * checks/schema-inventory.ts — the gate's guard that a real migration run still produces the
 * schema `schema-target.ts` declares.
 *
 *   node checks/schema-inventory.ts   # migrates a throwaway container and compares
 *
 * `SCHEMA_TARGET` is never regenerated here — it is the frozen baseline, edited by hand as
 * later phases add to it. This only ever checks the real migrations against it.
 *
 * `scripts/rehearse.ts` compares its restored production copy by calling `compareWithTarget`
 * in-process on the client of the container it started. There is deliberately no way to hand
 * this CLI a database address: the only database it ever connects to is one it created.
 *
 * Exit 0: the catalog matches `SCHEMA_TARGET` — one summary line.
 * Exit 1: one or more differences — one line each, then a non-zero exit.
 * Exit 2: Docker is not available — the throwaway path cannot run, and that is not a pass.
 */
import { pathToFileURL } from "node:url";

import { SCHEMA_TARGET } from "../schema-target.ts";
import { compareWithTarget } from "../scripts/schema/compare.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

function dockerUnavailable(err: unknown): boolean {
  return err instanceof Error && /Docker is not running/.test(err.message);
}

async function main(): Promise<void> {
  let diffs: string[];
  try {
    diffs = await withThrowawayDb(compareWithTarget);
  } catch (err) {
    if (dockerUnavailable(err)) {
      console.error("schema inventory: Docker is not available — the gate requires Docker to run this check");
      process.exit(2);
    }
    throw err;
  }

  if (diffs.length === 0) {
    const n = Object.keys(SCHEMA_TARGET.tables).length;
    console.log(`schema inventory: ${n} tables match phase ${SCHEMA_TARGET.phase}`);
    process.exit(0);
  }

  for (const line of diffs) console.error(line);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
