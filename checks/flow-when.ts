#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { documentApplies } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/flow-when.js")).href);
assert.equal(documentApplies({}, {}), "applies", "no predicate, always applies");
const imp = { when: { release_mode: "promotable" } };
assert.equal(documentApplies(imp, { release_mode: "promotable" }), "applies");
assert.equal(documentApplies(imp, { release_mode: "proposal_only" }), "not_applicable");
assert.equal(documentApplies(imp, {}), "undetermined");
const proto = { when: { protocol_action: ["create", "revise"] } };
assert.equal(documentApplies(proto, { protocol_action: "reuse" }), "not_applicable");
assert.equal(documentApplies(proto, { protocol_action: "revise" }), "applies");
const both = { when: { improvement_mode: "search", release_mode: "promotable" } };
assert.equal(documentApplies(both, { improvement_mode: "search", release_mode: "proposal_only" }), "not_applicable");
assert.equal(documentApplies(both, { improvement_mode: "search" }), "undetermined");
console.log("ok flow-when");
