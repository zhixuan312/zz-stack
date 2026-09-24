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
 * prefix. The check at the bottom of this file reads each file's own text and reports a
 * `gate-` prefix on a file that spawns nothing. */
export const runsCheck = (file: string) => (): string | null => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`.trim();
    return out.split("\n").filter((l) => l.trim()).join("; ").slice(0, 400)
      || `checks/${file} exited non-zero`;
  }
};

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
    return out.split("\n").filter((l) => /FAIL/.test(l)).join("; ").slice(0, 400)
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
