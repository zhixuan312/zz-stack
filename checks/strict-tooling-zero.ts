// The one type check of the tooling project — scripts/, checks/, testing/ and the shipped skill
// scripts under catalog/ — measured as one project, because a helper retyped in one subtree
// changes inference in another. The strict-*-dir checks scan each subtree for what the compiler
// accepts (`any`, a silenced error) and leave compiling to this one.
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const errors = out.split("\n").filter((l) => /error TS\d+:/.test(l));
if (errors.length) {
  // Counted by subtree first, so a red run says where the errors are before it lists them.
  const by = new Map<string, number>();
  for (const l of errors) {
    const where = /^(scripts\/gate|scripts|checks|testing|catalog)\//.exec(l)?.[1] ?? "elsewhere";
    by.set(where, (by.get(where) ?? 0) + 1);
  }
  console.error(`${errors.length} strict error(s) remain in the tooling project ` +
                `(${[...by].map(([d, n]) => `${d}/: ${n}`).join(", ")}):\n` + errors.slice(0, 30).join("\n"));
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`tsc exited ${r.status} while reporting no errors — the project is misconfigured, ` +
                `not clean:\n${out}`);
  process.exit(1);
}
