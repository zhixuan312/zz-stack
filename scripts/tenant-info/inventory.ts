/**
 * inventory.ts — the `fixtures` verb.
 *
 * What the generated corpus actually contains is a later task's contract (its own `Check:`
 * exists already, frozen, for when its turn comes — see `plan-approved.md`); this task's
 * plan boundary excludes that content. What belongs here is the safe entry point: a seed and
 * a scale, written nowhere but the caller's own workspace, recorded so a later run can prove
 * what produced what it finds there.
 */
import { writeFileSync } from "node:fs";

import { safeWritePath } from "./workspace.ts";

interface FixturesArgs {
  seed: number;
  scale: string;
}

interface FixturesReceipt {
  verb: "fixtures";
  seed: number;
  scale: string;
  generatedAt: string;
}

export function runFixtures(workspaceReal: string, args: FixturesArgs): FixturesReceipt {
  const receipt: FixturesReceipt = {
    verb: "fixtures",
    seed: args.seed,
    scale: args.scale,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(safeWritePath(workspaceReal, "fixtures-manifest.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
