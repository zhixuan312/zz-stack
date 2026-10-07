#!/usr/bin/env node
/**
 * How many audit rounds is a question of evidence, and the budget is not a pass.
 *
 * Drives the real `initiativeState` and `auditMove` against a stubbed `pg.Pool`, with no
 * typed-service key, so the deterministic rule is what is exercised; the two
 * assessment-dependent branches are driven by the answers the assessor actually records, which is
 * what `source_add` writes and what `review-rounds.ts` reads back.
 *
 * A store fixture used to be a directory of `.md` files. A document is a `zz.doc` row plus the
 * revision it points at now, so the fixture is those rows: same documents, same declarations,
 * same questions.
 *
 *   1. material supporting spec.md is not a round
 *   2. a round that read the current version settles the audit
 *   3. a new version after the last round owes the next round
 *   4. a spent budget with an unaudited version waits on the stakeholder, and a recorded
 *      decision releases it
 *   5. a round that reopens an agreement waits on the stakeholder, and a decision releases it
 *   6. `auditRoundOf` counts only a stage that produces a source supporting that document
 *   7. `readingOf` bands, and the nine families each carry an instruction
 *   8. `nextMoveLine` says the next move, and nothing for a freeform initiative
 *   9. a round is asked `changes_commitment` only: `repeats_finding` routes no audit move, so it
 *      is not asked, and a repeating round still owes the revision its round
 *  10. the plan is audited before its approval, the spec after it
 *  11. a round reads the PUBLIC version: every fixture's stored revision differs from its version,
 *      and a new snapshot of the same version owes no round
 *  12. a closed initiative's gated document corrected after the close awaits its own approval,
 *      with the outcome still reported from the anchor and the initiative not counted closed;
 *      a draft the close itself left — a stop's fallback, or a change before the close — does not;
 *      a stop's fallback approved at the close and corrected after it does, whichever document it is
 *
 * Run: node checks/audit-rounds.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
delete process.env.TYPESAFE_API_KEY;

const TEAM = "t1";
/** One initiative's world: its own row, its documents, its branch facts and its stage records. */
interface W {
  flow: string | null; closed_at: string | null; closed_by: string | null; outcome: string | null;
  docs: Record<string, unknown>[];
  facts: Record<string, string>;
  records: Record<string, Record<string, string>>;
  answers: { about: string; family: string; reading: string; probability: number | null;
             asked_at: string }[];
}
let world = new Map<string, W>();
const blank = (flow: string | null): W =>
  ({ flow, closed_at: null, closed_by: null, outcome: null, docs: [], facts: {}, records: {}, answers: [] });

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  // Two param shapes: the document/fact/record readers take the INITIATIVE first
  // (`docRows(p, team, initiative)` binds it as $1), and the initiative-row readers take the TEAM
  // first and the slug second. One lookup each, so a route cannot read the wrong one.
  const byInit = world.get(String(values[0]));
  const bySlug = world.get(String(values[1] ?? values[0] ?? ""));
  // The team's roster, and nothing else, when there is no slug to look up.
  if (/select i\.slug from zz\.initiative i join zz\.team t on t\.id = i\.team_id where t\.slug = \$1 order by i\.slug/.test(sql)) {
    return one([...world.keys()].sort().map((slug) => ({ slug })));
  }
  // anchorsFor: every named initiative's own row, in one query.
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    const names = (values[1] as string[]) ?? [];
    return one(names.filter((n) => world.has(n)).map((n) => ({
      slug: n, flow: world.get(n)!.flow, closed_at: world.get(n)!.closed_at,
      closed_by: world.get(n)!.closed_by, outcome: world.get(n)!.outcome })));
  }
  // openRecord / initiativeIdFor / takenRefusal / unopenedRefusal: one initiative by slug.
  if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
    const row = bySlug ? { id: "i1", flow: bySlug.flow, opened_at: "2026-09-24", opened_by: "ada@zz.test",
                      slug: String(values[0]) } : undefined;
    return one(row ? [row] : []);
  }
  // docRows: every document the initiative holds.
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) return one(byInit?.docs ?? []);
  // factsFor: the branch facts.
  if (/from zz\.initiative_fact f\b/.test(sql)) {
    return one(Object.entries(byInit?.facts ?? {}).map(([fact, value]) => ({ fact, value })));
  }
  // recordsFor: the stage records.
  if (/from zz\.initiative_record r\b/.test(sql)) {
    return one(Object.entries(byInit?.records ?? {}).flatMap(([stage, ids]) =>
      Object.entries(ids).map(([id_name, value]) => ({ stage, id_name, value }))));
  }
  // assessmentsFor: the typed answers already taken about this initiative's sources.
  if (/from zz\.assessment a\b/.test(sql) && /select a\.family/.test(sql)) {
    return one((bySlug?.answers ?? []).map((a) => ({ ...a, instruction_version: 1, question_digest: "d",
      requested_model: null, resolved_model: null, identity_assurance: null, reason: null,
      initiative: String(values[1]), asked_by: "ada@zz.test" })));
  }
  // assessFamily persists what it was asked; the check reads those rows back through the same
  // reader the platform uses, so nothing here is a second memo of the answer.
  if (/insert into zz\.assessment\b/.test(sql)) {
    // COUPLED: the insert's own bind order — family `$1`, reading `$5`, about `$13`, the slug
    // `$16`. Read off the statement rather than guessed, because a stub that reads the wrong
    // slot answers confidently and wrongly.
    const target = world.get(String(values[15] ?? ""));
    target?.answers.push({ family: String(values[0] ?? ""), reading: String(values[4] ?? ""),
                           about: String(values[12] ?? ""), probability: null,
                           asked_at: new Date().toISOString() });
    return one([{ id: "a1" }]);
  }
  // Everything else — a write, an insert — succeeds and changes nothing this check reads.
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState, nextMoveLine } = await load("services/zz-core/dist/tools/initiative-status.js");
const { assessRound, auditRoundOf, ROUND_BUDGET } = await load("services/zz-core/dist/audit-rounds.js");
const { assessmentsFor } = await load("services/zz-core/dist/review-rounds.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { db } = await load("services/zz-core/dist/platform-db.js");
const sem = await load("services/zz-core/dist/semantic.js");
const { QUESTION_FAMILIES } = await load("packages/contracts/dist/index.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

let n = 0;
let seq = 0;
/** One document row, as `docRows` answers with it. */
const docRow = (initiative: string, path: string, o: Record<string, unknown> = {}) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "", status: "",
  outcome: null, approved_by: null, approved_at: null, closed_by: null,
  updated_at: "2026-09-24T00:00:00.000Z", title: "", body: "", tags: [],
  current_revision: 1, approved_revision: null, current_version: 1, fields: null, supports: [], ...o,
});

interface Fixture { name: string; chain: Awaited<ReturnType<typeof chainFor>> }

/** A fresh sdlc-flow initiative with spec.md approved at `version`. */
async function fresh(version: number): Promise<Fixture> {
  const name = `2026-09-24-audit-${++n}`;
  world.set(name, blank("sdlc-flow"));
  world.get(name)!.docs.push(docRow(name, "explore.md", { title: "E", flow: "sdlc-flow", body: "# E" }));
  spec(name, version);
  const chain = await chainFor(db()!, TEAM, `${name}/x.md`);
  return { name, chain };
}
function spec(name: string, version: number) {
  const w = world.get(name)!;
  w.docs = w.docs.filter((d) => d.path !== "spec.md");
  w.docs.push(docRow(name, "spec.md", { title: "Spec", flow: "sdlc-flow", status: "approved",
    approved_by: "ada@zz.test", approved_at: "2026-09-24", current_revision: version * 2 + 1,
    current_version: version, body: "# Spec" }));
}
function round(name: string, i: number, read: number, extra: Record<string, string> = {}): string {
  const file = `2026-09-24-spec-audit-round-${i}.md`;
  world.get(name)!.docs.push(docRow(name, `sources/${file}`, { type: "sdlc-spec-audit",
    title: `Spec audit round ${i}`, body: `Round ${i} findings.`, supports: ["spec.md"],
    fields: { stage: "sdlc-spec-audit", audits_version: String(read),
              added_at: `2026-09-24T0${i}:00:00.000Z`, ...extra } }));
  return file;
}
function material(name: string, at: string) {
  world.get(name)!.docs.push(docRow(name, `sources/2026-09-24-decision-${at.replace(/\W/g, "")}.md`, {
    title: "Stakeholder decision", body: "Keep it as agreed.", supports: ["spec.md"],
    fields: { added_at: at } }));
}
/** An answer the assessor recorded, in the grain `assessFamily` persists it and `recordsFor`-style
 *  readers read it back. */
function answered(name: string, about: string, family: string, reading: string, probability: number) {
  world.get(name)!.answers.push({ about, family, reading, probability, asked_at: "2026-09-24T01:00:00.000Z" });
}
const move = async (i: Fixture) =>
  (await initiativeState(db()!, TEAM, i.name, i.chain, i.chain.documents)).next_move;

// 1. material is not a round
const a = await fresh(1);
material(a.name, "2026-09-24T01:00:00.000Z");
let m = await move(a);
// NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
is(m?.action === "add_source" && m?.document === "spec.md" && /stage: "sdlc-spec-audit"/.test(m?.why ?? ""),
   `a stakeholder's material supporting spec.md was taken for an audit round: ${JSON.stringify(m)}`);

// 2. a round that read the current version settles it
round(a.name, 1, 1);
m = await move(a);
is(m?.action === "write_document" && m?.document === "plan.md",
   `round 1 read spec v1 and spec is v1, yet the next move is ${JSON.stringify(m)}`);

// 3. a new version after the last round owes the next round
spec(a.name, 2);
m = await move(a);
// NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
is(m?.action === "add_source" && /Round 2 checks the new version/.test(m?.why ?? ""),
   `spec went to v2 after round 1 read v1, and the next move is ${JSON.stringify(m)}`);
round(a.name, 2, 2);
m = await move(a);
is(m?.action === "write_document" && m?.document === "plan.md",
   `round 2 read the current v2 and found the revision sound; the next move is ${JSON.stringify(m)}`);

// 4. the budget is spent and the latest revision is unaudited -> the stakeholder decides
const b = await fresh(4);
for (let i = 1; i <= ROUND_BUDGET; i++) round(b.name, i, i);
m = await move(b);
is(m?.action === "decide" && m?.waiting_on === "stakeholder",
   `${ROUND_BUDGET} rounds spent and v4 unaudited was treated as a pass: ${JSON.stringify(m)}`);
material(b.name, "2026-09-24T09:00:00.000Z");
m = await move(b);
is(m?.action === "write_document" && m?.document === "plan.md",
   `the stakeholder's recorded decision did not release the spent budget: ${JSON.stringify(m)}`);

// 5. a round that reopens an agreement -> the stakeholder decides; a decision releases it
const c = await fresh(1);
const f = round(c.name, 1, 1);
answered(c.name, `sources/${f}`, "changes_commitment", "yes", 0.9);
m = await move(c);
is(m?.action === "decide" && m?.waiting_on === "stakeholder" && /reopens/.test(m?.why ?? ""),
   `a round the assessor read as reopening an agreement did not go to the stakeholder: ${JSON.stringify(m)}`);
material(c.name, "2026-09-24T02:00:00.000Z");
m = await move(c);
is(m?.action === "write_document" && m?.document === "plan.md",
   `the stakeholder's decision on a reopened agreement did not release it: ${JSON.stringify(m)}`);

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
const line = await nextMoveLine(db()!, TEAM, a.name);
is(/Next move: write_document plan\.md/.test(line), `nextMoveLine said ${JSON.stringify(line)}`);
world.set("2026-09-24-freeform", blank(null));
is(await nextMoveLine(db()!, TEAM, "2026-09-24-freeform") === "",
   "a freeform initiative was given a next move");

// 9. one question per round, and a repeating round changes no move
const d = await fresh(1);
round(d.name, 1, 1);
const f2 = round(d.name, 2, 1);
const said = await assessRound(db()!, TEAM, d.name, `${d.name}/sources/${f2}`, "spec.md", "Round 2 findings.", "ada@zz.test");
const asked = ((await assessmentsFor(db()!, TEAM, d.name)).get(`sources/${f2}`) ?? []).map((x: { family: string }) => x.family);
is(asked.length === 1 && asked[0] === "changes_commitment" && !/repeats_finding/.test(said),
   `an audit round was asked ${JSON.stringify(asked)} (${said}); only changes_commitment routes a move`);
// A stray reading of a family nothing routes on must change nothing.
world.get(d.name)!.answers.push({ about: `sources/${f2}`, family: "repeats_finding", reading: "yes",
                                  probability: 0.9, asked_at: "2026-09-24T02:00:00.000Z" });
spec(d.name, 2);
m = await move(d);
// NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
is(m?.action === "add_source" && /Round 3 checks the new version/.test(m?.why ?? "") && !/repeat/.test(m?.why ?? ""),
   `a stray repeats_finding reading changed the audit's move: ${JSON.stringify(m)}`);

// 10. The plan is audited, then approved; the spec is agreed, then audited. A draft plan phase owes
//     its sdlc-plan-audit round before await_approval is offered — its approval is usually
//     delegated, so the audit is what it rests on — and every revision owes the next round.
{
  const p = await fresh(1);
  round(p.name, 1, 1);                       // the spec's audit is settled, so only the plan's is asked
  const plan = (version: number) => {
    const w = world.get(p.name)!;
    w.docs = w.docs.filter((x) => x.path !== "plan.md");
    w.docs.push(docRow(p.name, "plan.md", { title: "Plan", flow: "sdlc-flow", status: "draft",
      current_revision: version + 5, current_version: version, body: "# Plan\n\n## Phase 1 — skeleton\n" }));
  };
  plan(1);
  let pm = await move(p);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(pm?.action === "add_source" && pm?.document === "plan.md" && /sdlc-plan-audit/.test(pm?.why ?? ""),
     `a draft plan with no audit round was not sent to its audit first: ${JSON.stringify(pm)}`);
  world.get(p.name)!.docs.push(docRow(p.name, "sources/2026-09-24-plan-audit-round-1.md", {
    type: "sdlc-plan-audit", title: "Plan audit round 1", body: "No blocking findings.", supports: ["plan.md"],
    fields: { stage: "sdlc-plan-audit", audits_version: "1", added_at: "2026-09-24T05:00:00.000Z" } }));
  pm = await move(p);
  is(pm?.action === "await_approval" && pm?.document === "plan.md",
     `a draft plan whose audit read its current version was not offered for approval: ${JSON.stringify(pm)}`);
  plan(2);
  pm = await move(p);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(pm?.action === "add_source" && pm?.document === "plan.md" && /Round 2 checks the new version/.test(pm?.why ?? ""),
     `a revised draft plan did not owe the next audit round: ${JSON.stringify(pm)}`);

  // The spec keeps its order: a draft spec is approved first, and audited once it is.
  const q = await fresh(1);
  const w = world.get(q.name)!;
  const sp = w.docs.find((x) => x.path === "spec.md")!;
  Object.assign(sp, { status: "draft", approved_by: null, approved_at: null });
  const qm = await move(q);
  is(qm?.action === "await_approval" && qm?.document === "spec.md",
     `a draft spec was sent to its audit before its approval: ${JSON.stringify(qm)}`);
}

// 11. A new snapshot of the same public version is not a revision an audit owes a round for: the
//     round read v2, the document is still v2 though its stored revision moved.
{
  const r = await fresh(2);
  round(r.name, 1, 2);
  let rm = await move(r);
  is(rm?.action === "write_document" && rm?.document === "plan.md",
     `a round that read the current public version did not settle the audit: ${JSON.stringify(rm)}`);
  Object.assign(world.get(r.name)!.docs.find((x) => x.path === "spec.md")!, { current_revision: 9 });
  rm = await move(r);
  is(rm?.action === "write_document" && rm?.document === "plan.md",
     `a same-version snapshot owed an audit round, so the stored revision was read as the version: ${JSON.stringify(rm)}`);
}

// 12. A closed initiative's correction.
{
  // `sealedOutcome`: the approved revision carries the outcome too — the close stamped it while it
  // was approved, and the draft is a change filed after.
  const closed = async (outcome: string, written: string, closing: string, draftOutcome: boolean, sealedOutcome = false) => {
    const c = await fresh(1);
    round(c.name, 1, 1);
    const w = world.get(c.name)!;
    Object.assign(w, { outcome, closed_at: "2026-09-25T00:00:00.000Z", closed_by: "bo@zz.test" });
    for (const path of ["plan.md", "review.md", "handover.md"]) {
      w.docs.push(docRow(c.name, path, { title: path, flow: "sdlc-flow", status: "approved",
        approved_by: "ada@zz.test", approved_at: "2026-09-24", approved_revision: 1, body: `# ${path}` }));
    }
    // The document under test: approved at r1, a draft at r2 of v2, written at `written`.
    Object.assign(w.docs.find((x) => x.path === closing)!, {
      status: "draft", approved_by: null, approved_at: null, approved_revision: 1, current_revision: 2,
      current_version: 2, updated_at: written, outcome: draftOutcome ? outcome : null,
      closed_by: draftOutcome ? "bo@zz.test" : null, approved_outcome: sealedOutcome ? outcome : null });
    return c;
  };
  const after = "2026-09-26T00:00:00.000Z", before = "2026-09-24T12:00:00.000Z";
  const c = await closed("accepted", after, "review.md", true);
  const st = await initiativeState(db()!, TEAM, c.name, c.chain, c.chain.documents);
  is(st.next_move?.action === "await_approval" && st.next_move?.document === "review.md"
     && /v2 is a correction/.test(st.next_move?.why ?? ""),
     `a corrected closing document does not await its own approval: ${JSON.stringify(st.next_move)}`);
  is(st.outcome === "accepted" && st.closed_by === "bo@zz.test",
     `the outcome and closer are not reported from the anchor during a correction: ${st.outcome}, ${st.closed_by}`);
  is((await nextMoveLine(db()!, TEAM, c.name)).includes("Next move: await_approval review.md"),
     "an initiative with a pending correction reads as closed to the listing and to nextMoveLine");
  // Any gated document of a finished close, corrected after it, is one too.
  const s2 = await closed("accepted", after, "spec.md", false);
  const m2 = (await initiativeState(db()!, TEAM, s2.name, s2.chain, s2.chain.documents)).next_move;
  is(m2?.action === "await_approval" && m2?.document === "spec.md",
     `a spec corrected after a finished close does not await approval: ${JSON.stringify(m2)}`);
  // A draft written before the close is what the close closed on, not a correction.
  const early = await closed("accepted", before, "spec.md", false);
  const m3 = (await initiativeState(db()!, TEAM, early.name, early.chain, early.chain.documents)).next_move;
  is(m3?.action === "closed", `a draft left before the close reopened the initiative: ${JSON.stringify(m3)}`);
  // A stop's fallback document closed as a draft: its gate is waived, so it is not a correction.
  const stop = await closed("abandoned", after, "spec.md", true);
  const m4 = (await initiativeState(db()!, TEAM, stop.name, stop.chain, stop.chain.documents)).next_move;
  is(m4?.action === "closed", `a stop's fallback draft reads as a correction: ${JSON.stringify(m4)}`);
  // A stop that landed on an approved fallback, corrected after it: the correction awaits its own
  // approval, whichever document the stop landed on — not only the flow's declared closing one.
  const fixed = await closed("abandoned", after, "spec.md", true, true);
  const m5 = (await initiativeState(db()!, TEAM, fixed.name, fixed.chain, fixed.chain.documents)).next_move;
  is(m5?.action === "await_approval" && m5?.document === "spec.md" && /v2 is a correction/.test(m5?.why ?? ""),
     `a stop's approved fallback, corrected after it, does not await its own approval: ${JSON.stringify(m5)}`);
}

if (fail.length) {
  console.error(`audit-rounds: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("audit-rounds: rounds follow evidence, the budget escalates, and a decision releases it");
