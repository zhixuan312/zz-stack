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

import { installWorld, type World } from "../scripts/schema/initiative-world.ts";

const TEAM = "t1";
const I = "2026-09-25-records";
const ID = "11111111-1111-4111-8111-111111111111";
const world = new Map<string, World>();
const w: World = { id: ID, flow: null, docs: [], facts: {}, records: {} };
world.set(I, w);
installWorld(world, "2026-09-25");

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
    current_version: 1, content_generation: "0", approved_revision: null, fields: null });
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
await record("define", { owes: "affirmed_path,qualified_measures" });
n = await next();
is(n.action === "run_stage" && n.stage === "define" && /protocol_affirm\(/.test(n.why),
   `protocol.md approved, not affirmed: next_move is ${JSON.stringify(n)}, not run_stage define naming protocol_affirm`);
await record("define", { protocol_version_id: "pv-1", affirmed_path: `${I}/protocol.md`, qualify_owed: "m.a,m.b" });
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
