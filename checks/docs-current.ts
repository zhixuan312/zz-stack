// The written record matches the delivered surface, and nothing exceeds the ceiling.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import { trackedFiles } from "../scripts/gate/read.ts";
const fail: string[] = [];

// ARCHITECTURE.md is the standard, and there is no second document to concatenate.
const standard = readFileSync("ARCHITECTURE.md", "utf8");
for (const rule of ["produces", "documents", "libraries", "commands", "purpose"]) {
  if (!new RegExp(`\\b${rule}\\b`).test(standard)) fail.push(`the standard does not state ${rule}`);
}

// The 700-line ceiling, on the root documents, the skills and the checks.
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});

// Every root document, discovered rather than listed, so a document split in two is measured
// on both halves.
//
// DELIBERATE: CHANGELOG.md is the one exemption, as it is in `deploy-release.ts`. It is an
// append-only transaction log, so a ceiling on it would be an instruction to rewrite history.
//
// Asked of git, not of the directory: `readdirSync` also answers for gitignored working
// material. `trackedFiles()` is tracked and untracked-but-not-ignored, so a document written
// and not yet added is still measured — which is what a split produces.
const carried = trackedFiles();
const rootDocs = readdirSync(".")
  .filter((f) => f.endsWith(".md") && f !== "CHANGELOG.md" && (!carried || carried.has(f)))
  .sort();
const touched = [...rootDocs, ...walk("skills"), ...walk("scripts/gate/checks"), ...walk("checks")];
// A discovery that finds nothing passes for the wrong reason, so it is asserted against the
// two root documents that must always be there.
if (!rootDocs.includes("README.md") || !rootDocs.includes("ARCHITECTURE.md")) {
  fail.push("the root document discovery found neither README.md nor ARCHITECTURE.md — it is broken");
}
for (const p of touched) {
  if (!/\.(md|mjs|ts)$/.test(p)) continue;
  const n = readFileSync(p, "utf8").split("\n").length;
  if (n > 700) fail.push(`${p} is ${n} lines, over the 700 ceiling`);
}
// The fit-for-purpose review is a real step in the only release procedure that exists.
const rel = readFileSync("scripts/release.ts", "utf8");
if (!/fit[- ]for[- ]purpose|surface.*deliver.*purpose/i.test(rel)) {
  fail.push("release.ts has no fit-for-purpose review step");
}
// And it is a step that stops, proven by running it rather than by reading it: the module
// already dies for other reasons, so a check for `die(` in the source passes with the
// attestation refusal deleted.
//
// Driven in a subprocess both ways. Unattested must exit nonzero and attested must exit zero;
// a step that refused always would be as broken as one that never did.
/** node:child_process throws an object carrying a numeric exit code, never an Error. Narrow
 *  at the boundary rather than assume the shape. */
function errStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as Record<string, unknown>).status;
    if (typeof s === "number") return s;
  }
  return 1;
}
const drive = (attested: boolean) => {
  const probe = `const m = await import("./scripts/release/fit-for-purpose.ts"); m.fitForPurpose(${attested});`;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], { stdio: "ignore" });
    return 0;
  } catch (err) {
    return errStatus(err);
  }
};
if (!existsSync("scripts/release/fit-for-purpose.ts")) {
  fail.push("scripts/release/fit-for-purpose.ts is gone — the release has no fit-for-purpose step");
} else {
  if (drive(false) === 0) fail.push("the fit-for-purpose step does not stop a release nobody reviewed");
  if (drive(true) !== 0) fail.push("the fit-for-purpose step refuses a release that WAS reviewed");
}

// Control: zz-platform keeps its prose. A rewrite that replaced the law with a table would
// pass a check that only looked for the table.
const plat = readFileSync("skills/zz-platform/SKILL.md", "utf8");
if (plat.split("\n").length < 200) fail.push("zz-platform lost its prose; the law is not a table");
if (!/\|/.test(plat.split("\n").slice(0, 120).join("\n"))) fail.push("zz-platform has no state table near the top");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("docs current: ok");
