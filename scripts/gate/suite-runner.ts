/**
 * How a check that lives in `checks/` is run, and the helpers the `suites-*.ts` registration
 * modules share.
 *
 * DELIBERATE: this module sits beside read.ts and run.ts, not in `checks/`. Everything under
 * `scripts/gate/checks/` registers checks, and this file registers none.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { root, unbuilt } from "./read.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. Here it is an `execFileSync` failure, which carries `stdout`/`stderr`
 *  rather than a plain `message`. */
export function execFields(err: unknown): { stdout: string; stderr: string } {
  const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return { stdout: e.stdout !== undefined ? String(e.stdout) : "", stderr: e.stderr !== undefined ? String(e.stderr) : "" };
}

/** Run a check that lives in `checks/`, the same way `runsClean` runs one that lives in dist.
 *
 * Three kinds of file live in that directory and only the first is registered here:
 *   - plain checks, which assert a property by reading or importing;
 *   - break-tests, which plant a defect and spawn `scripts/gate.ts` to prove it goes red —
 *     registering one here makes the gate invoke itself, forever;
 *   - host-dependent checks, which reach the live deployment and belong to the release.
 *
 * DELIBERATE: spawning the gate is the marker for the second kind, not the `gate-` prefix,
 * which is a naming convention over it. `all-checks-wired.ts` spawns the gate and carries no
 * prefix. The check in `suites.ts` that every file in checks/ is registered reads each file's own
 * text and reports a `gate-` prefix on a file that spawns nothing. */
export const runsCheck = (file: string) => (): string | null => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    return failureDetail(execFields(err).stderr, execFields(err).stdout) || `checks/${file} exited non-zero`;
  }
};

/** What a failed check printed, as the gate reports it: one line, its end kept, and the line that
 *  says why it failed at that end.
 *
 *  DELIBERATE: the reason line is moved last, because no order of the two streams keeps it. A check
 *  that starts a real zz-core prints its cases on stdout, and its `FAILED at` line on stderr with
 *  zz-core's boot log after it (scripts/schema/throwaway-core.ts). Stdout last, gate 4838 reported
 *  only passing cases; stderr last, gate 4590 reported only zz-core's plugin_version warnings. */
export function failureDetail(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`.split("\n").filter((l) => l.trim());
  const why = lines.filter((l) => /\bFAILED\b|^\s*FAIL:/.test(l));
  return tailOf([...lines.filter((l) => !why.includes(l)), ...why].join("; "));
}

/** The end of a failure's output, not the beginning, and why this is not a style choice.
 *
 * A check prints each case as it goes and names the one that failed — or throws — after them, so
 * its reason is the LAST thing it says. A head-slice of a long output therefore keeps a column of
 * case-by-case "ok"s and drops the one line that says what went wrong. That is not hypothetical:
 * two gate runs here failed on checks whose entire reported detail was passing cases, with the
 * cause cut off at 400 characters, and each had to be run by hand to be diagnosed at all. A
 * truncated tail is worth more than a complete-looking head — the leading `…` says the rest is
 * above it, where the cases are. */
const tailOf = (said: string): string => (said.length > 400 ? `…${said.slice(-400)}` : said);

/** The same, for the checks in `checks/` written as bash rather than as a module. Both print
 * `FAIL:` lines and exit non-zero as the module checks do, so the failure text needs no
 * separate handling.
 *
 * DELIBERATE: a second helper rather than a flag on the first — only the interpreter
 * differs. */
export const runsShell = (file: string) => (): string | null => {
  try {
    execFileSync("bash", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`.trim();
    return tailOf(out.split("\n").filter((l) => /FAIL/.test(l)).join("; "))
      || `checks/${file} exited non-zero`;
  }
};

/**
 * Every gate module, as one text — what the two rules about registration read.
 *
 * DELIBERATE: the whole directory, not the modules whose name looks right. Filtering on
 * `suites-*` depends on a naming convention nothing enforces, and filtering on "calls
 * runsCheck" excludes `suites.ts`, which registers through a bare execFileSync.
 *
 * DELIBERATE: raw, never stripped. One of the two rules strips comments before matching and
 * the other does not; stripping here takes that choice away from them.
 */
export function suiteSources(): string {
  return readdirSync(join(root, "scripts/gate/checks")).filter((f) => f.endsWith(".ts")).sort()
    .map((f) => readFileSync(join(root, "scripts/gate/checks", f), "utf8")).join("\n");
}
