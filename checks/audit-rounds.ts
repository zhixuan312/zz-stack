#!/usr/bin/env node
/**
 * How many audit rounds is a question of evidence, and the budget is not a pass.
 *
 * Drives the real `initiativeState` and `auditMove` over a fixture store, with no typed-service
 * key, so the deterministic rule is what is exercised; the two assessment-dependent branches are
 * driven by writing the store copy of an assessment, which is exactly what `source_add` writes.
 *
 *   1. material supporting spec.md is not a round
 *   2. a round that read the current version settles the audit
 *   3. a revision after the last round owes the next round
 *   4. a spent budget with an unaudited revision waits on the stakeholder, and a recorded
 *      decision releases it
 *   5. a round that reopens an agreement waits on the stakeholder, and a decision releases it
 *  5b. the light track: one round settles it, unless it reopened an agreement
 *   6. `auditRoundOf` counts only a stage that produces a source supporting that document
 *   7. `readingOf` bands, and the nine families each carry an instruction
 *   8. `nextMoveLine` says the next move, and nothing for a freeform initiative
 *
 * Run: node checks/audit-rounds.ts   (also run by scripts/gate.ts)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
delete process.env.TYPESAFE_API_KEY;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState, nextMoveLine } = await load("services/zz-core/dist/tools/initiative-status.js");
const { auditRoundOf, ROUND_BUDGET } = await load("services/zz-core/dist/audit-rounds.js");
const sem = await load("services/zz-core/dist/semantic.js");
const rec = await load("services/zz-core/dist/initiative-record.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { QUESTION_FAMILIES } = await load("packages/contracts/dist/index.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const root = mkdtempSync(join(tmpdir(), "audit-rounds-"));
const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

/** The slice of a resolved chain this check reads: `initiativeState` takes the rest as given. */
interface Resolved { documents: unknown[]; stages: Array<{ name?: string; produces?: string }> }
interface Fixture { name: string; chain: Resolved }

let n = 0;
/** A fresh sdlc-flow initiative with spec.md approved at `version`. */
function fresh(version: number, track: "full" | "light" = "full"): Fixture {
  const name = `2026-09-24-audit-${++n}`;
  rec.recordOpen(root, name, "sdlc-flow", "ada@zz.test", track);
  mkdirSync(join(root, name, "sources"), { recursive: true });
  writeFileSync(join(root, name, "explore.md"), doc({ title: "E", flow: "sdlc-flow" }, "# E"));
  spec(name, version);
  return { name, chain: chainFor(root, `${name}/x.md`) };
}
function spec(name: string, version: number) {
  writeFileSync(join(root, name, "spec.md"), doc({ title: "Spec", flow: "sdlc-flow", status: "approved",
    approved_by: "ada@zz.test", approved_at: "2026-09-24", version: String(version) }, "# Spec"));
}
function round(name: string, i: number, read: number, extra: Record<string, string> = {}) {
  const file = `2026-09-24-spec-audit-round-${i}.md`;
  writeFileSync(join(root, name, "sources", file), doc({ title: `Spec audit round ${i}`, supports: "spec.md",
    stage: "sdlc-spec-audit", audits_version: String(read),
    added_at: `2026-09-24T0${i}:00:00.000Z`, ...extra }, `Round ${i} findings.`));
  return file;
}
function material(name: string, at: string) {
  writeFileSync(join(root, name, "sources", `2026-09-24-decision-${at.replace(/\W/g, "")}.md`),
    doc({ title: "Stakeholder decision", supports: "spec.md", added_at: at }, "Keep it as agreed."));
}
const move = (i: Fixture) => initiativeState(root, i.name, i.chain, i.chain.documents).next_move;

try {
  // 1. material is not a round
  const a = fresh(1);
  material(a.name, "2026-09-24T01:00:00.000Z");
  let m = move(a);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && m?.document === "spec.md" && /stage: "sdlc-spec-audit"/.test(m?.why ?? ""),
     `a stakeholder's material supporting spec.md was taken for an audit round: ${JSON.stringify(m)}`);

  // 2. a round that read the current version settles it
  round(a.name, 1, 1);
  m = move(a);
  is(m?.action === "write_document" && m?.document === "plan.md",
     `round 1 read spec v1 and spec is v1, yet the next move is ${JSON.stringify(m)}`);

  // 3. a revision after the last round owes the next round
  spec(a.name, 2);
  m = move(a);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && /Round 2 checks the revision/.test(m?.why ?? ""),
     `spec went to v2 after round 1 read v1, and the next move is ${JSON.stringify(m)}`);
  round(a.name, 2, 2);
  m = move(a);
  is(m?.action === "write_document" && m?.document === "plan.md",
     `round 2 read the current v2 and found the revision sound; the next move is ${JSON.stringify(m)}`);

  // 4. the budget is spent and the latest revision is unaudited -> the stakeholder decides
  const b = fresh(4);
  for (let i = 1; i <= ROUND_BUDGET; i++) round(b.name, i, i);
  m = move(b);
  is(m?.action === "decide" && m?.waiting_on === "stakeholder",
     `${ROUND_BUDGET} rounds spent and v4 unaudited was treated as a pass: ${JSON.stringify(m)}`);
  material(b.name, "2026-09-24T09:00:00.000Z");
  m = move(b);
  is(m?.action === "write_document" && m?.document === "plan.md",
     `the stakeholder's recorded decision did not release the spent budget: ${JSON.stringify(m)}`);

  // 5. a round that reopens an agreement -> the stakeholder decides; a decision releases it
  const c = fresh(1);
  const f = round(c.name, 1, 1);
  sem.writeRoundAssessments(root, c.name, f, [{
    family: "changes_commitment", instruction_version: 1, question_digest: sem.questionDigest("changes_commitment"),
    reading: "yes", probability: 0.9, requested_model: null, resolved_model: null, identity_assurance: null,
    reason: null, initiative: c.name, about: `sources/${f}`, asked_by: "ada@zz.test", asked_at: "2026-09-24T01:00:00.000Z" }]);
  m = move(c);
  is(m?.action === "decide" && m?.waiting_on === "stakeholder" && /reopens/.test(m?.why ?? ""),
     `a round the assessor read as reopening an agreement did not go to the stakeholder: ${JSON.stringify(m)}`);
  material(c.name, "2026-09-24T02:00:00.000Z");
  m = move(c);
  is(m?.action === "write_document" && m?.document === "plan.md",
     `the stakeholder's decision on a reopened agreement did not release it: ${JSON.stringify(m)}`);

  // 5b. the light track: one round settles it, a revision after it is not audited again, and a
  // round that reopens an agreement still goes to the stakeholder
  const l = fresh(1, "light");
  m = move(l);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source", `a light initiative skipped its one audit round: ${JSON.stringify(m)}`);
  round(l.name, 1, 1);
  spec(l.name, 2);
  m = move(l);
  is(m?.action === "write_document" && m?.document === "plan.md",
     `on the light track a revision after the one round owed another: ${JSON.stringify(m)}`);
  const l2 = fresh(1, "light");
  const lf = round(l2.name, 1, 1);
  sem.writeRoundAssessments(root, l2.name, lf, [{
    family: "changes_commitment", instruction_version: 1, question_digest: sem.questionDigest("changes_commitment"),
    reading: "yes", probability: 0.8, requested_model: null, resolved_model: null, identity_assurance: null,
    reason: null, initiative: l2.name, about: `sources/${lf}`, asked_by: "ada@zz.test", asked_at: "2026-09-24T01:00:00.000Z" }]);
  m = move(l2);
  is(m?.action === "decide" && m?.waiting_on === "stakeholder",
     `on the light track a round that reopens an agreement did not go to the stakeholder: ${JSON.stringify(m)}`);
  is(rec.openRecord(root, l.name)?.track === "light", "the light track was not recorded at the open");
  is(rec.recordOpen(root, "2026-09-24-free-light", null, "ada@zz.test", "light").track === undefined,
     "a freeform initiative carried a track");

  // 6. only a stage producing a source supporting that document is a round
  is(auditRoundOf(a.chain, "sdlc-spec-audit", ["spec.md"])?.document === "spec.md", "the spec audit stage was not recognised");
  is(auditRoundOf(a.chain, "sdlc-spec-audit", ["plan.md"]) === null, "a spec-audit round supporting plan.md was counted");
  is(auditRoundOf(a.chain, "sdlc-spec", ["spec.md"]) === null, "a stage that produces a document was counted as a round");
  is(auditRoundOf(a.chain, undefined, ["spec.md"]) === null, "a source naming no stage was counted as a round");

  // 7. readings and the registry
  is(sem.readingOf(0.9) === "yes" && sem.readingOf(0.1) === "no" && sem.readingOf(0.5) === "unclear" &&
     sem.readingOf(null) === "unavailable", "readingOf does not draw the documented bands");
  for (const fam of QUESTION_FAMILIES) is(Boolean(sem.FAMILY_INSTRUCTIONS[fam]), `family ${fam} has no instruction`);
  const offline = await sem.assessFamily({ family: "changes_commitment", subject: "x", askedBy: "ada@zz.test" });
  is(offline.reading === "unavailable" && Boolean(offline.reason),
     `with no key the assessment must be unavailable with a reason, got ${JSON.stringify(offline)}`);
  let refused = false;
  try { await sem.assessFamily({ family: "not_a_family", subject: "x", askedBy: "a" }); } catch { refused = true; }
  is(refused, "an unregistered family was asked instead of refused");

  // 8. the next move reaches the result of the call that changed the initiative
  const line = nextMoveLine(root, a.name);
  is(/Next move: write_document plan\.md/.test(line), `nextMoveLine said ${JSON.stringify(line)}`);
  rec.recordOpen(root, "2026-09-24-freeform", null, "ada@zz.test");
  is(nextMoveLine(root, "2026-09-24-freeform") === "", "a freeform initiative was given a next move");
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`audit-rounds: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("audit-rounds: rounds follow evidence, the budget escalates, and a decision releases it");
