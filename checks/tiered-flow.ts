#!/usr/bin/env node
/**
 * A tiered flow's spec outline and phase-by-phase plan are read as the platform reads them.
 *
 * Drives the real `specApprovalRefusal` (what `document_approve` calls for a spec) over a fixture
 * store resolved through the real `chainFor` and the sdlc-flow manifest, and the real
 * `validatePlan` (what `initiative_status` reports for a plan), with no typed-service key so only
 * the deterministic rules run. The fixtures are in the tiered shape: a Skeleton phase, a See
 * phase, a "No Feel phase" line, and an Unseen phase that is out of order.
 *
 *   1. the tiered spec is accepted
 *   2. the same spec with `Covers AC-2.1.` removed is refused, and the refusal names AC-2.1
 *   3. the "No Feel phase" line is not read as a phase: an outline holding only that line names
 *      no phase, and the line does not disturb coverage in the full spec
 *   4. the tiered plan validates ok, with Phase 1 current, Phase 2 unplanned, and Phase 1's
 *      tasks the two declared under it
 *
 * The tier labels on `## Full-suite gate` lines are not asserted: no platform code reads that
 * section, so a case about them would pass on nothing. `sdlc-plan-audit` checks them.
 *
 * Run: node checks/tiered-flow.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");
delete process.env.TYPESAFE_API_KEY;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { specApprovalRefusal } = await load("services/zz-core/dist/spec-gate.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { db } = await load("services/zz-core/dist/platform-db.js");
const { validatePlan } = await load("packages/contracts/dist/plan-validation.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(`FAIL: ${why}`); };
let cases = 0;
let failedBefore = 0;
/** A case's line, printed only when the case added no failure: a red case never reads as passed. */
const report = (line: string) => {
  cases += 1;
  if (fail.length === failedBefore) console.log(line);
  failedBefore = fail.length;
};

// The fixture is rows under a stubbed `pg.Pool`: an initiative, and its documents as `zz.doc` rows.
const TEAM = "t1";
interface W { flow: string | null; docs: Record<string, unknown>[] }
const world = new Map<string, W>();
let seq = 0;
const row = (path: string, text: string) => ({
  id: `d${++seq}`, path, flow: "", type: "", status: "", outcome: null,
  approved_by: null, approved_at: null, closed_by: null, updated_at: "2026-10-23T00:00:00.000Z",
  title: "", body: text, tags: [], current_revision: 1, approved_revision: null, fields: null,
  supports: [] as string[] });

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
    return one(bySlug ? [{ id: "i1", flow: bySlug.flow, opened_at: "2026-10-23",
                           opened_by: "ada@zz.test", slug: String(values[1]) }] : []);
  }
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) {
    return one(world.get(String(values[0]))?.docs ?? []);
  }
  if (/insert into zz\.(assessment|model_call)\b/.test(sql)) return one([{ id: `a${++seq}` }]);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;

// The spec fixture, in the tiered line format.
const ACS = "## Stakeholders & Work\n\n- [ ] **AC-1.1** An intake email becomes a case. (FR-1)\n" +
            "- [ ] **AC-2.1** A case can be closed. (FR-2)\n" +
            "- [ ] **AC-3.1** A closed case is archived. (FR-3)\n\n";
const OUTLINE_HEAD = "## Phase outline\n\n";
const SKELETON = "- **Phase 0 — Intake path** (Skeleton): an email becomes a case end to end. Covers AC-1.1.\n";
const SEE = "- **Phase 1 — Closing a case** (See): a person closes a case on screen. Covers AC-2.1.\n";
const NO_FEEL = "- No Feel phase: the pilot has no interaction detail worth a separate pass.\n";
const UNSEEN = "- **Phase 2 — Archive sweep** (Unseen, out of order: it needs no screen and can run last): " +
               "closed cases are archived. Covers AC-3.1.\n";
const OUTLINE = `${OUTLINE_HEAD}${SKELETON}${SEE}${NO_FEEL}${UNSEEN}\n`;
const STATEMENTS = "## Core statements\n\n" +
  "| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The mail relay delivers to the intake queue. | No email becomes a case. | holds | " +
  "run:relay-spike — `delivered 1/1 to intake` | |\n\n";
const SPEC = "# Spec\n\n" + ACS + OUTLINE + STATEMENTS;

let n = 0;
/** A fresh sdlc-flow initiative; returns what approving `body` as its spec answers. */
const fresh = (): string => {
  const name = `2026-10-23-tiered-${++n}`;
  world.set(name, { flow: "sdlc-flow", docs: [] });
  return name;
};
const specApproval = async (body: string) => {
  const name = fresh();
  const chain = await chainFor(db()!, TEAM, `${name}/x.md`);
  is(chain.name === "sdlc-flow", `${name}: the fixture did not resolve to sdlc-flow — every assertion would pass on nothing`);
  const content = doc({ title: "Spec", flow: "sdlc-flow" }, body);
  world.get(name)!.docs.push(row("spec.md", content));
  return specApprovalRefusal(db()!, TEAM, chain, `${name}/spec.md`, content, "ada@zz.test",
                             world.get(name)!.docs) as Promise<{ refusal: string | null; note: string }>;
};

// 1. The tiered spec is accepted.
{
  const r = await specApproval(SPEC);
  is(r.refusal === null, `case 1: the tiered spec was refused: ${r.refusal}`);
  report("tiered outline: accepted");
}

// 2. An AC no phase covers is refused by name.
{
  const r = await specApproval("# Spec\n\n" + ACS + OUTLINE.replace(" Covers AC-2.1.", "") + STATEMENTS);
  is(r.refusal !== null && /AC-2\.1/.test(r.refusal),
     `case 2: a tiered outline with no phase covering AC-2.1 was not refused naming it — got ${r.refusal ?? "an approval"}`);
  report("tiered outline missing an AC: refused naming it");
}

// 3. The "No Feel phase" line is not a phase, and does not break coverage.
{
  const only = await specApproval("# Spec\n\n" + ACS + OUTLINE_HEAD + NO_FEEL + "\n" + STATEMENTS);
  is(only.refusal !== null && /names no phase/.test(only.refusal),
     `case 3: an outline holding only the No Feel line was not refused as naming no phase — got ${only.refusal ?? "an approval"}`);
  const full = await specApproval(SPEC);
  is(full.refusal === null, `case 3: the No Feel line broke coverage in the full spec: ${full.refusal}`);
  report("no-Feel line: not read as a phase, coverage intact");
}

// 4. The tiered plan validates, with its current and unplanned phases.
{
  const task = (id: string, ac: string, out: string, deps = "none") =>
    `### Task ${id}: ${out} (← ${ac})\n\n**Output:** \`${out}\`\n**Dependencies:** ${deps}\n**Owns:** \`${out}\`\n\n`;
  const PLAN = "# Plan: tiered fixture\n\nThe plan grows a phase at a time.\n\n" +
    "## Phase 0 — Skeleton: an email becomes a case\n\n" + task("I-1", "AC-1.1", "src/intake.ts") +
    "### As built\n\nIntake lands; the skeleton runs.\n\n" +
    "## Phase 1 — See: a person closes a case\n\n" +
    task("I-2", "AC-2.1", "src/close.ts") + task("I-3", "AC-2.1", "src/screen.ts") +
    "## Phase 2 — Unseen: closed cases are archived\n\nPlanned after Phase 1 is built.\n\n" +
    "## Integration hotspots\n\n- `CHANGELOG.md`\n\n" +
    "## Full-suite gate\n\n- [Skeleton] `npm run test:intake` — intake still works\n" +
    "- [See] `npm run test:close` — closing still works\n";
  const r = validatePlan(PLAN, "tiered-fixture");
  const phase1 = (r.phases as { phase: number; taskIds: string[] }[]).find((p) => p.phase === 1);
  is(r.ok === true, `case 4: the tiered plan is not ok: ${JSON.stringify(r.violations)}`);
  is(r.currentPhase === 1, `case 4: currentPhase is ${r.currentPhase}, not 1`);
  is(r.unplannedPhase === 2, `case 4: unplannedPhase is ${r.unplannedPhase}, not 2`);
  is(JSON.stringify(phase1?.taskIds) === JSON.stringify(["I-2", "I-3"]),
     `case 4: Phase 1's tasks are ${JSON.stringify(phase1?.taskIds)}, not the two declared under it`);
  report("tiered plan: ok, current phase 1, unplanned phase 2");
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log(`tiered-flow: ${cases} cases passed`);
