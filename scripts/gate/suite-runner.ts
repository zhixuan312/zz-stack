/**
 * How a check that lives in `checks/` is run, and where the registrations of them all are.
 *
 * WHY THESE MOVED OUT OF `suites.ts`. `check_sha256` in the mutation report is computed per
 * FILE, so every row hangs off the file that REGISTERED its check. suites.ts registered
 * ninety-six of them, which meant editing one line of it — a rename, a comment — drifted
 * ninety-four rows and cost a fifty-minute re-run to say nothing had changed about any of them.
 * The registrations are grouped by subject now, in `suites-*.ts`, and the helpers they share
 * live here so that splitting them further later costs nothing.
 *
 * IT SITS BESIDE read.ts AND run.ts, NOT IN checks/. It registers no check, and `declaredChecks`
 * — what the mutation report demands a row for — is every tracked file under `scripts/gate/checks/`.
 * A machinery module there would be demanded a row it can never have: a row names a target, a
 * target is a registered check, and this file registers none. One directory up is where the
 * gate's own machinery already lives.
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
 * WHY THIS EXISTS. Everything in `checks/` was invoked by hand and nothing else: the gate
 * registered three of them and the other forty-one ran only when somebody typed their name.
 * Five checks this initiative wrote were mutation-tested, reported green, and were never once
 * executed by `scripts/gate.ts` — so "the gate passes" and "the checks pass" were two
 * separate claims that sounded like one. A check nobody runs automatically is documentation.
 *
 * NOT EVERY FILE IN `checks/` BELONGS HERE. Three kinds live in that directory:
 *   - plain checks, which assert a property by reading or importing — these, registered below;
 *   - break-tests, which plant a defect and SPAWN `scripts/gate.ts` to prove it goes red —
 *     registering one of those here makes the gate invoke itself, forever;
 *   - host-dependent checks (`returns-sees-a-backtrack.ts` reaches the live database over
 *     ssh) — those belong to the release, which has a deployment to reach.
 *
 * SPAWNING THE GATE IS THE MARKER for the second kind, and the `gate-` prefix is a naming
 * convention over it rather than the test itself. This paragraph said the prefix WAS the
 * marker, and the file that would have caught an unwired check — `all-checks-wired.ts` —
 * spawns the gate and carries no prefix, so a rule reading the name would have registered it
 * and the gate would have invoked itself until something ran out. The check at the bottom of
 * this file reads the file's own text instead, and reports a `gate-` prefix on a file that
 * spawns nothing as the naming lie it is. */
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

/** The same, for the two checks in `checks/` written as bash rather than as a module.
 *
 * A SECOND HELPER RATHER THAN A FLAG ON THE FIRST, because what differs is the interpreter and
 * nothing else, and `runsCheck(file, { shell: true })` is a parameter every future reader has
 * to go and look up. Both scripts print `FAIL:` lines and exit non-zero, exactly as the .mjs
 * checks do, so the failure text needs no separate handling. */
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
 * THEY USED TO READ `suites.ts` BY NAME, and that was correct while one file held every
 * registration. It does not any more, and a rule that went on reading that one file would have
 * reported eighty-five correctly registered checks as unwired — or, had it been written with
 * `includes` instead of a match, said nothing at all and left the directory unwatched, which is
 * the failure this repository has now met twice in one day.
 *
 * EVERY MODULE, NOT THE ONES WHOSE NAME LOOKS RIGHT. Filtering on `suites-*` would make the
 * rule depend on a naming convention nothing enforces; filtering on "does it call runsCheck"
 * would exclude `suites.ts`, which registers three checks through a bare execFileSync naming
 * `checks/<file>` and would silently stop being read. The whole directory is cheap, complete,
 * and needs nothing from whoever adds the next module.
 *
 * RAW, NEVER STRIPPED. One of the two rules strips comments before matching and the other does
 * not, each for a reason written where it is. Stripping here would take that choice away from
 * them.
 */
export function suiteSources(): string {
  return readdirSync(join(root, "scripts/gate/checks")).filter((f) => f.endsWith(".ts")).sort()
    .map((f) => readFileSync(join(root, "scripts/gate/checks", f), "utf8")).join("\n");
}
