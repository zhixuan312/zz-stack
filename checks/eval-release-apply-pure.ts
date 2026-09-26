#!/usr/bin/env node
// release_apply's decision inputs, as the pure functions planApply builds them from: which subject
// is currently released (semver, never text), which owner teams an approval speaks for (membership,
// bound to the attempt and its digest), and whether another attempt already holds the plugin.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { approvedOwners, applyingRefusal, STALE_APPLYING_MS } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/release-rules.js")).href);
const { compareSemver, newestVersion, retractedVersions } =
  await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/release-head.js")).href);

// Semver, not text: text puts 0.9.0 above 0.43.0.
assert.equal(compareSemver("0.43.0", "0.9.0"), 1);
assert.equal(compareSemver("1.2.0", "1.2.0"), 0);
assert.equal(compareSemver("1.2.0-rc.1", "1.2.0"), -1, "a pre-release sorts below its release");
assert.equal(compareSemver("1.2", "1.2.0"), 0);
assert.equal(compareSemver("garbage", "0.0.1"), -1);
// Pre-release precedence, identifier by identifier (semver.org section 11).
const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
  "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
for (let i = 1; i < ordered.length; i += 1) {
  assert.equal(compareSemver(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compareSemver(ordered[i], ordered[i - 1]), 1, `${ordered[i]} > ${ordered[i - 1]}`);
}
assert.equal(compareSemver("1.0.0-rc.10", "1.0.0-rc.9"), 1, "numeric identifiers compare numerically");
assert.equal(compareSemver("1.0.0+build.5", "1.0.0"), 0, "build metadata is ignored");
// No leading numeric core — `v1.0.0` included — sorts below every version with one.
assert.equal(compareSemver("v9.0.0", "0.0.1"), -1);

// The head is the newest registered version by semver; first wins a tie; none is null.
assert.equal(newestVersion(["0.9.0", "0.43.0", "0.43.0-rc.1"]), "0.43.0");
assert.equal(newestVersion(["1.0.0-rc.9", "1.0.0-rc.10"]), "1.0.0-rc.10");
assert.equal(newestVersion([]), null);

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
assert.equal(citedReleaseAttempt(cite("-".repeat(36))), null, "a 36-character non-UUID cites nothing");
assert.equal(citedReleaseAttempt(cite("0b7a3c1e-1111-4222-8333-94445555666g")), null, "not hex");
assert.equal(citedReleaseAttempt(cite(a1.toUpperCase())), a1, "case-insensitive, lowercased");
// A rollback makes the prior version current again without deleting the retracted
// zz.plugin_version row: retractedVersions is the one rule, read by currentVersionOf
// (release-head.ts), which BOTH "what is released now" readers call — plugin_locate's head
// (subject.ts) and release_apply's baseline. checks/eval-release-head.ts pins what it answers.
import { readFileSync } from "node:fs";
let seen = "";
const stub = { async query(text: string) { seen = text; return { rows: [{ declared_version: "0.44.0" }] }; } };
assert.deepEqual(await retractedVersions(stub, "11111111-1111-4111-8111-111111111111"), ["0.44.0"]);
assert.match(seen, /status = 'rolled_back'/, "only a rolled_back attempt retracts its version");
assert.match(readFileSync("services/zz-core/src/release-head.ts", "utf8"), /await retractedVersions\(/,
  "currentVersionOf does not read the retracted versions");
console.log("ok eval-release-apply-pure");
process.exit(0);
