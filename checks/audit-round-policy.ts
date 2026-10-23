#!/usr/bin/env node
/**
 * An audit stage that declares its round policy is routed on it: its budget, the weights that owe
 * another round, the ledger its round filed, and the sentence that says why it settled.
 *
 * Drives the real `initiativeState` (which builds each stage's policy from the real sdlc-flow
 * manifest and calls the real `auditMove`) over a stubbed `pg.Pool`, with no typed-service key,
 * so the deterministic routing is what is exercised. The policy is never written here: every
 * case reads what `catalog/sdlc/sdlc-flow/flow.json` declares, so a case fails if the manifest
 * stops declaring it.
 *
 *   1. plan revised after a round raising only medium and low: settled, with the settled note
 *   2. the same plan approved: no audit move, and the note still says why the audit settled
 *   3. plan revised after a round raising high: round 2 owed, naming high
 *   4. plan revised after a round with no readable ledger (none, two blocks, an unknown or
 *      capitalised weight, a non-array `findings`): round 2 owed, naming no readable ledger
 *   5. plan revised after a round with `findings: []`: settled, with the note
 *   6. plan revised after round 1 raising critical and round 2 raising high: the stakeholder
 *      decides, on a budget of two
 *   7. a round raising high on the current version, not yet revised: no audit move and no note
 *   8. a round raising critical and high, plan revised: the weights in the manifest's order
 *   9. the spec audit, which declares no policy, on a round raising only low: today's routing
 *
 * Run: node checks/audit-round-policy.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
delete process.env.TYPESAFE_API_KEY;

const TEAM = "t1";
const world = new Map<string, Record<string, unknown>[]>();

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    const names = (values[1] as string[]) ?? [];
    return one(names.filter((n) => world.has(n)).map((n) => ({
      slug: n, flow: "sdlc-flow", closed_at: null, closed_by: null, outcome: null })));
  }
  if (/from zz\.initiative i join zz\.team t on t\.id = i\.team_id/.test(sql)) {
    const slug = String(values[1] ?? values[0] ?? "");
    return one(world.has(slug) ? [{ id: "i1", flow: "sdlc-flow", opened_at: "2026-10-23",
                                    opened_by: "ada@zz.test", slug }] : []);
  }
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) return one(world.get(String(values[0])) ?? []);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { ROUND_BUDGET } = await load("services/zz-core/dist/audit-rounds.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const NOTE = "sdlc-plan-audit settled after round 1: it raised no critical or high finding.";
const PLAN_BODY = "# Plan\n\n## Phase 0 — Skeleton: it runs\n\n### Task I-1: the skeleton (← AC-1.1)\n\n" +
  "**Output:** `run.sh`\n**Dependencies:** none\n**Owns:** `run.sh`\n\n" +
  "## Full-suite gate\n\n- [Skeleton] `sh run.sh` — it runs\n";

let n = 0;
let seq = 0;
const row = (path: string, o: Record<string, unknown> = {}) => ({
  id: `d${++seq}`, path, flow: "sdlc-flow", type: "", status: "", outcome: null,
  approved_by: null, approved_at: null, closed_by: null, updated_at: "2026-10-23T00:00:00.000Z",
  title: "", body: "", tags: [], current_revision: 1, approved_revision: null, approved_outcome: null,
  current_version: 1, approved_before: null, fields: null, supports: [] as string[], ...o,
});
/** The ledger a round files, as `sdlc-audit-criteria` writes it. */
const ledger = (...weights: string[]) => "```json\n" + JSON.stringify({ criteriaCovered: ["plan-contract"],
  findings: weights.map((weight) => ({ weight, category: "c", claim: "x", evidence: "y", suggestion: "z" })) }) + "\n```";

/** A fresh sdlc-flow initiative: spec.md approved at v1 and audited once on v1, plan.md at `version`. */
function fresh(version: number, status = "draft"): string {
  const name = `2026-10-23-policy-${++n}`;
  world.set(name, [
    row("explore.md", { title: "E", body: "# E" }),
    row("spec.md", { title: "Spec", status: "approved", approved_by: "ada@zz.test", approved_at: "2026-10-23",
                     current_revision: 3, current_version: 1, body: "# Spec" }),
    row("sources/2026-10-23-spec-audit-round-1.md", { type: "sdlc-spec-audit", body: "Round.\n\n" + ledger("low"),
      supports: ["spec.md"], fields: { stage: "sdlc-spec-audit", audits_version: "1", added_at: "2026-10-23T01:00:00.000Z" } }),
  ]);
  plan(name, version, status);
  return name;
}
function plan(name: string, version: number, status = "draft") {
  const docs = world.get(name)!.filter((d) => d.path !== "plan.md");
  docs.push(row("plan.md", { title: "Plan", status, current_revision: version + 7, current_version: version,
    approved_by: status === "approved" ? "ada@zz.test" : null,
    approved_at: status === "approved" ? "2026-10-23 09:00:00.5+00" : null, body: PLAN_BODY }));
  world.set(name, docs);
}
function planRound(name: string, i: number, read: number, body: string) {
  world.get(name)!.push(row(`sources/2026-10-23-plan-audit-round-${i}.md`, { type: "sdlc-plan-audit",
    title: `Plan audit round ${i}`, body: `# Plan audit round ${i}\n\n${body}\n`, supports: ["plan.md"],
    fields: { stage: "sdlc-plan-audit", audits_version: String(read), added_at: `2026-10-23T0${i + 1}:00:00.000Z` } }));
}
async function move(name: string): Promise<{ action?: string; document?: string; why?: string } | null> {
  const chain = await chainFor(db()!, TEAM, `${name}/x.md`);
  is(chain.name === "sdlc-flow", `${name}: the fixture did not resolve to sdlc-flow — every assertion would pass on nothing`);
  return (await initiativeState(db()!, TEAM, name, chain, chain.documents)).next_move ?? null;
}
const said = (m: unknown) => JSON.stringify(m);
const auditOwed = (m: { action?: string; document?: string } | null) =>
  m?.document === "plan.md" && (m?.action === "add_source" || m?.action === "decide"); // NOT A TOOL: next_move's action vocabulary

// 1. Revised after a round raising only medium and low: settled, and the why says so.
{
  const p = fresh(2);
  planRound(p, 1, 1, ledger("medium", "low"));
  const m = await move(p);
  is(!auditOwed(m), `case 1: a revision after a round raising only medium and low still owes a round: ${said(m)}`);
  is(m?.why?.endsWith(` ${NOTE}`), `case 1: the settled note is not appended after one space: ${said(m)}`);
}

// 2. The same plan approved: no audit move, and the note still says why the audit settled.
{
  const p = fresh(2, "approved");
  planRound(p, 1, 1, ledger("medium"));
  const m = await move(p);
  is(!auditOwed(m), `case 2: an approved revision after a clean round owes a round: ${said(m)}`);
  is(m?.why?.endsWith(` ${NOTE}`), `case 2: the settled note is missing once the plan is approved: ${said(m)}`);
}

// 3. Revised after a round raising high: round 2 owed, and the why names high.
{
  const p = fresh(2);
  planRound(p, 1, 1, ledger("high", "low"));
  const m = await move(p);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && m?.document === "plan.md" &&
     m?.why?.startsWith("round 1 raised high; round 2 reads only what changed to answer it — dispatch it on plan.md v2, then source_add("),
     `case 3: a revision after a round raising high did not owe round 2 naming high: ${said(m)}`);
  is(!m?.why?.includes(NOTE), `case 3: an owed round carries the settled note: ${said(m)}`);
}

// 4. Revised after a round with no readable ledger: round 2 owed, naming it.
for (const [label, body] of [
  ["no block", "Findings in prose only."],
  ["two blocks", `${ledger("low")}\n\n${ledger("low")}`],
  ["an unknown weight", ledger("severe")],
  ["a capitalised weight", ledger("High")],
  ["a block that does not parse", "```json\n{\"findings\": [\n```"],
  ["findings not an array", "```json\n{\"findings\": {\"weight\": \"low\"}}\n```"],
] as const) {
  const p = fresh(2);
  planRound(p, 1, 1, body);
  const m = await move(p);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && m?.document === "plan.md" &&
     m?.why?.startsWith("round 1 carries no readable ledger; round 2 reads only what changed to answer it"),
     `case 4 (${label}): a revision after a round with no readable ledger did not owe round 2 naming it: ${said(m)}`);
}

// 5. Revised after a round with `findings: []`: settled, with the note.
{
  const p = fresh(2);
  planRound(p, 1, 1, ledger());
  const m = await move(p);
  is(!auditOwed(m) && m?.why?.endsWith(` ${NOTE}`),
     `case 5: a revision after a round with findings [] is not settled with its note: ${said(m)}`);
}

// 6. Round 1 raising critical, round 2 raising high, revised after round 2: the stakeholder decides.
{
  const p = fresh(3);
  planRound(p, 1, 1, ledger("critical"));
  planRound(p, 2, 2, ledger("high"));
  const m = await move(p);
  is(m?.action === "decide" && m?.document === "plan.md" &&
     /^2 rounds of sdlc-plan-audit are spent and plan\.md v3/.test(m?.why ?? ""),
     `case 6: a revision after two serious rounds did not go to the stakeholder on a budget of two: ${said(m)}`);
}

// 7. A round raising high on the current version, not revised: no audit move, and no note.
{
  const p = fresh(1);
  planRound(p, 1, 1, ledger("high"));
  const m = await move(p);
  is(!auditOwed(m), `case 7: a round on the current version owes another round: ${said(m)}`);
  is(!m?.why?.includes(NOTE), `case 7: the settled note claims a round that raised high raised nothing serious: ${said(m)}`);
}

// 8. A round raising high and critical, revised: the weights are named in the manifest's order.
{
  const p = fresh(2);
  planRound(p, 1, 1, ledger("high", "medium", "critical"));
  const m = await move(p);
  is(m?.why?.startsWith("round 1 raised critical and high; round 2 reads only what changed"),
     `case 8: the raised weights are not named in the manifest's order: ${said(m)}`);
}

// 9. The spec audit declares no policy: a revision after a round raising only low owes round 2, as today.
{
  const p = fresh(1);
  world.set(p, world.get(p)!.filter((d) => d.path !== "plan.md").map((d) => d.path === "spec.md"
    ? { ...d, current_version: 2, current_revision: 5 } : d));
  const m = await move(p);
  // NOT A TOOL: `add_source` is next_move's own action vocabulary; the call it asks for is source_add.
  is(m?.action === "add_source" && m?.document === "spec.md" && /Round 2 checks the new version/.test(m?.why ?? ""),
     `case 9: the spec audit, which declares no policy, did not keep today's routing: ${said(m)}`);
  is(!m?.why?.includes("settled after"), `case 9: the spec audit carries a settled note: ${said(m)}`);
}

is(ROUND_BUDGET === 3, `ROUND_BUDGET is ${ROUND_BUDGET}; it stays 3 for every stage that declares no budget`);

if (fail.length) {
  for (const f of fail) console.log(`FAIL: ${f}`);
  process.exit(1);
}
console.log("audit-round-policy: a declared budget and threshold route the plan audit, and the spec audit routes as before");
