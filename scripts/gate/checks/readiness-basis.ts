import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readiness } from "@zz/contracts";
import { root } from "../read.ts";
import { check } from "../run.ts";

// DELIBERATE: the stage list is read from the flow module that owns it, never imported from
// `@zz/contracts`. COUPLED: scripts/gate/checks/generic-host-genericity.ts forbids SDLC stage
// names anywhere in `packages/contracts/src`, and both run in one gate — a kernel exporting
// the seven names fails that check, and a kernel without them fails this one.
const STAGES = JSON.parse(readFileSync(join(root, "catalog/sdlc/sdlc-flow/flow.json"), "utf8")).stages;

check("readiness rests on evidence and gates, never on volume, rounds or a score", () => {
  if (STAGES.length !== 7) return `${STAGES.length} stages are wired, not 7`;
  const base = { evidence: [], gaps: ["g1"], gatesRecorded: false };
  for (const noise of [{ bytesAdded: 500_000 }, { roundsElapsed: 3 }, { modelConfidence: 0.99 }, { aggregateScore: 98 }]) {
    const r = readiness({ ...base, ...noise });
    if (r.advance) return `readiness advanced on ${Object.keys(noise)[0]} alone, with an open gap and no gate`;
  }
  const evidenced = readiness({ evidence: ["e1"], gaps: [], gatesRecorded: true, bytesAdded: 12 });
  if (!evidenced.advance) return "a small evidenced correction that closed its gap did not advance";
  const clean = readiness({ evidence: ["e1"], gaps: [], gatesRecorded: true, auditRoundsUsed: 1, auditFindings: 0 });
  if (clean.mustSpendRemainingRounds) return "a clean audit was required to spend its remaining rounds";
  const renamed = readiness({ ...base, auditRoundsUsed: 3, renamedRetry: true });
  if (renamed.budgetReset) return "a renamed retry reset the episode's audit budget";
});
