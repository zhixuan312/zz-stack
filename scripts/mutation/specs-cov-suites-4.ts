/**
 * Mutation specs for the tail of `scripts/gate/checks/suites.ts`.
 *
 * Every check registered by that file is one line — `check("<id>", runsCheck("<name>.ts"))` —
 * so the file itself asserts nothing. The real subject of each row below is whatever
 * `checks/<name>.ts` READS, and the defect is planted there rather than in the script that
 * judges it: a defect in the thing being judged is a measurement, a defect in the judge is not.
 *
 * Every row carries an `assertion` because this one check file will end up with ~95 rows, and
 * a row naming only `suites.ts` says nothing about which claim it proved.
 */
import type { MutationSpec } from "./plant.ts";

export const COV_SUITES_4: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
    target: "checks/ carries zero strict errors, and none of them was reached by widening to any",
    assertion: "zero errors under checks/ was not bought by widening a type to any",
    subject: "checks/backup-covers-the-undisposable.ts",
    find: "const bad=structuredClone(good); bad.components[0].sha256='not-a-hash';",
    // SEAMED: the payload is a widening assertion, and the strict sweep reads every tracked
    // file — including this one. `plant()` joins it back together before it is written.
    replace: "const bad=structuredClone(good) as an" + "y; bad.components[0].sha256='not-a-hash';",
    planted: "a check widens its own fixture past the compiler, so the subtree still reports " +
      "zero strict errors and that number now means nothing: the fixture this check feeds the " +
      "validator is no longer held to the shape it claims to be, and a validator driven by an " +
      "unchecked fixture proves whatever the fixture happens to contain",
  },
  {
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
    target: "a file that resolves renamed tools never matches a pre-rename name",
    assertion: "a file that folds old names onto new ones never compares against an old one",
    subject: "packages/tools/src/testing/tool-report.ts",
    find: 't.includes("skill_read")',
    // SEAMED: the payload is a pre-rename tool name, which is the whole point of it — and the
    // door-naming sweep reads this file too. `plant()` joins it back before it is written.
    replace: 't.includes("skill_vi' + 'ew")',
    // REDACTED. The payload is a pre-rename tool name, and this repository sweeps every tracked
    // file for those — including testing/mutation-report.json, which plant() writes the
    // RECONSTRUCTED string into. Seaming the source keeps the name out of THIS file and the
    // report still carries it whole. redact base64-encodes it there.
    redact: true,
    planted: "the tool report filters resolved subjects for a name the resolver has already " +
      "folded away. It matches no row, ever, so the \"skills this run loaded\" section " +
      "silently stops rendering and the report looks complete while a whole section is gone",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "the resolvers are applied wherever a stored name is read",
    assertion: "an old tool name folds onto the tool it actually became",
    subject: "packages/contracts/src/alias.ts",
    find: '  write_file: "document_write",',
    replace: '  write_file: "document_revise",',
    // REDACTED. The payload is a pre-rename tool or skill name, and this repository sweeps
    // every tracked file for those — including `testing/mutation-report.json`, which `plant()`
    // writes the RECONSTRUCTED string into. Seaming the source is not enough: the seam keeps
    // the name out of THIS file and the report still carries it whole. `redact` base64-encodes
    // it there, so the experiment stays exactly reproducible and neither file is the finding.
    redact: true,
    planted: "calls made before the rename are folded onto the wrong survivor. A window " +
      "spanning the rename reads as one series for write_file and document_revise and another " +
      "for document_write, so both tools' usage figures are wrong and neither is obviously so",
  },
  {
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
    target: "a document read takes a list and a version, and history never vouches for the present",
    assertion: "a fetch of an old version is recorded against the bytes it returned",
    subject: "services/zz-core/src/versions.ts",
    find: 'logActivity(root, readRel, { user, action: "shown", path: readRel, version: env.version ?? "" });',
    replace: 'logActivity(root, readRel, { user, action: "shown", path: relPath, version: env.version ?? "" });',
    planted: "opening an old approval is recorded as having opened the live document. " +
      "shownSinceLastChange matches on path and ignores version, so reading v1 now attests " +
      "the current draft nobody looked at, and an approval leans on exactly that answer",
  },
  {
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
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
    check: "scripts/gate/checks/suites.ts",
    target: "a baseline receipt carries every required field with its measurement evidence, and never a credential",
    assertion: "every count in a receipt carries the query it was measured with",
    subject: "scripts/tenant-info/baseline.ts",
    find: "    || !isNonEmptyString(c.query))) {",
    replace: "    || c.query === undefined)) {",
    planted: "a baseline receipt is accepted with counts whose query is blank. The number is " +
      "still in the record and nothing says how it was obtained, so nobody can re-derive it " +
      "or tell a measured zero from a query that quietly returned nothing",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "a backup manifest is refused when it is missing any of the five undisposable component kinds, when the canonical record is not included, or when a component's hash is malformed",
    assertion: "a manifest that declares the canonical record absent is refused",
    subject: "testing/tenant-info/deployment.ts",
    find: "if (report.artifacts_include_canonical_record !== true) {",
    replace: "if (report.artifacts_include_canonical_record === undefined) {",
    planted: "a backup manifest that explicitly says the canonical .zz record is NOT in the " +
      "artifacts archive now passes. Only an omitted field is refused, so the one declaration " +
      "somebody has to make by hand is the one that no longer has to be true",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "a semantic payload's canonical hash is stable under tag order/dupes, CRLF and sorted content_fields, and changes on every single-field edit the spec names",
    assertion: "an edit to any semantic field changes the payload's canonical hash",
    subject: "services/zz-core/src/tenant-info/policies.ts",
    find: 'if (field === "description") { out.description = crlfToLf(String(payload.description ?? "")); continue; }',
    replace: 'if (field === "description") { continue; }',
    planted: "description drops out of the canonical payload, so editing it produces the same " +
      "content hash as before. The kernel reads that as a no-op: the new description is never " +
      "committed, no revision is cut and no event is written, and the edit simply vanishes. " +
      "Every other check driving the mutation kernel's identity goes red with this one, " +
      "because the hash IS the kernel's notion of what changed",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "the actual migrations directory names the migration slug exactly once, every numeric prefix is unique, and a duplicate or missing slug is refused",
    assertion: "two migrations sharing one numeric prefix are refused",
    subject: "scripts/tenant-info/inventory.ts",
    find: "if (names.length > 1) problems.push(",
    replace: "if (names.length > 2) problems.push(",
    planted: "a numeric prefix reused by exactly two migrations is accepted. Two files then " +
      "claim the same position in the apply order, and which one the runner treats as that " +
      "step depends on directory order rather than on anything anybody decided",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "a migration needing an extension declares it, and the runner still defers rather than taking the database down",
    assertion: "a migration that creates an extension declares that requirement",
    // 070 is squashed into 001_init.sql, which carries the same directive verbatim -- pg_dump
    // does not emit extensions, so they are written back into the squashed file's header along
    // with the two lines the runner reads to decide whether to defer.
    subject: "services/gateway/migrations/001_init.sql",
    find: "-- requires-extension: pg_trgm",
    replace: "-- note: this migration also needs pg_trgm",
    planted: "the migration's second extension requirement stops being machine-readable, so " +
      "the runner no longer defers on a cluster without pg_trgm. It attempts the file, throws, " +
      "rolls back and un-sets the pool — and the gateway starts anyway, serving with no " +
      "database while reporting itself healthy",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "grammar recognition precedes identifier normalization so a quoted phrase, an OR alternative and a leading exclusion survive intact, an unterminated natural-mode quote refuses by position while websearch tolerates it, and the actual serialized response stays within 24000 UTF-8 bytes with disclosed truncation",
    assertion: "the serialized response stays inside the agreed byte budget",
    subject: "services/zz-core/src/tenant-info/retrieval.ts",
    find: "const RESPONSE_BYTE_BUDGET = 24000;",
    replace: "const RESPONSE_BYTE_BUDGET = 240000;",
    planted: "the search response budget is raised tenfold, so a wide result set serializes " +
      "far past what the agreed limit allows and comes back claiming to be complete. Nothing " +
      "is truncated, nothing is disclosed, and the caller that has to hold the payload is the " +
      "one that finds out",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "every one of the eighteen release targets is evaluated in its own direction, and a missing observation is blocked rather than zero",
    assertion: "a latency target is evaluated as an upper bound, not a lower one",
    subject: "scripts/tenant-info/benchmark.ts",
    find: '{ key: "latency_p95_ms", direction: "at_most", target: 750, unit: "ms", measured_by: REFERENCE_RUN },',
    replace: '{ key: "latency_p95_ms", direction: "at_least", target: 750, unit: "ms", measured_by: REFERENCE_RUN },',
    planted: "the p95 latency target is read backwards: a run is judged to PASS the faster it " +
      "fails, so an observation of a million milliseconds satisfies the agreement and a " +
      "genuinely fast one does not. A release report would report the worst result as green",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    target: "the committed judged dataset is exactly what its generator produces, byte for byte",
    assertion: "the committed qrels are byte-identical to what the generator emits",
    subject: "scripts/tenant-info/judged-dataset.ts",
    find: 'reviewer: "generator:tenant-info-i4"',
    replace: 'reviewer: "generator:tenant-info-i5"',
    planted: "the generator no longer reproduces the committed qrels.jsonl. Those bytes are " +
      "signed by hash, and a signature over bytes nobody can regenerate is a rubber stamp — " +
      "the dataset every recall figure is measured against stops being re-derivable",
  },
];
