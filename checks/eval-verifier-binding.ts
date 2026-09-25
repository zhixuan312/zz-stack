#!/usr/bin/env node
// Release-review fix (finding 1): a verifier_token reaches exactly one proof allocation — one
// candidate, one case set, the proof split — never a caller-named case, never a run another
// allocation started, never an evaluator-role event, and a proof-split run's per-case result
// fields are blanked whoever reads it. Pure: replay-verifier.ts's decisions on values alone.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { verifierStartRefusal, verifierReadRefusal, sealProofRead } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-verifier.js")).href);

const alloc = {
  id: "a1111111-1111-1111-1111-111111111111", candidate_id: "c2222222-2222-2222-2222-222222222222",
  case_set_id: "53333333-3333-3333-3333-333333333333", base_subject_version_id: "b4444444-4444-4444-4444-444444444444",
  released_subject_version_id: null,
};
const inside = { split: "proof", case_set_id: alloc.case_set_id };

assert.equal(verifierStartRefusal(alloc, { ...inside, candidate_id: alloc.candidate_id }), null,
  "the allocation's own candidate on its own case set's proof split is admitted");
assert.equal(verifierStartRefusal(alloc, { ...inside, subject_version_id: alloc.base_subject_version_id }), null,
  "the allocation's own base subject (the baseline side) is admitted");
assert.match(verifierStartRefusal(alloc, { ...inside, split: "validation", candidate_id: alloc.candidate_id }),
  /split: proof only/, "a verifier context never replays another split");
assert.match(verifierStartRefusal(alloc, { ...inside, case_set_id: "56666666-6666-6666-6666-666666666666", candidate_id: alloc.candidate_id }),
  /on case set/, "another case set is refused");
assert.match(verifierStartRefusal(alloc, { ...inside, candidate_id: "c7777777-7777-7777-7777-777777777777" }),
  /not candidate/, "another candidate is refused");
assert.match(verifierStartRefusal(alloc, { ...inside, subject_version_id: "b8888888-8888-8888-8888-888888888888" }),
  /neither its base subject nor its released subject/, "another subject is refused");
const verify = { ...alloc, released_subject_version_id: "ba555555-5555-5555-5555-555555555555" };
assert.equal(verifierStartRefusal(verify, { ...inside, subject_version_id: verify.released_subject_version_id }), null,
  "release_verify's token admits its released subject");
assert.match(verifierStartRefusal(alloc, { ...inside, candidate_id: alloc.candidate_id, case_id: "c9999999-9999-9999-9999-999999999999" }),
  /never names a case_id/, "a caller-named proof case is refused — the draw is server-side");

const ownLive = { verifier_allocation_id: alloc.id, status: "running" };
assert.equal(verifierReadRefusal(alloc, ownLive, undefined), null, "its own run, no events asked: admitted");
assert.equal(verifierReadRefusal(alloc, ownLive, "actor"), null, "actor events of its own live run: admitted");
assert.equal(verifierReadRefusal(alloc, ownLive, "simulated_person"), null, "the launcher's simulated-person read: admitted");
assert.match(verifierReadRefusal(alloc, { ...ownLive, verifier_allocation_id: null }, undefined),
  /its own proof allocation started/, "a run no allocation started is refused");
assert.match(verifierReadRefusal(alloc, { ...ownLive, verifier_allocation_id: "a0000000-0000-0000-0000-000000000000" }, undefined),
  /its own proof allocation started/, "another allocation's run is refused");
assert.match(verifierReadRefusal(alloc, ownLive, "evaluator"), /evaluator-role/, "evaluator-role events are refused");
assert.match(verifierReadRefusal(alloc, { ...ownLive, status: "completed" }, "simulated_person"),
  /read once, while it is live/, "events of a finished proof run are refused");
assert.equal(verifierReadRefusal(alloc, { ...ownLive, status: "completed" }, undefined), null,
  "a finished run's status (already sealed) stays readable");

const row = {
  split: "proof", case_id: "c1", score: { overall: 0.9 }, guardrails: [], model_usage: {}, cost: "1.2",
  duration_ms: "900", team_slug: "replay-x", status: "completed",
};
const sealed = sealProofRead(row);
for (const k of ["case_id", "score", "guardrails", "model_usage", "cost", "duration_ms"]) {
  assert.equal(sealed[k], null, `a proof-split read blanks ${k}`);
}
assert.equal(sealed.team_slug, "replay-x", "the launcher's own fields survive");
assert.deepEqual(sealProofRead({ ...row, split: "validation" }), { ...row, split: "validation" },
  "a validation-split read is untouched");

console.log("ok eval-verifier-binding");
