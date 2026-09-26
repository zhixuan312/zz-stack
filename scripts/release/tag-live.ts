/**
 * The tag a release could not write at the time. A release whose verification could not run
 * every probe goes live UNTAGGED and tells the operator to run `--verify-only` once the probes
 * can look; this is what that run owes once every probe has run and agreed.
 *
 * Only the version the host is running, and only when this checkout declares the same one: a
 * tag says "deployed and verified", and a version no longer live can no longer be verified. It
 * goes on the first commit on this branch that declares the version — the release's own merge,
 * not whatever tooling commit came after it. A tag already there is left alone; one elsewhere is
 * reported, never moved (the same rule as release.ts's tagOnce).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HOST, log, root, run, warn } from "../deployment.ts";

const declaredAt = (commit: string): string | null => {
  try { return (JSON.parse(run("git", ["show", `${commit}:package.json`], { cwd: root })) as { version?: string }).version ?? null; }
  catch { return null; }
};

export function tagVerifiedLive(live: string): void {
  const declared = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  if (live !== declared) {
    log(`  host runs ${live || "an unset ZZ_VERSION"}, this checkout declares ${declared} — nothing tagged`);
    return;
  }
  const name = `v${declared}`;
  let first: string | null = null;
  for (const c of run("git", ["log", "--first-parent", "--format=%H", "-n", "200"], { cwd: root }).split("\n").filter(Boolean)) {
    if (declaredAt(c) !== declared) break;
    first = c;
  }
  if (!first) { warn(`  no commit on this branch declares ${declared} — nothing tagged`); return; }
  const at = (() => { try { return run("git", ["rev-parse", `${name}^{commit}`], { cwd: root }); } catch { return null; } })();
  if (at === first) { log(`  ${name} already at ${first.slice(0, 7)} — left as it is`); return; }
  if (at) { warn(`  ${name} already points at ${at.slice(0, 7)}, not ${first.slice(0, 7)} — not moved`); return; }
  run("git", ["tag", "-a", name, first, "-m", `zz-stack ${declared}\n\nverified on ${HOST} by --verify-only, every probe run`], { cwd: root });
  run("git", ["push", "origin", name], { cwd: root });
  log(`  tagged zz-stack ${name} at ${first.slice(0, 7)}`);
}
