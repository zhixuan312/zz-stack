// The written record matches the delivered surface, and nothing exceeds the ceiling.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import { trackedFiles } from "../scripts/gate/read.mjs";
const fail = [];

// ARCHITECTURE.md IS THE STANDARD, and there is no second document to concatenate.
//
// The plan offered a fallback — "or in its own root document with `ARCHITECTURE.md` pointing
// at it if the ceiling would otherwise break" — and Task I-35 did not take it: the standard
// went into ARCHITECTURE.md, which is 444 lines and well under the ceiling the fallback
// existed for. What was left behind was an `existsSync("PLUGIN-STANDARD.md")` and a clause
// guarded on its result, for a file this repository has never carried. So `standalone` was
// always "", the concatenation always added nothing, and the clause below it could not fire
// under any tree — a branch kept for a choice that was made.
const standard = readFileSync("ARCHITECTURE.md", "utf8");
for (const rule of ["produces", "documents", "libraries", "commands", "purpose"]) {
  if (!new RegExp(`\\b${rule}\\b`).test(standard)) fail.push(`the standard does not state ${rule}`);
}

// The 700-line ceiling, on every file this initiative writes or grows.
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist", "_versions"].includes(f) ? [] : walk(p)) : [p];
});

// EVERY ROOT DOCUMENT, DISCOVERED — not the two this check was written naming.
//
// STATE.md was 1309 lines when this check first ran, and the fix was to split it into
// HISTORY.md and HISTORY-PRE-0.23.md. A list naming STATE.md and ARCHITECTURE.md would have
// measured neither of the files the fix created, so the ceiling would have been enforced on
// the document that broke it and on nothing the repair produced. That is the shape of
// satisfiable-without-the-feature: the rule passes because the rule stopped looking.
//
// CHANGELOG.md IS THE ONE EXEMPTION, and it is the same one `deploy-release.mjs` already
// grants it for the same reason: it is an append-only transaction log, so a ceiling on it
// would be a standing instruction to rewrite history, which is the one thing a changelog must
// never have done to it. Every other root document describes the present and can be split.
//
// ASKED OF GIT, NOT OF THE DIRECTORY, because the question is "what does this repository
// carry", and `readdirSync` also answers for gitignored working material — which is not part
// of what anyone receives. `trackedFiles()` is tracked AND untracked-but-not-ignored, so a
// document written and not yet added is still measured; that is the case that matters here,
// since a split produces exactly such files.
const carried = trackedFiles();
const rootDocs = readdirSync(".")
  .filter((f) => f.endsWith(".md") && f !== "CHANGELOG.md" && (!carried || carried.has(f)))
  .sort();
const touched = [...rootDocs, ...walk("skills"), ...walk("scripts/gate/checks"), ...walk("checks")];
if (!rootDocs.includes("STATE.md") || !rootDocs.includes("ARCHITECTURE.md")) {
  fail.push("the root document discovery found neither STATE.md nor ARCHITECTURE.md — it is broken");
}
for (const p of touched) {
  if (!/\.(md|mjs|ts)$/.test(p)) continue;
  const n = readFileSync(p, "utf8").split("\n").length;
  if (n > 700) fail.push(`${p} is ${n} lines, over the 700 ceiling`);
}
// AC-3.7: the fit-for-purpose review is a real step in the only release procedure that exists.
const rel = readFileSync("scripts/release.mjs", "utf8");
if (!/fit[- ]for[- ]purpose|surface.*deliver.*purpose/i.test(rel)) {
  fail.push("release.mjs has no fit-for-purpose review step");
}
// And it is a step that STOPS — PROVEN BY RUNNING IT, not by reading it.
//
// A printed paragraph nobody has to answer is the decoration FR-23a names, so the attestation
// is what makes the pause real. The first spelling of this arm asked whether the file contained
// `die(` at all, and that is the vacuous shape: the module already dies twice for other reasons
// — no manifests, an unknown door — so deleting the ENTIRE `if (!attested)` refusal left the
// arm green. Measured, not imagined: the mutation was applied and this check passed it.
//
// So it is driven instead, in a subprocess, both ways. Unattested must exit nonzero and
// attested must exit zero; a step that refused always would be as broken as one that never did,
// and only the two-sided form can tell them apart.
const drive = (attested) => {
  const probe = `const m = await import("./scripts/release/fit-for-purpose.mjs"); m.fitForPurpose(${attested});`;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", probe], { stdio: "ignore" });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
};
if (!existsSync("scripts/release/fit-for-purpose.mjs")) {
  fail.push("scripts/release/fit-for-purpose.mjs is gone — the release has no fit-for-purpose step");
} else {
  if (drive(false) === 0) fail.push("the fit-for-purpose step does not stop a release nobody reviewed");
  if (drive(true) !== 0) fail.push("the fit-for-purpose step refuses a release that WAS reviewed");
}

// STATE.md puts unproven work in 6b, not 6.
//
// ANCHORED TO THE HEADING. `/6b/` over the whole file matched the sentence in STATE.md's
// header that PROMISES a §6b, so the section could have been deleted outright and this would
// still have passed — a check satisfied by the promise instead of by the thing.
const state = readFileSync("STATE.md", "utf8");
if (!/^## 6b\./m.test(state)) fail.push("STATE.md has no 6b section for what has not yet run in front of anyone");
// Control: zz-platform keeps its prose. A rewrite that replaced the law with a table
// would pass a check that only looked for the table.
const plat = readFileSync("skills/zz-platform/SKILL.md", "utf8");
if (plat.split("\n").length < 200) fail.push("zz-platform lost its prose; the law is not a table");
if (!/\|/.test(plat.split("\n").slice(0, 120).join("\n"))) fail.push("zz-platform has no state table near the top");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("docs current: ok");
