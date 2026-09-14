/**
 * The public shelf: that what is committed is what the catalog currently renders.
 *
 * `marketplace/` and `.claude-plugin/marketplace.json` are build output that has to live in
 * the repository, because `claude plugin marketplace add zhixuan312/zz-stack` clones this
 * tree and reads the files as they are. Build output under version control drifts the moment
 * someone edits a skill and does not re-run the build, and the drift is invisible: the shelf
 * keeps installing, it just installs last week's method.
 *
 * The tarball this replaced had the same disease with no way to catch it — a laptop still
 * holding the 0.23 package offers `zz-admin`, a plugin retired into `zz-access` at 0.24,
 * pointing at a door that stopped answering. Here the fix is one line of git.
 */
import { execFileSync } from "node:child_process";

import { root } from "../read.ts";
import { check } from "../run.ts";

check("the committed marketplace is what the catalog renders", () => {
  // REBUILT, then compared — not compared against a second renderer. A check that computed
  // the expected shelf its own way would be exactly the duplicate of `buildClientPackage`
  // that build-marketplace.mjs exists to avoid, and the two would eventually disagree about
  // which one is right.
  //
  // This writes to the working tree, deliberately. Regenerating is idempotent and the result
  // is the correct content, so a red gate leaves the fix already staged: commit it.
  try {
    execFileSync("node", ["scripts/build-marketplace.ts"], { cwd: root, stdio: "pipe" });
  } catch (err) {
    const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
    const stderr = e.stderr !== undefined && e.stderr !== null ? String(e.stderr).trim() : "";
    return `build-marketplace.mjs failed: ${stderr || String(e.message ?? err)}`;
  }

  // `status --porcelain`, not `diff`: a newly shipped plugin is an UNTRACKED directory, and
  // `git diff` says nothing about those — so the one case where the shelf gained something
  // would have passed silently.
  const dirty = execFileSync(
    "git", ["status", "--porcelain", "--", "marketplace", ".claude-plugin"],
    { cwd: root, encoding: "utf8" },
  ).trim();

  if (!dirty) return null;
  const lines = dirty.split("\n");
  return `the committed shelf is stale — it has been rebuilt, now commit it:\n      ` +
    lines.slice(0, 12).join("\n      ") +
    (lines.length > 12 ? `\n      … and ${lines.length - 12} more` : "");
});
