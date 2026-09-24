/**
 * The public shelf: that what is committed is what the catalog currently renders.
 *
 * `marketplace/` and `.claude-plugin/marketplace.json` are build output that has to live in
 * the repository, because `claude plugin marketplace add zhixuan312/zz-stack` clones this
 * tree and reads the files as they are. That drifts the moment someone edits a skill and does
 * not re-run the build, and the drift is invisible: the shelf keeps installing, it just
 * installs last week's method.
 */
import { execFileSync } from "node:child_process";

import { root } from "../read.ts";
import { check } from "../run.ts";

check("the committed marketplace is what the catalog renders", () => {
  // DELIBERATE: rebuilt through the real renderer and then compared, and it writes to the
  // working tree. Computing the expected shelf another way would duplicate
  // `buildClientPackage`. Regenerating is idempotent and the result is the correct content,
  // so a red gate leaves the fix in the tree: commit it.
  try {
    execFileSync("node", ["scripts/build-marketplace.ts"], { cwd: root, stdio: "pipe" });
  } catch (err) {
    const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
    const stderr = e.stderr !== undefined && e.stderr !== null ? String(e.stderr).trim() : "";
    return `build-marketplace.ts failed: ${stderr || String(e.message ?? err)}`;
  }

  // `status --porcelain`, not `diff`: a newly shipped plugin is an untracked directory, and
  // `git diff` says nothing about those.
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
