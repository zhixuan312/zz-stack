// A suite's output never escapes the machine that produced it — not into the lock, not into
// the package a person installs.
//
// THE DEFECT. `walkTree` in plugin-lock.ts had no exclusions, so it hashed `evals/results/` —
// gitignored, zero tracked files, one directory per local run — into the committed
// `plugins.lock.json`. The digest reproduced perfectly on the machine that wrote it and nowhere
// else. A fresh clone recomputed a different value and was told "CHANGED WITHOUT A VERSION BUMP
// — bump the version in its flow.json", which names the wrong cause: no version bump fixes a
// digest that depends on files git does not carry.
//
// This is the third thing in this initiative that was green for its author and red for everyone
// else, after checks registered but untracked and checks that passed while unregistered. The
// shared shape is worth stating: AN ARTIFACT IS ONLY AS TRUSTWORTHY AS THE INPUTS A FRESH CLONE
// CAN REPRODUCE. So this does not assert the exclusion by reading the source — it rebuilds the
// lock from a tree containing only tracked files and compares.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fail: string[] = [];
const tracked = (dir: string) => execFileSync("git", ["ls-files", dir], { encoding: "utf8" })
  .split("\n").filter(Boolean);

const scratch = mkdtempSync(join(tmpdir(), "zz-lock-"));
try {
  // Exactly what `git clone` would materialise for the baseline's eval suite.
  const evals = join(scratch, "evals");
  for (const f of tracked("evals")) {
    const rel = f.replace(/^evals\//, "");
    mkdirSync(join(evals, dirname(rel)), { recursive: true });
    cpSync(f, join(evals, rel));
  }

  const out = execFileSync("node", ["scripts/plugin-versions.ts"],
    { encoding: "utf8", env: { ...process.env, ZZ_EVALS_DIR: evals } });

  // `plugin-versions.ts` prints a state per plugin; anything but "unchanged" means the value in
  // the lock cannot be rebuilt from tracked inputs.
  for (const line of out.split("\n")) {
    const m = /^\s{2}(\S+)\s+\S+\s+\S+\s+\S+\s+(.*)$/.exec(line);
    if (!m || m[1] === "plugin") continue;
    const [, plugin, state] = m;
    if (!/^unchanged\s*$/.test(state)) {
      fail.push(`${plugin}: the committed lock cannot be rebuilt from git-tracked files alone — ` +
                `a fresh clone gets "${state.trim()}". The digest depends on something git does ` +
                `not carry.`);
    }
  }
  if (!/\bzz-core\b/.test(out)) fail.push("the rebuild found no zz-core — this check read nothing");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// ── AND THE PACKAGE DOES NOT CARRY IT EITHER ──────────────────────────────────────────────
//
// The exclusion above was applied to plugin-lock.ts and the matching walk in client-package.ts
// was left alone, so the hash stopped depending on `evals/results/` while the bytes kept
// shipping: the baseline plugin handed every installer one developer's local run output.
// Measured before the fix, on a tree with a single run in it — aggregate-result.json and
// report.html both travelled. That is 264KB of somebody else's afternoon in the real checkout,
// and `readFileSync(path, "utf8")` on a run's HTML and trace.jsonl ships mojibake besides.
//
// RUN, NOT READ. Asserting `f.name === OUTPUT_DIR` appears in the source would pass on the
// string sitting in a comment, and would say nothing about the walk that actually builds the
// package. This builds one from a tree that HAS a results directory and looks at what came out.
const pkgRoot = mkdtempSync(join(tmpdir(), "zz-pkg-"));
try {
  mkdirSync(join(pkgRoot, "evals", "a-case"), { recursive: true });
  writeFileSync(join(pkgRoot, "evals", "a-case", "case.yaml"), 'schema_version: "1.0"\nname: a-case\n');
  const run = join(pkgRoot, "evals", "results", "2026-09-13T11-02-43-258Z");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "aggregate-result.json"), '{"cases":[]}');
  writeFileSync(join(run, "report.html"), "<html></html>");
  mkdirSync(join(pkgRoot, "skills", "zz-platform"), { recursive: true });
  writeFileSync(join(pkgRoot, "skills", "zz-platform", "SKILL.md"),
                "---\nname: zz-platform\nversion: 1.0\n---\nbody\n");

  // Set BEFORE the import: client-package.ts and @zz/catalog both read their directory from the
  // environment once, at module load, so an assignment after the import would be ignored.
  process.env.ZZ_EVALS_DIR = join(pkgRoot, "evals");
  process.env.ZZ_SKILLS_DIR = join(pkgRoot, "skills");
  process.env.ZZ_CATALOG_DIR ??= join(process.cwd(), "catalog");
  const { buildClientPackage } = await import("../services/gateway/dist/client-package.js");
  const pkg = buildClientPackage({
    target: "https://example.test", base: "https://example.test", flows: [] });

  const shipped = pkg.files.map((f) => f.path);
  const leaked = shipped.filter((p) => /(^|\/)evals\/results\//.test(p));
  if (leaked.length) {
    fail.push(`the installed package carries ${leaked.length} file(s) of run output: ` +
              `${leaked.slice(0, 3).join(", ")}. A suite's output is not part of the suite.`);
  }
  // CONTROL: the suite itself must still travel. An exclusion that swallowed evals/ entirely
  // would pass the assertion above and ship a plugin with no cases, and the symptom arrives far
  // away — client-package.ts says an installed plugin with no evals/ below it turns a run into a
  // baseline-only one with no comparison in it at all.
  if (!shipped.some((p) => /evals\/a-case\/case\.yaml$/.test(p))) {
    fail.push("the package carries no eval case at all — the exclusion is too broad, and an " +
              "installed plugin with no suite runs baseline-only with nothing to compare");
  }
} finally {
  rmSync(pkgRoot, { recursive: true, force: true });
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("suite output stays home: lock reproducible, package clean");
