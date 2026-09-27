#!/usr/bin/env node
// A zz-plugin-eval stage that starts in a new conversation finds its ids on the initiative, and
// `initiative_status` names the record stage that runs next. Found by scripts/eval-flow-e2e.ts:
// IDENTIFY, OBSERVE, DISCOVER and EVALUATE write no document, so before stage records a fresh
// DISCOVER had no tool that returned the snapshot OBSERVE minted, a fresh EXPLAIN none that
// returned the eval run, and `next_move` read the same before IDENTIFY as after DISCOVER.
//
// Drives the real `initiativeState` and `writeStageRecord` against a fixture chain shaped like
// zz-plugin-eval's own: record stages ahead of a `when`-conditional document, and one between two
// documents.
//
// And the acts DEFINE/QUALIFY owes after protocol.md is approved (2026-09-26-eval-zz-core, where
// next_move said run EVALUATE while protocol_affirm and evaluator_qualify were still owed): once
// protocol_read has recorded `owes`, an approved protocol.md routes to affirm, then to qualify
// until every owed measure has a state, and only then to EVALUATE. The record is written in the
// shape stage-record.ts's helpers write, through their own pure half.
//
// The records are `zz.initiative_record` ROWS under a stubbed `pg.Pool` — their own table, keyed
// by (initiative, stage, id name) and latest-wins, which is what the `<initiative>/_records.json`
// file they replace was.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
const I = "2026-09-25-records";
const ID = "11111111-1111-4111-8111-111111111111";
interface W { id: string; flow: string | null; docs: Record<string, unknown>[]; facts: Record<string, string>;
             records: Record<string, Record<string, string>> }
const world = new Map<string, W>();
const w: W = { id: ID, flow: null, docs: [], facts: {}, records: {} };
world.set(I, w);

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  const bySlug = world.get(String(values[1] ?? ""));
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    const names = (values[1] as string[]) ?? [];
    return one(names.filter((n) => world.has(n)).map((n) => ({
      slug: n, flow: world.get(n)!.flow, closed_at: null, closed_by: null, outcome: null })));
  }
  if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
    return one(bySlug ? [{ id: bySlug.id, flow: bySlug.flow, opened_at: "2026-09-25",
                           opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
  }
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
    return one(world.get(String(values[0]))?.docs ?? []);
  }
  if (/from zz\.doc d\b/.test(sql)) {
    const hit = (bySlug?.docs ?? []).filter((d) => d.path === values[2]);
    return one(hit.length ? [hit[hit.length - 1]] : []);
  }
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    const d = [...world.values()].flatMap((x) => x.docs).find((x) => x.id === String(values[0]));
    return one(d ? [{ revision: 1, content_state: "retained", title: d.title, body: d.body,
                      tags: [], content_hash: "h", fields: d.fields, revision_note: null,
                      written_by: "ada@zz.test", written_at: d.updated_at,
                      approved_by: d.approved_by, approved_at: d.approved_at }] : []);
  }
  if (/from zz\.initiative_fact f\b/.test(sql)) {
    return one(Object.entries(bySlug?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
  }
  if (/from zz\.initiative_record r\b/.test(sql)) {
    return one(Object.entries(bySlug?.records ?? {}).flatMap(([stage, ids]) =>
      Object.entries(ids).map(([id_name, value]) => ({ stage, id_name, value }))));
  }
  // `writeStageRecord` keys on the initiative's ID, so the write finds its world by id.
  if (/insert into zz\.initiative_record\b/.test(sql)) {
    const target = [...world.values()].find((x) => x.id === String(values[0]));
    if (target) {
      const stage = String(values[1]);
      target.records[stage] = { ...(target.records[stage] ?? {}), [String(values[2])]: String(values[3]) };
    }
    return { rows: [], rowCount: 1 };
  }
  if (/delete from zz\.initiative_record\b/.test(sql)) {
    const target = [...world.values()].find((x) => x.id === String(values[0]));
    if (target) delete target.records[String(values[1])];
    return { rows: [], rowCount: 1 };
  }
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { recordsFor, writeStageRecord } = await load("services/zz-core/dist/initiative-record.js");
const { qualifiedUpdate } = await load("services/zz-core/dist/eval/stage-record.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

interface DocSpec { name: string; gate?: boolean; requires?: string; stage?: string; when?: Record<string, string[]> }
const documents: DocSpec[] = [
  { name: "protocol.md", gate: true, stage: "define", when: { protocol_action: ["create", "revise"] } },
  { name: "findings.md", requires: "protocol.md", stage: "explain" },
];
const CHAIN = {
  name: "fixture-record-flow", documents,
  stages: [
    { name: "identify", produces: "record" }, { name: "observe", produces: "record" },
    { name: "define", produces: "protocol.md" }, { name: "evaluate", produces: "record" },
    { name: "explain", produces: "findings.md" },
  ],
  docs: new Set(documents.map((d) => d.name)), requires: { "findings.md": "protocol.md" },
  closingDoc: "findings.md", closeRequires: [], roles: {},
};

let seq = 0;
/** `protocol.md` as a row: its status and approver are columns, its body is the bytes. */
const protocol = (body: string, status: string, approved_by: string | null) => {
  const existing = w.docs.find((d) => d.path === "protocol.md");
  if (existing) { existing.body = body; existing.status = status; existing.approved_by = approved_by; return; }
  w.docs.push({ id: `d${++seq}`, path: "protocol.md", initiative: I, flow: "", type: "",
    status, outcome: null, approved_by, approved_at: approved_by ? "2026-09-25" : null, closed_by: null,
    updated_at: "2026-09-25T00:00:00.000Z", title: "P", body, tags: [], current_revision: 1,
    approved_revision: null, fields: null });
};
const st = async () => initiativeState(db()!, TEAM, I, CHAIN, documents);
const next = async () => (await st()).next_move;
const record = (stage: string, ids: Record<string, string>) => writeStageRecord(db()!, ID, stage, ids);

let n = await next();
is(n.action === "run_stage" && n.stage === "identify", `nothing recorded: next_move is ${JSON.stringify(n)}, not run_stage identify`);
is((await st()).records === undefined, "an initiative with no records reports a records field");

await record("identify", { subject_version_id: "s-1" });
n = await next();
is(n.action === "run_stage" && n.stage === "observe", `identify recorded: next_move is ${JSON.stringify(n)}, not run_stage observe`);
is((await st()).records?.identify?.subject_version_id === "s-1",
   "initiative_status does not hand back what identify recorded");

await record("observe", { observation_snapshot_id: "o-1" });
await record("observe", { observation_snapshot_id: "o-2" });
is((await recordsFor(db()!, TEAM, I)).observe?.observation_snapshot_id === "o-2",
   "a stage run again does not supersede its own record");
n = await next();
is(n.action === "resolve_branch" && n.document === "protocol.md",
   `every record stage ahead of protocol.md recorded: next_move is ${JSON.stringify(n)}, not resolve_branch protocol.md`);

// Past the gated document, the record stage between it and findings.md runs before findings.md.
w.facts.protocol_action = "create";
protocol("# P\n", "approved", "ada@zz.test");
n = await next();
is(n.action === "run_stage" && n.stage === "evaluate", `protocol.md approved, nothing owed: next_move is ${JSON.stringify(n)}, not run_stage evaluate`);

// protocol_read recorded what DEFINE owes: approved is not bound, bound is not qualified.
await record("define", { owes: "protocol_affirm,evaluator_qualify" });
n = await next();
is(n.action === "run_stage" && n.stage === "define" && /protocol_affirm\(/.test(n.why),
   `protocol.md approved, not affirmed: next_move is ${JSON.stringify(n)}, not run_stage define naming protocol_affirm`);
await record("define", { protocol_version_id: "pv-1", protocol_affirm: `${I}/protocol.md`, qualify_owed: "m.a,m.b" });
n = await next();
is(n.action === "run_stage" && n.stage === "define" && /evaluator_qualify\("pv-1"/.test(n.why) && /m\.a, m\.b/.test(n.why),
   `affirmed, nothing qualified: next_move is ${JSON.stringify(n)}, not run_stage define naming evaluator_qualify for m.a, m.b`);
const held = async () => (await recordsFor(db()!, TEAM, I)).define;
is(qualifiedUpdate(await held(), "pv-other", "m.a", "qualified") === null,
   "a qualification of a version this initiative did not affirm is recorded");
await record("define", qualifiedUpdate(await held(), "pv-1", "m.a", "qualified")!);
n = await next();
is(n.action === "run_stage" && n.stage === "define" && /for m\.b before/.test(n.why),
   `one of two qualified: next_move is ${JSON.stringify(n)}, not run_stage define naming m.b alone`);
await record("define", qualifiedUpdate(await held(), "pv-1", "m.b", "unqualified")!);
n = await next();
is(n.action === "run_stage" && n.stage === "evaluate",
   `every owed measure has a state: next_move is ${JSON.stringify(n)}, not run_stage evaluate`);
// A protocol.md revised to quote a newer version owes that version's bind and qualification,
// whatever the record says of the old one (2026-09-26-eval-sdlc: v2 and v3 approved, and
// next_move went straight to EVALUATE on v1's record).
await record("define", { affirmed_digest: "digest-v1" });
protocol("# P\n\ncontent_digest `digest-v1`\n", "approved", "ada@zz.test");
n = await next();
is(n.action === "run_stage" && n.stage === "evaluate", `the bound version still quoted: next_move is ${JSON.stringify(n)}, not run_stage evaluate`);
protocol("# P v2\n\ncontent_digest `digest-v2`\n", "approved", "ada@zz.test");
n = await next();
is(n.action === "run_stage" && n.stage === "define" && /protocol_affirm/.test(n.why),
   `protocol.md revised to a newer version: next_move is ${JSON.stringify(n)}, not run_stage define naming protocol_affirm`);
await record("define", { affirmed_digest: "digest-v2" });
await record("evaluate", { eval_run_id: "e-1" });
n = await next();
is(n.action === "write_document" && n.document === "findings.md", `evaluate recorded: next_move is ${JSON.stringify(n)}, not findings.md`);

// DELIBERATE: the file version's last case — "a damaged `_records.json` is not read as empty" —
// has nothing left to assert. A row is written whole by the database or not at all, so there is
// no damaged state to read: the `readFileSync`/`JSON.parse` failure it guarded cannot arise.

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-stage-records");
