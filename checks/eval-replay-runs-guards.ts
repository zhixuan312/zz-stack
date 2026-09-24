#!/usr/bin/env node
// Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, defect 4: subject_version_id on
// replay_start reached zz.replay_run's own FK constraint as a raw postgres error, unlike
// candidate_id, which was already refused by name. resolveSubjectOrCandidate (replay-runs.ts) is
// the one check both now share — exercised here with a stub Db so the branching is provable with
// no live database, the same way checks/eval-replay-safety.ts's dependencyAction/sealedRows are.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { resolveSubjectOrCandidate } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-runs.js")).href);

const KNOWN_CANDIDATE = "11111111-1111-1111-1111-111111111111";
const UNKNOWN_CANDIDATE = "22222222-2222-2222-2222-222222222222";
const KNOWN_SUBJECT = "33333333-3333-3333-3333-333333333333";
const UNKNOWN_SUBJECT = "44444444-4444-4444-4444-444444444444";

// A stub Db: canned rows keyed off which table the statement names, never a real connection —
// resolveSubjectOrCandidate's own SQL text is the only thing distinguishing the two lookups.
const stub = {
  async query(text: string, params?: unknown[]) {
    const id = (params ?? [])[0];
    if (text.includes("zz.candidate ")) {
      return { rows: id === KNOWN_CANDIDATE ? [{ id }] : [], rowCount: id === KNOWN_CANDIDATE ? 1 : 0 };
    }
    if (text.includes("zz.eval_subject_version ")) {
      return { rows: id === KNOWN_SUBJECT ? [{ id }] : [], rowCount: id === KNOWN_SUBJECT ? 1 : 0 };
    }
    throw new Error(`stub Db: unrecognised query — ${text}`);
  },
};

assert.equal(await resolveSubjectOrCandidate(stub, undefined, undefined), null,
  "neither id given: nothing to resolve, and replay_start's own exactly-one-of check runs first");
assert.equal(await resolveSubjectOrCandidate(stub, KNOWN_SUBJECT, undefined), null,
  "a subject_version_id that resolves is fine");
assert.equal(await resolveSubjectOrCandidate(stub, undefined, KNOWN_CANDIDATE), null,
  "a candidate_id that resolves is fine");
assert.match(
  await resolveSubjectOrCandidate(stub, UNKNOWN_SUBJECT, undefined),
  new RegExp(`ERROR: unknown subject_version_id ${UNKNOWN_SUBJECT}`),
  "an unknown subject_version_id is refused by name, never left to reach a raw FK error — the fix");
assert.match(
  await resolveSubjectOrCandidate(stub, undefined, UNKNOWN_CANDIDATE),
  new RegExp(`ERROR: unknown candidate_id ${UNKNOWN_CANDIDATE}`),
  "an unknown candidate_id is refused by name (unchanged behaviour, still covered)");
assert.match(
  await resolveSubjectOrCandidate(stub, "not-a-uuid", undefined),
  /ERROR: unknown subject_version_id not-a-uuid/,
  "a malformed subject_version_id is refused before it ever reaches a query");
assert.match(
  await resolveSubjectOrCandidate(stub, undefined, "not-a-uuid"),
  /ERROR: unknown candidate_id not-a-uuid/,
  "a malformed candidate_id is refused before it ever reaches a query");

console.log("ok eval-replay-runs-guards");
