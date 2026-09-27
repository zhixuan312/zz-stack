#!/usr/bin/env node
/**
 * `initiative_status` carries the structural report of the initiative's current plan, so the
 * orchestrator executing it reads its parallel waves instead of deriving them by hand.
 *
 * Driven over a fixture store through the real `chainFor` and the real sdlc-flow manifest:
 *   1. a plan whose tasks own disjoint paths answers ok, with the waves `validatePlan` computes
 *      and the hotspots it lists, and no note on the next move;
 *   2. an approved plan where two independent tasks own one path answers not ok, names
 *      `owns_overlap` against a task id, derives no waves, and says so in `next_move.why`;
 *   3. the same plan still in draft reports the violation and adds no note — the note is about
 *      a gate already recorded, not about a draft being worked on;
 *   4. an initiative with no plan.md yet carries no `plan` field at all;
 *   5. a plan whose only phase carries `### As built` answers `current_phase: null` and offers the
 *      review round — nothing is left to execute;
 *   6. a plan with a phase still to build answers `current_phase` for it and routes to
 *      `sdlc-execute`, never to a review round: the round would sweep a change that is a fraction
 *      written. This is the defect 0.83.2 fixes — an approved plan was read as a built plan, so a
 *      seven-phase plan answered with a review round from its third phase onward.
 *
 * Run: node checks/plan-waves-status.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

// Set before any import: @zz/catalog reads it into a module-level const at load time.
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const TEAM = "t1";
interface W { flow: string | null; docs: Record<string, unknown>[]; facts: Record<string, string>;
             records: Record<string, Record<string, string>> }
const world = new Map<string, W>();

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
    return one(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: "2026-09-26",
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
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const task = (n: number, deps: string, owns: string) =>
  `### Task I-${n}: T${n} (← AC-1.${n})\n**Output:** o${n}\n**Dependencies:** ${deps}\n**Owns:** ${owns}\n\n`;
const planBody = (...tasks: string[]) => "# Plan\n\n## Phase 0 — Skeleton\n\n" + tasks.join("") +
  "## Integration hotspots\n\n- `CHANGELOG.md`\n\n## Full-suite gate\n\n`npm run gate`\n";
/** The same plan with its phase's `### As built`, which is what `current_phase` reads to decide
 *  whether a phase is still to build. */
const planBodyBuilt = (...tasks: string[]) => "# Plan\n\n## Phase 0 — Skeleton\n\n" + tasks.join("") +
  "### As built\n\nPhase 0 is built.\n\n## Integration hotspots\n\n- `CHANGELOG.md`\n\n" +
  "## Full-suite gate\n\n`npm run gate`\n";

const DISJOINT = planBody(task(1, "none", "`packages/a/**`"), task(2, "none", "`packages/b/x.ts`"),
                          task(3, "Task I-1", "`packages/a/extra.ts`"));
const OVERLAP = planBody(task(1, "none", "`packages/a/**`"), task(2, "none", "`packages/a/x.ts`"));

let seq = 0;
const row = (initiative: string, path: string, o: Record<string, unknown>) => ({
  id: `d${++seq}`, path, initiative, flow: "", type: "", status: "", outcome: null,
  approved_by: null, approved_at: null, closed_by: null, updated_at: "2026-09-26T00:00:00.000Z",
  title: "", body: "", tags: [], current_revision: 1, approved_revision: null, fields: null, ...o });

/** A recorded audit round: a source naming its stage and supporting the document it audited, which
 *  is all `auditMove` needs to stop owing that stage. */
async function stateOf(name: string, planText: string | null, status: string, audited = false) {
  const w: W = { flow: "sdlc-flow", docs: [], facts: {}, records: {} };
  world.set(name, w);
  w.docs.push(row(name, "spec.md", { title: "Spec", status: "approved", approved_by: "ada@zz.test", body: "# Spec" }));
  if (planText !== null) {
    w.docs.push(row(name, "plan.md", { title: "Plan", status, body: planText }));
  }
  if (audited) {
    for (const [stage, supports] of [["sdlc-spec-audit", "spec.md"], ["sdlc-plan-audit", "plan.md"]]) {
      w.docs.push(row(name, `sources/2026-09-26-audit-${supports.replace(".md", "")}.md`, {
        body: "# Round 1\n\n```json\n{\"round\":1,\"findings\":[],\"resolved\":[]}\n```\n",
        fields: { supports, stage, audits_version: "1" } }));
    }
  }
  const chain = await chainFor(db()!, TEAM, `${name}/x.md`);
  is(chain.name === "sdlc-flow", `${name}: the fixture did not resolve to sdlc-flow — every assertion below would pass on nothing`);
  return initiativeState(db()!, TEAM, name, chain, chain.documents);
}

// 1. Disjoint owners: waves, hotspots, no note.
  const good = await stateOf("2026-09-26-disjoint", DISJOINT, "approved");
  is(good.plan?.ok === true, `a plan with disjoint Owns answered not ok: ${JSON.stringify(good.plan?.violations)}`);
  is(JSON.stringify(good.plan?.waves) === JSON.stringify([["I-1", "I-2"], ["I-3"]]),
     `a plan with disjoint Owns answered waves ${JSON.stringify(good.plan?.waves)}, not [[I-1,I-2],[I-3]]`);
  is(JSON.stringify(good.plan?.hotspots) === JSON.stringify(["CHANGELOG.md"]),
     `hotspots read as ${JSON.stringify(good.plan?.hotspots)}`);
  is(!good.next_move?.why.includes("fails structural validation"),
     "a plan that validates still got a structural note on its next move");

  // 2. An approved plan with two parallel writers of one path.
  const bad = await stateOf("2026-09-26-overlap", OVERLAP, "approved");
  const overlap = bad.plan?.violations.find((v: { kind: string }) => v.kind === "owns_overlap");
  is(bad.plan?.ok === false, "an approved plan with overlapping Owns answered ok");
  is(overlap && /^I-[12]$/.test(overlap.task ?? "") && overlap.message,
     `owns_overlap was not reported against a task with a message: ${JSON.stringify(bad.plan?.violations)}`);
  is(Array.isArray(bad.plan?.waves) && bad.plan.waves.length === 0,
     `a plan that does not validate still answered waves ${JSON.stringify(bad.plan?.waves)}`);
  is(bad.next_move?.why.includes("fails structural validation") && bad.next_move.why.includes("owns_overlap"),
     `an approved plan that does not validate was not named in next_move.why: ${bad.next_move?.why}`);

  // 3. The same plan in draft: reported, no note.
  const draft = await stateOf("2026-09-26-draft", OVERLAP, "draft");
  is(draft.plan?.ok === false, "a draft plan with overlapping Owns answered ok");
  is(!draft.next_move?.why.includes("fails structural validation"),
     "a draft plan got the approved-plan note on its next move");

  // 4. No plan yet: no field.
  const none = await stateOf("2026-09-26-unplanned", null, "draft");
  is(!("plan" in none) || none.plan === undefined, `an initiative with no plan.md answered plan ${JSON.stringify(none.plan)}`);

  // 5. Every written phase is built: with both audits recorded, the review round is what is owed.
  //    A phase is built when it carries its `### As built`, which is what `current_phase` reads.
  const built = await stateOf("2026-09-26-built", planBodyBuilt(task(1, "none", "`packages/a/**`")), "approved", true);
  is(built.plan?.current_phase === null,
     `a plan whose phase carries ### As built answered current_phase ${built.plan?.current_phase}, not null`);
  is(built.next_move?.action === "add_source" && built.next_move?.document === "review.md",
     `a plan with every phase built was not offered the review round: ${JSON.stringify(built.next_move)}`);

  // 6. A phase still to build: `sdlc-execute` for it, and no round offered.
  const executing = await stateOf("2026-09-26-executing", planBody(task(1, "none", "`packages/a/**`")), "approved", true);
  is(executing.plan?.current_phase === 0,
     `a plan whose phase carries no ### As built answered current_phase ${executing.plan?.current_phase}, not 0`);
  is(executing.next_move?.action === "run_stage" && executing.next_move?.stage === "sdlc-execute",
     `a plan with phase 0 still to build answered ${executing.next_move?.action}/${executing.next_move?.stage}, ` +
     "not run_stage/sdlc-execute");
  is(executing.next_move?.why.includes("phase 0 still to build"),
     `the execute move did not name the phase: ${executing.next_move?.why}`);
  is(executing.next_move?.document !== "review.md",
     "a plan with a phase still to build was offered the review round");
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("plan waves in initiative_status: ok");
