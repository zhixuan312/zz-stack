#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { requestDigest, idempotencyDecision } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/idempotency.js")).href);
const a = requestDigest({ b: 1, a: { y: 2, x: 1 }, idempotency_key: "k1" });
const b = requestDigest({ a: { x: 1, y: 2 }, b: 1, idempotency_key: "k2" });
assert.equal(a, b, "digest ignores key order and the idempotency key");
assert.match(a, /^[0-9a-f]{64}$/);
assert.notEqual(a, requestDigest({ a: { x: 1, y: 3 }, b: 1 }), "different payload, different digest");
assert.deepEqual(idempotencyDecision(null, a), { kind: "proceed" });
const row = { request_digest: a, result_table: "zz.candidate", result_id: "11111111-1111-1111-1111-111111111111" };
assert.deepEqual(idempotencyDecision(row, a), { kind: "replay", result_table: "zz.candidate", result_id: row.result_id });
assert.deepEqual(idempotencyDecision(row, requestDigest({ z: 1 })), { kind: "conflict" });
console.log("ok eval-idempotency");
