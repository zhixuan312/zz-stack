/**
 * Real use of zz-core, before anybody evaluates it — the history an evaluation needs and a fresh
 * deployment does not have.
 *
 * Each piece of use is one sdlc-flow initiative, driven through its gates the way
 * scripts/control-loop-e2e.ts drives one, plus what the person said in their own words: load the
 * platform skill, open it, write and approve each gated document, record both audit rounds, and
 * close it. The skill load attributes the calls after it to a step, so OBSERVE counts the run as
 * usable.
 *
 * The same use is seeded twice: before the evaluation, against the release under evaluation, and
 * again after PROMOTE/VERIFY released its improvement — real use of the released version, which
 * is what `release_verify` judges it on. That second round carries `RELEASED_MARKER` in its
 * documents, and the stub judges every text carrying it poor: the released version regresses on
 * purpose, so the rollback is exercised.
 *
 * Every initiative is its own conversation, as it would be.
 */
import { Conversation } from "./doors.ts";
import { RELEASED_MARKER } from "./stub-model.ts";

const WANTS = [
  ["the weekly digest", "I want the weekly digest to list only open decisions; my team skims it on Monday."],
  ["the release notes", "I'd like the release notes to lead with what broke for users, not with the refactors."],
  ["the onboarding page", "My new starters get lost on step three; I want that step split into two."],
  ["the audit export", "I need the audit export as CSV because our compliance people only use spreadsheets."],
  ["the incident template", "I want every incident to name who decided the rollback, in the first paragraph."],
] as const;

/** How many initiatives, each round: the reference protocol establishes nothing on fewer than
 *  five usable runs and five judged documents, and judges a release on five real runs. Eight
 *  leaves room. */
const SEEDED = 8;

const SPEC = ["Context", "Problem", "Goals & Requirements", "Alternatives", "Approach, Method & Structure",
  "Verification Plan", "Risks & Mitigations", "Stakeholders & Work"];

/** `round: "use"` is the use before the evaluation; `round: "after"` is real use of the released
 *  version, marked (see the module note). */
export async function seedUsage(url: string, pat: string, tag: string, round: "use" | "after" = "use"): Promise<string[]> {
  const names: string[] = [];
  const mark = round === "after" ? ` ${RELEASED_MARKER}` : "";
  for (let i = 0; i < SEEDED; i += 1) {
    const c = new Conversation(url, pat, "seed", `eval-flow-seed-${round}-${i}`);
    const [topic, words] = WANTS[i % WANTS.length];
    await c.skill("zz-platform");
    const opened = await c.call("core", "initiative_open", { slug: `${tag}-${round}-${i}`, flow: "sdlc-flow" });
    const name = String(opened.initiative ?? "");
    if (!name) throw new Error(`initiative_open returned no initiative: ${JSON.stringify(opened)}`);
    const doc = (p: string, content: string) => c.call("core", "document_write", { path: `${name}/${p}`, content });
    const sign = async (p: string) => {
      await c.call("core", "document_present", { path: `${name}/${p}` });
      return c.call("core", "document_approve", { path: `${name}/${p}` });
    };
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
    await doc("spec.md", SPEC.map((h) => `## ${h}\nChange ${topic} as asked in request ${i}.${mark}\n`).join("\n"));
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
