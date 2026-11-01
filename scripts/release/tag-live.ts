/**
 * The tag a release could not write at the time. A release whose verification could not run
 * every probe goes live UNTAGGED and tells the operator to run `--verify-only` once the probes
 * can look; this is what that run owes once every probe has run and agreed.
 *
 * Only the version the host is running, and only when this checkout declares the same one: a
 * tag says "deployed and verified", and a version no longer live can no longer be verified. It
 * goes on the first commit on this branch that declares the version — the release's own merge,
 * not whatever tooling commit came after it. A tag already there is kept and pushed again, so a
 * push an earlier run lost is finished; one elsewhere is reported, never moved (release/tag.ts, the
 * same rule as release.ts's tagOnce). Once the tag is where it belongs,
 * written now or by an earlier run, it records the release in `zz.release`, as the release itself does
 * after its own tag, and returns what the record found wrong: the tag stands either way. So a rerun of
 * `--verify-only` also writes a row an earlier run could not; a row already there is left as it is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HOST, log, root, run, warn } from "../deployment.ts";
import { recordAfterTag } from "../release-record.ts";
import { regSql } from "./registries.ts";
import { placeTag } from "./tag.ts";

const declaredAt = (commit: string): string | null => {
  try { return (JSON.parse(run("git", ["show", `${commit}:package.json`], { cwd: root })) as { version?: string }).version ?? null; }
  catch { return null; }
};

export async function tagVerifiedLive(live: string): Promise<string[]> {
  const declared = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  if (live !== declared) {
    log(`  host runs ${live || "an unset ZZ_VERSION"}, this checkout declares ${declared} — nothing tagged`);
    return [];
  }
  const name = `v${declared}`;
  let first: string | null = null;
  for (const c of run("git", ["log", "--first-parent", "--format=%H", "-n", "200"], { cwd: root }).split("\n").filter(Boolean)) {
    if (declaredAt(c) !== declared) break;
    first = c;
  }
  if (!first) { warn(`  no commit on this branch declares ${declared} — nothing tagged`); return []; }
  const placed = placeTag(root, name, first, `zz-stack ${declared}\n\nverified on ${HOST} by --verify-only, every probe run`);
  if ("elsewhere" in placed) {
    warn(`  ${name} already points at ${placed.elsewhere.slice(0, 7)}, not ${first.slice(0, 7)} — not moved`);
    return [];
  }
  log(placed.wrote ? `  tagged zz-stack ${name} at ${first.slice(0, 7)}` : `  ${name} already at ${first.slice(0, 7)} — kept, and on origin`);
  return recordAfterTag(declared, regSql);
}
