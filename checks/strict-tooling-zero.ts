// The whole-project assertion. The per-subtree checks can all pass while this fails, because
// a helper retyped in one subtree changes inference in another.
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.tooling.json"], { encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
const errors = out.split("\n").filter((l) => /error TS\d+:/.test(l));
if (errors.length) {
  console.error(`${errors.length} strict error(s) remain in the tooling project ` +
                `(was 909 before the conversion):\n` + errors.slice(0, 30).join("\n"));
  process.exit(1);
}
if (r.status !== 0) {
  console.error(`tsc exited ${r.status} while reporting no errors — the project is misconfigured, ` +
                `not clean:\n${out}`);
  process.exit(1);
}
