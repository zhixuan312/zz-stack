/**
 * Defects planted for the third batch of `scripts/gate/checks/suites.ts`'s registered checks.
 *
 * Every row names `suites.ts` as its `check` because that is the file registering the check,
 * but the rule being measured lives in a standalone script under `checks/`, which `runsCheck`
 * spawns and fails on a non-zero exit. So each spec's real subject is whatever that script
 * reads: a source module, a lock file, a manifest, a skill's frontmatter, a tsconfig.
 *
 * Every row carries an `assertion`, because a table of ninety-odd rows all reading
 * `scripts/gate/checks/suites.ts` tells a reader nothing about what was broken.
 *
 * DELIBERATE: the defect goes in the data, not in the judge. `checks/*.ts` is not frozen the
 * way `scripts/gate/` is, so a spec could break the script rather than the thing it judges.
 * Every row below plants in what the script reads; the one exception says so where it sits.
 */
import type { MutationSpec } from "./plant.ts";

// Which module registers the target, which is what `check_sha256` is computed over.
const SUITES = "scripts/gate/checks/suites.ts";
const SUITES_DATA = "scripts/gate/checks/suites-data.ts";
const SUITES_SURFACE = "scripts/gate/checks/suites-surface.ts";
const SUITES_TOOLING = "scripts/gate/checks/suites-tooling.ts";

export const COV_SUITES_3: readonly MutationSpec[] = [
  {
    check: SUITES,
    target: "the record knows whether a document was fetched before its gate",
    assertion: "an approval rests only on a context that covered exactly the current snapshot",
    subject: "services/zz-core/src/attest.ts",
    find: "    const used = recent.find((c) => coverageOf(by.get(c)!).includes(target));",
    replace: "    const used = recent.find((c) => coverageOf(by.get(c)!).length > 0);",
    planted: "an approval with no context passed rests on any context of the caller's that covered " +
      "anything, so a presentation of an earlier snapshot vouches for bytes the approver never " +
      "saw — the one comparison that ties a signature to what was shown"
  },
  {
    check: SUITES,
    target: "the version that shipped has a changelog section of its own",
    assertion: "a tagged release has a section under its own version, not under Unreleased",
    subject: "CHANGELOG.md",
    // DELIBERATE: the anchor is the heading form, never a version number. The check asks
    // whether CHANGELOG.md carries `## [<the version in package.json>]`, and it reads only the
    // current version's section — a pinned version number would land on a section the check
    // does not read and survive. Taking the brackets off every heading makes the check false
    // whatever the version is, so this lands on every release.
    find: "## [",
    replace: "## ",
    all: true,
    planted: "no release has a section under its own version any more — the heading form the " +
      "changelog is read by is gone, so the version that is tagged, shipped and deployed has " +
      "nowhere its entry can be found, exactly as 0.25.0 had when it shipped under " +
      "`## [Unreleased]` and the next release wrote its own sections beside it",
  },
  {
    check: SUITES_TOOLING,
    target: "the tooling project runs standalone through typecheck:tooling, is deliberately " +
      "absent from tsc -b's reference graph, and inherits its strictness rather than " +
      "softening it locally",
    assertion: "the tooling project may not re-declare an inherited strictness flag",
    subject: "tsconfig.tooling.json",
    find: '    "types": ["node"]\n',
    replace: '    "types": ["node"],\n    "noUnusedLocals": false\n',
    planted: "the tooling project turns off noUnusedLocals locally instead of inheriting the " +
      "base's strictness — the error count drops, the conversion looks finished, and dead " +
      "locals and unused imports across scripts/, checks/ and testing/ stop being reported at all",
  },
  {
    check: SUITES_TOOLING,
    target: "every entry point a human types — an npm script, a deploy script — names the .ts " +
      "file that exists, not the .mjs file that no longer does",
    assertion: "an npm script may not name a .mjs entry point the rename deleted",
    subject: "package.json",
    find: '"rollback": "node scripts/release.ts --rollback"',
    // SEAMED. The payload is a tooling path that deliberately does not exist, which is what
    // `checks/literal-paths-resolve.ts` hunts for. Its own rule would exempt this one, but a
    // payload whose whole point is an absent path is not left to an exemption holding.
    replace: '"rollback": "node scripts/release.mj' + 's --rollback"',
    planted: "`npm run rollback` points at a .mjs file the TypeScript conversion removed, so " +
      "the one command somebody types when a release has gone wrong fails with a module-not-" +
      "found the moment they need it, and no import graph anywhere would have noticed",
  },
  {
    check: SUITES_TOOLING,
    target: "the five shipped skill scripts carry zero strict errors, every construct in them " +
      "is erasable, and none was reached by widening to any",
    assertion: "a shipped skill script may not reach zero errors by widening to any",
    subject: "catalog/zz/zz-access/skills/zz-doctor/doctor.ts",
    find: "const readable = (p: string): string | null => {",
    // SEAMED. The strict sweeps read every tracked file under scripts/, and a payload quoting
    // a widened type reads to them as a widened type — this file would turn that check red at
    // baseline and every row in the batch would come back against an already-red target.
    replace: "const readable = (p: string): an" + "y => {",
    planted: "zz-doctor's file reader is widened to `any`, so every value it returns stops " +
      "being checked — the token read off disk, the installed plugin's config — and the " +
      "\"zero strict errors\" this script ships with is bought by switching the checking off " +
      "rather than by making it true",
  },
  {
    check: SUITES_TOOLING,
    target: "the whole tooling project carries zero strict errors, measured as one project " +
      "rather than subtree by subtree",
    assertion: "a strict error anywhere in the tooling project is reported, not just per subtree",
    subject: "scripts/skill-versions.ts",
    find: 'const major = (v: string | undefined) => String(v ?? "").split(".")[0];',
    replace: "const major = (v: string | undefined) => v.split(\".\")[0];",
    planted: "the version comparison drops the guard around a version that may be absent, so a " +
      "skill with no recorded version throws instead of comparing — and the tooling project " +
      "carries a strict error again, which is the state the conversion was declared finished from",
  },
  {
    check: SUITES_DATA,
    target: "every tool the spec renamed resolves through one frozen map",
    assertion: "a deleted tool takes no alias entry",
    subject: "packages/contracts/src/alias.ts",
    find: '  issue_pat: "pat_issue",\n',
    replace: '  issue_pat: "pat_issue",\n  issue_my_access_token: "pat_issue",\n',
    planted: "a tool that was DELETED is aliased onto the tool that replaced its neighbour, so " +
      "two distinct series of calls merge under one name — every historical " +
      "`issue_my_access_token` is read back as if it had been a `pat_issue`, which is the one " +
      "thing a rename map must never do to a deletion",
  },
  {
    check: SUITES_DATA,
    target: "a query binds as many parameters as its statement names",
    assertion: "a statement that stops naming a placeholder its caller still binds is caught",
    subject: "services/zz-core/src/tools/bugs.ts",
    // The last placeholder the caller binds, replaced by a literal — the same shape this plant
    // has always had. Phase 2 gave `bug_resolve` a fifth bind (`duplicate_of`), so the last one
    // moved from `$4` to `$5`; a plant still naming `$4` matches nothing, and `plant()` writes
    // the file back only when a substitution happened, so it would have applied nothing and
    // reported nothing while this check stayed green for the wrong reason.
    find: "duplicate_of = $5::uuid",
    replace: "duplicate_of = null",
    planted: "bug_resolve's statement stops naming `$5` while its caller still passes five " +
      "values, so postgres rejects the bind and closing a bug report throws for every " +
      "operator — the exact shape that shipped green through tsc, the gate and the dry run once " +
      "already, because nothing offline reads SQL inside a template literal",
  },
  {
    check: SUITES_DATA,
    target: "what a call cost is a column, and detail keeps no second copy",
    assertion: "an unmeasured run's byte total stays null rather than being coalesced to zero",
    subject: "services/gateway/src/runs.ts",
    find: "sum(e.response_bytes)",
    replace: "coalesce(sum(e.response_bytes), 0)",
    all: true,
    planted: "both run rollups coalesce an unmeasured byte total back to 0, so a run whose " +
      "calls were never measured is indistinguishable from a run that transferred nothing — " +
      "the confident zero the schema exists to prevent, back in both directions",
  },
  {
    check: SUITES_SURFACE,
    target: "a command is what a manifest declares, not what a function derives from a skill name",
    assertion: "the literal \"flow\" fallback stays deleted, not merely unused",
    subject: "services/gateway/src/client-package.ts",
    find: "const entryCmd = entryCommand(f.flow, f.entry || f.flow);",
    replace: 'const entryCmd = f.entry ? entryCommand(f.flow, f.entry) : "flow";',
    planted: "a flow whose manifest names no entry skill falls back to the literal string " +
      "\"flow\" instead of the command the manifest declares, so the packaged client offers a " +
      "command nobody wrote down and zz-router is told the front door is called something it " +
      "is not",
  },
  {
    check: SUITES_SURFACE,
    target: "a change to an approved body names its cause — a source on the record or new words, never neither",
    assertion: "a single cause is enough",
    subject: "services/zz-core/src/document-change.ts",
    find: "  if (bodyChanged && approved && !causes.length) {",
    replace: "  if (bodyChanged && approved && causes.length < 2) {",
    planted: "document_edit starts demanding two causes, so the other half of the rule dies " +
      "quietly: a wording fix that says in one line what was wrong is refused, and the refusal " +
      "still tells the caller that one source or its words is enough",
  },
  {
    check: SUITES_SURFACE,
    target: "opening is explicit and dated by the platform, and freeform gets no next move",
    assertion: "a closed initiative's answer says what is true of its own handover",
    subject: "services/zz-core/src/tools/initiative-closed.ts",
    find: "  const handover = states.find(isHandover);",
    replace: "  const handover = undefined as (typeof states)[number] | undefined;",
    planted: "the closed answer stops looking at the handover it has, so every closed " +
      "initiative is told to go and write one — including the one whose handover.md is " +
      "already written, approved and signed. The field exists to say what is left, and it " +
      "would be naming a thing that was done",
  },
  {
    check: SUITES_SURFACE,
    target: "opening is explicit and dated by the platform, and freeform gets no next move",
    assertion: "a stage that evidences itself with a source is walked like any other stage",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "st.produces === \"source\")",
    replace: "st.produces !== \"source\")",
    planted: "no stage that produces a source is ever counted as an owed audit, so the next " +
      "move never names it — which is the shape the walk had before it read the manifest's " +
      "stages at all: the platform answered `write plan.md` the moment the spec was approved, " +
      "and the close then refused for a round nothing had told the agent to run",
  },
  {
    check: SUITES_SURFACE,
    target: "opening is explicit and dated by the platform, and freeform gets no next move",
    assertion: "a freeform initiative is given no next move at all",
    subject: "services/zz-core/src/tools/initiative-status.ts",
    find: "        : null,",
    replace: '        : { action: "declare_flow", waiting_on: "the team",\n' +
      '            why: "no flow governs this initiative — pass `flow` to document_write on " +\n' +
      '                 "the first document" },',
    planted: "an initiative somebody assembled by hand is told to declare a flow, which is the " +
      "instruction the platform removed: a flow cannot be adopted after an initiative exists, so the " +
      "platform is naming a next stage it invented and pointing the caller at a door that no " +
      "longer opens",
  },
  {
    check: SUITES_SURFACE,
    target: "the evaluation modules are on the evaluation side, and attest stays on the core one",
    assertion: "only the evaluation side and its door reach into the evaluation modules",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: 'import { approvalBasis, approvalConflict, approvalRecord } from "../attest.js";',
    replace: 'import { approvalBasis, approvalConflict, approvalRecord } from "../attest.js";\n' +
      'import { JUDGE_MODEL } from "../eval/judge-model.js";\nvoid JUDGE_MODEL;',
    planted: "a core document tool reaches into the evaluation flow's judge, so one flow's " +
      "judging machinery is loaded into every account's core door — and the directory the core " +
      "surface is scanned out of starts importing the modules that were moved off it",
  },
  {
    check: SUITES_SURFACE,
    target: "the two misnamed core skills are renamed, every caller moved, and an old step " +
      "still resolves",
    assertion: "the renamed skill declares its new name in its own frontmatter",
    subject: "skills/zz-platform/SKILL.md",
    find: "name: zz-platform",
    // SEAMED, and the prose below is worded around the old name rather than quoting it: the
    // rename sweep reads every tracked file under scripts/ and cannot tell a spec quoting a
    // dead skill name from a caller still using one.
    replace: "name: zz-back" + "bone",
    // REDACTED. The payload is a pre-rename tool or skill name, and this repository sweeps
    // every tracked file for those — including `testing/mutation-report.json`, which `plant()`
    // writes the reconstructed string into, so seaming the source is not enough. `redact`
    // base64-encodes it there, so the experiment stays reproducible and neither file is the
    // finding.
    redact: true,
    planted: "the platform skill announces itself under its pre-rename name again, in the " +
      "frontmatter skill_read resolves by, so the rename is a directory that moved and a name " +
      "that did not — every caller asking for zz-platform gets a skill that says it is " +
      "something else",
  },];
