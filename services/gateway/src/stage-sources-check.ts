/**
 * Prove that stageOf credits a stage that produces a source with the sources that are really
 * there, and with nothing that only looks like one.
 *
 *   node services/gateway/dist/stage-sources-check.js   # exits non-zero on failure
 *
 * Drives the real stageOf over the real sdlc-flow manifest from this checkout's catalog. The
 * bug this was written for: stageOf picked sources by `type === "source"`, but source_add types
 * an audit round by its stage (`sdlc-spec-audit`), so every real round was invisible and the
 * audit steps drew `empty`. A round is a document under `sources/`, typed by its stage and
 * supporting the stage's document, which is zz-core's rule (`roundsOf`, audit-rounds.ts).
 */
import { fileURLToPath } from "node:url";

// DELIBERATE: before the import, which is why the import is dynamic. @zz/catalog reads its
// directory once, at load, and defaults to the image's `/catalog`.
process.env.ZZ_CATALOG_DIR ||= fileURLToPath(new URL("../../../catalog", import.meta.url));
const { stageOf } = await import("./console/shared.js");
type StageDoc = Parameters<typeof stageOf>[0][number];

const FLOW = "sdlc-flow";
const OPEN = { closed: false, outcome: null };
const explore: StageDoc = { path: "explore.md", type: "explore", status: "approved" };
const spec: StageDoc = { path: "spec.md", type: "spec", status: "approved" };

interface Case {
  name: string;
  docs: StageDoc[];
  step: string;
  expect: string;
  why: string;
}

const CASES: Case[] = [
  {
    name: "an audit round under sources/, typed by its stage",
    docs: [explore, spec,
           { path: "sources/spec-audit-r1.md", type: "sdlc-spec-audit", status: null, supports: "spec.md" }],
    step: "spec audit",
    expect: "done",
    why: "source_add types a round by its stage, so the type is never `source` for the rounds that count",
  },
  {
    name: "a document typed `source` that is not under sources/",
    docs: [explore, spec,
           { path: "notes.md", type: "source", status: null, supports: "spec.md" }],
    step: "spec audit",
    expect: "empty",
    why: "a source is a document under sources/; a `type` alone does not make one a round",
  },
  {
    name: "untyped material under sources/ supporting the audited document",
    docs: [explore, spec,
           { path: "sources/decision.md", type: "source", status: null, supports: "spec.md" }],
    step: "spec audit",
    expect: "empty",
    why: "only a source typed by its stage is a round (zz-core's roundsOf); untyped material is a decision",
  },
  {
    name: "a round supporting a different document",
    docs: [explore, spec,
           { path: "sources/plan-audit-r1.md", type: "sdlc-plan-audit", status: null, supports: "plan.md" }],
    step: "spec audit",
    expect: "empty",
    why: "a source evidences the stage whose `supports` it names, not every stage that produces one",
  },
];

function main(): number {
  const failures: string[] = [];
  for (const c of CASES) {
    const steps = stageOf(c.docs, FLOW, OPEN).steps;
    const got = steps.find((s) => s.name === c.step);
    // Without the manifest stageOf answers ops-flow's fallback, which has no audit step, and
    // every case would fail for a reason that is not the one it states.
    if (!got) {
      failures.push(`${c.name}: no "${c.step}" step — is ${FLOW} in the catalog? steps: ` +
                    steps.map((s) => s.name).join(", "));
      continue;
    }
    if (got.state !== c.expect) {
      failures.push(`${c.name}: got ${got.state}, expected ${c.expect} — ${c.why}`);
    }
  }
  if (failures.length) {
    console.error(`\n  stage-sources: ${failures.length} case(s) failed\n`);
    for (const f of failures) console.error(`    ${f}`);
    console.error("");
    return 1;
  }
  console.log(`  stage-sources: ${CASES.length} cases pass — a stage that produces a source is done ` +
              "on a round under sources/, typed by that stage, supporting its document, and on nothing else");
  return 0;
}

process.exit(main());
