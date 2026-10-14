#!/usr/bin/env node
// The one classification of a call's origin, asked of the built contracts package.
// Run from the repository root after `npm run build`.
import assert from "node:assert/strict";
import { eventOrigin, PLATFORM_CLIENTS } from "../packages/contracts/dist/index.js";

assert.deepEqual([...PLATFORM_CLIENTS].sort(), ["chain-check", "zz-doctor", "zz-migrate"]);

const platform = [
  "chain-check", "zz-migrate", "zz-doctor",
  "zz-doctor/0.96.0", "ZZ-Doctor/0.96.0", "Chain-Check 1.2", "zz-migrate/1 (darwin)", "ZZ-MIGRATE",
];
for (const name of platform) assert.equal(eventOrigin(name), "platform", `${name} is maintenance`);

const work = [
  "zz-plugin", "zz-plugin/0.96.0", "zz-update", "zz-hook", "call", "smoke", "provision",
  "my-zz-doctor", "zz-doctor-helper", "zz_doctor", " zz-doctor", "zz-doctor\t1", "", "/", " ",
];
for (const name of work) assert.equal(eventOrigin(name), "work", `${JSON.stringify(name)} is work`);

assert.equal(eventOrigin(undefined), "work", "a missing header is work");
assert.equal(eventOrigin(null), "work", "a null client is work");
console.log("ok event-origin");
