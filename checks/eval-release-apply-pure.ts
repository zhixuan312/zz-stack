#!/usr/bin/env node
// release_apply's decision inputs, as the pure functions planApply builds them from: which subject
// is currently released (semver, never text), which owner teams an approval speaks for (membership,
// bound to the attempt and its digest), and whether another attempt already holds the plugin.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { compareSemver, newestSubject, approvedOwners, applyingRefusal, STALE_APPLYING_MS } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);

// Semver, not text: text puts 0.9.0 above 0.43.0.
assert.equal(compareSemver("0.43.0", "0.9.0"), 1);
assert.equal(compareSemver("1.2.0", "1.2.0"), 0);
assert.equal(compareSemver("1.2.0-rc.1", "1.2.0"), -1, "a pre-release sorts below its release");
assert.equal(compareSemver("1.2", "1.2.0"), 0);
assert.equal(compareSemver("garbage", "0.0.1"), -1);

// The newer of this system's release and the catalog head wins; a tie keeps the first listed.
const evalReleased = { id: "eval", declared_version: "0.9.0" };
const catalogHead = { id: "catalog", declared_version: "0.43.0" };
assert.equal(newestSubject([evalReleased, catalogHead]).id, "catalog", "an ordinary release past this system's own");
assert.equal(newestSubject([{ id: "eval", declared_version: "1.0.0" }, { id: "catalog", declared_version: "0.43.0" }]).id, "eval");
assert.equal(newestSubject([{ id: "eval", declared_version: "1.0.0" }, { id: "catalog", declared_version: "1.0.0" }]).id, "eval");
assert.equal(newestSubject([]), null);

// An approval speaks only for owner teams its signer is a MEMBER of, and only for this attempt.
const approval = {
  status: "approved", cited_attempt_id: "a1", attempt_id: "a1", quotes_digest: true,
  approver_teams: ["xuan", "other"], required_owners: ["xuan"],
};
assert.deepEqual(approvedOwners(approval), ["xuan"]);
assert.deepEqual(approvedOwners({ ...approval, approver_teams: ["other"] }), [], "a non-member signs for nobody");
assert.deepEqual(approvedOwners({ ...approval, cited_attempt_id: "a0" }), [], "an earlier attempt's approval");
assert.deepEqual(approvedOwners({ ...approval, cited_attempt_id: null }), [], "no attempt cited");
assert.deepEqual(approvedOwners({ ...approval, quotes_digest: false }), [], "digest not quoted");
assert.deepEqual(approvedOwners({ ...approval, status: "draft" }), []);

// Any applying attempt of the plugin refuses; past the stale bound it is named for reconciling.
const now = Date.parse("2026-09-25T12:00:00Z");
assert.equal(applyingRefusal([], now), null);
assert.deepEqual(applyingRefusal([{ id: "a9", applying_at: "2026-09-25T11:55:00Z" }], now), { attempt_id: "a9", stale: false });
assert.deepEqual(applyingRefusal([{ id: "a9", applying_at: new Date(now - STALE_APPLYING_MS).toISOString() }], now), { attempt_id: "a9", stale: true });
assert.deepEqual(applyingRefusal([{ id: "a9", applying_at: null }], now), { attempt_id: "a9", stale: true });
// The citation approvedOwners compares is the ONE attempt improvement.md's body names, in the
// closing line improvement-doc.ts renders; none, or two different ones, cite nothing.
const { citedReleaseAttempt } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/release-owners.js")).href);
const a1 = "0b7a3c1e-1111-4222-8333-944455556666", a2 = "0b7a3c1e-1111-4222-8333-944455557777";
const cite = (id: string): string => `release_attempt_id: \`${id}\` — initiative \`i\`.`;
assert.equal(citedReleaseAttempt(`# Improvement\n\n${cite(a1)}\n`), a1);
assert.equal(citedReleaseAttempt(`${cite(a1)}\n${cite(a1)}`), a1);
assert.equal(citedReleaseAttempt(`${cite(a1)}\n${cite(a2)}`), null, "two attempts cited");
assert.equal(citedReleaseAttempt("no citation"), null);
// A rollback makes the prior version current again without deleting the retracted
// zz.plugin_version row: retractedVersions is the one rule, and BOTH "what is released now"
// readers filter by it — plugin_locate's head (subject.ts) and release_apply's baseline.
import { readFileSync } from "node:fs";
const { retractedVersions } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-retracted.js")).href);
let seen = "";
const stub = { async query(text: string) { seen = text; return { rows: [{ declared_version: "0.44.0" }] }; } };
assert.deepEqual(await retractedVersions(stub, "11111111-1111-4111-8111-111111111111"), ["0.44.0"]);
assert.match(seen, /status = 'rolled_back'/, "only a rolled_back attempt retracts its version");
for (const f of ["services/zz-core/src/eval/subject.ts", "services/zz-core/src/eval/release-apply.ts"]) {
  const src = readFileSync(f, "utf8");
  assert.match(src, /await retractedVersions\(/, `${f} does not read the retracted versions`);
  assert.match(src, /pv\.version <> all\(\$\d::text\[\]\)/, `${f} does not leave retracted versions out of its head`);
}
console.log("ok eval-release-apply-pure");
process.exit(0);
