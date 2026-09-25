/**
 * Real use of zz-core, before anybody evaluates it — the history an evaluation needs and a fresh
 * deployment does not have.
 *
 * Each piece of use is one sdlc-flow initiative, driven through its gates the way
 * scripts/control-loop-e2e.ts drives one, plus what the person said in their own words: load the
 * platform skill, open it, write and approve each gated document, record both audit rounds, and
 * close it. The skill load attributes the calls after it to a step (so OBSERVE counts the run as
 * usable); the person's words are what `replay_case_set_build` turns into a replayable case; the
 * close makes the initiative a case source at all. The reference protocol derives its cases from
 * sdlc-flow (`replay.caseSelection.defaultSourceScope`), so that is the flow used here.
 *
 * Every initiative is its own conversation, as it would be.
 */
import { Conversation } from "./doors.ts";

const WANTS = [
  ["the weekly digest", "I want the weekly digest to list only open decisions; my team skims it on Monday."],
  ["the release notes", "I'd like the release notes to lead with what broke for users, not with the refactors."],
  ["the onboarding page", "My new starters get lost on step three; I want that step split into two."],
  ["the audit export", "I need the audit export as CSV because our compliance people only use spreadsheets."],
  ["the incident template", "I want every incident to name who decided the rollback, in the first paragraph."],
] as const;

/** How many initiatives: the reference protocol splits replayable cases 0.4/0.3/0.3 with minimums
 *  of 5/10/10, so validation reaches 10 only from 34 cases on. Forty leaves room. */
const SEEDED = 40;

const SPEC = ["Context", "Problem", "Goals & Requirements", "Alternatives", "Approach, Method & Structure",
  "Verification Plan", "Risks & Mitigations", "Stakeholders & Work"];

export async function seedUsage(url: string, pat: string, tag: string): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < SEEDED; i += 1) {
    const c = new Conversation(url, pat, "seed", `eval-flow-seed-${i}`);
    const [topic, words] = WANTS[i % WANTS.length];
    await c.skill("zz-platform");
    const opened = await c.call("core", "initiative_open", { slug: `${tag}-use-${i}`, flow: "sdlc-flow" });
    const name = String(opened.initiative ?? "");
    if (!name) throw new Error(`initiative_open returned no initiative: ${JSON.stringify(opened)}`);
    const doc = (p: string, content: string) => c.call("core", "document_write", { path: `${name}/${p}`, content });
    const sign = (p: string) => c.call("core", "document_approve", { path: `${name}/${p}` });
    await c.skill("sdlc-explore");
    await doc("explore.md", `## Background\nA request about ${topic}.\n\n## Current state\nIt does not do this yet.\n\n## Rough direction\nChange ${topic}.\n`);
    await c.call("core", "source_add", {
      initiative: name, title: `request ${i} from the stakeholder`, content: `${words} (request ${i})`, supports: ["explore.md"],
    });
    await c.skill("sdlc-spec");
    // Some real use goes wrong first: the agent jumps ahead to the plan before the spec's gate,
    // is refused, and goes back. That refusal is what DISCOVER has to mine.
    if (i % 4 === 0) {
      await c.call("core", "document_write", { path: `${name}/plan.md`, content: `## Full-suite gate\nnpm run gate.\n` },
        { refusal: /^ERROR/ });
    }
    await doc("spec.md", SPEC.map((h) => `## ${h}\nChange ${topic} as asked in request ${i}.\n`).join("\n"));
    await sign("spec.md");
    await c.call("core", "source_add", { initiative: name, title: `spec audit ${i}`,
      content: "Audit round 1 of spec.md: no blocking findings.", supports: ["spec.md"], stage: "sdlc-spec-audit" });
    await c.skill("sdlc-plan");
    await doc("plan.md", `## Full-suite gate\nnpm run gate, for request ${i}.\n`);
    await sign("plan.md");
    await c.call("core", "source_add", { initiative: name, title: `plan audit ${i}`,
      content: "Audit round 1 of plan.md: no blocking findings.", supports: ["plan.md"], stage: "sdlc-plan-audit" });
    await c.skill("sdlc-review");
    await doc("review.md", `## Verdict\nShips: request ${i} is done.\n`);
    await sign("review.md");
    await c.call("core", "initiative_close", { initiative: name, disposition: "finished" });
    names.push(name);
  }
  return names;
}
