#!/usr/bin/env node
// A waiver covers exactly its own step's unmet rule of its own kind (withWaivers,
// services/zz-core/src/host/store.ts). It used to match by substring on the kind alone, so a
// waiver of kind `spec` covered an audit gap "about a recorded spec", kind `review` covered a
// `review_approval` gap, and a waiver signed for one step discharged another step's same-kind gap.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

delete process.env.TEAM_DB_URL;
const { withWaivers } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/host/store.js")).href);

const waiver = (step_id: string, kind: string) => ({ step_id, kind, ground: "accepted", recorded_by: "person@example.test" });
const verdict = (...unmet: string[]) => ({ satisfied: unmet.length === 0, unmet });

// The exact sentence, with and without its `about` tail: covered.
{
  const s = withWaivers(verdict("review needs 1 audit"), [waiver("review", "audit")]);
  assert.equal(s.clear, true);
  assert.equal(s.dischargedBy.length, 1);
  assert.equal(withWaivers(verdict("review needs 2 audit about a recorded spec"), [waiver("review", "audit")]).clear, true);
}

// A kind that only appears in the `about` tail: not covered.
{
  const s = withWaivers(verdict("review needs 1 audit about a recorded spec"), [waiver("review", "spec")]);
  assert.equal(s.clear, false, "a waiver of kind spec covers no audit gap");
  assert.deepEqual(s.dischargedBy, []);
}

// A kind that is a prefix or substring of another kind: not covered.
assert.equal(withWaivers(verdict("ship needs 1 review_approval"), [waiver("ship", "review")]).clear, false);
assert.equal(withWaivers(verdict("ship needs 1 review"), [waiver("ship", "view")]).clear, false);

// Another step's waiver, even of the same kind: not covered — nor a step whose id merely prefixes.
assert.equal(withWaivers(verdict("ship needs 1 audit"), [waiver("review", "audit")]).clear, false);
assert.equal(withWaivers(verdict("review-2 needs 1 audit"), [waiver("review", "audit")]).clear, false);

// Regex metacharacters in a step or kind are literal.
assert.equal(withWaivers(verdict("a.b needs 1 x+y"), [waiver("a.b", "x+y")]).clear, true);
assert.equal(withWaivers(verdict("axb needs 1 xxy"), [waiver("a.b", "x+y")]).clear, false);

// Two gaps, one waived: not clear, and only the waiver that matched is reported.
{
  const s = withWaivers(verdict("review needs 1 audit", "review needs 1 decision"),
                        [waiver("review", "audit"), waiver("review", "spec")]);
  assert.equal(s.clear, false);
  assert.deepEqual(s.dischargedBy.map((w: { kind: string }) => w.kind), ["audit"]);
}

// Ruled-out steps still discharge by step prefix, the chain sentence included.
assert.equal(withWaivers(verdict("plan has not completed, and build follows it", "plan needs 1 audit"), [], ["plan"]).clear, true);

// A predecessor whose every gap is waived counts as completed: its chain sentence is discharged
// too, so the closing step is clear. Partly waived, it still blocks. Transitively, through a
// fully waived grandparent; and a ruled-out grandparent excuses the chain the same way.
{
  const trail = verdict("plan has not completed, and ship follows it", "plan needs 1 audit", "plan needs 1 decision");
  const full = withWaivers(trail, [waiver("plan", "audit"), waiver("plan", "decision")]);
  assert.equal(full.clear, true, "a fully waived predecessor no longer holds the closing step back");
  assert.deepEqual(full.dischargedBy.map((w: { kind: string }) => w.kind), ["audit", "decision"],
    "the chain sentence adds no waiver of its own");
  assert.equal(withWaivers(trail, [waiver("plan", "audit")]).clear, false, "a partly waived predecessor still blocks");
  assert.equal(withWaivers(verdict("plan has not completed, and ship follows it", "plan needs 1 audit", "ship needs 1 review"),
    [waiver("plan", "audit")]).clear, false, "the closing step's own gap is not excused by its predecessor's waiver");

  const deep = verdict("plan has not completed, and ship follows it", "spec has not completed, and plan follows it",
    "spec needs 1 audit", "plan needs 1 audit");
  assert.equal(withWaivers(deep, [waiver("spec", "audit"), waiver("plan", "audit")]).clear, true, "excused transitively");
  assert.equal(withWaivers(deep, [waiver("plan", "audit")]).clear, false, "an unwaived grandparent still blocks");
  assert.equal(withWaivers(deep, [waiver("plan", "audit")], ["spec"]).clear, true, "a ruled-out grandparent excuses its chain");
}

console.log("ok store-waivers");
