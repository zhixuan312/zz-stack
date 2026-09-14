/**
 * Every package manifest in this repo, discovered rather than listed.
 *
 * There were two hardcoded copies of this list — one in set-version.mjs, exported and
 * imported by nobody, and a second in gate.mjs. Both happened to be complete, and neither
 * could stay that way on its own: a new package under packages/ or services/ would have
 * kept its old version through a release while the gate confirmed everything was in step,
 * because the gate was reading the same stale list the release wrote.
 *
 * A workspace already declares where its packages live. Reading that is the only version of
 * this list that cannot fall behind.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative paths of every package.json, root first. */
export function manifestPaths(root: string): string[] {
  const out = ["package.json"];
  const globs: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  // Only the one shape this repo's workspaces use — "<dir>/*". Anything else is a
  // workspace layout nobody here has adopted, and guessing at it would be inventing a
  // requirement rather than reading one.
  for (const glob of globs) {
    const m = /^([^*]+)\/\*$/.exec(glob);
    if (!m) throw new Error(`unsupported workspace pattern in package.json: ${glob}`);
    const dir = join(root, m[1]);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const rel = `${m[1]}/${d.name}/package.json`;
      if (existsSync(join(root, rel))) out.push(rel);
    }
  }
  return out;
}
