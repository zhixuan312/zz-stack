#!/usr/bin/env node
// Release-review fixes (findings 6 and 11): a search generation is the search's own round —
// never composition depth — and maxCandidatesPerGeneration/maxGenerations bound it; a run whose
// search_policy is malformed or empty is refused, never validated with an invented mme of 0.
// Pure: search-rules.ts on values alone.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { parseSearchPolicy, searchGeneration, generationCapRefusal } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/search-rules.js")).href);

const policy = {
  maxGenerations: 2, maxCandidatesPerGeneration: 2, wallClockHours: 24, minRepeats: 3,
  minMeaningfulEffect: 0.05, confidence: 0.95, equivalenceBand: 0.1, complexity: "lines",
};

assert.deepEqual(parseSearchPolicy(policy, "run-1"), policy, "a complete policy parses as itself");
const empty = parseSearchPolicy({}, "run-1");
assert.match(empty.error, /run-1 carries no valid search_policy/, "an empty policy is refused, not defaulted");
assert.match(empty.error, /minMeaningfulEffect/, "the refusal names what is missing");

const m = (generation: number, validated: boolean, rejected = false) => ({ generation, validated, rejected });

assert.deepEqual(searchGeneration([]), { next: 0, nextCount: 0, validatedGenerations: 0, settled: true, current: 0 });
const unsettled = searchGeneration([m(0, true), m(0, false)]);
assert.equal(unsettled.next, 0, "an unsettled generation takes the next candidate");
assert.equal(unsettled.nextCount, 2);
const settled = searchGeneration([m(0, true), m(0, false, true)]);
assert.equal(settled.next, 1, "a generation where every candidate has a verdict or was rejected is settled");
assert.equal(settled.validatedGenerations, 1);
assert.equal(searchGeneration([m(0, false, true)]).validatedGenerations, 0,
  "a generation of rejections alone validates nothing");

assert.equal(generationCapRefusal(searchGeneration([m(0, false)]), policy), null, "room left in generation 0");
assert.match(generationCapRefusal(unsettled, policy), /already holds 2 candidates/,
  "a full, unsettled generation refuses another candidate");
assert.equal(generationCapRefusal(settled, policy), null, "a settled generation opens the next one");
assert.match(generationCapRefusal(searchGeneration([m(0, true), m(1, true)]), policy),
  /used all 2 generations/, "two validated, settled generations exhaust maxGenerations: 2");
assert.equal(generationCapRefusal(searchGeneration([m(0, true), m(1, false)]), policy), null,
  "the last generation may still fill while it is unsettled");

console.log("ok eval-search-rules");
