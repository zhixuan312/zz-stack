// A recorded run is READABLE: both arms, a computable delta, and no invented cost.
import { readFileSync, existsSync } from "node:fs";

interface Arm { error?: string }
interface CaseRun {
  name: string;
  arms?: Record<string, Arm[]>;
  aggregates?: { delta?: number | null; score?: number | null; scoreWithout?: number | null };
}
interface RunPayload { partial?: boolean; partialReason?: string; cases?: CaseRun[]; costUsd?: number }

const fail: string[] = [];
const runs = ["zz-core", "sdlc", "zz-access", "zz-plugin-eval"]
  .map((p) => [p, `evals/results/latest/${p}.json`]);

for (const [plugin, path] of runs) {
  if (!existsSync(path)) { fail.push(`${plugin}: no recorded run at ${path}`); continue; }
  const d: RunPayload = JSON.parse(readFileSync(path, "utf8"));
  if (d.partial) fail.push(`${plugin}: run is partial (${d.partialReason}) — repeat it`);

  const readable = (d.cases || []).filter((c) => {
    const withArm = c.arms?.with?.length, without = c.arms?.without?.length;
    const delta = c.aggregates?.delta ?? null;
    const both = c.aggregates?.score != null && c.aggregates?.scoreWithout != null;
    return withArm && without && (delta !== null || both);
  });
  if (!readable.length) {
    fail.push(`${plugin}: no case carries both arms and a computable delta — exit status is not enough`);
  }
  // Every run erroring is a failure of the run, not a low score.
  const all = (d.cases || []).flatMap((c) => Object.values(c.arms || {}).flat());
  if (all.length && all.every((r) => r.error)) fail.push(`${plugin}: every run errored`);
  // Cost is read from the payload, never invented.
  if (typeof d.costUsd !== "number") fail.push(`${plugin}: no costUsd recorded`);
  // Control: each case appears once. Two entries of one name means both trees were swept.
  const names = (d.cases || []).map((c) => c.name);
  if (new Set(names).size !== names.length) fail.push(`${plugin}: a case was discovered twice`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval readable: ok");
