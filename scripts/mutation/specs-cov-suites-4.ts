/**
 * Mutation specs for the tail of `scripts/gate/checks/suites.ts`.
 *
 * Every check registered by that file is one line — `check("<id>", runsCheck("<name>.ts"))` —
 * so the file itself asserts nothing. The real subject of each row below is whatever
 * `checks/<name>.ts` reads, and the defect is planted there rather than in the script that
 * judges it: a defect in the thing being judged is a measurement, a defect in the judge is not.
 *
 * Every row carries an `assertion` because this one check file will end up with ~95 rows, and
 * a row naming only `suites.ts` says nothing about which claim it proved.
 */
import type { MutationSpec } from "./plant.ts";

// Which module registers the target, which is what `check_sha256` is computed over.
const SUITES_DATA = "scripts/gate/checks/suites-data.ts";
const SUITES_SURFACE = "scripts/gate/checks/suites-surface.ts";
const SUITES = "scripts/gate/checks/suites.ts";
const SUITES_TOOLING = "scripts/gate/checks/suites-tooling.ts";
const HYGIENE = "scripts/gate/checks/hygiene.ts";

export const COV_SUITES_4: readonly MutationSpec[] = [
  {
    check: SUITES,
    target: "the write guards refuse what they say they refuse",
    assertion: "a gated approval carrying a signer but no date is refused",
    subject: "services/zz-core/src/write-guards.ts",
    find: '(["approved_by", "approved_at"] as const).filter((f) => !(env[f] ?? "").trim());',
    replace: '(["approved_by"] as const).filter((f) => !(env[f] ?? "").trim());',
    planted: "a gate pass no longer has to be dated. A gated document offered as approved " +
      "with an approver and no approved_at is accepted, so the record says somebody agreed " +
      "and cannot say when — which is half a signature, and the half an audit reads",
  },
  {
    check: SUITES_TOOLING,
    target: "the node floor is one decision written in package.json and .nvmrc, and the image does not move with it",
    assertion: "the contributor's floor is one decision, written the same in both files",
    subject: ".nvmrc",
    find: "24",
    replace: "22",
    planted: "the Node floor becomes two different decisions: package.json requires >=24 and " +
      ".nvmrc selects 22, so a contributor who trusts the version file installs a runtime the " +
      "project's own engines field refuses, and finds out at an arbitrary later failure",
  },
  {
    check: SUITES_TOOLING,
    target: "no file this rename touched went missing, and every sibling that imports one now names it by its .ts extension",
    assertion: "a relative import of a converted sibling names it by its .ts extension",
    subject: "catalog/zz/zz-access/skills/zz-migrate/migrate.ts",
    find: 'import type { JournalNode, Survey } from "./read-mma.ts";',
    replace: 'import type { JournalNode, Survey } from "./read-mma.js";',
    planted: "a shipped skill script imports a converted sibling by a .js path that does not " +
      "exist in the source tree. NodeNext still resolves it for the compiler, so the rename " +
      "reads as complete while one specifier has quietly gone back to naming build output",
  },
  {
    check: SUITES_TOOLING,
    target: "what consumers receive is JavaScript, never the source, and rebuilding it changes nothing",
    assertion: "the shipped skill scripts carry no source map reference",
    subject: "tsconfig.catalog.json",
    find: '"sourceMap": false,',
    replace: '"sourceMap": true,',
    planted: "every shipped skill script gains a sourceMappingURL footer pointing at a .map " +
      "file consumers never receive. What installs from the marketplace now references build " +
      "artifacts that are not there, and the compile stops being reproducible from the tree",
  },
  {
    check: SUITES_TOOLING,
    target: "a file that resolves renamed tools never matches a pre-rename name",
    assertion: "a file that folds old names onto new ones never compares against an old one",
    subject: "packages/tools/src/testing/tool-report.ts",
    find: 't.includes("skill_read")',
    // SEAMED: the payload is a pre-rename tool name, which is the whole point of it — and the
    // door-naming sweep reads this file too. `plant()` joins it back before it is written.
    replace: 't.includes("skill_vi' + 'ew")',
    // REDACTED. The payload is a pre-rename tool name, and this repository sweeps every tracked
    // file for those — including testing/mutation-report.json, which plant() writes the
    // reconstructed string into. redact base64-encodes it there.
    redact: true,
    planted: "the tool report filters resolved subjects for a name the resolver has already " +
      "folded away. It matches no row, ever, so the \"skills this run loaded\" section " +
      "silently stops rendering and the report looks complete while a whole section is gone",
  },
  {
    check: SUITES_DATA,
    target: "the resolvers are applied wherever a stored name is read",
    assertion: "an old tool name folds onto the tool it actually became",
    subject: "packages/contracts/src/alias.ts",
    find: '  write_file: "document_write",',
    replace: '  write_file: "document_revise",',
    // REDACTED. The payload is a pre-rename tool or skill name, and this repository sweeps
    // every tracked file for those — including `testing/mutation-report.json`, which `plant()`
    // writes the reconstructed string into, so seaming the source is not enough. `redact`
    // base64-encodes it there, so the experiment stays reproducible and neither file is the
    // finding.
    redact: true,
    planted: "calls made before the rename are folded onto the wrong survivor. A window " +
      "spanning the rename reads as one series for write_file and document_revise and another " +
      "for document_write, so both tools' usage figures are wrong and neither is obviously so",
  },
  {
    check: SUITES_DATA,
    target: "the definition this platform is built on holds in its source",
    assertion: "R5 — nothing may stamp a status where the manifest declares no gate",
    subject: "services/zz-core/src/write-guards.ts",
    find: 'if (gated && present.status === undefined) add.push("status: draft");',
    replace: 'if ((gated || governed) && present.status === undefined) add.push("status: draft");',
    planted: "the envelope stamper goes back to conditioning `status` on the document merely " +
      "being declared rather than on it being gated. Every ungated document a flow names is " +
      "stamped `status: draft`, which records a verdict no manifest ever asked anyone for",
  },
  {
    check: SUITES_DATA,
    target: "the chain check runs where a deployment exists, and not in this gate",
    assertion: "every tool a door registers is exercised through that door's client",
    subject: "packages/tools/src/testing/chain-check.ts",
    find: 'call("source_list", { initiative: INIT })',
    replace: 'call("sources_list", { initiative: INIT })',
    planted: "the release walk calls a tool name no door serves, so source_list is never " +
      "exercised and the call that replaces it fails at release with `tool not found` — the " +
      "one place this walk runs, and the last place anybody wants to discover a gap in it",
  },
  {
    check: SUITES_SURFACE,
    target: "a flow is a plugin that declares documents, and zz-access is not one",
    assertion: "the prose that defines a flow agrees with the predicate that decides it",
    subject: "ARCHITECTURE.md",
    find: "**A package is a flow if and only if it declares `documents`.**",
    replace: "**A package is a flow if and only if it declares `stages`.**",
    planted: "the document this platform treats as its ruler states the rule the code " +
      "replaced. A reader deciding whether their package is a flow is told to look at " +
      "`stages`, which is the exact confusion that put a non-flow in the flow menu twice",
  },
  {
    check: SUITES_SURFACE,
    target: "a document read takes a list and a version, and history never vouches for the present",
    assertion: "a fetch of an old version is recorded against the bytes it returned",
    subject: "services/zz-core/src/versions.ts",
    find: "    : snapshotOf(history, version);",
    replace: "    : snapshotOf(history, version) ?? history[history.length - 1] ?? null;",
    planted: "opening an old approval is recorded as having opened the live document. " +
      "shownSinceLastChange matches on path and ignores version, so reading v1 now attests " +
      "the current draft nobody looked at, and an approval leans on exactly that answer",
  },
  {
    check: SUITES_SURFACE,
    target: "the /manage door is cut by role, the duplicates are gone, and the exception is kept",
    assertion: "an administrative tool is behind the role gate that carries it",
    subject: "services/gateway/src/admin.ts",
    find: 'if (sup) server.registerTool("person_deactivate", {',
    replace: 'server.registerTool("person_deactivate", {',
    planted: "person_deactivate loses its superadmin gate, so every ordinary member of every " +
      "team is offered a tool that deactivates people. The door still looks cut by role " +
      "everywhere else, which is what makes one missing gate easy to ship",
  },
  {
    check: SUITES_SURFACE,
    target: "the three verification stages leave a document, and keep their independence",
    assertion: "a stage that delegates to a library actually tells its worker to load it",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-spec-audit/SKILL.md",
    find: "**Load `sdlc-audit-criteria` first, then come back here.**",
    replace: "**See `sdlc-audit-criteria` for the rest of the method.**",
    planted: "the spec audit stops instructing its worker to open the library that carries the " +
      "method. The mention survives as an aside, so the skill reads unchanged — but nothing " +
      "the worker is actually handed now states the read-only discipline or that the JSON " +
      "block is the final response, and a round that edits what it audits destroys its own evidence",
  },
  {
    check: SUITES_SURFACE,
    target: "no shipped file states a count of this platform's own surface",
    assertion: "no shipped file freezes a count of the surface it sits beside",
    subject: "services/gateway/src/access-door.ts",
    find: " * The access door: the tools a person uses on their own account.",
    // SEAMED: this payload IS a count of the platform's own surface, which is exactly what
    // `derived-counts.ts` exists to catch — and it sweeps this file too.
    replace: " * The access door: the ni" + "ne tools a person uses on their own account.",
    planted: "the door's own header states how many tools it serves. The number is right the " +
      "day it is typed and silently wrong the next time anybody registers or moves one — the " +
      "same defect this file already shipped four times, each found by a person, late",
  },
  {
    check: SUITES_DATA,
    target: "a proposal is written up without its patch ever being applied",
    assertion: "the proposal module imports nothing that can run anything",
    subject: "services/zz-core/src/eval/proposal-doc.ts",
    find: 'import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";',
    replace: 'import { parseCaller, parseEnvelope, PLATFORM_OWNED } from "@zz/contracts";\n' +
      'import { execFileSync } from "node:child_process";   // to check the patch applies, supposedly',
    planted: "a non-owned subject's write-up reaches for child_process — the one thing the task's own " +
      "words forbid ('a non-owned subject never causes a repository write, ever — make that an " +
      "explicit guard'). Nothing else in the tree would notice: the import compiles, the document " +
      "still renders, and the guarantee is simply no longer true",
  },
  {
    check: HYGIENE,
    target: "every module in the services tree is reachable from something",
    assertion: "a module nothing imports is reported",
    subject: "services/zz-core/src/eval/subject-ref.ts",
    find: 'import { traceOf } from "./judge-trace.js";',
    replace: 'import { traceOf } from "./judge-trace2.js";',
    planted: "the only import of judge-trace is re-pointed at a path that does not exist, so that " +
      "module becomes one nothing reaches while every name it exports stays in use elsewhere — the " +
      "shape this check exists for, and the shape hygiene's own export scan cannot see",
  },
  {
    check: "scripts/gate/checks/checkpoints-consumed.ts",
    target: "every question family a skill names is read by code that routes on it",
    subject: "services/zz-core/src/review-acceptance.ts",
    // The one branch that makes a `no` from evidence_relation refuse a review row. This file had
    // no plant at all until the first full run recorded it as never measured.
    find: '    if (now.reading === "no") {',
    replace: '    if (now.reading === "never") {',
    planted: "sdlc-review still tells the agent the platform asks evidence_relation of every row, " +
      "and a `no` no longer refuses anything — the question is asked and paid for and its answer " +
      "is read by nobody",
  },
  {
    check: "scripts/gate/checks/skill-calls.ts",
    target: "every tool call a skill writes names only the tool's arguments, and every one it requires",
    subject: "skills/zz-platform/SKILL.md",
    // The worked document_revise call every agent reads first. This file had no plant at all
    // until the first full run recorded it as never measured.
    find: '  source_title: "Second brain dump — <what it was about>")',
    replace: '  source_heading: "Second brain dump — <what it was about>")',
    planted: "the platform skill's worked example calls document_revise with an argument the tool " +
      "does not take, so an agent copying it is refused by the schema on its first revision",
  },
];
