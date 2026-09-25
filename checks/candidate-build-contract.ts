#!/usr/bin/env node
// candidate_validate no longer builds (0.76.0): it asks the local `npm run candidate-build` for
// the build, and consumes what that CLI records through candidate_build_record. Proven on values
// and against a stub pool, with no database:
//   - candidate_build_record's guard refuses a candidate session's credential, another principal,
//     a candidate not awaiting its build, a second record, an expired lease and another patch;
//   - a recorded build decides the candidate: ok -> valid, apply/install/build/gate -> invalid
//     with the tail, timeout or host -> recorded, a record for another patch -> recorded, never valid;
//   - candidate_validate on an awaiting_build candidate with nothing recorded answers
//     build_required again and writes nothing but the lease sweep; with a failed build recorded
//     it consumes it in the SAME statement that takes the hold, and rests the candidate invalid;
//     a hold it cannot take is refused; a status outside (recorded, awaiting_build, valid) is
//     refused before any hold is taken;
//   - the in-process build is gone: zz-core carries no worktree, no `git`, no `npm run` of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const rules = await load("services/zz-core/dist/eval/candidate-build-rules.js");
const { validateCandidate } = await load("services/zz-core/dist/eval/candidate-validate.js");

const now = new Date("2026-09-25T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const row = {
  status: "awaiting_build", patch_digest: "d1", build_requested_by: "a@x",
  build_requested_at: minutesAgo(5), build_recorded_at: null,
};
const me = { principal: "a@x", patTeam: null };

// ---- the record guard, one branch at a time.
assert.equal(rules.buildRecordRefusal(me, row, "d1", now), null, "the requester records its own build inside the lease");
assert.match(rules.buildRecordRefusal({ principal: "a@x", patTeam: "replay-abc" }, row, "d1", now) ?? "",
  /reserved replay team/, "a candidate session's credential never records a build");
assert.match(rules.buildRecordRefusal({ principal: "b@x", patTeam: null }, row, "d1", now) ?? "",
  /is for a@x, not b@x/, "only the principal whose candidate_validate asked records");
assert.match(rules.buildRecordRefusal(me, { ...row, status: "valid" }, "d1", now) ?? "",
  /not awaiting_build/, "a candidate not awaiting its build is refused");
assert.match(rules.buildRecordRefusal(me, { ...row, build_recorded_at: minutesAgo(1) }, "d1", now) ?? "",
  /already recorded/, "one record per lease");
assert.match(rules.buildRecordRefusal(me, { ...row, build_requested_at: minutesAgo(61) }, "d1", now) ?? "",
  /lease .* has expired/, "a build recorded after the lease is refused");
assert.equal(rules.buildRecordRefusal(me, { ...row, build_requested_at: minutesAgo(59) }, "d1", now), null,
  "inside the lease is accepted");
assert.match(rules.buildRecordRefusal(me, row, "d2", now) ?? "", /not this candidate's/, "another patch's build is refused");
assert.equal(rules.BUILD_LEASE_MS, 60 * 60_000);
assert.ok(rules.VALIDATING_LEASE_MS < rules.BUILD_LEASE_MS, "one call's hold is shorter than a build lease");

// ---- judging a consumed record.
assert.deepEqual(rules.judgeBuild("c", "d1", { ok: true, patch_digest: "d1" }), { next: "valid" });
for (const stage of ["apply", "install", "build", "gate"]) {
  const v = rules.judgeBuild("c", "d1", { ok: false, stage, log_tail: "boom", patch_digest: "d1" });
  assert.equal(v.next, "invalid", `${stage} failure invalidates`);
  assert.match(v.error, new RegExp(`failed its own ${stage}[\\s\\S]*boom`));
}
assert.equal(rules.judgeBuild("c", "d1", { ok: false, stage: "timeout", patch_digest: "d1" }).next, "recorded",
  "a timeout judged nothing");
const hostVerdict = rules.judgeBuild("c", "d1", { ok: false, stage: "host", log_tail: "no compose plugin", patch_digest: "d1" });
assert.equal(hostVerdict.next, "recorded", "a host problem never invalidates a candidate");
assert.match(hostVerdict.error, /problem on the building host[\s\S]*no compose plugin/);
assert.deepEqual([...rules.BUILD_STAGES], ["apply", "install", "build", "gate", "timeout", "host"]);
assert.equal(rules.judgeBuild("c", "d1", { ok: true, patch_digest: "d2" }).next, "recorded",
  "a record for another patch never makes this one valid");
assert.equal(rules.judgeBuild("c", "d1", null).next, "recorded");
const req = rules.buildRequired("c1", "d1", now);
assert.equal(req.status, "awaiting_build");
assert.equal(req.build_required.command, "npm run candidate-build -- --candidate c1 --repo <path-to-a-checkout>");
assert.equal(req.build_required.lease_expires_at, new Date(now.getTime() + rules.BUILD_LEASE_MS).toISOString());

// ---- candidate_validate's transitions, against a stub pool that answers by statement.
interface Call { sql: string; params: unknown[] }
function stubPool(candidate: Record<string, unknown>, lock: Record<string, unknown> | null) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/^\s*update zz\.candidate c\s+set status = case/.test(sql)) return { rows: [] }; // validating sweep
      if (/status = 'recorded', build_requested_at = null/.test(sql)) return { rows: [] }; // build lease sweep
      if (/with prior as/.test(sql)) return { rows: lock ? [lock] : [] };
      if (/from zz\.candidate where id = \$1::uuid/.test(sql) && /build_recorded_at\s+from/.test(sql)) return { rows: [candidate] };
      if (/set status = \$2::text, validating_since = null/.test(sql)) return { rows: [] };
      throw new Error(`stub pool: unexpected statement ${sql.slice(0, 120)}`);
    },
  };
}
const cid = "11111111-1111-1111-1111-111111111111";
const base = {
  id: cid, improvement_run_id: "r", base_subject_version_id: "s", complexity_delta: 0, patch_digest: "d1",
};

{
  const p = stubPool({ ...base, status: "awaiting_build", build_requested_at: minutesAgo(3), build_recorded_at: null }, null);
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.equal(out.status, "awaiting_build", "nothing recorded yet: the same instruction again");
  assert.equal(out.build_required.patch_digest, "d1");
  assert.ok(!p.calls.some((c) => /with prior as/.test(c.sql)), "no hold is taken while the build is awaited");
  assert.ok(!p.calls.some((c) => /set status = \$2/.test(c.sql)), "and no status is written");
}
{
  const p = stubPool(
    { ...base, status: "awaiting_build", build_requested_at: minutesAgo(3), build_recorded_at: minutesAgo(1) },
    { prior_status: "awaiting_build", build_result: { ok: false, stage: "gate", log_tail: "gate said no", patch_digest: "d1" } });
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.match(out.error, /failed its own gate[\s\S]*gate said no/);
  const lock = p.calls.find((c) => /with prior as/.test(c.sql))!;
  assert.match(lock.sql, /status = 'awaiting_build' and build_recorded_at is not null/, "only a recorded build is taken");
  assert.match(lock.sql, /build_result = null, build_recorded_at = null/, "and it is consumed in the same statement");
  const rest = p.calls.find((c) => /set status = \$2::text, validating_since = null/.test(c.sql))!;
  assert.equal(rest.params[1], "invalid", "a failed gate rests the candidate invalid");
}
{
  const p = stubPool(
    { ...base, status: "awaiting_build", build_requested_at: minutesAgo(3), build_recorded_at: minutesAgo(1) },
    { prior_status: "awaiting_build", build_result: { ok: false, stage: "timeout", patch_digest: "d1" } });
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.match(out.error, /did not finish in time/);
  assert.equal(p.calls.find((c) => /set status = \$2/.test(c.sql))!.params[1], "recorded", "a timeout goes back to recorded");
}
{
  const p = stubPool({ ...base, status: "awaiting_build", build_requested_at: minutesAgo(3), build_recorded_at: minutesAgo(1) }, null);
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.match(out.error, /another candidate_validate call is already in progress/, "a hold it cannot take is refused");
}
for (const status of ["validating", "invalid", "rejected_precheck", "selected"]) {
  const p = stubPool({ ...base, status, build_requested_at: null, build_recorded_at: null }, null);
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.match(out.error, /only callable for status in \(recorded, awaiting_build, valid\)/, `${status} is refused`);
  assert.ok(!p.calls.some((c) => /with prior as/.test(c.sql)), `${status}: refused before any hold`);
}
{
  // The lease sweep runs first, on both leases, scoped to this candidate.
  const p = stubPool({ ...base, status: "invalid", build_requested_at: null, build_recorded_at: null }, null);
  await validateCandidate(p, cid, "k", "a@x");
  const sweep = p.calls.find((c) => /status = 'recorded', build_requested_at = null/.test(c.sql))!;
  assert.match(sweep.sql, /build_recorded_at is null/, "a recorded build is kept for a call to consume, lease or not");
  assert.deepEqual(sweep.params, [cid, rules.BUILD_LEASE_MS / 1000]);
}

// ---- the in-process build is gone.
for (const f of ["candidate-validate.ts", "candidate-build.ts", "candidate-build-rules.ts"]) {
  const src = readFileSync(`services/zz-core/src/eval/${f}`, "utf8");
  assert.doesNotMatch(src, /node:child_process|discoverRepoRoot|worktree add|npm run gate/, `${f} runs no build of its own`);
}

console.log("ok candidate-build-contract");
