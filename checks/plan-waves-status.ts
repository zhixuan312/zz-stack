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
 *   4. an initiative with no plan.md yet carries no `plan` field at all.
 *
 * Run: node checks/plan-waves-status.ts   (also run by scripts/gate.ts)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Set before any import: @zz/catalog reads it into a module-level const at load time.
process.env.ZZ_CATALOG_DIR = join(process.cwd(), "catalog");

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { chainFor } = await load("services/zz-core/dist/chain.js");
const { recordOpen } = await load("services/zz-core/dist/initiative-record.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const doc = (fields: Record<string, string>, body: string) =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n\n${body}\n`;
const task = (n: number, deps: string, owns: string) =>
  `### Task I-${n}: T${n} (← AC-1.${n})\n**Output:** o${n}\n**Dependencies:** ${deps}\n**Owns:** ${owns}\n\n`;
const planBody = (...tasks: string[]) => "# Plan\n\n## Phase 0 — Skeleton\n\n" + tasks.join("") +
  "## Integration hotspots\n\n- `CHANGELOG.md`\n\n## Full-suite gate\n\n`npm run gate`\n";

const DISJOINT = planBody(task(1, "none", "`packages/a/**`"), task(2, "none", "`packages/b/x.ts`"),
                          task(3, "Task I-1", "`packages/a/extra.ts`"));
const OVERLAP = planBody(task(1, "none", "`packages/a/**`"), task(2, "none", "`packages/a/x.ts`"));
const spec = doc({ title: "Spec", status: "approved", approved_by: "ada@zz.test" }, "# Spec");

const root = mkdtempSync(join(tmpdir(), "zz-plan-waves-"));
const stateOf = (name: string, planText: string | null, status: string) => {
  mkdirSync(join(root, name), { recursive: true });
  recordOpen(root, name, "sdlc-flow", "ada@zz.test");
  writeFileSync(join(root, name, "spec.md"), spec);
  if (planText !== null) {
    writeFileSync(join(root, name, "plan.md"), doc({ title: "Plan", status, flow: "sdlc-flow" }, planText));
  }
  const chain = chainFor(root, `${name}/x.md`);
  is(chain.name === "sdlc-flow", `${name}: the fixture did not resolve to sdlc-flow — every assertion below would pass on nothing`);
  return initiativeState(root, name, chain, chain.documents);
};

try {
  // 1. Disjoint owners: waves, hotspots, no note.
  const good = stateOf("2026-09-26-disjoint", DISJOINT, "approved");
  is(good.plan?.ok === true, `a plan with disjoint Owns answered not ok: ${JSON.stringify(good.plan?.violations)}`);
  is(JSON.stringify(good.plan?.waves) === JSON.stringify([["I-1", "I-2"], ["I-3"]]),
     `a plan with disjoint Owns answered waves ${JSON.stringify(good.plan?.waves)}, not [[I-1,I-2],[I-3]]`);
  is(JSON.stringify(good.plan?.hotspots) === JSON.stringify(["CHANGELOG.md"]),
     `hotspots read as ${JSON.stringify(good.plan?.hotspots)}`);
  is(!good.next_move?.why.includes("fails structural validation"),
     "a plan that validates still got a structural note on its next move");

  // 2. An approved plan with two parallel writers of one path.
  const bad = stateOf("2026-09-26-overlap", OVERLAP, "approved");
  const overlap = bad.plan?.violations.find((v: { kind: string }) => v.kind === "owns_overlap");
  is(bad.plan?.ok === false, "an approved plan with overlapping Owns answered ok");
  is(overlap && /^I-[12]$/.test(overlap.task ?? "") && overlap.message,
     `owns_overlap was not reported against a task with a message: ${JSON.stringify(bad.plan?.violations)}`);
  is(Array.isArray(bad.plan?.waves) && bad.plan.waves.length === 0,
     `a plan that does not validate still answered waves ${JSON.stringify(bad.plan?.waves)}`);
  is(bad.next_move?.why.includes("fails structural validation") && bad.next_move.why.includes("owns_overlap"),
     `an approved plan that does not validate was not named in next_move.why: ${bad.next_move?.why}`);

  // 3. The same plan in draft: reported, no note.
  const draft = stateOf("2026-09-26-draft", OVERLAP, "draft");
  is(draft.plan?.ok === false, "a draft plan with overlapping Owns answered ok");
  is(!draft.next_move?.why.includes("fails structural validation"),
     "a draft plan got the approved-plan note on its next move");

  // 4. No plan yet: no field.
  const none = stateOf("2026-09-26-unplanned", null, "draft");
  is(!("plan" in none) || none.plan === undefined, `an initiative with no plan.md answered plan ${JSON.stringify(none.plan)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("plan waves in initiative_status: ok");
