// The committed lock is reproducible from what git carries, and nothing else.
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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fail = [];
const tracked = (dir) => execFileSync("git", ["ls-files", dir], { encoding: "utf8" })
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

  const out = execFileSync("node", ["scripts/plugin-versions.mjs"],
    { encoding: "utf8", env: { ...process.env, ZZ_EVALS_DIR: evals } });

  // `plugin-versions.mjs` prints a state per plugin; anything but "unchanged" means the value in
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

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("lock reproducible: ok");
