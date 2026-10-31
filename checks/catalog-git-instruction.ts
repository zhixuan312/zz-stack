#!/usr/bin/env node
/**
 * `gitInstruction` (@zz/catalog) reads a `.gitattributes` the way git does: a `#` line is a
 * comment, the first field is the pattern, and only an attribute field naming `filter` assigns
 * one. And `pluginDirComponents` never walks into a clone's own `.git`, as `pluginTreeDigest`
 * does not.
 *
 * Reads the built `packages/catalog/dist`. No Docker, no network.
 * Run: node checks/catalog-git-instruction.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { gitInstruction, pluginDirComponents } = await import(
  pathToFileURL(join(process.cwd(), "packages/catalog/dist/index.js")).href);

const scratch = mkdtempSync(join(tmpdir(), "zz-git-instruction-"));
try {
  const verdict = (attributes: string): string | null => {
    const dir = mkdtempSync(join(scratch, "tree-"));
    writeFileSync(join(dir, ".gitattributes"), attributes);
    return gitInstruction(dir);
  };
  const assigns = /\.gitattributes assigns a git filter/;

  for (const text of ["*.md filter=lfs\n", "* -filter\n", "*.bin !filter\n", "[attr]big filter=lfs diff=lfs\n",
                      "  *.md   text   filter=x\n"]) {
    assert.match(verdict(text) ?? "", assigns, `${JSON.stringify(text)} assigns a filter and was not refused`);
  }
  for (const text of ["# no filter here\n*.png binary\n", "   # filter=lfs\n", "filter -text\n",
                      "*.txt text eol=lf\n", "*.c diff=cpp filtered\n"]) {
    assert.equal(verdict(text), null, `${JSON.stringify(text)} assigns no filter and was refused`);
  }

  // A clone with no top-level skills/ walks from its root: its .git holds no component.
  const clone = join(scratch, "clone");
  mkdirSync(join(clone, ".git", "skills", "planted"), { recursive: true });
  writeFileSync(join(clone, ".git", "skills", "planted", "SKILL.md"), "---\nname: planted\n---\n");
  mkdirSync(join(clone, "real"), { recursive: true });
  writeFileSync(join(clone, "real", "SKILL.md"), "---\nname: real\n---\n");
  const got = pluginDirComponents(clone);
  assert.ok(!("error" in got && got.error), `pluginDirComponents refused the clone: ${JSON.stringify(got)}`);
  const names = (got.components as { kind: string; name: string }[]).filter((c) => c.kind === "skill").map((c) => c.name);
  assert.deepEqual(names, ["real"], `the walk read a SKILL.md inside .git: ${names.join(", ")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log("catalog-git-instruction: a .gitattributes comment or pattern is not a filter, and a clone's .git holds no component: ok");
