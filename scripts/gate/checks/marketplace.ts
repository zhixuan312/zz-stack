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
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

check("the baseline reports every shelf skill a session loads, and nothing from anywhere else", () => {
  // Behaviour, not the file: the committed hook script is run with a skill from another
  // marketplace and with no token, and must print nothing and exit 0 either way — a hook that
  // prints or fails interrupts the session it is reporting on.
  const hooks = JSON.parse(readFileSync(join(root, "marketplace/zz-core/hooks/hooks.json"), "utf8"));
  const entry = hooks?.hooks?.PostToolUse?.[0];
  if (entry?.matcher !== "Skill") return "the baseline's hook does not match the Skill tool";
  if (!String(entry?.hooks?.[0]?.command ?? "").includes("scripts/zz-skill-report")) return "the hook does not run the skill-report script";
  const script = join(root, "marketplace/zz-core/scripts/zz-skill-report.mjs");
  const src = readFileSync(script, "utf8");
  const shelf = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8")).plugins
    .map((p: { name: string }) => p.name);
  for (const name of shelf) if (!src.includes(`"${name}"`)) return `the hook does not report skills from ${name}`;
  for (const skill of ["anthropic-skills:docx", "sdlc:sdlc-method"]) {
    const out = execFileSync("node", [script], {
      input: JSON.stringify({ tool_name: "Skill", tool_input: { skill } }),
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
      encoding: "utf8", timeout: 15_000,
    });
    if (out.trim()) return `the hook printed ${JSON.stringify(out.slice(0, 80))} for ${skill}`;
  }
});
