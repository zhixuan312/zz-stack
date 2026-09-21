import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root, trackedFiles } from "../read.ts";
import { check } from "../run.ts";

check("every critical check has been shown to fail on a planted defect", () => {
  const p = join(root, "testing/mutation-report.json");
  if (!existsSync(p)) return "testing/mutation-report.json is missing — no declared check has been shown able to fail";
  const rep = JSON.parse(readFileSync(p, "utf8")) as {
    results: Array<{ check: string; planted: string; replacements: number; failed: boolean }> };

  // `trackedFiles()` is declared `Set<string> | null` — a Set has no `.filter`, and the null
  // arm is "git could not be consulted", which by this repository's own rule is reported as
  // COULD NOT RUN rather than as a failure of the thing being checked. An earlier form of
  // this check called `.filter()` on it directly and did not typecheck.
  const tracked = trackedFiles();
  if (tracked === null) return "git could not be consulted, so this check could not run — it is not reporting that the checks are uncovered";
  const declared = [...tracked].filter((f) => f.startsWith("scripts/gate/checks/") && f.endsWith(".ts"));
  const covered = new Set(rep.results.map((r) => r.check));
  const uncovered = declared.filter((f) => !covered.has(f));
  if (uncovered.length) return `no mutation was planted against: ${uncovered.slice(0, 6).join(", ")}`;

  const bad: string[] = [];
  for (const r of rep.results) {
    if (r.replacements === 0) {
      bad.push(`${r.check}: the mutation never landed (0 replacements), so this run proves nothing about it`);
    } else if (!r.failed) {
      bad.push(`${r.check}: survived a planted defect, so it cannot detect the thing it describes`);
    }
  }
  return bad.length ? bad.slice(0, 8).join("; ") : undefined;
});
