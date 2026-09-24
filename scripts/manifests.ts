/**
 * Every package manifest in this repo, discovered from the workspace declaration rather than
 * listed. The release (set-version.ts) and the gate (gate/facts.ts, gate/checks/image.ts)
 * read the same list, so a new package under packages/ or services/ is picked up by both
 * without an edit here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative paths of every package.json, root first. */
export function manifestPaths(root: string): string[] {
  const out = ["package.json"];
  const globs: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  // DELIBERATE: only the one shape this repo's workspaces use — "<dir>/*". Any other layout
  // is unsupported rather than guessed at.
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
