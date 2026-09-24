/**
 * Defects aimed at the suites registered by `scripts/gate/checks/suites.ts`.
 *
 * Each check there is one line that spawns `checks/<name>.ts` and fails on a non-zero exit,
 * so a row's subject here is almost never the spawned script: it is whatever that script
 * reads — a source module, a manifest, a migration, a skill's prose.
 *
 * Every row carries an `assertion`, because one module registers dozens of checks and a row
 * naming only the module says nothing about which suite went red.
 *
 * DELIBERATE: every mutation that reaches its check through `dist/` is type-valid. `tsc -b`
 * emits nothing for a project with type errors, so the check would read the previous dist and
 * the row would record "survived" for a defect that never arrived.
 */
import type { MutationSpec } from "./plant.ts";

/** Every row in this file is registered by the same module. */
// COUPLED: `check_sha256` is computed over the module that registers the target, so a row
// drifts when that module changes.
const SUITES = "scripts/gate/checks/suites.ts";
const SUITES_DATA = "scripts/gate/checks/suites-data.ts";
const SUITES_SURFACE = "scripts/gate/checks/suites-surface.ts";
const SUITES_TENANT = "scripts/gate/checks/suites-tenant.ts";
const SUITES_TOOLING = "scripts/gate/checks/suites-tooling.ts";

/* DELIBERATE: the three tokens below are split across a concatenation, and that is not
 * style. This file is under `scripts/` and ends in `.ts`, which is the tree three of the
 * checks it plants for walk, and all three read string literals. Written whole, each token
 * turns its own check red on the unmutated tree, so every row here would read `baseline_red`.
 *
 * Joining them at runtime keeps the planted text byte-identical and the token out of the
 * source. Do not tidy them back into one literal. */
const MJS = ".m" + "js";
const MERGED_AWAY = "block_" + "skills";

export const COV_SUITES_1: readonly MutationSpec[] = [

  {
    check: SUITES,
    target: "the pure document rules do what they say",
    assertion: "a cell cannot break out of its table row",
    subject: "services/zz-core/src/document-rules.ts",
    find: "const tableCell = (v: string) => oneLine(v).replace(/\\|/g, \"/\");",
    replace: "const tableCell = (v: string) => oneLine(v);",
    planted: "a pipe inside a table cell is written through unescaped, so an initiative " +
      "folder named `a|b` becomes two columns and the outcome ledger — the record the " +
      "closing verdict rests on — reads as an initiative and an outcome that were never written",
  },
  {
    check: SUITES_TOOLING,
    target: "an unsupported Node fails naming both versions and why, as a runtime problem " +
      "rather than a syntax error in the code",
    assertion: "the floor is read from package.json and compared against the running Node",
    subject: "package.json",
    find: `"node": ">=24.0.0"`,
    replace: `"node": ">=99.0.0"`,
    planted: "the declared Node floor is raised past every release that exists, so the " +
      "repository refuses to run anywhere — and .nvmrc and the image still say 24, which is " +
      "the drift a single declared floor exists to make impossible",
  },
  {
    check: SUITES_TOOLING,
    target: "no discovery site under scripts/ or checks/ filters on .mjs alone, matching " +
      "nothing after the rename",
    assertion: "a discovery site that selects an extension nothing carries is found",
    subject: "scripts/probes/envelope-shape.ts",
    find: `  .filter((f) => f.endsWith(".ts"))`,
    replace: `  .filter((f) => f.endsWith("${MJS}"))`,
    planted: "the envelope-shape probe looks for files under an extension this repository " +
      "stopped carrying, so it " +
      "reads an empty source, finds no stampEnvelope to examine and reports a clean result " +
      "for a check that examined nothing",
  },
  {
    check: SUITES_TOOLING,
    target: "scripts/gate/ carries zero strict errors, the registry it runs is unchanged, " +
      "and none of them was reached by widening to any",
    assertion: "the gate subtree still typechecks clean",
    subject: "scripts/tenant-info/judged-dataset.ts",
    find: "export function generateJudgedDataset(): { readonly queries: readonly JudgedQuery[]; " +
      "readonly qrels: readonly Qrel[] } {",
    replace: "export function generateJudgedDataset(): { readonly queries: readonly JudgedQuery[] } {",
    planted: "the judged dataset's generator stops declaring the qrels half it still returns, " +
      "so its one caller inside the gate reads an undeclared property and the gate subtree " +
      "no longer typechecks — the state this check exists to stop the repository drifting into",
  },
  {
    check: SUITES_TOOLING,
    target: "the command a model is told to run names a file the consumer will actually have",
    assertion: "a shipped command resolves against the built tree, not the catalog source",
    subject: "catalog/zz/zz-access/skills/zz-doctor/SKILL.md",
    find: "node \"${CLAUDE_PLUGIN_ROOT}/skills/zz-doctor/doctor.js\"",
    replace: "node \"${CLAUDE_PLUGIN_ROOT}/skills/zz-doctor/doctor.ts\"",
    planted: "the doctor skill tells a model to run the TypeScript source, which only this " +
      "repository has — a consumer receives the compiled .js, so the command fails with " +
      "\"cannot find module\" at the moment somebody is already trying to diagnose something",
  },
  {
    check: SUITES_TOOLING,
    target: "every script or check a document or a thrown error names by path is a file that " +
      "exists, and CHANGELOG.md alone is left free to remember one that isn't",
    assertion: "a path named in prose still resolves",
    subject: "ARCHITECTURE.md",
    find: "checks/docs-current.ts",
    replace: `checks/docs-current${MJS}`,
    planted: "the architecture document points a reader at a file under an extension this " +
      "repository stopped using, so the one place that says which check holds the document " +
      "ceiling names something nobody can open",
  },
  {
    check: SUITES_DATA,
    target: "an aggregate nothing measured renders as null, never a confident zero",
    assertion: "the overview tests run bytes for null rather than folding a gap to zero",
    subject: "services/gateway/src/console/overview-metrics.ts",
    find: "const measured = runs.rows.filter((r) => r.bytes !== null);",
    replace: "const measured = runs.rows;",
    planted: "the overview stops separating runs whose size was never measured from runs that " +
      "moved nothing, so every unmeasured run renders as a zero on the floor of the chart and " +
      "drags the median size down with it",
  },
  {
    check: SUITES_DATA,
    target: "a column nothing reads is not proof a column nothing needs",
    assertion: "the written tool_key is resolved again rather than read outright",
    subject: "packages/tools/src/testing/tool-report.ts",
    find: "resolveToolKey(e.tool_key ?? e.subject)",
    replace: "resolveToolKey(e.subject)",
    planted: "the tool report goes back to grouping by the raw subject, so the snapshot column " +
      "written at call time is fetched and thrown away and a renamed tool appears as two " +
      "unrelated series that never add up",
  },
  {
    check: SUITES_DATA,
    target: "the record's own columns exist, and a gap is nullable",
    assertion: "a token column a provider never reported stays nullable",
    // The schema, not the migration that added the column: a squashed migration is a file
    // that is no longer there, and planting into one lands zero replacements, a row proving
    // nothing. The spelling is pg_dump's, four spaces and one before the type.
    subject: "services/gateway/migrations/001_init.sql",
    find: "    input_tokens integer,",
    replace: "    input_tokens integer NOT NULL DEFAULT 0,",
    planted: "the input-token column is made not-null with a zero default, so a provider that " +
      "reported no usage and a call that genuinely consumed nothing land as the same row and " +
      "a sum over the column reads as complete while it is silently short",
  },
  {
    check: SUITES_DATA,
    target: "every completion the judge asks for is recorded, and an unreported figure stays null",
    assertion: "an unreported token count is recorded as null, never as zero",
    subject: "services/zz-core/src/eval/judge.ts",
    find: "? Math.trunc(v) : null;",
    replace: "? Math.trunc(v) : 0;",
    planted: "the judge records a token count the provider never sent as zero, which is the " +
      "exact conflation the column was added to prevent — spend that was not reported " +
      "becomes spend that did not happen",
  },
  {
    check: SUITES_SURFACE,
    target: "every plugin declares what it is, what it ships, and what each stage leaves behind",
    assertion: "every stage declares what it produces",
    subject: "catalog/sdlc/sdlc-flow/flow.json",
    find: `      "name": "sdlc-explore",\n      "produces": "explore.md"`,
    replace: `      "name": "sdlc-explore"`,
    planted: "the explore stage stops declaring what it leaves behind, so the manifest " +
      "describes a flow whose first stage promises no artifact and nothing downstream can say " +
      "what the stage after it is supposed to read",
  },
  {
    check: SUITES_SURFACE,
    target: "the core door serves exactly its tools, and a removed tool is gone from every caller",
    assertion: "a deleted tool name survives nowhere, prose included",
    subject: "skills/zz-platform/SKILL.md",
    find: "| skills | `/core/mcp` | `skill_list` `skill_read` |",
    replace: `| skills | \`/core/mcp\` | \`${MERGED_AWAY}\` \`skill_read\` |`,
    // REDACTED: the payload is a pre-rename tool name, which this repository sweeps every
    // tracked file for — including the mutation report, which plant() writes the
    // reconstructed string into. `redact` base64-encodes it there.
    redact: true,
    planted: "the platform skill's door table names the listing tool that was merged away " +
      "into `skill_list(owner?)` and is registered by no door, so an agent that follows the " +
      "one document describing the surface fails with \"tool not found\" mid-stage, with " +
      "nothing red anywhere",
  },
  {
    check: SUITES_SURFACE,
    target: "the evaluation door serves its own tools, and the gateway reaches that door and " +
      "not the other",
    assertion: "the flow's manifest declares the door that serves the tools its skills call",
    subject: "catalog/zz/zz-plugin-eval/flow.json",
    find: `      "path": "/eval/mcp"`,
    replace: `      "path": "/core/mcp"`,
    planted: "zz-plugin-eval declares the baseline core door instead of its own, so the " +
      "manifest points every install at a door that serves none of the tools its skills call " +
      "— and at one every account already has, which hides the mistake behind a door that answers",
  },
  {
    check: SUITES_SURFACE,
    target: "the evaluation door speaks four nouns, three names are deliberately untouched, " +
      "and the graders and the chain check follow",
    assertion: "the release chain check calls names the door actually registers",
    subject: "packages/tools/src/testing/chain-eval.ts",
    find: `await callEval("protocol_read", { subject_version_id: randomUUID() }),`,
    replace: `await callEval("ruler_read", { subject_version_id: randomUUID() }),`,
    planted: "the release chain check calls `ruler_read`, which Task I-10 removed from the " +
      "door — the call 404s against a live deployment hours after the gate said the change " +
      "was fine, and `protocol_read` is exercised by nothing",
  },
  {
    check: SUITES_SURFACE,
    target: "the written record matches the delivered surface, and no document outgrew the ceiling",
    assertion: "the fit-for-purpose review is a step that actually stops the release",
    subject: "scripts/release/fit-for-purpose.ts",
    find: `    die("this release has not been reviewed for fit. Read the surfaces above, then re-run "`,
    replace: `    log("this release has not been reviewed for fit. Read the surfaces above, then re-run "`,
    planted: "the one release step nothing computes for you is softened from a refusal to a " +
      "printed paragraph, so a release nobody reviewed for fit carries straight on — and the " +
      "message still says it stopped",
  },
  {
    check: SUITES_TENANT,
    target: "corpus planning arithmetic refuses a fractional fixture count, and the " +
      "deterministic text generator hits its exact byte target",
    assertion: "a scale that gives a fractional fixture count is refused, not rounded",
    subject: "scripts/tenant-info/inventory.ts",
    find: "    if (!isWholeNumber(records) || !isWholeNumber(oneMib)) {",
    replace: "    if (!isWholeNumber(records)) {",
    planted: "a reduced scale whose one-MiB fixture count comes out fractional is rounded " +
      "silently instead of refused, so the corpus that gets generated is a different and " +
      "undeclared one from the corpus the report says was measured",
  },
  {
    check: SUITES_TENANT,
    target: "the artifact reference and semantic payload schemas reject malformed input and " +
      "agree on the one semantic-field order",
    assertion: "a reference's revision must be a positive integer or null",
    subject: "packages/contracts/src/tenant-information.ts",
    find: "export const ArtifactRefSchema = z.object({\n  owner_id: UuidSchema,\n" +
      "  artifact_id: UuidSchema,\n  revision: PositiveIntSchema.nullable(),",
    replace: "export const ArtifactRefSchema = z.object({\n  owner_id: UuidSchema,\n" +
      "  artifact_id: UuidSchema,\n  revision: z.number().nullable(),",
    planted: "an artifact reference accepts revision 0, a negative revision and a fractional " +
      "one, so provenance can be written naming a revision that cannot exist and the " +
      "append-only record carries it forever",
  },
  {
    check: SUITES_TENANT,
    target: "a subtype policy decision refuses source verify, knowledge approve and an " +
      "undeclared work gate by name, and binds approval/verification to the actual revision " +
      "and record digest",
    assertion: "a transition binds to the record digest, not the revision alone",
    subject: "services/zz-core/src/tenant-info/policies.ts",
    find: "  if (context.current_revision !== context.expected_revision) return " +
      "refusedTransition(\"REVISION_CONFLICT\");\n  if (context.record_digest !== " +
      "context.expected_record_digest) return refusedTransition(\"REVISION_CONFLICT\");",
    replace: "  if (context.current_revision !== context.expected_revision) return " +
      "refusedTransition(\"REVISION_CONFLICT\");",
    planted: "an approval stops binding to the record digest and binds to the revision alone, " +
      "so effective provenance moving underneath an artifact no longer invalidates the " +
      "approval — a signature carries onto content nobody read",
  },
  {
    check: SUITES_TENANT,
    target: "a legacy import through the real importer and the real kernel keeps every " +
      "original byte, classifies malformed frontmatter as legacy-raw, leaves an undeclared " +
      "original time null, and applying the same conversion manifest twice adds no identity, " +
      "revision or event",
    assertion: "a document that declared no original time keeps a null one",
    subject: "services/zz-core/src/tenant-info/legacy-import.ts",
    find: `  if (raw === null) return { at: null, precision: "unknown" };`,
    replace: `  if (raw === null) return { at: "1970-01-01T00:00:00.000Z", precision: "unknown" };`,
    planted: "a legacy file that declared no date is imported carrying the epoch as its " +
      "original time, so every undated document in a migrated store looks like a recorded " +
      "instant and a reader can no longer tell which times the converter invented",
  },
  {
    check: SUITES_TENANT,
    target: "the rebuild cache decision is exact equality, refuses no prior attempt as always " +
      "stale, and changes on every one of a fingerprint's own named fields",
    assertion: "every version the fingerprint names actually changes it",
    subject: "packages/indexing/src/tenant-analysis.ts",
    find: "    analyzer: v.analyzer, passage: v.passage, projection: v.projection,",
    replace: "    analyzer: v.analyzer, projection: v.projection,",
    planted: "the derivation fingerprint stops folding in the passage version, so bumping the " +
      "passage builder leaves every stored fingerprint unchanged and an index built by the " +
      "old code is never rebuilt — it just quietly keeps serving",
  },
  {
    check: SUITES_TENANT,
    target: "an isolation observation is refused as vacuous with no baseline results, and " +
      "refused on a changed statistic, a changed score or leaked forbidden metadata, never " +
      "only on a mismatched shape",
    assertion: "a corpus statistic that moved is refused on its value, not its shape",
    subject: "testing/tenant-info/isolation.ts",
    find: "if (a !== b) {",
    replace: "if (typeof a !== typeof b) {",
    planted: "the isolation check compares corpus statistics by type instead of by value, so " +
      "another owner's write moving this owner's document count from 40 to 5040 passes as an " +
      "observation of perfect isolation — the shape matched, and nothing read the number",
  },
  {
    check: SUITES_TENANT,
    target: "a benchmark report is refused when its scale is forged, its corpus distribution " +
      "is off, a slice divides by nothing, its qrels are not the approved ones or a binding " +
      "is missing — and the honestly empty report still validates",
    assertion: "a report measured against an unapproved judged set is refused",
    subject: "scripts/tenant-info/benchmark-report.ts",
    find: "    if (dataset.queries_jsonl_sha256 !== dataset.approved_queries_sha256\n" +
      "      || dataset.qrels_jsonl_sha256 !== dataset.approved_qrels_sha256) {\n" +
      "      errors.push(\"the measured dataset hashes are not the ones H1 approved — this " +
      "report was run against a \" +\n        \"different judged set, which voids the approval " +
      "rather than inheriting it\");\n    }\n",
    replace: "",
    planted: "a benchmark report stops being checked against the judged set a person actually " +
      "approved, so a run over a different set of queries and qrels validates and inherits an " +
      "approval that was never given to it",
  },
  {
    check: SUITES_SURFACE,
    target: "the deck skill names one destination, and never the platform's document-write tool",
    assertion: "the skill names one destination and no platform write tool",
    subject: "skills/zz-deck/SKILL.md",
    find: "Output path: `decks/YYYY-MM-DD-<slug>.html` under the workspace root, always",
    replace: "Output path: `decks/YYYY-MM-DD-<slug>.html` under the workspace root, or " +
      "`document_write` into the initiative",
    planted: "the deck skill grows a second destination and reaches for the platform's " +
      "document-write tool, so where a deck lands depends on whether an initiative happens to " +
      "be open and a reader sent to `decks/` finds nothing there",
  },
];
