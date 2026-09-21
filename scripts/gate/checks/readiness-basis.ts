import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readiness } from "@zz/contracts";
import { root } from "../read.ts";
import { check } from "../run.ts";

// THE STAGE LIST COMES FROM THE FLOW MODULE THAT OWNS IT, never from the generic kernel.
// An earlier form of this check imported `STAGES` from `@zz/contracts` — while Task I-20's
// check forbids SDLC stage names anywhere in `packages/contracts/src` and fails on them.
// Both run in one gate, so no implementation satisfied both: a kernel exporting the seven
// names failed I-20, and a kernel without them failed this. `spec.md` puts stage identity in
// the SDLC module and I-20's whole criterion is that no generic kernel module branches on a
// stage, so the kernel was the wrong place to ask. `flow.json` already declares all seven.
// Spelling them with different quotes to slip past I-20's regex would have made both checks
// green and the architecture false, which I-20's own contract rules out in as many words.
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
