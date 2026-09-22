/**
 * Defects planted in what a skill SAYS — its claims, its arithmetic, the tools it names and
 * the shape it ships in.
 *
 * These four check files read prose, and prose is the one part of this platform nothing else
 * verifies: a skill is served to an agent verbatim, so a sentence that is wrong is an
 * instruction that is wrong. The defects below are therefore lies rather than damage — a
 * skill naming a tool no door registers, a roster claiming the wrong door, a count that
 * disagrees with the list under it, an instruction to load something that was merged away.
 * A misspelling would prove only that a check can see noise; what is worth measuring is
 * whether it can see a confident, well-formed, false statement.
 *
 * NOTHING HERE IS PLANTED UNDER `marketplace/`. The gate rewrites that tree from `catalog/`
 * and `skills/` while it runs, so a defect planted there is overwritten mid-measurement and
 * the row means nothing. Every subject below is the source the shelf is rendered FROM.
 */
import type { MutationSpec } from "./plant.ts";

const SDLC = "catalog/sdlc/sdlc-flow/skills";
const ACCESS = "catalog/zz/zz-access/skills";
const EVAL = "catalog/zz/zz-plugin-eval/skills";
const PLATFORM = "skills/zz-platform/SKILL.md";
const ARTIFACTS = "services/zz-core/src/tools/artifacts.ts";

export const COV_SKILLS: readonly MutationSpec[] = [
  // ---------------------------------------------------------------- skill-prose.ts
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill_read a skill spells out names a skill that exists",
    subject: PLATFORM,
    find: "  `zz-handover` with `skill_read` and run it if the cycle taught something —",
    replace: "  it with `skill_read(\"zz-journal\")` and run it if the cycle taught something —",
    planted: "the skill every agent on this platform loads first instructs an agent to load " +
      "`zz-journal`, a skill that was merged away — so the handover step ends in a refusal " +
      "instead of the record the next initiative reads",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill justifies itself by machinery this platform does not have",
    assertion: "a skill names a renderer as the reason one of its rules matters",
    subject: `${SDLC}/sdlc-plan/SKILL.md`,
    find: "dependency order, the full-suite gate. Write the plan expecting that.",
    replace: "dependency order, the full-suite gate. Write the plan expecting that. The " +
      "plan-stage renderer\nre-materializes your declared checks from the plan before scoring, " +
      "so the heading format is\nload-bearing rather than cosmetic.",
    planted: "the plan stage gives a plan-stage renderer as the REASON its heading format " +
      "matters, and no such renderer exists anywhere on this platform — so anyone who checks " +
      "finds nothing and concludes a rule sdlc-execute genuinely depends on is vestigial",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill writes a document with a local-file tool",
    assertion: "a stage is told to create a gated document with the runtime's Write",
    subject: `${SDLC}/sdlc-spec/SKILL.md`,
    find: "Write this skeleton in ONE `document_write` call into the initiative",
    replace: "Write this skeleton in ONE `Write` call into the initiative",
    planted: "the spec stage tells the model to create the spec with the runtime's local file " +
      "tool, so the spec lands on somebody's disk with no envelope, no version snapshot at " +
      "approval and nothing a person can approve — and it looks exactly like success",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill that ships an asset does not say the asset is beside it",
    subject: `${ACCESS}/zz-doctor/SKILL.md`,
    find: "node \"${CLAUDE_PLUGIN_ROOT}/skills/zz-doctor/doctor.js\"",
    replace: "node ./doctor.js   # the script is next to this file — that is the only place to look",
    planted: "the doctor skill says its script sits beside it, which is false on Claude Code: " +
      "the skill is promoted into commands/ and the script stays in skills/, so the one " +
      "command a blocked person is told to run cannot find what it runs",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "every stage that writes a document names document_present, or says why not",
    assertion: "a declared stage names neither document_present nor a departure from it",
    subject: `${EVAL}/zz-plugin-report/SKILL.md`,
    find: "put in front of the person with `document_present`, and approved by them with",
    replace: "put in front of the person by pasting the text you just wrote, and approved by them with",
    planted: "the stage that writes findings.md stops naming document_present, so the person " +
      "approves an account of the document rather than the stored bytes — and the record " +
      "cannot show that anyone read what they signed",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill or agent prompt names a repository path that does not exist",
    subject: "skills/zz-deck/SKILL.md",
    find: "a separate file, `skills/zz-deck/deck-guidebook.html`, which **this step does not read**.",
    replace: "a separate file, `skills/zz-deck/deck-composition.html`, which **this step does not read**.",
    planted: "the deck skill sends its reader to a composition reference under a path nothing " +
      "ships, so the step that says to consult it has nothing to open and the skill's own " +
      "stop-rather-than-improvise instruction fires every time",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "only a dispatched skill demands a JSON-only final response",
    subject: `${SDLC}/sdlc-audit-criteria/SKILL.md`,
    find: "when_to_use: \"You were dispatched as",
    replace: "when_to_use: \"You are running as",
    planted: "the audit criteria demand a JSON-only final response while their description no " +
      "longer says the skill is dispatched, so a model that loads them in the main agent ends " +
      "the stage by handing the person a JSON envelope nothing on this platform reads",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no flow tells an agent to refuse a person's own words",
    assertion: "a list of accepted approval words beside a list of rejected ones",
    subject: `${SDLC}/sdlc-plan/SKILL.md`,
    find: "approved, and the approval is recorded on the document.",
    replace: "approved on an explicit \"approved\", not \"ok\" or \"go ahead\", and the approval " +
      "is recorded on the document.",
    planted: "the plan gate reintroduces a whitelist of accepted approval phrases, so a person " +
      "who has already said yes the fourth way is held and asked again — the platform " +
      "instructing a flow to make somebody repeat a decision they made",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill names the command a person would actually type",
    assertion: "a skill names the wrong string for a command that does exist",
    subject: `${ACCESS}/zz-migrate/SKILL.md`,
    find: "/zz-access:migrate",
    // SEAMED: this file is swept, and a slash command spelled out here reads as this
    // repository typing one its own manifest does not declare. plant() concatenates it back.
    replace: "/zz-access" + ":zz-migrate",
    planted: "the migrate skill names its command by the skill's name instead of the " +
      "manifest's key, so the string a person is told to type is one the packager never " +
      "writes a file for and the command simply does not exist",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill names a package file the packager does not emit",
    assertion: "a skill names the file by the skill's name where the packager writes the command's",
    subject: `${ACCESS}/zz-update/SKILL.md`,
    find: "node \"${CLAUDE_PLUGIN_ROOT}/skills/zz-update/update.js\"\n```",
    replace: "node \"${CLAUDE_PLUGIN_ROOT}/skills/zz-update/update.js\"\n```\n\nOn Claude Code " +
      "this skill is installed as `commands/zz-update.md`, and the path above resolves\nrelative " +
      "to the plugin root from there.",
    planted: "the update skill tells the reader it is installed as commands/zz-update.md while " +
      "the packager writes commands/update.md — the file is named by the command, not by the " +
      "skill — so anyone resolving a path from it resolves it from a directory that is not there",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a re-entry section names the tool that can change an approved document",
    subject: `${SDLC}/sdlc-plan/SKILL.md`,
    find: "document_revise",
    replace: "document_patch",
    all: true,
    planted: "the plan stage tells a re-entering agent to patch plan.md, which the platform " +
      "refuses on an approved document — and the same file two lines above says so, so the " +
      "skill routes the agent straight into a refusal it has already explained",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill offers a choice the manifest does not allow",
    subject: `${SDLC}/sdlc-spec/SKILL.md`,
    find: "**The canonical `##` component labels, in this exact order — all eight, every time:**",
    replace: "**The canonical `##` component labels, in this exact order — the components the person selected:**",
    planted: "the spec's canonical component list becomes a menu, so a narrowed spec writes " +
      "cleanly as a draft and is refused at the gate — the worst place to find a rule, with " +
      "the work finished and the person already agreed",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill a person types is not one a model is told to load",
    subject: `${ACCESS}/zz-doctor/SKILL.md`,
    find: "`/zz-access:update` is the fix.",
    replace: "load `zz-update` and run it.",
    planted: "the doctor skill tells a model to LOAD zz-update, which is promoted to a command " +
      "and therefore dropped from the package as a loadable skill — the fix for a half-updated " +
      "install silently stops working and nothing about the build fails",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill citing another's section cites one that is there",
    subject: `${SDLC}/sdlc-spec-audit/SKILL.md`,
    find: "5. **Scope is exhaustive.** In-scope and out-of-scope both enumerated. Anything ambiguous belongs\n   explicitly in one of them.",
    replace: "5. **Scope is exhaustive.** In-scope and out-of-scope both enumerated. Anything ambiguous belongs\n   explicitly in one of them. `sdlc-spec` states the rule in its quality bar at\n   section 3 (\"Explicit scope\").",
    planted: "the spec auditor cites another skill's quality bar by a number that item does not " +
      "sit at, so an auditor who follows the pointer lands on a different rule and concludes " +
      "the instruction is stale",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "a skill describing acceptance describes the honest close too",
    subject: `${SDLC}/sdlc-flow/SKILL.md`,
    find: "said it; `no_signoff_reason: \"<one line>\"` when nobody accepted it at all; or\n",
    replace: "said it; or\n",
    planted: "the flow's close section names only the acceptor route, so an agent closing work " +
      "nobody signed off sees no honest way through and goes looking for a name — inventing " +
      "the acceptance the whole close derivation exists to make impossible",
  },

  // --------------------------------------------------------------- skill-claims.ts
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a flow's skills state its gate count as the manifest declares it",
    subject: `${SDLC}/sdlc-flow/SKILL.md`,
    find: "the person decides at the three gates",
    replace: "the person decides at the four gates",
    planted: "the flow's own routing sentence claims a gate the manifest does not declare, so " +
      "the agent reading it waits for a fourth approval that never arrives and the initiative " +
      "stalls one decision short of the close",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a stage skill's ordinal for its own gate matches the manifest",
    subject: `${SDLC}/sdlc-plan/SKILL.md`,
    find: "`plan.md` is a gate: `sdlc-execute` does not start until it is",
    replace: "`plan.md` carries the third gate: `sdlc-execute` does not start until it is",
    planted: "the plan stage calls its own gate the third when plan.md is the second of three, " +
      "so an agent counting approvals believes a person has already signed something they " +
      "have not been shown",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a skill that counts its own contents counts them right",
    subject: `${SDLC}/sdlc-review/SKILL.md`,
    find: "### Failure-Mode Taxonomy (10 Categories)",
    replace: "### Failure-Mode Taxonomy (11 Categories)",
    planted: "the review taxonomy's heading claims one more category than it lists, so a " +
      "reviewer told to sweep all of them goes looking for an eleventh lens that is not " +
      "written down and reports coverage it cannot have had",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "the audit criteria count themselves the way they tell auditors to",
    subject: `${SDLC}/sdlc-plan-audit/SKILL.md`,
    find: "description: Audit plan.md — the eleven prose failure modes",
    replace: "description: Audit plan.md — the twelve prose failure modes",
    planted: "the plan auditor's description states a criteria count the criteria skill does " +
      "not have, and that line is what a model matches on — the auditor's own Criterion 8 is " +
      "the rule it breaks",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a skill that lists a document's sections lists all of them",
    assertion: "a one-column table of section headings, against the manifest's list and order",
    subject: `${SDLC}/sdlc-spec/SKILL.md`,
    find: "| `## Alternatives` |",
    replace: "| `## Options` |",
    planted: "the spec's component catalog renames a section the manifest declares, so a writer " +
      "following the table emits a heading the platform does not know and the spec is refused " +
      "at its approval",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a skill's coverage contract matches the list it enumerates",
    assertion: "a coverage slug whose words are in no heading of the list it describes",
    subject: `${SDLC}/sdlc-research/SKILL.md`,
    find: "\"counter-perspectives\"",
    replace: "\"opposing-views\"",
    planted: "the research worker reports a coverage slug that names none of the perspectives " +
      "it was told to apply, so the caller's only evidence that all five were walked describes " +
      "something the skill does not contain",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "the deck skill counts the template's slides correctly",
    assertion: "the slide count the skill states, against the template's own sections",
    subject: "skills/zz-deck/SKILL.md",
    find: "the 53 guidebook `<section>` elements",
    replace: "the 52 guidebook `<section>` elements",
    planted: "the deck skill undercounts the guidebook by one, which is exactly the count an " +
      "agent gets by matching the literal class attribute and missing the cover — so the " +
      "guidebook's own title page is dropped from every deck built from it",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a heading that counts its own list counts it right",
    subject: `${SDLC}/sdlc-investigate/SKILL.md`,
    find: "### Five Investigation Perspectives",
    replace: "### Six Investigation Perspectives",
    planted: "the investigation heading promises six perspectives over a list of five, so a " +
      "worker told to apply ALL of them looks for one that was never written and reports " +
      "against a taxonomy that does not exist",
  },

  // ---------------------------------------------------------------- skill-tools.ts
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "no tool description teaches a path form the platform refuses",
    subject: ARTIFACTS,
    find: "\"Read a file from your team's artifact store. Paths are relative to it — \"",
    replace: "\"Read a file from your .zz artifact store. Paths are relative to it — \"",
    planted: "document_read's own description invites the `.zz/` prefix that safePath refuses, " +
      "in the one sentence a model reads before deciding how to call it — so the tool teaches " +
      "the shape its own guard rejects",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "a skill never names a platform tool that does not exist",
    subject: `${SDLC}/sdlc-method/SKILL.md`,
    find: "`document_read(...)`",
    replace: "`document_fetch(...)`",
    planted: "the method skill every sdlc stage loads first names a document tool under a " +
      "spelling no door has ever registered, so the check that a worker's document exists is " +
      "an unknown-tool error and the caller improvises past a step the flow declared mandatory",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "zz-platform's roster of platform tools is the tools zz-core serves",
    assertion: "a row's door column, against the door those tools are served on",
    subject: PLATFORM,
    find: "| plugin evaluation | `/eval/mcp` |",
    replace: "| plugin evaluation | `/core/mcp` |",
    planted: "the roster puts the eleven evaluation tools on the baseline door, and zz-platform " +
      "ships in the required package — so every account on this platform is told it can call " +
      "tools that are not on its surface",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "every MCP tool description is well-formed",
    subject: ARTIFACTS,
    find: "\"logs, records). The store is shared with your whole team if you belong to \"",
    replace: "\"logs, records. The store is shared with your whole team if you belong to \"",
    planted: "document_write's description loses the bracket that closed its parenthesis, so " +
      "the sentence a model reads before every write trails off mid-clause — the shape an " +
      "unfinished edit leaves behind",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "a skill never instructs a tool its package cannot reach",
    assertion: "a package whose manifest does not declare the door its own skills instruct",
    subject: "catalog/zz/zz-plugin-eval/flow.json",
    find: "      \"name\": \"zz-plugin-eval\",\n      \"path\": \"/eval/mcp\"",
    replace: "      \"name\": \"zz-plugin-eval\",\n      \"path\": \"/core/mcp\"",
    planted: "the evaluation flow declares the baseline door instead of the one its own tools " +
      "are served on, so every skill it ships instructs a call the installed package cannot " +
      "reach — complete, well written and unreachable, with nothing failing until an agent " +
      "tries it",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "every tool on the access door is taught by a skill that ships with it",
    subject: `${ACCESS}/zz-admin/SKILL.md`,
    find: "| a team | `team_create` `team_archive` `team_list` |",
    replace: "| a team | `team_create` `team_list` |",
    planted: "team_archive stays registered on /manage and no zz-access skill mentions it any " +
      "more, and those skills are the only thing describing that door — so the way to retire " +
      "a team is reachable and invisible, which is the same as absent",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "every zz-core tool is named by a skill somebody loads",
    subject: PLATFORM,
    find: "skill_list",
    replace: "skill_catalog",
    all: true,
    planted: "the platform skill renames the tool that answers which skills are installed to a " +
      "spelling no door registers, so the real tool is taught nowhere and the name every agent " +
      "is handed answers \"tool not found\"",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "no tool teaches a date format the platform does not use",
    subject: PLATFORM,
    find: "`2026-08-19-sample-intake/spec.md`",
    replace: "`19-08-2026-sample-intake/spec.md`",
    planted: "the skill every agent loads first demonstrates a DD-MM-YYYY initiative folder " +
      "while the platform stamps and sorts on ISO — and a folder name is chosen before any " +
      "document exists, so no later stamp repairs it",
  },

  // ---------------------------------------------------------------- skill-shape.ts
  {
    check: "scripts/gate/checks/skill-shape.ts",
    target: "a heading is not printed twice on one line",
    subject: `${SDLC}/sdlc-review/SKILL.md`,
    find: "\n## Execution\n",
    replace: "\n## Execution## Execution\n",
    planted: "a paste lands inside the heading line rather than beside it, so the review skill " +
      "stutters its own section title — and a skill is served to an agent verbatim, so the " +
      "agent reads the stutter too",
  },
  {
    check: "scripts/gate/checks/skill-shape.ts",
    target: "no two skills in a flow carry the same page",
    subject: `${SDLC}/sdlc-plan-audit/SKILL.md`,
    find: "explicitly out of scope\" — which is among the most valuable findings available here, because\nnothing else in the flow is positioned to see it.\n",
    replace: "explicitly out of scope\" — which is among the most valuable findings available here, because\nnothing else in the flow is positioned to see it.\n\n**Do not audit the " +
      "decision.** Whether the team should build this, and which alternative they\npicked, " +
      "was settled with a person in `sdlc-spec` and is not yours to reopen. Audit whether the\n" +
      "document says what was decided, coherently enough to plan from.\n\n\"I would have chosen " +
      "option B\" is not a finding. \"The Approach implements option B while\nAlternatives " +
      "records option A as the decision\" is — and it is a critical one.\n",
    planted: "the spec auditor's section is pasted into the plan auditor, so two skills in one " +
      "flow now carry the same page — they will drift apart edit by edit and the reader has no " +
      "way to tell which copy is the live one",
  },
  {
    check: "scripts/gate/checks/skill-shape.ts",
    target: "every code fence a shipped document opens is closed",
    subject: `${SDLC}/sdlc-spec/SKILL.md`,
    find: "````markdown",
    replace: "```markdown",
    planted: "the spec skeleton's outer fence shrinks to the same length as the block nested " +
      "inside it, so the nested close ends the skeleton early, the bare fence meant to end it " +
      "opens a new one, and everything after renders as code to the end of the file",
  },
  {
    check: "scripts/gate/checks/skill-shape.ts",
    target: "a skill that changed says so in its version",
    assertion: "a skill whose text moved while the version it declares did not",
    subject: `${SDLC}/sdlc-recall/SKILL.md`,
    find: "Those rows are **leads,\nnot an answer**: the top one may share two words out of nine with what you asked. Narrow the\nquestion and confirm a lead before citing it as something the team decided.",
    replace: "Those rows are **as good as an\nordinary match**: the top one was ranked on the same signals every other hit was. Cite\nit directly as something the team decided.",
    planted: "the recall skill reverses what a broadened search result is worth — a lead that " +
      "may share two words out of nine becomes something to cite as a team decision — and the " +
      "version it declares does not move, so every measurement taken before and after is " +
      "filed under one number",
  },
];
