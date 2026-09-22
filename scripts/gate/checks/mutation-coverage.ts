import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { root, trackedFiles } from "../read.ts";
import { check } from "../run.ts";

check("every critical check has been shown to fail on a planted defect", () => {
  const p = join(root, "testing/mutation-report.json");
  if (!existsSync(p)) return "testing/mutation-report.json is missing — no declared check has been shown able to fail";
  const rep = JSON.parse(readFileSync(p, "utf8")) as {
    results: Array<{ check: string; planted: string; replacements: number; failed: boolean;
                     baseline_red?: boolean; target?: string }> };

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
    } else if (r.baseline_red) {
      // A THIRD OUTCOME, AND IT IS NOT "SURVIVED". When the row's own target was ALREADY
      // failing before anything was planted, `new_failures` cannot contain it, so `failed`
      // comes back false and the row reads exactly like a check that shrugged off a defect.
      // It is not. Nothing was measured: the experiment had no baseline to move from.
      //
      // The distinction is the whole value of the message. "This check is weak" sends a
      // reader to rewrite a check that may be fine; "your spec turned the gate red before it
      // ran" sends them to the spec. A spec file is tracked TypeScript and this repository
      // sweeps tracked files, so a literal payload — an import line, a credential shape, a
      // sentence counting the platform's own tools — makes the gate red at baseline and takes
      // every row in the batch down with it, all of them wearing `failed: false`.
      bad.push(`${r.check}: its target was ALREADY RED at baseline, so this row measured ` +
               `nothing — the defect is in the run, not in the check. Find what turned the ` +
               `gate red before the mutation landed (a spec's own payload is the usual cause) ` +
               `and re-run that row.`);
    } else if (!r.failed) {
      bad.push(`${r.check}: survived a planted defect, so it cannot detect the thing it describes`);
    }
  }
  return bad.length ? bad.slice(0, 8).join("; ") : undefined;
});
