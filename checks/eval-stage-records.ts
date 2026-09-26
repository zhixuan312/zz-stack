#!/usr/bin/env node
// A zz-plugin-eval stage that starts in a new conversation finds its ids on the initiative, and
// `initiative_status` names the record stage that runs next. Found by scripts/eval-flow-e2e.ts:
// IDENTIFY, OBSERVE, DISCOVER and EVALUATE write no document, so before `_records.json` a fresh
// DISCOVER had no tool that returned the snapshot OBSERVE minted, a fresh EXPLAIN none that
// returned the eval run, and `next_move` read the same before IDENTIFY as after DISCOVER.
//
// Drives the real `initiativeState` and `writeStageRecord` over a fixture chain shaped like
// zz-plugin-eval's own: record stages ahead of a `when`-conditional document, and one between two
// documents.
//
// And the acts DEFINE/QUALIFY owes after protocol.md is approved (2026-09-26-eval-zz-core, where
// next_move said run EVALUATE while protocol_affirm and evaluator_qualify were still owed): once
// protocol_read has recorded `owes`, an approved protocol.md routes to affirm, then to qualify
// until every owed measure has a state, and only then to EVALUATE. The record is written in the
// shape stage-record.ts's helpers write, through their own pure half.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { recordsFor, writeStageRecord } = await load("services/zz-core/dist/initiative-record.js");
const { qualifiedUpdate } = await load("services/zz-core/dist/eval/stage-record.js");

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

const root = mkdtempSync(join(tmpdir(), "eval-stage-records-"));
const I = "2026-09-25-records";
mkdirSync(join(root, I), { recursive: true });
const next = () => initiativeState(root, I, CHAIN, documents).next_move;

try {
  let n = next();
  is(n.action === "run_stage" && n.stage === "identify", `nothing recorded: next_move is ${JSON.stringify(n)}, not run_stage identify`);
  is(initiativeState(root, I, CHAIN, documents).records === undefined, "an initiative with no records reports a records field");

  writeStageRecord(root, I, "identify", { subject_version_id: "s-1" });
  n = next();
  is(n.action === "run_stage" && n.stage === "observe", `identify recorded: next_move is ${JSON.stringify(n)}, not run_stage observe`);
  is(initiativeState(root, I, CHAIN, documents).records?.identify?.subject_version_id === "s-1",
     "initiative_status does not hand back what identify recorded");

  writeStageRecord(root, I, "observe", { observation_snapshot_id: "o-1" });
  writeStageRecord(root, I, "observe", { observation_snapshot_id: "o-2" });
  is(recordsFor(root, I).observe?.observation_snapshot_id === "o-2", "a stage run again does not supersede its own record");
  n = next();
  is(n.action === "resolve_branch" && n.document === "protocol.md",
     `every record stage ahead of protocol.md recorded: next_move is ${JSON.stringify(n)}, not resolve_branch protocol.md`);

  // Past the gated document, the record stage between it and findings.md runs before findings.md.
  writeFileSync(join(root, I, "_facts.json"), JSON.stringify({ protocol_action: "create" }));
  writeFileSync(join(root, I, "protocol.md"), "---\ntitle: P\nstatus: approved\napproved_by: ada@zz.test\n---\n\n# P\n");
  n = next();
  is(n.action === "run_stage" && n.stage === "evaluate", `protocol.md approved, nothing owed: next_move is ${JSON.stringify(n)}, not run_stage evaluate`);

  // protocol_read recorded what DEFINE owes: approved is not bound, bound is not qualified.
  writeStageRecord(root, I, "define", { owes: "protocol_affirm,evaluator_qualify" });
  n = next();
  is(n.action === "run_stage" && n.stage === "define" && /protocol_affirm\(/.test(n.why),
     `protocol.md approved, not affirmed: next_move is ${JSON.stringify(n)}, not run_stage define naming protocol_affirm`);
  writeStageRecord(root, I, "define", { protocol_version_id: "pv-1", protocol_affirm: `${I}/protocol.md`, qualify_owed: "m.a,m.b" });
  n = next();
  is(n.action === "run_stage" && n.stage === "define" && /evaluator_qualify\("pv-1"/.test(n.why) && /m\.a, m\.b/.test(n.why),
     `affirmed, nothing qualified: next_move is ${JSON.stringify(n)}, not run_stage define naming evaluator_qualify for m.a, m.b`);
  const held = () => recordsFor(root, I).define;
  is(qualifiedUpdate(held(), "pv-other", "m.a", "qualified") === null,
     "a qualification of a version this initiative did not affirm is recorded");
  writeStageRecord(root, I, "define", qualifiedUpdate(held(), "pv-1", "m.a", "qualified"));
  n = next();
  is(n.action === "run_stage" && n.stage === "define" && /for m\.b before/.test(n.why),
     `one of two qualified: next_move is ${JSON.stringify(n)}, not run_stage define naming m.b alone`);
  writeStageRecord(root, I, "define", qualifiedUpdate(held(), "pv-1", "m.b", "unqualified"));
  n = next();
  is(n.action === "run_stage" && n.stage === "evaluate",
     `every owed measure has a state: next_move is ${JSON.stringify(n)}, not run_stage evaluate`);
  writeStageRecord(root, I, "evaluate", { eval_run_id: "e-1" });
  n = next();
  is(n.action === "write_document" && n.document === "findings.md", `evaluate recorded: next_move is ${JSON.stringify(n)}, not findings.md`);

  // Unreadable records are "nothing recorded", never a thrown status.
  writeFileSync(join(root, I, "_records.json"), "{not json");
  is(JSON.stringify(recordsFor(root, I)) === "{}", "a damaged _records.json is not read as empty");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-stage-records");
