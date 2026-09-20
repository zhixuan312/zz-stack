/**
 * benchmark.ts — the `benchmark` verb, run against either the `baseline` or the `acceptance`
 * profile. As with `baseline.ts`, what a benchmark actually measures belongs to a later
 * task's contract; this records that the verb ran, at which profile, into the workspace.
 */
import { writeFileSync } from "node:fs";

import { safeWritePath } from "./workspace.ts";

export type BenchmarkProfile = "baseline" | "acceptance";

interface BenchmarkReceipt {
  verb: "benchmark";
  profile: BenchmarkProfile;
  ranAt: string;
}

export function runBenchmark(workspaceReal: string, profile: BenchmarkProfile): BenchmarkReceipt {
  const receipt: BenchmarkReceipt = { verb: "benchmark", profile, ranAt: new Date().toISOString() };
  writeFileSync(
    safeWritePath(workspaceReal, `benchmark-${profile}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  return receipt;
}
