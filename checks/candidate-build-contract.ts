#!/usr/bin/env node
// candidate_validate no longer builds (0.76.0): it asks the local `npm run candidate-build` for
// the build, and consumes what that CLI records through candidate_build_record. Proven on values
// and against a stub pool, with no database:
//   - candidate_build_record's guard refuses another principal,
//     a candidate not awaiting its build, a second record, an expired lease and another patch;
//   - a recorded build decides the candidate: ok -> valid, apply/install/build/gate -> invalid
//     with the tail, timeout or host -> recorded, a record for another patch -> recorded, never valid;
//   - candidate_validate asks a recorded candidate for its build by a compare-and-set; on an
//     awaiting_build candidate with nothing recorded it answers build_required again and writes
//     nothing but the lease sweep; a valid candidate answers releasable with the build it was
//     judged by; a status outside (recorded, awaiting_build, valid) is refused;
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
const me = "a@x";

// ---- the record guard, one branch at a time.
assert.equal(rules.buildRecordRefusal(me, row, "d1", now), null, "the requester records its own build inside the lease");
assert.match(rules.buildRecordRefusal("b@x", row, "d1", now) ?? "",
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

// ---- candidate_validate's transitions, against a stub pool that answers by statement. The
// consume of a recorded build goes through the idempotency ledger's own transaction, which a stub
// pool cannot open; the eval-flow walk drives it against a real database.
interface Call { sql: string; params: unknown[] }
function stubPool(candidate: Record<string, unknown>, askedAt: Date | null = null) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/status = 'recorded', build_requested_at = null/.test(sql)) return { rows: [] }; // build lease sweep
      if (/set status = 'awaiting_build'/.test(sql)) return { rows: askedAt ? [{ build_requested_at: askedAt }] : [] };
      if (/from zz\.candidate where id = \$1::uuid/.test(sql)) return { rows: [candidate] };
      throw new Error(`stub pool: unexpected statement ${sql.slice(0, 120)}`);
    },
  };
}
const cid = "11111111-1111-1111-1111-111111111111";
const base = { id: cid, patch_digest: "d1", build_result: null };

{
  const p = stubPool({ ...base, status: "recorded", build_requested_at: null, build_recorded_at: null }, minutesAgo(0));
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.equal(out.status, "awaiting_build", "a recorded candidate is asked for its build");
  const ask = p.calls.find((c) => /set status = 'awaiting_build'/.test(c.sql))!;
  assert.match(ask.sql, /where id = \$1::uuid and status = 'recorded'/, "the ask is a compare-and-set on recorded");
  assert.deepEqual(ask.params, [cid, "a@x"], "the asker is the one principal who may record the build");
}
{
  const p = stubPool({ ...base, status: "awaiting_build", build_requested_at: minutesAgo(3), build_recorded_at: null });
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.equal(out.status, "awaiting_build", "nothing recorded yet: the same instruction again");
  assert.equal(out.build_required.patch_digest, "d1");
  assert.ok(!p.calls.some((c) => /set status = ('awaiting_build'|\$2)/.test(c.sql)), "and no status is written");
}
{
  const build = { ok: true, commands: ["npm ci"], patch_digest: "d1" };
  const p = stubPool({ ...base, status: "valid", build_requested_at: minutesAgo(3), build_recorded_at: minutesAgo(1), build_result: build });
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.equal(out.status, "valid");
  assert.equal(out.releasable, true, "a built and gated candidate is releasable — no replay, no proof");
  assert.deepEqual(out.build, build, "and it answers with the build it was judged by");
}
for (const status of ["invalid", "released", "rolled_back"]) {
  const p = stubPool({ ...base, status, build_requested_at: null, build_recorded_at: null });
  const out = await validateCandidate(p, cid, "k", "a@x");
  assert.match(out.error, /only callable for status in \(recorded, awaiting_build, valid\)/, `${status} is refused`);
}
{
  // The lease sweep runs first, scoped to this candidate.
  const p = stubPool({ ...base, status: "invalid", build_requested_at: null, build_recorded_at: null });
  await validateCandidate(p, cid, "k", "a@x");
  const sweep = p.calls.find((c) => /status = 'recorded', build_requested_at = null/.test(c.sql))!;
  assert.match(sweep.sql, /build_recorded_at is null/, "a recorded build is kept for a call to consume, lease or not");
  assert.deepEqual(sweep.params, [cid, rules.BUILD_LEASE_MS / 1000]);
}
{
  // The consume keeps the build a valid or invalid candidate was judged by; only a timeout or a
  // host problem clears it, back to recorded. A recorded build is consumed once.
  const src = readFileSync("services/zz-core/src/eval/candidate-validate.ts", "utf8");
  assert.match(src, /build_result = case when \$2::text = 'recorded' then null else build_result end/);
  assert.match(src, /where id = \$1::uuid and status = 'awaiting_build' and build_recorded_at is not null/,
    "a recorded build is consumed by a compare-and-set on its status");
}

// ---- the in-process build is gone.
for (const f of ["candidate-validate.ts", "candidate-build.ts", "candidate-build-rules.ts"]) {
  const src = readFileSync(`services/zz-core/src/eval/${f}`, "utf8");
  assert.doesNotMatch(src, /node:child_process|discoverRepoRoot|worktree add|npm run gate/, `${f} runs no build of its own`);
}

console.log("ok candidate-build-contract");
