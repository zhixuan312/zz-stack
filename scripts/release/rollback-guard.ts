/**
 * Whether the deployment may be put back on an earlier release: which migrations this checkout
 * ships that the earlier release's tag never had, and which of them refuse to be rolled back
 * across, with each one's reason.
 *
 * Pure in the sense that matters to its callers: it reads git and the migrations directory and
 * nothing else — no `ssh`, no `die`, no output — so `--rollback`, release step 6 and
 * `checks/rollback-boundary.ts` all ask the same function, and asking it moves nothing. It never
 * throws: step 6 asks it outside its `try`, and a throw there would replace the verification
 * failures with a stack trace.
 *
 * Two reasons refuse:
 *
 *   - a migration that DECLARES it, with a header line `-- rollback: refused — <reason>`. What
 *     breaks an old writer — a new NOT NULL column, a new CHECK, a column whose meaning changed —
 *     is not reliably visible in DDL, so the migration that knows says so, and this reads it;
 *   - destructive DDL — a dropped column, table, type or schema, or a column whose type changed.
 *     The previous release's code still SELECTs what was dropped, and every request that resolves
 *     an identity then answers 500 while `/health` stays green, because /health resolves nobody.
 *
 * Deploying before verifying rests on being able to undo it. For a release carrying either, that
 * is false, so the callers say so and leave the new version running rather than performing a
 * rollback that makes the outage worse.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { root } from "../deployment.ts";

const MIGRATIONS = "services/gateway/migrations";

/** DDL that cannot be undone by putting the old image back. */
const IRREVERSIBLE = /\b(drop\s+(column|table|type|schema)|alter\s+column\s+\S+\s+type)\b/i;

/** A migration's own declaration that the release before it cannot run on what it builds. */
const DECLARED = /^--[ \t]*rollback:[ \t]*refused\b[ \t]*(?:—[ \t]*)?(.*?)[ \t]*$/m;

/** One migration that refuses a rollback across it, and why. */
export interface Refusal { file: string; reason: string }

/** The guard's answer: the refusals (none means the rollback may go ahead), or why it could not
 *  tell. */
export type Guarded = { refusals: Refusal[] } | { error: string };

const stderrOf = (err: unknown): string =>
  String((err as { stderr?: unknown })?.stderr ?? (err as Error)?.message ?? err).trim();

/**
 * Which migrations since release `version` (bare, `0.93.3`, as `ZZ_PREVIOUS_VERSION` stores it)
 * refuse a rollback to it.
 *
 * Asked of git rather than of the database: the question is what the target version's code knows
 * about, and its tag is what that code was. A version with no tag is an error, never "every
 * migration is new": an empty or a full list both claim to know what that version's code expects,
 * and without its tag nothing here does.
 */
export function rollbackGuard(version: string, repo: string = root): Guarded {
  const tag = `v${version}`;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
                 { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return { error: `no tag ${tag}` };
  }
  try {
    // DELIBERATE: the tree and a path filter, not `<tag>:<dir>`. A tag from before the gateway had
    // migrations has none, which is a true answer (every migration is new to it), not a failure.
    const then = new Set(execFileSync("git", ["ls-tree", "--name-only", tag, "--", `${MIGRATIONS}/`],
                                      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").map((l) => basename(l.trim())).filter(Boolean));
    const dir = join(repo, MIGRATIONS);
    const refusals: Refusal[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && !then.has(f)).sort()) {
      const text = readFileSync(join(dir, file), "utf8");
      const declared = DECLARED.exec(text);
      if (declared) refusals.push({ file, reason: declared[1] || "the migration declares it and gives no reason" });
      if (IRREVERSIBLE.test(text)) {
        refusals.push({ file, reason:
          `it drops something ${version}'s code still reads. Putting ${version} back would leave its code ` +
          "querying a column that no longer exists — the deployment would answer 500 to every caller while " +
          "/health stayed green. To go back you must first write a migration that restores what it dropped, " +
          "and decide what its values should be — which is a decision, not a rollback" });
      }
    }
    return { refusals };
  } catch (err) {
    return { error: `the migrations since ${tag} could not be read: ${stderrOf(err)}` };
  }
}

/**
 * What a refused rollback says, one line each: the verification failures it was asked after (step
 * 6 passes them; `--rollback` has none), then the guard's reasons or its error, then that `live`
 * is still running and the way out is forward. Empty when the guard permits the rollback.
 */
export function refusalLines(live: string, to: string, guard: Guarded, failures: string[] = []): string[] {
  if ("refusals" in guard && !guard.refusals.length) return [];
  const lines = failures.length
    ? [`${failures.length} verification failure(s):`, ...failures.map((f) => `  - ${f}`)]
    : [];
  if ("error" in guard) {
    lines.push(`rolling back to ${to} is refused: ${guard.error} — the guard cannot know what that ` +
               "version's code expects of this schema without its tag.");
  } else {
    lines.push(`rolling back to ${to} is refused — the migrations this release applied cannot be crossed backwards:`,
               ...guard.refusals.map((r) => `  - ${r.file}: ${r.reason}`));
  }
  lines.push(`${live} is STILL LIVE; fix forward. The deployment is LEFT AS IT IS, running the version ` +
             "that matches the schema: redeploy it, or a fix on top of it — the new image keeps writing what the " +
             "old one cannot.");
  return lines;
}
