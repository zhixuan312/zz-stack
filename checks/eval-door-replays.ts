#!/usr/bin/env node
/**
 * checks/eval-door-replays.ts — the evaluation door answers a retried call with what the first call
 * did, binds nothing for a caller with no team, and refuses a malformed id in its own words.
 *
 *   node checks/eval-door-replays.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds one
 * plugin's release, protocol versions, observation, evaluation run, findings and release attempts
 * with SQL, and drives `/eval-mcp` with the same identity headers the core door is given. What it
 * establishes:
 *
 *   - `protocol_affirm` by a person in no team binds nothing, even when another team's approved
 *     `protocol.md` under that initiative quotes the version's digest;
 *   - `protocol_affirm` retried with the same key after it bound answers the binding again, not a
 *     refusal that the version is already affirmed;
 *   - a malformed id handed to `protocol_affirm`, `improvement_start`, `candidate_record`,
 *     `candidate_validate`, `finding_record`, `finding_decide` or `evaluation_start` is refused in
 *     the tool's own words, never with PostgreSQL's `invalid input syntax for type uuid`, and
 *     `finding_decide` still decides the well-formed findings of the same batch;
 *   - `plugin_locate` naming a version a registered plugin has no row for names that version,
 *     not the plugin as unregistered;
 *   - `evaluator_qualify` retried with the same key answers what its first call answered, and one
 *     whose typed service answers nothing is refused with no qualification written;
 *   - `finding_decide` retried with the same key reports as decided only the findings that call
 *     decided, not one somebody else had already decided;
 *   - `plugin_profile` retried with the same key answers the snapshot it recorded after the
 *     window's calls are gone;
 *   - a replayed `release_record` lists as decided only the findings its own call decided, and a
 *     replayed `release_apply` hands the patch and plan only to the call that moved the attempt
 *     to `applying` — read through the built replay functions on zz-core's own pool;
 *   - the readings `evaluation_score` returns carry the reading each value's assessment recorded,
 *     and a guardrail on a measure of a dimension the protocol marks not applicable is not read;
 *   - a qualification's label evidence pairs a decided finding only with answers of its own run,
 *     and counts its labels as findings;
 *   - `protocol_record` refused for a stale version leaves no evaluator version registered;
 *   - a `wholeDocument` measure asks every part of a long document of a stub typed service on a
 *     local port, several at a time and never more than eight — and two such measures sharing one
 *     set of slots, as `evaluation_assess` answers its plan, still no more than eight together.
 *   - a yes/no answer in the unclear band is excluded with a reason naming it and its probability;
 *   - `finding_record` with `supersedes` closes the old finding as rejected and superseded by the new
 *     one, and a second correction of it is refused with nothing written;
 *   - `finding_decide` regenerates findings.md in the initiative whose EVALUATE record names the run;
 *   - `release_record` of a rollback reopens the findings its release applied, and only those, and
 *     findings.md says so;
 *   - `evaluation_score` on a run already scored is refused under a new key, and the published score
 *     stands;
 *   - `protocol_record` writes each model-backed measure against the evaluator version it registered;
 *   - a knowledge subject_ref resolves, for the text judged and for the row pinned, to the node its
 *     ordinal and slug name, on the caller's shelf or the platform's, with both numbering from one.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";
import { ask, evalDoor, finding, LONER, one, OTHER, PLUGIN, seed, SLUG, VERSION, type Seed } from "../scripts/schema/eval-door-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "eval-door-replays";
const DONE = "eval-door-replays: a retried evaluation call answers what its first call did, a caller in no team " +
  "binds nothing, and a malformed id is refused in the tool's own words: ok";

delete process.env.TYPESAFE_API_KEY;

// A typed service that answers every call 400 after a pause, counting how many calls it holds at
// once — or, with `noul` set, answers every question yes/no with that probability. zz-core's child
// inherits the address and no key, so only a case that sets a key in this process asks it anything.
const typed = { inFlight: 0, most: 0, calls: 0, noul: null as number | null };
const typedServer = createServer((req, res) => {
  typed.calls += 1;
  typed.inFlight += 1;
  typed.most = Math.max(typed.most, typed.inFlight);
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => setTimeout(() => {
    typed.inFlight -= 1;
    if (typed.noul === null) { res.writeHead(400).end("stub"); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; questions?: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(body.questions ?? {}).map((k) =>
      [k, { type: "noul", noul: typed.noul, confidence: Math.abs((typed.noul as number) - 0.5) * 2 }]));
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ model: body.model ?? "jev-latest", usage: { input_tokens: 1, output_tokens: 1 }, answers }));
  }, 40));
});
await new Promise<void>((r) => typedServer.listen(0, "127.0.0.1", r));
process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${(typedServer.address() as AddressInfo).port}`;

async function affirmBindsNothingWithoutATeam(c: Core, s: Seed): Promise<void> {
  const step = "protocol_affirm by a person in no team";
  const reply = await ask(evalDoor(c, LONER), "protocol_affirm",
    { protocol_version_id: s.protocols.bound, initiative: SLUG, idempotency_key: "loner-1" });
  const bound = (await one<{ doc: string | null }>(c,
    "select approved_doc_id::text as doc from zz.eval_protocol_version where id = $1", [s.protocols.bound])).doc;
  if (bound !== null || !reply.startsWith("ERROR")) {
    c.fail(step, `bound to ${bound} and answered: ${reply.slice(0, 300)}`);
  }
  c.pass(step);
}

async function affirmReplays(c: Core, s: Seed): Promise<void> {
  const step = "protocol_affirm retried with its key";
  const door = evalDoor(c, c.email);
  const args = { protocol_version_id: s.protocols.replayed, initiative: SLUG, idempotency_key: "affirm-1" };
  const first = await ask(door, "protocol_affirm", args);
  if (first.startsWith("ERROR") || first.startsWith("THROWN")) c.fail(step, `the first call did not bind: ${first}`);
  const again = await ask(door, "protocol_affirm", args);
  if (again !== first) c.fail(step, `the retry answered ${again.slice(0, 300)}, not the first call's answer`);
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
  ];
  const raw: string[] = [];
  for (const [tool, args] of calls) {
    const reply = await ask(door, tool, args);
    if (/invalid input syntax|THROWN/.test(reply)) raw.push(`${tool}: ${reply.slice(0, 160)}`);
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

async function decideReplays(c: Core, s: Seed): Promise<void> {
  const step = "finding_decide retried with its key";
  const door = evalDoor(c, c.email);
  const mine = await finding(c, s, "decided by this call");
  const theirs = await finding(c, s, "decided by somebody else first", s.other);
  const args = { decisions: [{ finding_id: mine, decision: "applied", note: "fixed in 1.2" },
                             { finding_id: theirs, decision: "applied", note: "fixed in 1.2" }],
                 idempotency_key: "decide-1" };
  const ids = (reply: string) => ((JSON.parse(reply) as { findings?: { id: string }[] }).findings ?? []).map((f) => f.id);
  const first = await ask(door, "finding_decide", args);
  if (JSON.stringify(ids(first)) !== JSON.stringify([mine])) c.fail(step, `the first call answered ${first.slice(0, 300)}`);
  const again = await ask(door, "finding_decide", args);
  if (JSON.stringify(ids(again)) !== JSON.stringify([mine])) {
    c.fail(step, `the retry reports as decided ${JSON.stringify(ids(again))}, not [${mine}] alone`);
  }
  c.pass(step);
}

async function profileReplays(c: Core, s: Seed): Promise<void> {
  const step = "plugin_profile retried after its window's calls are gone";
  const door = evalDoor(c, c.email);
  await c.sql.query(
    `insert into zz.event (kind, subject, detail, ok, team_id, plugin, plugin_version, tool_key, ts)
     values ('tool_call', 'core:document_read', '{}', true, $1, $2, $3, 'core:document_read', '2026-10-30T12:00:00Z')`,
    [s.team, PLUGIN, VERSION]);
  const args = { subject_version_id: s.versionId, evidence_window: { from: "2026-10-30T00:00:00Z", to: "2026-10-31T00:00:00Z" },
                 idempotency_key: "profile-1" };
  const first = await ask(door, "plugin_profile", args);
  const id = /"observation_snapshot_id": "([0-9a-f-]{36})"/.exec(first)?.[1];
  if (!id) c.fail(step, `the first call recorded no snapshot: ${first.slice(0, 300)}`);
  await c.sql.query("delete from zz.event where plugin = $1 and plugin_version = $2", [PLUGIN, VERSION]);
  const again = await ask(door, "plugin_profile", args);
  if (!again.includes(`"observation_snapshot_id": "${id}"`)) {
    c.fail(step, `the retry answered ${again.slice(0, 300)}, not snapshot ${id}`);
  }
  c.pass(step);
}

/** One ledger row, as `withIdempotency` writes it, for a call `email` made at `at`. */
async function ledger(c: Core, email: string, tool: string, key: string, attempt: string, at: string): Promise<void> {
  await c.sql.query(
    `insert into zz.eval_idempotency (principal_id, tool, idempotency_key, request_digest, result_table, result_id, created_at)
     values ((select id from zz.principal where email = $1), $2, $3, 'digest', 'zz.release_attempt', $4, $5::timestamptz)`,
    [email, tool, key, attempt, at]);
}

async function releaseReplays(c: Core, s: Seed): Promise<void> {
  const step = "a replayed release_record and release_apply";
  const { pool } = await c.inProcess();
  const load = (p: string) => import(pathToFileURL(join(root, "services/zz-core/dist/eval", p)).href);
  const { describeRecordOutcomeForReplay } = await load("release-record.js");
  const { describeApplyOutcomeForReplay } = await load("release-apply.js");
  const at = "2026-10-31T01:02:03.456789Z";
  const improvement = (await one<{ id: string }>(c,
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, now()) returning id::text as id", [s.run])).id;
  const mine = await finding(c, s, "applied by this release");
  const theirs = await finding(c, s, "rejected before the release landed", s.other);
  await c.sql.query(
    "update zz.eval_finding set decision = 'applied', decided_by = $2, decided_at = $3::timestamptz, decision_note = 'by release' where id = $1",
    [mine, s.me, at]);
  await c.sql.query(
    "insert into zz.improvement_run_finding (improvement_run_id, finding_id) values ($1, $2), ($1, $3)",
    [improvement, mine, theirs]);
  const candidate = (await one<{ id: string }>(c,
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, patch, proposed_by)
     values ($1, $2, 'h', '{}', 'pd', 0, '[]', 'valid', now(), 'diff', $3) returning id::text as id`,
    [improvement, s.versionId, s.me])).id;
  const released = (await one<{ id: string }>(c,
    `insert into zz.release_attempt (candidate_id, status, released_plugin_version_id, created_at, plugin_id)
     values ($1, 'released', $2, now(), $3) returning id::text as id`, [candidate, s.versionId, s.pluginId])).id;
  await ledger(c, c.email, "release_record", "record-1", released, at);
  const record = await describeRecordOutcomeForReplay(pool, released, { principal: c.email, tool: "release_record", key: "record-1" }) as
    { findings_decided: { id: string }[] };
  const decided = record.findings_decided.map((f) => f.id);
  if (JSON.stringify(decided) !== JSON.stringify([mine])) {
    c.fail(step, `release_record's replay lists as decided ${JSON.stringify(decided)}, not [${mine}] alone`);
  }

  // An attempt another call moved to applying, after this caller's call was refused on it.
  const candidate2 = (await one<{ id: string }>(c,
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, patch, proposed_by)
     values ($1, $2, 'h', '{}', 'pd2', 0, '[]', 'valid', now(), 'diff', $3) returning id::text as id`,
    [improvement, s.versionId, s.me])).id;
  const applying = (await one<{ id: string }>(c,
    `insert into zz.release_attempt (candidate_id, status, created_at, plugin_id, reason, applying_at, applied_by)
     values ($1, 'applying', now(), $2, 'approval_required', $3::timestamptz, $4) returning id::text as id`,
    [candidate2, s.pluginId, at, s.other])).id;
  await ledger(c, c.email, "release_apply", "apply-refused", applying, "2026-10-30T00:00:00Z");
  await ledger(c, OTHER, "release_apply", "apply-won", applying, at);
  const refusedReplay = await describeApplyOutcomeForReplay(pool, applying,
    { principal: c.email, tool: "release_apply", key: "apply-refused" }) as { status: string; patch: unknown };
  if (refusedReplay.status !== "refused" || refusedReplay.patch !== null) {
    c.fail(step, `a replay of the refused call answered ${refusedReplay.status} with ${refusedReplay.patch ? "a patch" : "no patch"}`);
  }
  const wonReplay = await describeApplyOutcomeForReplay(pool, applying,
    { principal: OTHER, tool: "release_apply", key: "apply-won" }) as { status: string; patch: unknown };
  if (wonReplay.status !== "applying" || wonReplay.patch === null) {
    c.fail(step, `a replay of the call that applied answered ${wonReplay.status} with ${wonReplay.patch ? "a patch" : "no patch"}`);
  }
  c.pass(step);
}

async function readingsCarryTheReading(c: Core, s: Seed): Promise<void> {
  const step = "evaluation_score's readings";
  const { pool } = await c.inProcess();
  const load = (p: string) => import(pathToFileURL(join(root, "services/zz-core/dist/eval", p)).href);
  const { STORED_ANSWERS_SQL } = await load("evaluate-run.js");
  const { readingsOf } = await load("evaluate-measures.js");
  const dimension = (await one<{ id: string }>(c,
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
     values ($1, 'd', 'effectiveness', 1, true) returning id::text as id`, [s.protocols.replayed])).id;
  const measure = (await one<{ id: string }>(c,
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id)
     values ($1, 'm', 'human', 1, true, '{}', $2) returning id::text as id`, [dimension, s.protocols.replayed])).id;
  const assessment = (await one<{ id: string }>(c,
    `insert into zz.assessment (family, instruction_version, question_digest, reading, probability, team_id, asked_by)
     values ('repeats_finding', 1, 'q', 'no', 0.1, $1, $2) returning id::text as id`, [s.team, s.me])).id;
  await c.sql.query(
    `insert into zz.eval_assessment (eval_run_id, measure_id, created_at, subject_kind, value, assessment_id)
     values ($1, $2, now(), 'run_level', 0.1, $3)`, [s.run, measure, assessment]);
  const rows = (await pool.query(`${STORED_ANSWERS_SQL} where a.eval_run_id = $1::uuid`, [s.run])).rows;
  const readings = readingsOf(rows, new Map([[measure, "m"]])) as Record<string, { reading?: string }[]>;
  if (readings.m?.[0]?.reading !== "no") c.fail(step, `the reading behind the value is missing: ${JSON.stringify(readings)}`);
  c.pass(step);
}

async function notApplicableGuardrailIsNotRead(c: Core, s: Seed): Promise<void> {
  const step = "a guardrail on a measure of a dimension the protocol marks not applicable";
  const dimension = (await one<{ id: string }>(c,
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required, applicable, not_applicable_reason)
     values ($1, 'na', 'efficiency', 0, false, false, 'this plugin writes no document') returning id::text as id`,
    [s.protocols.replayed])).id;
  await c.sql.query(
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id,
                                  guardrail_threshold)
     values ($1, 'g', 'human', 1, true, '{}', $2, 0.5)`, [dimension, s.protocols.replayed]);
  const reply = await ask(evalDoor(c, c.email), "evaluation_score", { eval_run_id: s.run, idempotency_key: "score-1" });
  const scored = JSON.parse(reply) as { guardrail_status?: string; guardrails?: { key: string }[] };
  if (scored.guardrail_status === "not_established" || scored.guardrails?.some((g) => g.key === "g")) {
    c.fail(step, `the run reads it: guardrail_status ${scored.guardrail_status}, guardrails ${JSON.stringify(scored.guardrails)}`);
  }
  c.pass(step);
}

async function qualifyReplays(c: Core, s: Seed): Promise<void> {
  const step = "evaluator_qualify retried with its key";
  const evaluator = (await one<{ id: string }>(c,
    `insert into zz.eval_evaluator_version (version, question, answer_schema, content_digest, stable_key)
     values (1, 'Does it hold?', '{"type":"noul"}', 'cd', 'check-evaluator') returning id::text as id`)).id;
  const dimension = (await one<{ id: string }>(c,
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
     values ($1, 'q', 'reliability', 0, false) returning id::text as id`, [s.protocols.replayed])).id;
  await c.sql.query(
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id,
                                  evaluator_version_id)
     values ($1, 'sem', 'bounded_semantic', 1, false, '{}', $2, $3)`, [dimension, s.protocols.replayed, evaluator]);
  const door = evalDoor(c, c.email);
  const args = { protocol_version_id: s.protocols.replayed, measure_key: "sem", idempotency_key: "qualify-1" };
  const first = await ask(door, "evaluator_qualify", args);
  if (!first.startsWith("{")) c.fail(step, `the first call answered ${first.slice(0, 300)}`);
  const again = await ask(door, "evaluator_qualify", args);
  if (again !== first) c.fail(step, `the retry answered a different shape:\n${again.slice(0, 600)}\nnot\n${first.slice(0, 600)}`);
  c.pass(step);
}

/** An evaluator nobody could ask is not an evaluator that answered wrongly: with no typed service
 *  answering, `evaluator_qualify` refuses and writes no qualification, rather than recording
 *  `unqualified` with a reason blaming the anchors (runtime pass 2, F4). */
async function qualifyOutageRecordsNothing(c: Core, s: Seed): Promise<void> {
  const step = "evaluator_qualify while the typed service answers nothing";
  const evaluator = (await one<{ id: string }>(c,
    `insert into zz.eval_evaluator_version (version, question, answer_schema, content_digest, stable_key)
     values (1, 'Does it hold?', '{"type":"noul"}', 'cd-outage', 'check-outage') returning id::text as id`)).id;
  const dimension = (await one<{ id: string }>(c,
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
     values ($1, 'qo', 'reliability', 0, false) returning id::text as id`, [s.protocols.replayed])).id;
  const anchors = [
    { id: "a-yes", role: "anchor", text: "It holds.", expected: "yes" },
    { id: "a-no", role: "anchor", text: "It does not hold.", expected: "no" },
    { id: "f-1", role: "fault", text: "It holds, mostly.", expected: "no" },
    { id: "c-1", role: "control", text: "A recipe for bread.", expected: "no" },
  ];
  const measure = (await one<{ id: string }>(c,
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id,
                                  evaluator_version_id)
     values ($1, 'sem-outage', 'bounded_semantic', 1, false, $2::jsonb, $3, $4) returning id::text as id`,
    [dimension, JSON.stringify({ qualification: { anchors } }), s.protocols.replayed, evaluator])).id;
  const reply = await ask(evalDoor(c, c.email), "evaluator_qualify",
    { protocol_version_id: s.protocols.replayed, measure_key: "sem-outage", idempotency_key: "qualify-outage-1" });
  const rows = (await one<{ n: number }>(c,
    "select count(*)::int as n from zz.eval_evaluator_qualification where measure_id = $1", [measure])).n;
  if (!/^ERROR: .*no answer to 12 of 12 asks/.test(reply) || rows !== 0) {
    c.fail(step, `${rows} qualification row(s) written, and it answered: ${reply.slice(0, 400)}`);
  }
  c.pass(step);
}

async function labelsPairWithinARun(c: Core, s: Seed): Promise<void> {
  const step = "label evidence pairs a decided finding with its own run's answers";
  const { pool } = await c.inProcess();
  const { labelEvidence } = await import(pathToFileURL(join(root, "services/zz-core/dist/eval/qualify-evidence.js")).href);
  const dimension = (await one<{ id: string }>(c,
    `insert into zz.eval_dimension (protocol_version_id, key, canonical_kind, weight, required)
     values ($1, 'l', 'generalization', 0, false) returning id::text as id`, [s.protocols.replayed])).id;
  const measure = (await one<{ id: string }>(c,
    `insert into zz.eval_measure (dimension_id, key, evaluator_type, weight, required, definition, protocol_version_id)
     values ($1, 'lab', 'human', 1, false, '{}', $2) returning id::text as id`, [dimension, s.protocols.replayed])).id;
  const otherRun = (await one<{ id: string }>(c,
    `insert into zz.eval_run (protocol_version_id, created_at, team_id, observation_snapshot_id, started_by)
     values ($1, now(), $2, $3, $4) returning id::text as id`, [s.protocols.replayed, s.team, s.snapshot, s.me])).id;
  for (const [decision, pattern] of [["applied", "labelled applied"], ["rejected", "labelled rejected"]]) {
    await c.sql.query(
      `insert into zz.eval_finding (pattern, decision, owner_kind, eval_run_id, kind, measure_id, decided_by, decided_at)
       values ($1, $2, 'plugin', $3, 'defect', $4, $5, now())`, [pattern, decision, s.run, measure, s.me]);
  }
  const answer = async (run: string, reading: string) => {
    const a = (await one<{ id: string }>(c,
      `insert into zz.assessment (family, instruction_version, question_digest, reading, probability, team_id, asked_by)
       values ('repeats_finding', 1, 'q', $1, 0.5, $2, $3) returning id::text as id`, [reading, s.team, s.me])).id;
    // One subject per answer: an assessment is unique per (run, measure, subject).
    const bug = (await one<{ id: string }>(c,
      "insert into zz.bug (title, detail, reported_by) values ('subject', 'subject', $1) returning id::text as id", [s.me])).id;
    await c.sql.query(
      `insert into zz.eval_assessment (eval_run_id, measure_id, created_at, subject_kind, bug_id, value, assessment_id)
       values ($1, $2, now(), 'bug', $3, 0.5, $4)`, [run, measure, bug, a]);
  };
  const mapping = { evaluator: "check-evaluator", applied: "yes", rejected: "no" };
  await answer(otherRun, "yes");
  await answer(otherRun, "no");
  const across = await labelEvidence(pool, measure, mapping);
  if (across !== null) c.fail(step, `answers of another run were paired with these findings: ${JSON.stringify(across)}`);
  await answer(s.run, "yes");
  await answer(s.run, "no");
  const within = await labelEvidence(pool, measure, mapping) as { n: number } | null;
  if (within?.n !== 2) c.fail(step, `two decided findings count as ${within?.n} labels`);
  c.pass(step);
}

/** `protocol_record` refused for a stale version leaves no evaluator version behind: the
 *  evaluators a body names are registered in the call's own transaction, after the checks that
 *  can refuse it. */
async function staleRecordRegistersNothing(c: Core, s: Seed): Promise<void> {
  const step = "protocol_record refused for a stale version";
  const body = JSON.parse(readFileSync(join(root, "catalog/zz/zz-plugin-eval/protocols/zz-core.json"), "utf8"));
  const measure = body.dimensions.flatMap((d: { measures: { evaluatorType: string }[] }) => d.measures)
    .find((m: { evaluatorType: string }) => m.evaluatorType === "bounded_semantic" || m.evaluatorType === "generative_critic");
  measure.evaluator.stable_key = "check.stale-record";
  body.version = 1;
  const reply = await ask(evalDoor(c, c.email), "protocol_record",
    { subject_version_id: s.versionId, protocol_body: body, idempotency_key: "record-stale-1" });
  if (!/version/i.test(reply) || /protocol_version_id/.test(reply)) c.fail(step, `a stale version was not refused: ${reply.slice(0, 300)}`);
  const left = (await one<{ n: number }>(c,
    "select count(*)::int as n from zz.eval_evaluator_version where stable_key = 'check.stale-record'")).n;
  if (left !== 0) c.fail(step, `the refused call left ${left} evaluator version(s) registered`);
  c.pass(step);
}

/** A `wholeDocument` measure asks every part of a long document, eight at a time: each part is
 *  its own model call with a 100-second budget, inside a request severed at about two minutes. */
async function partsAreAskedTogether(c: Core): Promise<void> {
  const step = "a wholeDocument measure over a long document";
  await c.inProcess();
  const { answerMeasure, callSlots } = await import(pathToFileURL(join(root, "services/zz-core/dist/eval/evaluate-measures.js")).href);
  const evaluator = (await one<{ id: string }>(c,
    `insert into zz.eval_evaluator_version (stable_key, version, question, answer_schema, content_digest)
     values ('check.parts', 1, 'Is every section substantive?', '{"type":"noul"}', 'check-parts') returning id::text as id`)).id;
  const text = Array.from({ length: 12 }, (_, k) => `## Section ${k}\n\n${"word ".repeat(4_000)}\n`).join("\n");
  const measure = { id: "m", key: "parts", evaluator_type: "bounded_semantic", weight: 1, required: true,
    definition: { wholeDocument: true }, evaluator_version_id: evaluator };
  Object.assign(typed, { inFlight: 0, most: 0, calls: 0 });
  process.env.TYPESAFE_API_KEY = "stub";
  try {
    const answer = await answerMeasure({ measure, snapshot: { facts: {} }, subjectRef: "doc:check", principal: c.email,
      subjectText: text, qualificationOf: async () => ({ id: "q", state: "operationally_qualified" }) }) as
      { detail: { parts?: number } };
    const parts = answer.detail.parts ?? 1;
    if (typed.calls !== parts || parts < 9) c.fail(step, `${parts} parts were asked ${typed.calls} times`);
    if (typed.most < 2 || typed.most > 8) c.fail(step, `${parts} parts held ${typed.most} typed-service calls at once`);
    // Two such measures answered together, as `evaluation_assess` answers its plan, share one set
    // of slots: the request still holds no more than eight.
    Object.assign(typed, { inFlight: 0, most: 0, calls: 0 });
    const slot = callSlots(8);
    await Promise.all([1, 2].map(() => answerMeasure({ measure, snapshot: { facts: {} }, subjectRef: "doc:check",
      principal: c.email, subjectText: text, slot,
      qualificationOf: async () => ({ id: "q", state: "operationally_qualified" }) })));
    if (typed.calls !== 2 * parts || typed.most > 8) {
      c.fail(step, `two measures sharing slots asked ${typed.calls} times, ${typed.most} at once`);
    }
  } finally {
    delete process.env.TYPESAFE_API_KEY;
  }
  c.pass(step);
}

/** A yes/no evaluator that answers in the unclear band is excluded, and the reason says so with
 *  its probability, not that no comparable answer came back. */
async function unclearIsNamed(c: Core): Promise<void> {
  const step = "an unclear yes/no answer";
  await c.inProcess();
  const { answerMeasure } = await import(pathToFileURL(join(root, "services/zz-core/dist/eval/evaluate-measures.js")).href);
  const evaluator = (await one<{ id: string }>(c,
    `insert into zz.eval_evaluator_version (stable_key, version, question, answer_schema, content_digest)
     values ('check.unclear', 1, 'Is the section substantive?', '{"type":"noul"}', 'check-unclear') returning id::text as id`)).id;
  const measure = { id: "m", key: "unclear", evaluator_type: "bounded_semantic", weight: 1, required: true,
    definition: {}, evaluator_version_id: evaluator };
  Object.assign(typed, { inFlight: 0, most: 0, calls: 0, noul: 0.5 });
  process.env.TYPESAFE_API_KEY = "stub";
  try {
    const answer = await answerMeasure({ measure, snapshot: { facts: {} }, subjectRef: "doc:check", principal: c.email,
      subjectText: "## One\n\nA section.", qualificationOf: async () => ({ id: "q", state: "operationally_qualified" }) }) as
      { value: number | null; excluded_reason: string | null };
    if (answer.value !== null || !/unclear \(p=0\.50\)/.test(answer.excluded_reason ?? "")) {
      c.fail(step, `answered ${JSON.stringify(answer.value)} with the reason ${JSON.stringify(answer.excluded_reason)}`);
    }
  } finally {
    typed.noul = null;
    delete process.env.TYPESAFE_API_KEY;
  }
  c.pass(step);
}

/** A knowledge ref names the node its file name spells — ordinal and slug, on the caller's own
 *  shelf or the platform's — and the text judged is that node's. Each shelf numbers its own nodes,
 *  so the two seeded here share an ordinal. */
async function knowledgeRefsResolve(c: Core, s: Seed): Promise<void> {
  const step = "a knowledge subject_ref on either shelf";
  const { pool } = await c.inProcess();
  const { resolveSubjectRef, knowledgeNodeAt } = await import(pathToFileURL(join(root, "services/zz-core/dist/eval/subject-ref.js")).href);
  await c.sql.query("insert into zz.team (slug, name, created_by) select 'zz-platform', 'Platform', $1 " +
    "where not exists (select 1 from zz.team where slug = 'zz-platform')", [s.me]);
  const platform = (await one<{ id: string }>(c, "select id::text as id from zz.team where slug = 'zz-platform'")).id;
  const node = async (team: string, slug: string, title: string) => (await one<{ id: string }>(c,
    `insert into zz.knowledge_node (kind, title, body, team_id, node_ordinal, slug)
     values ('process', $1, 'body', $2, '0901', $3) returning id::text as id`, [title, team, slug])).id;
  const mine = await node(s.team, "on-the-team-shelf", "The team's node");
  const theirs = await node(platform, "on-the-platform-shelf", "The platform's node");
  for (const [ref, id, title] of [["_knowledge/nodes/0901-on-the-team-shelf.md", mine, "The team's node"],
                                  ["_knowledge/nodes/0901-on-the-platform-shelf.md", theirs, "The platform's node"]]) {
    const judged = await resolveSubjectRef(pool, c.team, ref) as { text?: string; error?: string };
    if (!judged.text?.startsWith(title)) c.fail(step, `${ref} resolved to ${JSON.stringify(judged)}, not "${title}"`);
    const pinned = await knowledgeNodeAt(pool, c.team, ref) as { id: string } | null;
    if (pinned?.id !== id) c.fail(step, `${ref} pins ${JSON.stringify(pinned)}, not node ${id}`);
  }
  const none = await resolveSubjectRef(pool, c.team, "_knowledge/nodes/0901-on-no-shelf.md") as { error?: string };
  if (!/names no journal node/.test(none.error ?? "")) c.fail(step, `an unknown slug resolved to ${JSON.stringify(none)}`);
  c.pass(step);
}

async function supersedeClosesTheOld(c: Core, s: Seed): Promise<void> {
  const step = "finding_record with supersedes";
  const door = evalDoor(c, c.email);
  const wrong = await finding(c, s, "reliability scored 7.5");
  const record = (key: string) => ask(door, "finding_record", {
    eval_run_id: s.run, supersedes: wrong, idempotency_key: key,
    finding: { kind: "defect", pattern: "reliability scored 7.7", owner_kind: "plugin" } });
  const first = await record("supersede-1");
  const made = (JSON.parse(first.startsWith("{") ? first : "{}") as { finding?: { id?: string } }).finding?.id;
  if (!made) c.fail(step, `the correction was not recorded: ${first.slice(0, 300)}`);
  const old = await one<{ decision: string; superseded_by: string | null }>(c,
    "select decision, superseded_by::text as superseded_by from zz.eval_finding where id = $1", [wrong]);
  if (old.decision !== "rejected" || old.superseded_by !== made) {
    c.fail(step, `the corrected finding reads ${JSON.stringify(old)}, not rejected and superseded by ${made}`);
  }
  // A second correction of the same finding is refused, and nothing is written for it.
  const before = (await one<{ n: number }>(c, "select count(*)::int as n from zz.eval_finding where eval_run_id = $1", [s.run])).n;
  const again = await record("supersede-2");
  const after = (await one<{ n: number }>(c, "select count(*)::int as n from zz.eval_finding where eval_run_id = $1", [s.run])).n;
  if (!again.includes(`was already superseded by ${made}`) || after !== before) {
    c.fail(step, `a second correction of ${wrong} answered ${again.slice(0, 300)} and the run went from ${before} findings to ${after}`);
  }
  c.pass(step);
}

/** findings.md is regenerated when a finding is decided, not only when one is recorded: finding_decide
 *  names no initiative, and the document a reader opens kept saying `deferred` about a finding the
 *  database held as applied (runtime pass 2, F9). */
async function decideRefreshesFindingsDoc(c: Core, s: Seed): Promise<void> {
  const step = "finding_decide regenerates findings.md";
  const door = evalDoor(c, c.email);
  const recorded = await ask(door, "finding_record", {
    eval_run_id: s.run, initiative: SLUG, idempotency_key: "refresh-record-1",
    finding: { kind: "defect", pattern: "refresh: the refusal names no next call", owner_kind: "plugin" } });
  const id = (JSON.parse(recorded.startsWith("{") ? recorded : "{}") as { finding?: { id?: string } }).finding?.id;
  const doc = async () => (await one<{ body: string | null }>(c,
    `select r.body from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where i.slug = $1 and d.path = 'findings.md'`, [SLUG]))?.body ?? null;
  const line = (body: string | null) => body?.split("\n").find((l) => l.includes(String(id))) ?? null;
  if (!id || !line(await doc())?.includes("decision: deferred")) {
    c.fail(step, `findings.md was not written with the deferred finding: ${recorded.slice(0, 300)}`);
  }
  // What EVALUATE records on the initiative, which is how a decision finds the document.
  await c.sql.query(
    `insert into zz.initiative_record (initiative_id, stage, id_name, value)
     select id, 'zz-plugin-evaluate', 'eval_run_id', $2 from zz.initiative where slug = $1
     on conflict do nothing`, [SLUG, s.run]);
  const decided = await ask(door, "finding_decide", {
    decisions: [{ finding_id: id, decision: "applied", note: "fixed in 9.9.9" }], idempotency_key: "refresh-decide-1" });
  const after = line(await doc());
  if (!after?.includes("decision: applied")) c.fail(step, `findings.md reads ${JSON.stringify(after)} after ${decided.slice(0, 300)}`);
  c.pass(step);
}

async function rollbackReopensFindings(c: Core, s: Seed): Promise<void> {
  const step = "a rollback reopens what its release applied";
  const plugin = (await one<{ id: string }>(c,
    "insert into zz.plugin (name, origin) values ('rollback-probe', 'platform') returning id::text as id")).id;
  const version = async (v: string) => (await one<{ id: string }>(c,
    "insert into zz.plugin_version (plugin_id, version, digest) values ($1, $2, 'check') returning id::text as id", [plugin, v])).id;
  const base = await version("1.0.0");
  const shipped = await version("1.1.0");
  const improvement = (await one<{ id: string }>(c,
    "insert into zz.improvement_run (eval_run_id, created_at) values ($1, now()) returning id::text as id", [s.run])).id;
  const fixed = await finding(c, s, "rollback: fixed by the release");
  const byHand = await finding(c, s, "rollback: applied by hand");
  await c.sql.query("insert into zz.improvement_run_finding (improvement_run_id, finding_id) values ($1, $2), ($1, $3)",
    [improvement, fixed, byHand]);
  const candidate = (await one<{ id: string }>(c,
    `insert into zz.candidate (improvement_run_id, base_plugin_version_id, hypothesis, expected_effect, patch_digest,
                               complexity_delta, touched_components, status, created_at, patch, proposed_by)
     values ($1, $2, 'h', '{}', 'pd-rollback', 0, '[]', 'valid', now(), 'diff', $3) returning id::text as id`,
    [improvement, base, s.me])).id;
  const attempt = (await one<{ id: string }>(c,
    `insert into zz.release_attempt (candidate_id, status, released_plugin_version_id, release_ref, created_at, plugin_id,
                                     applying_at, applied_by, verdict)
     values ($1, 'released', $2, $3, now(), $4, now(), $5, 'rolled_back') returning id::text as id`,
    [candidate, shipped, "a".repeat(40), plugin, s.me])).id;
  const decide = (id: string, note: string) => c.sql.query(
    "update zz.eval_finding set decision = 'applied', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1",
    [id, s.me, note]);
  await decide(fixed, `Applied by release rollback-probe@1.1.0 (release_attempt ${attempt})`);
  await decide(byHand, "fixed in the docs");
  await c.sql.query(
    `insert into zz.initiative_record (initiative_id, stage, id_name, value)
     select id, 'zz-plugin-evaluate', 'eval_run_id', $2 from zz.initiative where slug = $1
     on conflict do nothing`, [SLUG, s.run]);
  const reply = await ask(evalDoor(c, c.email), "release_record",
    { release_attempt_id: attempt, status: "rolled_back", reason: "measured worse", idempotency_key: "rollback-1" });
  const rows = (await c.sql.query<{ id: string; decision: string; decided_by: string | null }>(
    "select id::text as id, decision, decided_by::text as decided_by from zz.eval_finding where id = any($1::uuid[])",
    [[fixed, byHand]])).rows;
  const of = (id: string) => rows.find((r) => r.id === id);
  if (of(fixed)?.decision !== "deferred" || of(fixed)?.decided_by !== null || of(byHand)?.decision !== "applied"
      || !reply.includes(`"id": "${fixed}"`) || reply.includes(`"id": "${byHand}"`)) {
    c.fail(step, `the findings read ${JSON.stringify(rows)} after ${reply.slice(0, 400)}`);
  }
  const body = (await one<{ body: string | null }>(c,
    `select r.body from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where i.slug = $1 and d.path = 'findings.md'`, [SLUG]))?.body ?? "";
  const line = body.split("\n").find((l) => l.includes(fixed));
  if (!line?.includes("decision: deferred")) c.fail(step, `findings.md reads ${JSON.stringify(line)}`);
  c.pass(step);
}

async function scoredRunIsNotRescored(c: Core, s: Seed): Promise<void> {
  const step = "evaluation_score on a scored run under a new key";
  const scored = (await one<{ id: string }>(c,
    `insert into zz.eval_run (protocol_version_id, created_at, team_id, observation_snapshot_id, started_by,
                              score_status, overall_score, scored_at)
     values ($1, now(), $2, $3, $4, 'provisional', 6.5, now()) returning id::text as id`,
    [s.protocols.replayed, s.team, s.snapshot, s.me])).id;
  const reply = await ask(evalDoor(c, c.email), "evaluation_score", { eval_run_id: scored, idempotency_key: "rescore-1" });
  const row = await one<{ overall_score: string; score_status: string }>(c,
    "select overall_score::text as overall_score, score_status from zz.eval_run where id = $1", [scored]);
  if (!reply.includes("is already scored") || row.overall_score !== "6.5" || row.score_status !== "provisional") {
    c.fail(step, `answered ${reply.slice(0, 300)}, and the run reads ${JSON.stringify(row)}`);
  }
  c.pass(step);
}

/** `protocol_record` writes every model-backed measure against the evaluator version it registered
 *  for it, so each one resolves to a `zz.eval_evaluator_version` row under its own stable key. */
async function recordRegistersEvaluators(c: Core, s: Seed): Promise<void> {
  const step = "protocol_record registers every model-backed measure's evaluator";
  type Measure = { key: string; evaluatorType: string; evaluator?: { stable_key: string } };
  const body = JSON.parse(readFileSync(join(root, "catalog/zz/zz-plugin-eval/protocols/zz-core.json"), "utf8"));
  body.version = 3;
  const reply = await ask(evalDoor(c, c.email), "protocol_record",
    { subject_version_id: s.versionId, protocol_body: body, idempotency_key: "record-3" });
  const id = (JSON.parse(reply.startsWith("{") ? reply : "{}") as { protocol_version_id?: string }).protocol_version_id;
  if (!id) c.fail(step, `version 3 was not recorded: ${reply.slice(0, 300)}`);
  const want = (body.dimensions as { measures: Measure[] }[]).flatMap((d) => d.measures)
    .filter((m) => m.evaluatorType === "bounded_semantic" || m.evaluatorType === "generative_critic")
    .map((m) => `${m.key} ${m.evaluator?.stable_key}`).sort();
  const got = (await c.sql.query<{ key: string; stable_key: string | null }>(
    `select m.key, v.stable_key from zz.eval_measure m
       left join zz.eval_evaluator_version v on v.id = m.evaluator_version_id
      where m.protocol_version_id = $1 and m.evaluator_type in ('bounded_semantic', 'generative_critic')`, [id])).rows
    .map((r) => `${r.key} ${r.stable_key}`).sort();
  if (!want.length || JSON.stringify(got) !== JSON.stringify(want)) {
    c.fail(step, `the measures resolve to ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }
  c.pass(step);
}

// Every case runs, and the failures are reported together.
process.exitCode = await withThrowawayCore(NAME, DONE, async (c) => {
  const s = await seed(c);
  const failed: string[] = [];
  for (const run of [affirmBindsNothingWithoutATeam, affirmReplays, malformedIdsAreNamed, unknownVersionIsNamed,
                     decideReplays, profileReplays, releaseReplays, readingsCarryTheReading,
                     notApplicableGuardrailIsNotRead, qualifyReplays, qualifyOutageRecordsNothing, labelsPairWithinARun, staleRecordRegistersNothing,
                     partsAreAskedTogether, unclearIsNamed, supersedeClosesTheOld, decideRefreshesFindingsDoc, rollbackReopensFindings, scoredRunIsNotRescored,
                     recordRegistersEvaluators, knowledgeRefsResolve]) {
    try {
      await run(c, s);
    } catch (err) {
      failed.push((err as Error).message);
    }
  }
  if (failed.length) c.fail("the cases above", `${failed.length} failed:\n  ${failed.join("\n  ")}`);
});
typedServer.close();
