#!/usr/bin/env node
// Round-2 review (finding 8, and finding 1's replay half): replay_case_set_build asks every model
// question before its transaction and only writes inside it. recordBuild is that transaction's
// body, driven here with a stub client: every write goes through the client it is handed, a
// freshly established qualification is recorded there (its answers before its row), and a
// concurrent change to the case set is refused before any case-set row is written.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { recordBuild } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-cases.js")).href);

type Row = Record<string, unknown>;
function stubClient(latest: Row | null) {
  const statements: string[] = [];
  let next = 1;
  return {
    statements,
    async query(text: string): Promise<{ rows: Row[]; rowCount: number }> {
      const sql = text.replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.includes("from zz.replay_case_set where plugin_id")) return { rows: latest ? [latest] : [], rowCount: latest ? 1 : 0 };
      if (sql.startsWith("insert into zz.assessment")) return { rows: [{ id: String(next++) }], rowCount: 1 };
      if (sql.startsWith("insert into")) return { rows: [{ id: `00000000-0000-4000-8000-00000000000${next++}` }], rowCount: 1 };
      if (sql.includes("count(*)")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const answer = (reading: string | null, distribution: Row | null) => ({
  row: {
    family: null, evaluator_version_id: "00000000-0000-4000-8000-0000000000aa", instruction_version: 1,
    question_digest: "d", reading, probability: null, distribution, answer_kind: distribution ? "choice" : "noul",
    requested_model: null, resolved_model: null, identity_assurance: null, reason: null,
    initiative: null, about: null, asked_by: "check@example.com", asked_at: "2026-09-25T00:00:00Z",
  },
  result: {
    answer_kind: distribution ? "choice" : "noul", probability: null, distribution, reading,
    resolved_model: null, identity_assurance: null, reason: null,
  },
});

const splitPolicy = { evolve: 0.4, validation: 0.3, proof: 0.3, min: { evolve: 0, validation: 0, proof: 0 } };
const material = {
  initiative: "init-a",
  sources: [{
    rel: "init-a/sources/brief.md", title: "Brief", contributedBy: "person@example.com",
    addedAt: "2026-09-01T00:00:00Z", supports: [], stage: "", body: "What I want.",
  }],
  gatedDocNames: [], gatedDocEvents: [], closing: null,
};
const plan = (over: Row) => ({
  pluginId: "00000000-0000-4000-8000-0000000000bb", protocolVersionId: "00000000-0000-4000-8000-0000000000cc",
  snapshotDigest: "digest-new", splitPolicy, scoringPolicy: null, qualState: "operationally_qualified",
  qualified: true, materialCount: 1, classified: [], qualification: null, ...over,
});

// 1. Classification was skipped (the newest case set matched when read) and a concurrent build
// has since replaced it: refused before any insert, never answered by asking a model in here.
const raced = stubClient({ id: "00000000-0000-4000-8000-0000000000dd", version: 3, digest: "digest-other" });
await assert.rejects(recordBuild(raced, plan({})), /another build replaced this plugin's case set/,
  "a concurrent change is refused");
assert.equal(raced.statements.filter((s) => s.startsWith("insert")).length, 0,
  "the refusal comes before any case-set, case or assessment row is written");
assert.match((await recordBuild(raced, plan({})).catch((e: Error) => e)).message, /same idempotency_key is still unused/,
  "the refusal tells the caller the same key works, since nothing reached the ledger");

// 2. A fresh build: the qualification this call established and the source classification it
// asked are recorded through the transaction's own client — the qualification's answers before
// its row — and then the case set is written.
const fresh = stubClient(null);
const qualification = {
  protocolVersionId: "00000000-0000-4000-8000-0000000000cc", evaluatorVersionId: "00000000-0000-4000-8000-0000000000aa",
  pluginId: "00000000-0000-4000-8000-0000000000bb", state: "operationally_qualified", reason: null,
  evidence: {
    anchors: { passed: 1, total: 1 }, planted_faults: { passed: 1, total: 1 },
    controls: { passed: 0, total: 0 }, stability: { passed: 3, total: 3 }, labels: null,
  },
  asked: [answer("yes", null), answer("no", null)],
};
const classified = [{ material, sources: [{ kind: "person_statement", asked: answer(null, { person_statement: 0.9, agent_record: 0.1 }) }] }];
const outcome = await recordBuild(fresh, plan({ classified, qualification }));
assert.equal(outcome.result_table, "zz.replay_case_set");
assert.equal(outcome.result.version, 1, "the first case set of a plugin is version 1");
const inserts = fresh.statements.filter((s) => s.startsWith("insert"));
const table = (s: string) => s.split(" ")[2];
assert.deepEqual(inserts.map(table).slice(0, 4),
  ["zz.assessment", "zz.assessment", "zz.eval_evaluator_qualification", "zz.replay_case_set"],
  "the qualification's two answers, then its row, then the case set — all through the client");
assert.equal(inserts.filter((s) => table(s) === "zz.assessment").length, 3,
  "the source classification's answer is recorded too — three assessment rows, none on a pool");
assert.ok(inserts.some((s) => table(s) === "zz.replay_case"), "the derived case is written");

// 3. Unchanged material reuses the existing version, still recording a qualification this call
// established, and writes no case set.
const reused = stubClient({ id: "00000000-0000-4000-8000-0000000000ee", version: 2, digest: "digest-new" });
const reuse = await recordBuild(reused, plan({ qualification }));
assert.equal(reuse.result_id, "00000000-0000-4000-8000-0000000000ee", "unchanged material reuses the version");
assert.ok(!reused.statements.some((s) => s.startsWith("insert into zz.replay_case_set")), "no new case set");
assert.equal(reused.statements.filter((s) => s.startsWith("insert into zz.eval_evaluator_qualification")).length, 1,
  "the qualification is recorded in the same transaction even when the case set is reused");

console.log("ok eval-replay-build-split");
