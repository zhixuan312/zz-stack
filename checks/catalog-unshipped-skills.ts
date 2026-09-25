#!/usr/bin/env node
// Round-6 review: pluginDirComponents' `unshipped` argument leaves a directory of that name out at
// any depth, so a fixture SKILL.md under `tests` is not a component of a catalog capture — whether
// the plugin keeps its skills under `skills/` or at its own root.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { IMAGE_UNSHIPPED, pluginDirComponents } =
  await import(pathToFileURL(join(process.cwd(), "packages/catalog/dist/index.js")).href);

const skill = (path: string, name: string) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\n---\n${name}\n`);
};
const names = (dir: string, unshipped?: string) => {
  const got = pluginDirComponents(dir, unshipped);
  assert.ok(!("error" in got), JSON.stringify(got));
  return got.components.map((c: { name: string }) => c.name).sort();
};

const dir = mkdtempSync(join(tmpdir(), "zz-unshipped-check-"));
try {
  const atRoot = join(dir, "at-root");
  skill(join(atRoot, "greet"), "greet");
  skill(join(atRoot, IMAGE_UNSHIPPED, "case"), "case");
  assert.deepEqual(names(atRoot), ["case", "greet"], "without unshipped, a tests fixture is walked");
  assert.deepEqual(names(atRoot, IMAGE_UNSHIPPED), ["greet"], "with unshipped, it is left out");

  const underSkills = join(dir, "under-skills");
  skill(join(underSkills, "skills", "greet"), "greet");
  skill(join(underSkills, "skills", "greet", IMAGE_UNSHIPPED, "fixture"), "fixture");
  assert.deepEqual(names(underSkills), ["fixture", "greet"]);
  assert.deepEqual(names(underSkills, IMAGE_UNSHIPPED), ["greet"], "left out at any depth under skills/");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("catalog-unshipped-skills: a tests fixture SKILL.md is not a component when tests is unshipped");
