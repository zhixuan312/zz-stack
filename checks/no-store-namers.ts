#!/usr/bin/env node
// The tree-wide negative I-41's check asserts too early: no tracked file may name the store's root
// or a `_versions/` path for a LIVE purpose. It is asserted here, at the task that does the moving,
// because I-41 cannot satisfy it and a check that cannot pass is a check nobody can use. The
// exemptions below are the files whose mention IS the record — a fixture that asserts a refusal
// keeps its fixture, and this check reads statements rather than prose.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "services", "packages", "scripts", "deploy"],
  { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/"));

// A mention counts only when it is CODE: a comment or a string about the past does not reach a
// store, and demanding their removal would be asking for a rewrite of the history.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const live = files.filter((f) => /\bARTIFACTS_DIR\b|_versions\//.test(code(readFileSync(f, "utf8"))));
assert.deepEqual(live, [], "no file reaches the store's root or its version directory");

// And the layer itself is gone, which is the half I-41's check asserts and this task makes true.
assert.ok(!files.includes("services/zz-core/src/persist.ts"), "the store layer is deleted");

console.log("ok no-store-namers");
