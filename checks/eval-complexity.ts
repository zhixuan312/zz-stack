#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { complexityDelta } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/complexity.js")).href);
assert.equal(complexityDelta({ lines_added: 30, lines_removed: 10, components_added: 1, components_removed: 0 }), 40);
assert.equal(complexityDelta({ lines_added: 0, lines_removed: 50, components_added: 0, components_removed: 1 }), -70, "pruning is negative");
assert.equal(complexityDelta({ lines_added: 0, lines_removed: 0, components_added: 0, components_removed: 0 }), 0);
console.log("ok eval-complexity");
