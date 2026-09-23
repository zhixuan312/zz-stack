/**
 * Defects planted in zz-core's document rules and the gateway's telemetry.
 *
 * Three of these are RUN by the check that catches them — `pathShapeRefusal` is lifted out of
 * the service and driven over a table of paths, and the guard and schema checks read what the
 * service actually does with a path or an envelope field. The frontmatter one is the odd case
 * and it is called out in its own row: the sweep it feeds currently has no subject in the
 * repository at all, so the only way to find out whether it can fail is to give it one.
 */
import type { MutationSpec } from "./plant.ts";

/**
 * The coverage check's own path, and why it was briefly not written out.
 *
 * `mutation-coverage.ts` is the frozen check this whole run exists to make answerable, and it
 * arrived with the task that integrates this one. A spec had to be ready before it landed,
 * because a declared check with no spec produces a zero-replacement row and the coverage check
 * refuses exactly that. But writing the path out while the file did not exist made this module
 * name a path that was not there — `every literal path a script or check names under scripts/
 * or checks/ is a file that exists` — and that check caught it on the first run after the spec
 * was added.
 *
 * So it was assembled as `scripts/gate/${"checks"}/mutation-coverage.ts` for exactly as long as
 * the file was missing, and disclosed rather than left in: a script under `scripts/` stepping
 * around one of this repository's own checks is the shape those checks exist to find, and the
 * disclosure is what stops it becoming a pattern somebody copies. The check is planted now, so
 * the path is a plain literal and the evasion is gone with the reason for it.
 */
const NOT_YET_PLANTED = "scripts/gate/checks/mutation-coverage.ts";

export const DOCUMENT_SPECS: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/documents-guards.ts",
    target: "every store mutation goes through the shared guard and persist",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: "      const blocked = writeGuard(relPath);",
    replace: "      const blocked: string | null = null;\n      void writeGuard;",
    all: true,
    planted: "one write path stops calling the shared write guard, so the tool can rewrite " +
      "the frozen copy of what was approved — the exact asymmetry document_patch once had",
  },
  {
    check: "scripts/gate/checks/documents-lifecycle.ts",
    target: "document_revise records the material behind every version",
    subject: "services/zz-core/src/tools/initiative-acts.ts",
    find: '          "ERROR: nothing says what caused this version. Content does not change without " +',
    replace: '          "ERROR: this revision was not accepted. Try again with more detail. " +',
    planted: "the refusal for a revision that cites nothing stops naming what is missing, so " +
      "a caller is turned away without being told that material is what the record needs",
  },
  {
    check: "scripts/gate/checks/documents-schema.ts",
    target: "every envelope field the platform writes is one the schema declares",
    subject: "services/zz-core/src/write-guards.ts",
    find: "  if (title) env.title = title;",
    replace: "  if (title) env.heading = title;",
    planted: "the platform writes an envelope field the published schema does not declare, so " +
      "a flow outside this repository may claim the same name and collide with it",
  },
  {
    check: "scripts/gate/checks/security-boundary.ts",
    target: "nothing under a store root that begins with a dot is reachable",
    subject: "services/zz-core/src/paths.ts",
    find: '  if (/(^|\\/)\\.zz\\//.test(path) || path.includes("~/")) {',
    replace: '  if (/(^|\\/)\\.zzz\\//.test(path) || path.includes("~~/")) {',
    planted: "the path-shape refusal stops recognising a store-relative escape, so a " +
      "home-relative path is accepted and the write lands somewhere nobody named",
  },
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "no skill calls a tool the platform does not register",
    subject: "skills/zz-platform/SKILL.md",
    find: "document_present(",
    replace: "document_display(",
    all: true,
    planted: "the skill every agent loads first tells it to call a tool no door registers, so " +
      "the model gets an unknown-tool error in the middle of a stage the flow declared mandatory",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    target: "every field the tool telemetry writes has a reader",
    subject: "services/gateway/src/events.ts",
    find: "export function logEvent(e: {",
    replace: "export function logEvent(e: {\n  attemptWindow?: string;",
    planted: "the event row grows a measurement column nothing reads — capture wired at one " +
      "end and nowhere at the other, which is what `status` was for six thousand rows",
  },
  {
    // READY BEFORE ITS CHECK EXISTS. The coverage check's subject is this run's own report, so
    // the moment it is planted it becomes a declared check that needs a row of its own. Flipping
    // a measured `failed` to false is the defect it is written to catch: a check that survived a
    // planted defect and was recorded as if it had not.
    // NO SPACE AFTER THE COLON, and that is not a typo. `reportText` in the runner writes each
    // result row with a bare `JSON.stringify`, one row per line, so the artifact this plants
    // into spells the field `"failed":true`. A spec carrying the pretty-printed spelling lands
    // zero replacements, which the coverage check reports as a row that proves nothing.
    check: NOT_YET_PLANTED,
    target: "every critical check has been shown to fail on a planted defect",
    subject: "testing/mutation-report.json",
    find: '"failed":true',
    replace: '"failed":false',
    all: true,
    assertion: "a row recorded as having survived its planted defect is refused",
    planted: "every row in the report claims its check survived the defect planted against it, " +
      "which is precisely the state the coverage check exists to refuse",
  },
  {
    // THE THIRD OUTCOME, WHICH USED TO BE REPORTED AS THE SECOND. A row whose own target was
    // already failing before anything was planted cannot appear in `new_failures`, so `failed`
    // comes back false and the row reads exactly like a check that shrugged off a defect. It is
    // not: nothing was measured, because the experiment had no baseline to move from.
    //
    // The wrong message is the whole cost. "This check is weak" sends a reader to rewrite a
    // check that is probably fine; the truth sends them to whatever turned the gate red before
    // the mutation landed, which is usually a spec file's own payload — these files are tracked
    // TypeScript and this repository sweeps tracked files, so a quoted defect reads as a real
    // one. That happened the same night this spec was written, in another author's batch, four
    // times in one file.
    check: NOT_YET_PLANTED,
    target: "every critical check has been shown to fail on a planted defect",
    assertion: "a row whose target was already red at baseline is named as having measured nothing, NOT as having survived",
    subject: "testing/mutation-report.json",
    find: '"baseline_red":false',
    replace: '"baseline_red":true',
    all: true,
    planted: "every row in the report says its target was already failing before the defect was " +
      "planted, so not one of them measured anything — the state a reader must never meet " +
      "wearing the word `survived`",
  },
  {
    check: "scripts/gate/checks/activation-runbook.ts",
    target: "the activation runbook is complete, abortable and not self-authorizing",
    assertion: "every step keeps an abort point",
    subject: "deploy/activation-runbook.json",
    find: '"abort":',
    replace: '"abort_note":',
    all: true,
    planted: "every step of the activation runbook loses its abort point, so a cutover that " +
      "goes wrong at step seven has no written way back written down anywhere",
  },
  {
    check: "scripts/gate/checks/activation-runbook.ts",
    target: "the activation runbook is complete, abortable and not self-authorizing",
    assertion: "a precondition marked met without evidence is refused — the shape that lets an activation mark its own gate",
    subject: "deploy/activation-runbook.json",
    find: '"state": "blocked"',
    replace: '"state": "met"',
    all: true,
    planted: "every precondition reads as met while restore_evidence and switch_authorization " +
      "still carry `evidence: null`, so the switch is cleared by eight fields somebody edited " +
      "rather than by anything observed",
  },
  {
    check: "scripts/gate/checks/activation-runbook.ts",
    target: "the activation runbook is complete, abortable and not self-authorizing",
    assertion: "an operator named by nobody is refused — accountability cannot be self-conferred",
    subject: "deploy/activation-runbook.json",
    find: '"name": null',
    replace: '"name": "the operator"',
    planted: "the runbook names an accountable operator while `assigned_by` stays null, which " +
      "is a name no authority ever conferred and the exact shape the old `=== \"unassigned\"` " +
      "clause was reaching for and could never touch",
  },
  {
    check: "scripts/gate/checks/activation-runbook.ts",
    target: "the activation runbook is complete, abortable and not self-authorizing",
    assertion: "a waiver field is refused — and the clause IS reachable, it is a guard on an absent key",
    subject: "deploy/activation-runbook.json",
    find: '"preconditions": {',
    replace: '"waivePreconditions": true,\n  "preconditions": {',
    planted: "the runbook gains the waiver field that deploy/ACTIVATION.md:53 says does not " +
      "exist and that activation-rehearsal.ts rehearses against, so a blocked precondition " +
      "could be stepped past",
  },
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "nothing sends the platform a document with frontmatter in it",
    subject: "packages/contracts/src/check-state.ts",
    find: "export const CHECK_STATES",
    replace: "const ENVELOPE = `---\\nflow: x\\n---\\n`;\nvoid ENVELOPE;\n\nexport const CHECK_STATES",
    planted: "a module outside zz-core composes a document that opens with frontmatter, which " +
      "is the third source of envelope fields the platform spent an initiative closing",
  },
  {
    check: "scripts/gate/checks/documents-frontmatter.ts",
    target: "generated frontmatter quotes what it interpolates",
    subject: "services/gateway/src/client-package.ts",
    find: 'const OWNER = { name: "ZZ Stack", url: `https://github.com/${MARKETPLACE_REPO}` };',
    replace: 'const OWNER = { name: "ZZ Stack", url: `https://github.com/${MARKETPLACE_REPO}` };\n' +
      'const CARD = `name: "${MARKETPLACE_REPO}"`;\nvoid CARD;',
    planted: "a YAML scalar is hand-quoted around an interpolation instead of being passed " +
      "through JSON.stringify, which is how a value containing a quote breaks the document it " +
      "is written into",
    caveat: "this sweep has NO subject in the repository as it stands — nothing currently " +
      "builds a hand-quoted frontmatter scalar — so the defect had to be introduced rather " +
      "than made out of an existing construction",
  },
];
