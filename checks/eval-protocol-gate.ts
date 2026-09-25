#!/usr/bin/env node
// Round-6 review: a protocol version is used only once protocol_affirm bound an approved
// protocol.md to it, and a measure is named by a key unique across its protocol.
//   - measureByKey answers none (naming the keys there are), one, and a key two dimensions of an
//     older version share (naming both).
//   - finding_record refuses a finding.measure_key its eval_run's protocol version does not have,
//     before the ledger is ever touched.
//   - evaluator_qualify refuses an unaffirmed protocol version by name, and a deterministic measure.
//   - evaluation_start refuses an unaffirmed protocol version by name.
//   - protocol_read never answers reuse for an unaffirmed newest version: create when no version was
//     ever affirmed, revise when one was, with awaiting_affirmation carrying the digest to quote.
//   - protocol_record's duplicateMeasureKeyRefusal names a key repeated in two dimensions.
// Driven against a stubbed pg.Pool; the handlers are harvested by handing each registrar a stub
// server, the same registrars the /eval door mounts.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const PV = "a0000000-0000-4000-8000-000000000001";
const SV = "b0000000-0000-4000-8000-000000000001";
const RUN = "c0000000-0000-4000-8000-000000000001";
const SNAP = "d0000000-0000-4000-8000-000000000001";

type Row = Record<string, unknown>;
let measures: Row[] = [];
let protocol: Row = { plugin_id: "p1", qualification_policy: null, version: 3, affirmed: false };
let latest: Row = {
  id: PV, version: 2, purpose: "p", observable_surfaces: [], approved_document_path: null,
  content_digest: "digest-v2", any_affirmed: false,
};
let connected = 0;

function answer(sql: string): Row[] {
  if (/from zz\.eval_measure m join zz\.eval_dimension d on d\.id = m\.dimension_id where d\.protocol_version_id = \$1::uuid order by d\.key, m\.key/.test(sql)) return measures;
  if (/pv\.approved_document_path is not null as affirmed/.test(sql)) return [protocol];
  if (/from zz\.eval_run where id = \$1::uuid/.test(sql)) return [{ id: RUN, protocol_version_id: PV }];
  if (/from zz\.eval_observation_snapshot where id = \$1::uuid/.test(sql)) return [{ id: SNAP, subject_version_id: SV, coverage: {} }];
  if (/from zz\.eval_subject_version sv join zz\.plugin pl on pl\.id = sv\.plugin_id where sv\.id/.test(sql)) return [{ plugin_id: "p1", plugin: "acme-not-in-catalog" }];
  if (/as any_affirmed/.test(sql)) return [latest];
  if (/select count\(\*\)::text as n/.test(sql)) return [{ n: "0" }];
  return [];
}
pg.Pool.prototype.query = (async function query(text: string) {
  const rows = answer(text.replace(/\s+/g, " ").trim());
  return { rows, rowCount: rows.length };
}) as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async function connect() {
  connected++;
  throw new Error("no transaction is expected on a refusal path");
}) as unknown as typeof pg.Pool.prototype.connect;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { measureByKey, registerEvaluatorQualifyTools } = await load("services/zz-core/dist/eval/qualify.js");
const { registerPluginRecordTools } = await load("services/zz-core/dist/eval/plugin-record.js");
const { registerEvaluationTools } = await load("services/zz-core/dist/eval/evaluate.js");
const { registerProtocolTools } = await load("services/zz-core/dist/eval/protocol.js");
const { duplicateMeasureKeyRefusal } = await load("services/zz-core/dist/eval/protocol-record.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, Handler>();
const server = { registerTool(name: string, _def: unknown, handler: Handler) { tools.set(name, handler); } };
for (const register of [registerEvaluatorQualifyTools, registerPluginRecordTools, registerEvaluationTools, registerProtocolTools]) {
  register(server);
}
const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const handler = tools.get(name);
  assert.ok(handler, `${name} is registered`);
  return (await handler(args)).content[0].text;
};

const measure = (key: string, dimension: string, evaluator_type = "bounded_semantic") =>
  ({ id: `m-${dimension}-${key}`, key, dimension, evaluator_type, evaluator_version_id: `ev-${key}` });

// ---- measureByKey: none, one, duplicate.
measures = [];
assert.match((await measureByKey(db(), PV, "a")).error, /has no measure "a" — its measures are none/);
measures = [measure("a", "d1"), measure("b", "d1")];
assert.deepEqual(await measureByKey(db(), PV, "a"),
  { id: "m-d1-a", evaluator_type: "bounded_semantic", evaluator_version_id: "ev-a" }, "one key resolves to its row");
assert.match((await measureByKey(db(), PV, "zzz")).error, /its measures are a, b/, "a miss names the keys there are");
measures = [measure("a", "d1"), measure("a", "d2")];
assert.match((await measureByKey(db(), PV, "a")).error, /"a" is in more than one dimension .*\(d1, d2\)/);

// ---- finding_record: an unknown measure_key is refused by name, before any transaction.
measures = [measure("a", "d1")];
assert.match(await call("finding_record", {
  eval_run_id: RUN, finding: { kind: "defect", pattern: "x", owner_kind: "plugin", measure_key: "zzz" },
  idempotency_key: "k1",
}), /^ERROR: protocol version .* has no measure "zzz" — its measures are a$/);
assert.equal(connected, 0, "the refusal anchors no ledger row");

// ---- evaluator_qualify: unaffirmed first, then a non-model measure.
protocol = { ...protocol, affirmed: false };
assert.match(await call("evaluator_qualify", { protocol_version_id: PV, measure_key: "a", idempotency_key: "k2" }),
  new RegExp(`^ERROR: protocol_version_id ${PV} \\(version 3\\) has not been affirmed`));
protocol = { ...protocol, affirmed: true };
measures = [measure("a", "d1", "deterministic")];
assert.match(await call("evaluator_qualify", { protocol_version_id: PV, measure_key: "a", idempotency_key: "k3" }),
  /^ERROR: measure "a" is deterministic — only a bounded_semantic\/generative_critic measure's evaluator is qualified$/);

// ---- evaluation_start: an unaffirmed protocol version is refused by name.
protocol = { ...protocol, affirmed: false };
assert.match(await call("evaluation_start", {
  subject_version_id: SV, protocol_version_id: PV, observation_snapshot_id: SNAP, idempotency_key: "k4",
}), new RegExp(`^ERROR: protocol_version_id ${PV} \\(version 3\\) has not been affirmed`));
assert.equal(connected, 0, "evaluation_start refuses before its ledger transaction");

// ---- protocol_read: an unaffirmed newest version is never reuse.
const read = async () => JSON.parse(await call("protocol_read", { subject_version_id: SV }));
latest = { ...latest, approved_document_path: null, any_affirmed: false };
let got = await read();
assert.equal(got.protocol_action, "create", "no version was ever affirmed: the lineage's create is still open");
assert.deepEqual(got.awaiting_affirmation, { version: 2, content_digest: "digest-v2" });
assert.equal(got.protocol_version_id, PV);
assert.match(got.note, /AWAITING APPROVAL OF VERSION 2, DO NOT RECORD/);
latest = { ...latest, any_affirmed: true };
got = await read();
assert.equal(got.protocol_action, "revise", "an earlier version was affirmed: this one is a revision in flight");
assert.ok(got.awaiting_affirmation, "still awaiting affirmation");
latest = { ...latest, approved_document_path: "init/protocol.md" };
got = await read();
assert.equal(got.protocol_action, "reuse", "an affirmed newest version with no trigger is reuse");
assert.equal(got.awaiting_affirmation, undefined);

// ---- protocol_record: measure keys are unique protocol-wide.
const body = (dims: [string, string[]][]) => ({ dimensions: dims.map(([key, keys]) => ({ key, measures: keys.map((k) => ({ key: k })) })) });
assert.equal(duplicateMeasureKeyRefusal(body([["d1", ["a", "b"]], ["d2", ["c"]]])), null);
assert.match(duplicateMeasureKeyRefusal(body([["d1", ["a", "b"]], ["d2", ["a"]]])) ?? "",
  /unique across the whole protocol — "a" is declared in d1, d2/);
assert.match(duplicateMeasureKeyRefusal(body([["d1", ["a", "a"]]])) ?? "", /"a" is declared in d1, d1/,
  "a key repeated inside one dimension is refused too");

console.log("eval-protocol-gate: measure keys resolve by name, and an unaffirmed protocol version is refused and never reused");
process.exit(0);
