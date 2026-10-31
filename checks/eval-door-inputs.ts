#!/usr/bin/env node
/**
 * checks/eval-door-inputs.ts — the evaluation door refuses an argument that names nothing real, or
 * the wrong thing, in the tool's own words, and records nothing for it.
 *
 *   node checks/eval-door-inputs.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * scripts/schema/eval-door-seed.ts declares, and drives `/eval-mcp` with the same identity headers
 * the core door is given. What it establishes:
 *
 *   - `protocol_affirm` naming an initiative with no protocol.md is told the document does not
 *     exist, and a version already bound under a later document is told it is bound;
 *   - a malformed id handed to `protocol_affirm`, `improvement_start`, `candidate_record`,
 *     `candidate_validate`, `finding_record`, `finding_decide`, `evaluation_start`, `protocol_read`,
 *     `protocol_record`, `release_verify` or `release_apply` is refused with `ERROR:`, never with
 *     PostgreSQL's `invalid input syntax for type uuid`, and `finding_decide` still decides the
 *     well-formed findings of the same batch;
 *   - `plugin_locate` naming a version a registered plugin has no row for names that version, not
 *     the plugin as unregistered;
 *   - `plugin_profile` refuses a window bound that is not an ISO date or timestamp, and a window
 *     whose start is not before its end, recording no snapshot;
 *   - `improvement_start` naming a finding already decided, or a strength, is refused and opens no
 *     improvement run;
 *   - `candidate_record` on a version other than the one the run evaluated, or with a patch that
 *     names no file, is refused and records nothing;
 *   - `plugin_register` refuses a blank name or version, and a catalog plugin's name in any case;
 *   - `plugin_conform` refuses a version the plugin never registered;
 *   - `finding_record` refuses a blank pattern, and an expected_effect on a finding another owner
 *     holds.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";
import { ask, evalDoor, finding, one, PLUGIN, seed, SLUG, VERSION, type Seed } from "../scripts/schema/eval-door-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "eval-door-inputs";
const DONE = "eval-door-inputs: an argument naming nothing real, or the wrong thing, is refused in the tool's own " +
  "words and records nothing: ok";

delete process.env.TYPESAFE_API_KEY;

async function affirmWithNoDocument(c: Core, s: Seed): Promise<void> {
  const step = "protocol_affirm where no protocol.md was written";
  await c.sql.query("insert into zz.initiative (team_id, slug, flow) values ($1, '2026-10-31-no-protocol', '')", [s.team]);
  const reply = await ask(evalDoor(c, c.email), "protocol_affirm",
    { protocol_version_id: s.protocols.bound, initiative: "2026-10-31-no-protocol", idempotency_key: "affirm-nodoc" });
  if (!reply.includes("does not exist") || reply.includes("Call document_approve")) c.fail(step, `answered ${reply.slice(0, 300)}`);
  // A bound version named under an approved protocol.md written for a later version is told it is
  // already affirmed, not that the document fails to quote it. It is bound first, under the seeded
  // initiative whose protocol.md quotes it.
  const first = await ask(evalDoor(c, c.email), "protocol_affirm",
    { protocol_version_id: s.protocols.replayed, initiative: SLUG, idempotency_key: "affirm-bind" });
  if (first.startsWith("ERROR")) c.fail(step, `binding the version answered ${first.slice(0, 300)}`);
  const later = (await one<{ id: string }>(c,
    "insert into zz.initiative (team_id, slug, flow) values ($1, '2026-10-31-later-protocol', '') returning id::text as id", [s.team])).id;
  await c.sql.query("BEGIN");
  await c.sql.query("SET CONSTRAINTS ALL DEFERRED");
  const doc = (await one<{ id: string }>(c,
    `insert into zz.doc (initiative_id, path, status, updated_at, current_revision, current_version)
     values ($1, 'protocol.md', 'draft', now(), 1, 1) returning id::text as id`, [later])).id;
  await c.sql.query(
    `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                  written_by, written_at, fields, approved_by, approved_at)
     values ($1, 1, 1, 'retained', 'Protocol', '# Protocol v3\n\ndigest-later-0003\n', '{}', 'h3', $2, now(), '{}', $2, now())`,
    [doc, s.me]);
  await c.sql.query("update zz.doc set status = 'approved', approved_revision = 1 where id = $1", [doc]);
  await c.sql.query("COMMIT");
  const bound = await ask(evalDoor(c, c.email), "protocol_affirm",
    { protocol_version_id: s.protocols.replayed, initiative: "2026-10-31-later-protocol", idempotency_key: "affirm-later" });
  if (!bound.includes("is already affirmed")) c.fail(step, `a bound version under a later document answered ${bound.slice(0, 300)}`);
  c.pass(step);
}

async function malformedIdsAreNamed(c: Core, s: Seed): Promise<void> {
  const step = "a malformed id on the evaluation door";
  const door = evalDoor(c, c.email);
  const good = await finding(c, s, "a finding decided beside a malformed id");
  const calls: [string, Record<string, unknown>][] = [
    ["protocol_affirm", { protocol_version_id: "abc", initiative: SLUG, idempotency_key: "bad-1" }],
    ["improvement_start", { eval_run_id: "abc", finding_ids: [], idempotency_key: "bad-2" }],
    ["improvement_start", { eval_run_id: s.run, finding_ids: ["abc"], idempotency_key: "bad-3" }],
    ["candidate_record", { improvement_run_id: "abc", base_subject_version_id: s.versionId, hypothesis: "h",
                           expected_effect: {}, patchset: { diff: "x" }, idempotency_key: "bad-4" }],
    ["candidate_validate", { candidate_id: "abc", idempotency_key: "bad-5" }],
    ["finding_record", { eval_run_id: "abc", finding: { kind: "defect", pattern: "p", owner_kind: "plugin" },
                         idempotency_key: "bad-6" }],
    ["finding_decide", { decisions: [{ finding_id: "abc", decision: "applied", note: "n" },
                                     { finding_id: good, decision: "applied", note: "n" }], idempotency_key: "bad-7" }],
    ["evaluation_start", { subject_version_id: s.versionId, protocol_version_id: s.protocols.replayed,
                           observation_snapshot_id: "abc", idempotency_key: "bad-8" }],
    ["protocol_read", { subject_version_id: "zzz" }],
    ["protocol_record", { subject_version_id: "nope", idempotency_key: "bad-9",
                          protocol_body: JSON.parse(readFileSync(join(root, "catalog/zz/zz-plugin-eval/protocols/zz-core.json"), "utf8")) }],
    ["release_verify", { release_attempt_id: "zz", idempotency_key: "bad-10" }],
    ["release_apply", { candidate_id: "zz", approved_patch_digest: "d", initiative: SLUG, idempotency_key: "bad-11" }],
  ];
  const raw: string[] = [];
  for (const [tool, args] of calls) {
    const reply = await ask(door, tool, args);
    // A refusal opens with ERROR: — what the gateway counts as one — except finding_decide's, which
    // decides the well-formed finding beside the malformed one.
    if (/invalid input syntax|THROWN/.test(reply) || (tool !== "finding_decide" && !reply.startsWith("ERROR:"))) {
      raw.push(`${tool}: ${reply.slice(0, 160)}`);
    }
  }
  if (raw.length) c.fail(step, `answered with the database's words:\n    ${raw.join("\n    ")}`);
  const decided = (await one<{ decision: string | null }>(c, "select decision from zz.eval_finding where id = $1", [good])).decision;
  if (decided !== "applied") c.fail(step, `the well-formed finding beside the malformed one is ${decided}, not applied`);
  c.pass(step);
}

async function unknownVersionIsNamed(c: Core): Promise<void> {
  const step = "plugin_locate naming a version a registered plugin has no row for";
  const reply = await ask(evalDoor(c, c.email), "plugin_locate", { plugin: PLUGIN, version: "9.9.9", idempotency_key: "locate-1" });
  if (!/9\.9\.9/.test(reply) || /no plugin named/.test(reply)) c.fail(step, `answered: ${reply.slice(0, 300)}`);
  c.pass(step);
}

async function profileWindowIsTimes(c: Core, s: Seed): Promise<void> {
  const step = "plugin_profile with a window that is not two times in order";
  const door = evalDoor(c, c.email);
  const snapshots = async () => Number((await one<{ n: string }>(c, "select count(*)::text as n from zz.eval_observation_snapshot")).n);
  const before = await snapshots();
  for (const [window, said] of [
    [{ from: "yesterday", to: "now" }, `"yesterday" is not an ISO date or timestamp`],
    [{ from: "2026-12-01", to: "2026-01-01" }, "is not before"],
  ] as const) {
    const reply = await ask(door, "plugin_profile",
      { subject_version_id: s.versionId, evidence_window: window, idempotency_key: `window-${window.from}` });
    if (!reply.startsWith("ERROR:") || !reply.includes(said)) c.fail(step, `${JSON.stringify(window)} answered ${reply.slice(0, 300)}`);
  }
  if (await snapshots() !== before) c.fail(step, "a snapshot was recorded");
  c.pass(step);
}

async function candidateBaseIsTheEvaluatedVersion(c: Core, s: Seed): Promise<void> {
  const step = "candidate_record on another version, or with no diff";
  const door = evalDoor(c, c.email);
  const improvement = (await one<{ id: string }>(c,
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, now()) returning id::text as id", [s.run])).id;
  const later = (await one<{ id: string }>(c,
    "insert into zz.plugin_version (plugin_id, version, digest) values ($1, '0.0.2', 'check') returning id::text as id",
    [s.pluginId])).id;
  const diff = "--- a/skills/x/SKILL.md\n+++ b/skills/x/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n";
  const candidates = async () => Number((await one<{ n: string }>(c, "select count(*)::text as n from zz.candidate")).n);
  const before = await candidates();
  for (const [base, patch, said] of [
    [later, diff, `version 0.0.2, not ${PLUGIN} ${VERSION}`],
    [s.versionId, "hello world", "names no file"],
  ] as const) {
    const reply = await ask(door, "candidate_record", {
      improvement_run_id: improvement, base_subject_version_id: base, hypothesis: `base check ${said}`,
      expected_effect: {}, patchset: { diff: patch }, idempotency_key: `base-${said}` });
    if (!reply.startsWith("ERROR:") || !reply.includes(said)) c.fail(step, `answered ${reply.slice(0, 300)}`);
  }
  if (await candidates() !== before) c.fail(step, "a candidate was recorded");
  c.pass(step);
}

async function registerNamesAreReal(c: Core, s: Seed): Promise<void> {
  const step = "plugin_register with a blank or look-alike name";
  const door = evalDoor(c, c.email);
  const plugins = async () => Number((await one<{ n: string }>(c, "select count(*)::text as n from zz.plugin")).n);
  const before = await plugins();
  for (const [name, version, said] of [
    ["", "1.0.0", "name and version must not be blank"],
    ["tp-blank", " ", "name and version must not be blank"],
    [PLUGIN.toUpperCase(), "1.0.0", `${PLUGIN.toUpperCase()} is a catalog plugin`],
  ] as const) {
    const reply = await ask(door, "plugin_register", {
      name, version, source_kind: "local_dir", source_locator: "/nowhere", idempotency_key: `register-${name}-${version}` });
    if (!reply.startsWith("ERROR:") || !reply.includes(said)) c.fail(step, `${JSON.stringify(name)} answered ${reply.slice(0, 300)}`);
  }
  if (await plugins() !== before) c.fail(step, "a plugin was registered");
  c.pass(step);
}

async function conformNamesARealVersion(c: Core): Promise<void> {
  const step = "plugin_conform on a version nobody registered";
  const door = evalDoor(c, c.email);
  const missing = await ask(door, "plugin_conform", { plugin: PLUGIN, version: "99.9.9" });
  if (!missing.startsWith("ERROR:") || !missing.includes("99.9.9")) c.fail(step, `answered ${missing.slice(0, 300)}`);
  const real = await ask(door, "plugin_conform", { plugin: PLUGIN, version: VERSION });
  if (!real.includes(`"version": "${VERSION}"`)) c.fail(step, `the registered version answered ${real.slice(0, 300)}`);
  c.pass(step);
}

async function findingRecordShape(c: Core, s: Seed): Promise<void> {
  const step = "finding_record with a blank pattern, or an effect it cannot own";
  const door = evalDoor(c, c.email);
  const count = async () => Number((await one<{ n: string }>(c, "select count(*)::text as n from zz.eval_finding")).n);
  const before = await count();
  for (const [finding, said] of [
    [{ kind: "defect", pattern: "  ", owner_kind: "plugin" }, "pattern must say what was found"],
    [{ kind: "defect", pattern: "the platform refused", owner_kind: "platform", expected_effect: { tool_refusal_rate: "-0.1" } },
     "expected_effect belongs to a plugin-owned finding"],
  ] as const) {
    const reply = await ask(door, "finding_record", { eval_run_id: s.run, finding, idempotency_key: `shape-${finding.owner_kind}` });
    if (!reply.startsWith("ERROR:") || !reply.includes(said)) c.fail(step, `answered ${reply.slice(0, 300)}`);
  }
  if (await count() !== before) c.fail(step, "a finding was recorded");
  c.pass(step);
}

async function improvementStartTakesOpenDefects(c: Core, s: Seed): Promise<void> {
  const step = "improvement_start on a decided finding or a strength";
  const door = evalDoor(c, c.email);
  const applied = await finding(c, s, "start: already applied");
  await c.sql.query(
    "update zz.eval_finding set decision = 'applied', decided_by = $2, decided_at = now(), decision_note = 'fixed' where id = $1",
    [applied, s.me]);
  const strength = (await one<{ id: string }>(c,
    `insert into zz.eval_finding (pattern, owner_kind, eval_run_id, kind)
     values ('start: a strength', 'plugin', $1, 'strength') returning id::text as id`, [s.run])).id;
  const runs = async () => Number((await one<{ n: string }>(c, "select count(*)::text as n from zz.improvement_run")).n);
  const before = await runs();
  for (const [id, said] of [[applied, `finding ${applied} is already applied`], [strength, `finding ${strength} is a strength`]]) {
    const reply = await ask(door, "improvement_start", { eval_run_id: s.run, finding_ids: [id], idempotency_key: `start-${id}` });
    if (!reply.startsWith("ERROR:") || !reply.includes(said)) c.fail(step, `answered ${reply.slice(0, 300)}`);
  }
  if (await runs() !== before) c.fail(step, "an improvement_run was opened");
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME, DONE, async (c) => {
  const s = await seed(c);
  const failed: string[] = [];
  for (const run of [affirmWithNoDocument, malformedIdsAreNamed, unknownVersionIsNamed, profileWindowIsTimes,
                     candidateBaseIsTheEvaluatedVersion, registerNamesAreReal, conformNamesARealVersion,
                     findingRecordShape, improvementStartTakesOpenDefects]) {
    try {
      await run(c, s);
    } catch (err) {
      failed.push((err as Error).message);
    }
  }
  if (failed.length) c.fail("the cases above", `${failed.length} failed:\n  ${failed.join("\n  ")}`);
});
