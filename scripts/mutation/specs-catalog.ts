/**
 * Defects planted in the catalog, the shelf and the shipped prose.
 *
 * THE SUBJECT OF THESE CHECKS IS SHIPPED CONTENT, so the planted defect is a change to that
 * content — a manifest that names a skill it does not ship, a skill that cites a sibling that
 * was merged away, a count that drifted from the thing it counts. That is not a weaker kind
 * of mutation: it is the exact regression each of these checks was written after somebody
 * shipped it. What is never touched is the CHECK's own prose, which is the failure mode this
 * whole run exists to rule out.
 */
import type { MutationSpec } from "./plant.ts";

const SDLC = "catalog/sdlc/sdlc-flow";

export const CATALOG_SPECS: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/catalog-manifest.ts",
    target: "every flow.json parses, and its entry names a skill it ships",
    subject: `${SDLC}/flow.json`,
    find: '  "name": "sdlc-flow",\n  "agentName"',
    replace: '  "name": "sdlc-delivery",\n  "agentName"',
    planted: "the manifest's declared name stops matching the directory the flow ships from, " +
      "so every consumer that resolves a flow by name resolves a different one",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    target: "every flow declares which document closes it",
    subject: `${SDLC}/flow.json`,
    find: '      "closing": true,',
    replace: '      "closing": false,',
    planted: "no document is marked closing, so the closing record silently defaults to " +
      "whichever document happens to be last — the plan treated as the outcome",
  },
  {
    check: "scripts/gate/checks/stage-produces.ts",
    target: "every stage says what it leaves behind, and the document it names names it back",
    subject: `${SDLC}/flow.json`,
    find: '      "name": "sdlc-explore",\n      "produces": "explore.md"',
    replace: '      "name": "sdlc-explore"',
    planted: "a stage stops declaring what it leaves behind, so nothing connects the work it " +
      "does to the document that is supposed to carry it",
  },
  {
    check: "scripts/gate/checks/plugin-declaration.ts",
    target: "a plugin declares every skill it ships, and ships every skill it declares",
    subject: `${SDLC}/flow.json`,
    find: '    "sdlc-recall",',
    replace: '    "sdlc-remember",',
    planted: "the manifest declares a library skill the flow does not ship, so an agent told " +
      "to load it is refused by the platform",
  },
  {
    check: "scripts/gate/checks/rule-registry.ts",
    target: "every enforcement claim in the rule registry names a handler and a behavioural test",
    subject: `${SDLC}/rules.json`,
    find: '"enforcement_class": "platform"',
    replace: '"enforcement_class": "convention"',
    all: true,
    planted: "every platform-enforced rule is reclassified as a convention, so a guarantee " +
      "the skills state as enforced is downgraded to something nobody has to implement",
  },
  {
    check: "scripts/gate/checks/skill-shape.ts",
    target: "every SKILL.md has frontmatter whose name matches its directory",
    subject: `${SDLC}/skills/sdlc-method/SKILL.md`,
    find: "name: sdlc-method",
    replace: "name: sdlc-methods",
    planted: "a skill's frontmatter name stops matching the directory it ships in, so the " +
      "name an agent loads it by and the name it declares disagree",
  },
  {
    check: "scripts/gate/checks/skill-prose.ts",
    target: "no skill references a skill that is not shipped",
    subject: `${SDLC}/skills/sdlc-flow/SKILL.md`,
    find: "| 7 | `sdlc-review` |",
    replace: "| 7 | `sdlc-code-review` |",
    planted: "the flow's own table cites a skill by a name nothing ships, so the agent reading " +
      "it loads a skill that is not there and is refused",
  },
  {
    check: "scripts/gate/checks/skill-claims.ts",
    target: "a skill counting the platform's vocabulary counts it right",
    subject: "skills/zz-platform/SKILL.md",
    find: "so a fourth word invents a row nobody can total",
    replace: "so a fifth word invents a row nobody can total",
    planted: "the skill every agent loads first miscounts the platform's own outcome " +
      "vocabulary, which is the drift that shipped once already and was invisible",
  },
  {
    check: "scripts/gate/checks/skills-provider-neutral.ts",
    target: "no sdlc skill names a provider, a credential or a harness-specific call",
    subject: `${SDLC}/skills/sdlc-investigate/SKILL.md`,
    find: "## Role",
    replace: "## Serving\n\nThe assessor for this stage runs on ollama.\n\n## Role",
    planted: "a flow skill names a specific serving provider, so substituting the provider " +
      "would mean editing the skill rather than the profile",
  },
  {
    check: "scripts/gate/checks/prose-names.ts",
    target: "no shipped prose names a tool no door registers",
    subject: `${SDLC}/skills/sdlc-method/SKILL.md`,
    find: "skill_read(",
    replace: "skill_load(",
    all: true,
    planted: "a flow's method skill names a platform tool under a verb no door registers, so " +
      "an agent following it asks for something that does not exist",
  },
  {
    check: "scripts/gate/checks/marketplace.ts",
    target: "the committed marketplace is what the catalog renders",
    subject: `${SDLC}/skills/sdlc-method/SKILL.md`,
    find: "\n---\n",
    replace: "\n---\n\nA sentence the committed shelf does not carry.\n",
    planted: "a catalog skill changes and the rendered shelf is left as it was, so the public " +
      "marketplace keeps installing last week's method",
  },
  {
    check: "scripts/gate/checks/docs-integrity.ts",
    target: "the README's map names every package, flow and script, and no others",
    subject: "README.md",
    find: "packages/catalog/",
    replace: "packages/catalogue/",
    all: true,
    planted: "the README's map renames a package that exists, so it tells a newcomer to look " +
      "somewhere the code is not and omits the place it is",
  },
];
