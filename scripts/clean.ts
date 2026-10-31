#!/usr/bin/env node
/**
 * Remove every build output: each workspace's dist/ and build info, and the tooling project's.
 *
 *   npm run clean            # this checkout
 *   node scripts/clean.ts <root>
 *
 * Not `tsc -b --clean`: that removes only what the current sources would emit, so the output of a
 * deleted source stays in dist/, and a check that still imports it passes here and fails on a
 * fresh clone. The workspaces are package.json's, each pattern a directory and `/*`.
 * checks/clean.ts holds it to that.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: string[] };

const dirs = workspaces.flatMap((pattern) => {
  const parent = join(root, pattern.replace(/\/\*$/, ""));
  return pattern.endsWith("/*") && existsSync(parent)
    ? readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(parent, d.name))
    : [join(root, pattern)];
});
for (const target of [...dirs.flatMap((d) => [join(d, "dist"), join(d, "tsconfig.tsbuildinfo")]),
                      join(root, "tsconfig.tooling.tsbuildinfo")]) {
  rmSync(target, { recursive: true, force: true });
}
console.log(`clean: ${dirs.length} workspace(s) cleared`);
