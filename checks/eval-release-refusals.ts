#!/usr/bin/env node
// Every refusal branch of the release path's database logic, against a stub client that answers
// each query by its text and fails the check on any query it does not expect or any two queries
// in flight at once (one PoolClient runs one query at a time): release_apply's planApply,
// release_record's recordRelease, releaseActorRefusal and document_approve's
// improvementApprovalRefusal.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = async (rel: string) => import(pathToFileURL(join(process.cwd(), "services/zz-core/dist", rel)).href);
const { planApply } = await load("eval/release-apply.js");
const { recordRelease, releaseActorRefusal } = await load("eval/release-record.js");
const { improvementApprovalRefusal } = await load("release-owners.js");

type Rows = Record<string, unknown>[];
type Handler = [RegExp, (values: unknown[], text: string) => Rows | Promise<Rows>];

/** A client answering by the first handler whose pattern matches the query text. */
function stub(handlers: Handler[]) {
  let inFlight = 0;
  const seen: { text: string; values: unknown[] }[] = [];
  return {
    seen,
    async query(text: string, values: unknown[] = []) {
      inFlight += 1;
      assert.equal(inFlight, 1, `two queries in flight on one client:\n${text}`);
      try {
        await new Promise((r) => setImmediate(r));
        seen.push({ text, values });
        const hit = handlers.find(([re]) => re.test(text));
        if (!hit) throw new Error(`unexpected query:\n${text}`);
        return { rows: await hit[1](values, text) };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

// -------------------------------------------------------------------------------------------
// planApply.

const CAND = "c0000000-0000-4000-8000-000000000001";
const BASE = "b0000000-0000-4000-8000-000000000001";
const A_OLD = "a0000000-0000-4000-8000-000000000001";
const A_NEW = "a0000000-0000-4000-8000-000000000002";
const OWNER = "owner@example.test", STRANGER = "stranger@example.test";
const DIGEST = "d".repeat(64);
const REF = "0123456789abcdef0123456789abcdef01234567";

interface Scenario {
  candidate?: Rows; subject?: Rows; teams?: Record<string, string[]>; applying?: Rows;
  prepared?: Rows; eligible?: boolean; retracted?: string[]; versions?: string[];
  captured?: Record<string, string>; casRows?: Rows; casError?: { code: string };
}

function applyClient(sc: Scenario) {
  const prepared = sc.prepared ?? [
    { id: A_NEW, required_owners: ["xuan"], approved_patch_digest: DIGEST, base_subject_version_id: BASE },
    { id: A_OLD, required_owners: ["xuan"], approved_patch_digest: DIGEST, base_subject_version_id: BASE },
  ];
  const updates: { text: string; values: unknown[] }[] = [];
  const row = { status: "prepared", reason: null as unknown };
  const client = stub([
    [/from zz\.candidate where id/, () => sc.candidate ?? [{ id: CAND, status: "proof_passed", base_subject_version_id: BASE, patch_digest: DIGEST, patchset: { diff: "x" } }]],
    [/pl\.release_owners/, () => sc.subject ?? [{ plugin_id: "p1", plugin: "demo", release_owners: ["xuan"], declared_version: "1.1.0" }]],
    [/from zz\.membership/, (v) => (sc.teams ?? { [OWNER]: ["xuan"] })[String(v[0])]?.map((slug) => ({ slug })) ?? []],
    [/pg_advisory_xact_lock/, () => []],
    [/where plugin_id = \$1::uuid and status = 'applying'/, () => sc.applying ?? []],
    [/status = 'prepared' and \(\$2::uuid is null/, (v) => prepared.filter((a) => v[1] === null || a.id === v[1])],
    [/from zz\.candidate_evaluation/, () => [{ aggregate_score: { release_eligible: sc.eligible ?? true } }]],
    [/status = 'rolled_back'/, () => (sc.retracted ?? []).map((declared_version) => ({ declared_version }))],
    [/from zz\.plugin_version pv/, (v) => (sc.versions ?? ["1.1.0"]).filter((x) => !(v[1] as string[]).includes(x)).map((version) => ({ version }))],
    [/from zz\.eval_subject_version\s+where plugin_id/, (v) => {
      const id = (sc.captured ?? { "1.1.0": BASE })[String(v[1])];
      return id ? [{ id }] : [];
    }],
    [/update zz\.release_attempt set status = 'applying'/, (v, text) => {
      updates.push({ text, values: v });
      if (sc.casError) throw Object.assign(new Error("duplicate"), sc.casError);
      const moved = sc.casRows ?? [{ id: v[0] }];
      if (moved.length) row.status = "applying";
      return moved;
    }],
    [/update zz\.release_attempt set reason/, (v, text) => {
      updates.push({ text, values: v });
      row.reason = v[1];
      if (/status = 'refused'/.test(text)) row.status = "refused";
      return [{ id: v[0] }];
    }],
    [/select status, reason, candidate_id/, () => [{ ...row, candidate_id: CAND, base_subject_version_id: BASE }]],
    [/select pl\.name as plugin, sv\.declared_version/, () => [{ plugin: "demo", declared_version: "1.1.0" }]],
    [/select release_ref from zz\.release_attempt/, () => []],
    [/release_identity->>'resolved_commit'/, () => [{ commit: null }]],
  ]);
  return { client, updates };
}

const approvedDoc = (cites: string, approver = OWNER) => async () => ({
  status: "approved", approved_by: approver,
  body: `Patch digest: \`${DIGEST}\`\n\nrelease_attempt_id: \`${cites}\` — initiative \`i\`.\n`,
});
const noDoc = async () => null;
const run = (sc: Scenario, principal = OWNER, readDoc: () => Promise<unknown> = approvedDoc(A_OLD)) => {
  const c = applyClient(sc);
  return { ...c, done: planApply(c.client, CAND, DIGEST, "i", principal, readDoc) };
};

await assert.rejects(run({ candidate: [] }).done, /no candidate/);
await assert.rejects(run({ subject: [] }).done, /no longer resolves to a plugin/);
await assert.rejects(run({ subject: [{ plugin_id: "p1", plugin: "demo", release_owners: [], declared_version: "1.1.0" }] }).done, /no_release_owners/);
await assert.rejects(run({}, STRANGER).done, /not_owner/);
await assert.rejects(run({ applying: [{ id: "held", candidate_id: CAND, applying_at: new Date().toISOString() }] }).done,
  /release_in_progress — release_attempt held of demo is applying now/);
await assert.rejects(run({ applying: [{ id: "held", candidate_id: CAND, applying_at: "2000-01-01T00:00:00Z" }] }).done,
  /release_in_progress[\s\S]*--reconcile held[\s\S]*--release-tag/);
await assert.rejects(run({ prepared: [] }, OWNER, noDoc).done, /no prepared release_attempt/);
// The cited attempt must be this candidate's prepared one — never silently another row.
await assert.rejects(run({ prepared: [{ id: A_NEW, required_owners: ["xuan"], approved_patch_digest: DIGEST, base_subject_version_id: BASE }] }).done,
  /improvement\.md cites release_attempt a0000000-0000-4000-8000-000000000001, which is not a prepared attempt/);
await assert.rejects(run({ versions: [] }).done, /no registered release/);
await assert.rejects(run({ versions: ["1.1.0"], captured: {} }).done, /1\.1\.0 is registered but was never captured/);

// Bound to the attempt the approved document cites (the OLDER one), not the newest prepared.
{
  const r = run({});
  const out = await r.done;
  assert.equal(out.result.status, "applying");
  assert.equal(out.result_id, A_OLD, "planApply applied the newest prepared attempt, not the cited one");
  assert.equal(r.updates.at(-1)?.values[0], A_OLD);
}
// A version registered at deploy but never captured is still the head: newer than the base, so
// stale_baseline — never read past as if the base were current.
{
  const r = run({ versions: ["1.1.0", "1.2.0"], captured: { "1.1.0": BASE } });
  const out = await r.done;
  assert.equal(out.result.reason, "stale_baseline");
  assert.equal(r.updates.at(-1)?.values[1], "stale_baseline");
}
// Semver, not text or capture order: 1.10.0 is above 1.9.0.
assert.equal((await run({ versions: ["1.9.0", "1.10.0"], subject: [{ plugin_id: "p1", plugin: "demo", release_owners: ["xuan"], declared_version: "1.9.0" }], captured: { "1.9.0": BASE } }).done).result.reason, "stale_baseline");
// A retracted head leaves the prior version current.
assert.equal((await run({ versions: ["1.1.0", "1.2.0"], retracted: ["1.2.0"] }).done).result.status, "applying");
// Not approved: approval_required, non-terminal (status is not moved).
{
  const r = run({}, OWNER, noDoc);
  const out = await r.done;
  assert.equal(out.result.reason, "approval_required");
  assert.equal(out.result_id, A_NEW, "with no citation the newest prepared attempt stands in");
  assert.doesNotMatch(r.updates.at(-1)!.text, /status = 'refused'/);
  assert.equal(out.result.status, "refused");
}
// A non-UUID citation cites nothing: named approval_required, never a raw ::uuid cast error.
{
  const out = await run({}, OWNER, approvedDoc("-".repeat(36))).done;
  assert.equal(out.result.reason, "approval_required");
  assert.equal(out.result_id, A_NEW);
}
assert.equal((await run({}, OWNER, approvedDoc(A_OLD, STRANGER)).done).result.reason, "approval_required", "a non-member approver signs for nobody");
assert.equal((await run({ eligible: false }).done).result.reason, "not_eligible");
{
  const c = applyClient({});
  const out = await planApply(c.client, CAND, "e".repeat(64), "i", OWNER, approvedDoc(A_OLD));
  assert.equal(out.result.reason, "digest_mismatch");
}
await assert.rejects(run({ casError: { code: "23505" } }).done, /release_in_progress — another attempt of demo is already applying/);
await assert.rejects(run({ casRows: [] }).done, /left 'prepared' before this call reached it/);

// -------------------------------------------------------------------------------------------
// recordRelease.

const REL = "e0000000-0000-4000-8000-000000000001", OTHER_PLUGIN = "e0000000-0000-4000-8000-000000000002";
function recordClient(attempt: Record<string, unknown> | null, o: { versions?: string[]; cas?: boolean } = {}) {
  const subjects: Record<string, { plugin_id: string; declared_version: string }> = {
    [BASE]: { plugin_id: "p1", declared_version: "1.1.0" },
    [REL]: { plugin_id: "p1", declared_version: "1.2.0" },
    [OTHER_PLUGIN]: { plugin_id: "p2", declared_version: "9.0.0" },
  };
  return stub([
    [/verification->>'verdict' as verdict/, () => (attempt ? [attempt] : [])],
    [/from zz\.membership/, (v) => (String(v[0]) === OWNER ? [{ slug: "xuan" }] : [])],
    [/update zz\.release_attempt/, (v) => (o.cas === false ? [] : [{ id: v[0] }])],
    [/update zz\.candidate/, () => []],
    [/status = 'rolled_back'/, () => [{ declared_version: "1.2.0" }]],
    [/from zz\.plugin_version pv/, (v) => (o.versions ?? ["1.1.0", "1.2.0"]).filter((x) => !(v[1] as string[]).includes(x)).map((version) => ({ version }))],
    [/from zz\.eval_subject_version\s+where plugin_id/, () => [{ id: BASE }]],
    [/select plugin_id::text as plugin_id, declared_version/, (v) => (subjects[String(v[0])] ? [subjects[String(v[0])]] : [])],
  ]);
}
const attemptRow = (over: Record<string, unknown> = {}) => ({
  id: A_OLD, candidate_id: CAND, base_subject_version_id: BASE, status: "applying",
  released_subject_version_id: null, release_ref: null, applied_by: OWNER, required_owners: ["xuan"],
  verdict: null, plugin_id: "p1", ...over,
});
const rec = (attempt: Record<string, unknown> | null, args: Record<string, unknown>, principal = OWNER, o = {}) =>
  recordRelease(recordClient(attempt, o), {
    release_attempt_id: A_OLD, status: "released", release_ref: null, released_subject_version_id: null,
    failure_tail: null, reason: null, ...args,
  }, principal);

await assert.rejects(rec(null, {}), /no release_attempt/);
await assert.rejects(rec(attemptRow({ applied_by: "someone@else.test" }), {}, STRANGER), /not_owner/);
await assert.rejects(rec(attemptRow({ status: "released" }), { status: "rolled_back" }), /requires reason/);
await assert.rejects(rec(attemptRow(), { status: "rolled_back", reason: "r" }), /not_released/);
await assert.rejects(rec(attemptRow({ status: "released" }), { status: "rolled_back", reason: "r" }), /not_rolled_back/);
await assert.rejects(rec(attemptRow({ status: "released", verdict: "rolled_back" }), { status: "rolled_back", reason: "r" }, OWNER, { cas: false }), /left 'released'/);
// Retracting 1.2.0 still leaves a newer 1.3.0 standing over the prior version.
await assert.rejects(rec(attemptRow({ status: "released", verdict: "rolled_back" }), { status: "rolled_back", reason: "r" }, OWNER, { versions: ["1.1.0", "1.2.0", "1.3.0"] }), /prior_not_current/);
assert.equal((await rec(attemptRow({ status: "released", verdict: "rolled_back" }), { status: "rolled_back", reason: "r" })).result.status, "rolled_back");
await assert.rejects(rec(attemptRow({ status: "failed" }), {}), /not_applying/);
await assert.rejects(rec(attemptRow(), { release_ref: REF }), /requires both release_ref and released_subject_version_id/);
for (const bad of ["abc", "v1.2.0", "demo@1.2.0", REF.slice(0, 12), REF.toUpperCase(), `${REF}\n`]) {
  await assert.rejects(rec(attemptRow(), { release_ref: bad, released_subject_version_id: REL }), /not a full 40-hex commit sha/,
    `release_ref ${JSON.stringify(bad)} is refused`);
}
await assert.rejects(rec(attemptRow(), { release_ref: REF, released_subject_version_id: OTHER_PLUGIN }), /SAME plugin/);
await assert.rejects(rec(attemptRow(), { release_ref: REF, released_subject_version_id: BASE }), /not_newer/);
await assert.rejects(rec(attemptRow(), { release_ref: REF, released_subject_version_id: REL }, OWNER, { cas: false }), /left 'applying'/);
assert.equal((await rec(attemptRow(), { release_ref: REF, released_subject_version_id: REL })).result.status, "released");
await assert.rejects(rec(attemptRow(), { status: "failed" }), /requires failure_tail/);
await assert.rejects(rec(attemptRow(), { status: "failed", failure_tail: "t" }, OWNER, { cas: false }), /left 'applying'/);
assert.equal((await rec(attemptRow(), { status: "failed", failure_tail: "t" })).result.status, "failed");

// -------------------------------------------------------------------------------------------
// releaseActorRefusal and improvementApprovalRefusal.

const members = stub([[/from zz\.membership/, (v) => (String(v[0]) === OWNER ? [{ slug: "xuan" }] : [])]]);
const attempt = { id: A_OLD, applied_by: "Applier@Example.test", required_owners: ["xuan"] };
assert.equal(await releaseActorRefusal(members, attempt, " applier@example.test "), null, "the applier, case-insensitively");
assert.equal(await releaseActorRefusal(members, attempt, OWNER), null, "an owner-team member");
assert.match(await releaseActorRefusal(members, attempt, STRANGER), /not_owner — stranger@example\.test neither applied/);
assert.match(await releaseActorRefusal(members, { ...attempt, applied_by: null, required_owners: [] }, ""), /not_owner — this caller[\s\S]*\(none\)/);

const cites = `release_attempt_id: \`${A_OLD}\` — initiative \`i\`.`;
const approvals = (owners: string[]) => stub([
  [/select required_owners from zz\.release_attempt/, () => (owners.length ? [{ required_owners: owners }] : [])],
  [/from zz\.membership/, (v) => (String(v[0]) === OWNER ? [{ slug: "xuan" }] : [])],
]);
assert.equal(await improvementApprovalRefusal("no citation here", STRANGER, null, approvals(["xuan"])), null, "nothing to protect");
assert.match(await improvementApprovalRefusal(cites, OWNER, null, null), /no platform database/);
assert.match(await improvementApprovalRefusal(cites, OWNER, null, approvals([])), /records no owner teams/);
assert.match(await improvementApprovalRefusal(cites, STRANGER, null, approvals(["xuan"])), /not_owner — stranger@example\.test is not a member/);
assert.match(await improvementApprovalRefusal(cites, OWNER, STRANGER, approvals(["xuan"])), /not_owner — stranger@example\.test may not record an approval/);
assert.equal(await improvementApprovalRefusal(cites, OWNER, OWNER, approvals(["xuan"])), null);

console.log("ok eval-release-refusals");
process.exit(0);
