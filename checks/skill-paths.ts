// Every skill path a script or a check names is a skill that is there, and the shelf builds.
//
// Gate checks hold `skills/<name>/SKILL.md` as a literal and throw ENOENT when it moves;
// `build-marketplace.ts` holds only the suffix and joins the rest, so no grep for the whole path
// finds it. Both shapes are covered by matching the suffix wherever it appears.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const fail: string[] = [];
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "marketplace", "results", "migrations", "runs"]);

const walk = (dir: string, out: string[] = []) => {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// The literal is read whole, from its opening quote, and resolved against the three bases these
// scripts actually join onto — the repository root, `catalog/` and `marketplace/`. Reading only the
// `skills/<name>/SKILL.md` tail reports a failure for every longer catalog path that resolves
// perfectly.
//
// A path that is a field rather than a file — `digest-per-plugin.ts` hashes an in-memory package
// whose `files[].path` is `skills/a/SKILL.md` — declares itself `SYNTHETIC:` on the line or the
// line above, the same convention `pre-rename-literals.ts` uses for `RAW NAME:`.
const BASES = ["", "catalog/", "marketplace/"];
const scripts = [...walk("scripts"), ...walk("checks")].filter((p) => /\.(ts|js)$/.test(p));
let literals = 0;
for (const p of scripts) {
  if (p === "checks/skill-paths.ts") continue;
  const lines = readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/["'`]((?:[A-Za-z0-9_.@-]+\/)*skills\/([a-z][a-z0-9-]*)\/SKILL\.md)/g)) {
      literals++;
      if (BASES.some((b) => existsSync(b + m[1]))) continue;
      if (/SYNTHETIC:/.test(lines[i]) || /SYNTHETIC:/.test(lines[i - 1] ?? "")) continue;
      fail.push(`${p}:${i + 1} reads ${m[1]}, which exists under none of ${BASES.map((b) => b || "<root>").join(", ")} — this throws rather than reporting. Mark the line \`SYNTHETIC:\` if it is a field and not a file.`);
    }
  }
}
if (literals < 5) fail.push(`only ${literals} skill-path literals were found in scripts/ and checks/; the scan's shape no longer matches the source it reads`);
// And the build, run. The marketplace renderer's assertion fires at build time as a thrown
// Error: nothing that reads source catches it, and a rename that misses it dies in the build
// with the shelf half-written.
try {
  execFileSync("node", ["scripts/build-marketplace.ts"], { stdio: "pipe", encoding: "utf8" });
} catch (err) {
  // The thrown message, not the tail of the stack: node prints the frame list last, so slicing
  // from the end reports `at file:///…` and buries the one sentence that says what is wrong.
  const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
  const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
  const message = typeof rec.message === "string" ? rec.message : String(err);
  const out = `${stderr}${stdout}`.trim() || message;
  fail.push(`the shelf does not build: ${out.split("\n").find((l) => /^Error:/.test(l.trim())) ?? out.split("\n").slice(0, 2).join(" ")}`);
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log(`skill paths: ok (${literals} skill-path literals)`);
