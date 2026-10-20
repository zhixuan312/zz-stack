#!/usr/bin/env node
// A tree-wide negative: no tracked TypeScript file under services, packages, scripts or deploy names
// the store's root or a `_versions/` path outside a comment, and none is exempt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "services", "packages", "scripts", "deploy"],
  { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/") && existsSync(f));

// A mention counts only outside a comment: a comment about the past does not reach a store. A string
// does count, since a path in a string is how code reaches one.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const live = files.filter((f) => /\bARTIFACTS_DIR\b|_versions\//.test(code(readFileSync(f, "utf8"))));
assert.deepEqual(live, [], "no file reaches the store's root or its version directory");

// And the layer itself is gone.
assert.ok(!files.includes("services/zz-core/src/persist.ts"), "the store layer is deleted");

console.log("ok no-store-namers");
