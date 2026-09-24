#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { assignSplits, minimumsMet } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/split.js")).href);
const policy = { evolve: 0.4, validation: 0.3, proof: 0.3, min: { evolve: 5, validation: 10, proof: 10 } };
const cases = Array.from({ length: 40 }, (_, i) => ({ case_digest: `c${i}`, replayable: i !== 7 }));
const a = assignSplits(cases, "seed-1", policy);
assert.equal(a.get("c7"), null, "not_replayable gets no split");
const n = 39, count = (s: string) => [...a.values()].filter((v) => v === s).length;
assert.equal(count("evolve"), Math.floor(0.4 * n)); assert.equal(count("validation"), Math.floor(0.3 * n));
assert.equal(count("proof"), n - Math.floor(0.4 * n) - Math.floor(0.3 * n));
const order = cases.filter((c) => c.replayable).map((c) => c.case_digest)
  .sort((x, y) => createHash("sha256").update("seed-1" + x).digest("hex").localeCompare(createHash("sha256").update("seed-1" + y).digest("hex")));
assert.equal(a.get(order[0]), "evolve"); assert.equal(a.get(order[order.length - 1]), "proof");
assert.deepEqual([...assignSplits(cases, "seed-1", policy)], [...a], "stable for a seed");
assert.equal(minimumsMet({ evolve: 15, validation: 11, proof: 13 }, policy), true);
assert.equal(minimumsMet({ evolve: 15, validation: 11, proof: 9 }, policy), false);
console.log("ok eval-replay-split");
