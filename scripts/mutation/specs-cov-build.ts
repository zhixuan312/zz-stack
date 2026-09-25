/**
 * Defects planted in what the build, the manifests and this repository's own hygiene checks
 * read — `build.ts`, `hygiene.ts`, `image.ts`.
 *
 * DELIBERATE: the subject is data wherever the check allows it. Every check in this group
 * judges whether the workspace compiles, whether the manifests agree, or whether the image is
 * built from what was compiled, so a planted defect that breaks `tsc -b` turns the gate red
 * for the wrong reason and the row proves nothing. Where a TypeScript subject is unavoidable
 * the mutation still compiles: an unused import is held alive with `void`, a rewritten guard
 * keeps its consumer's type, a duplicated comment line changes no code.
 *
 * The one exception is `tsc -b` itself, whose job is to fail when the workspace does not
 * compile. Its row is the only one where `build_failed` is the answer rather than a spoiled
 * experiment, and it carries a caveat saying so.
 */
import type { MutationSpec } from "./plant.ts";

export const COV_BUILD: readonly MutationSpec[] = [
  /* build.ts */
  {
    check: "scripts/gate/checks/build.ts",
    target: "tsc -b",
    subject: "services/gateway/src/identity.ts",
    find: "    activeTeam: actingTeam(base.teams, base.activeTeam, row.team_slug),",
    replace: "    activeTeam: actingTeam(base.teams, base.activeTeam, row.teamSlug),",
    planted: "the PAT resolver reads a column the query never selected, so the workspace does " +
      "not compile and every claim any later check makes is about bytes that were never built",
    caveat: "the one row in this file where a red `tsc -b` is the RESULT rather than a spoiled " +
      "experiment — `build_failed` will be true and that is what proves the check works",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "every package manifest carries the same version",
    // Anchored on a line that does not carry the version, because a spec naming one stops
    // landing the next time somebody releases and reports "0 replacements" forever.
    //
    // `"type"` sits after `"version"` in this manifest and `readJson` is `JSON.parse`, where a
    // duplicate key takes the last value, so an injected key here is the one the check reads.
    subject: "packages/contracts/package.json",
    find: '  "type": "module",',
    replace: '  "version": "0.0.1",\n  "type": "module",',
    planted: "one workspace manifest keeps the previous release's number while the other seven " +
      "moved, which is the half-done version bump set-version.ts exists to make impossible",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "no version is written as a literal in the source",
    subject: "services/zz-core/src/server.ts",
    find: "  const version = serviceVersion(import.meta.url);",
    replace: '  const version = "2.0.0";',
    planted: "zz-core records its own surface under a version number no release ever produced, " +
      "so the history says a version served tools that version never shipped",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "the lockfile records the version this release ships",
    subject: "package-lock.json",
    // Same shape, same reason: `"lockfileVersion"` follows `"version"` at the top of the file,
    // so the injected key is the later one and wins under JSON.parse.
    find: '  "lockfileVersion": 3,',
    replace: '  "version": "0.0.1",\n  "lockfileVersion": 3,',
    planted: "the lockfile still records the previous release while every manifest has moved — " +
      "`npm ci` tolerates it, so the wrong number ships with nothing saying anything",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "the workspace build covers every package",
    subject: "tsconfig.json",
    find: '    {\n      "path": "packages/indexing"\n    },\n',
    replace: "",
    planted: "a workspace package drops out of the root build's references, so it is compiled " +
      "only when something else happens to reference it and is otherwise silently absent",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "no workspace package can be published by accident",
    subject: "packages/catalog/package.json",
    find: '"private": true,',
    replace: '"private": false,',
    planted: "a workspace package stops being private, so `npm publish` inside it pushes this " +
      "platform's source to the public registry with nothing but npm's own warning in the way",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "a testing engine's exit status comes from its results",
    subject: "packages/tools/src/testing/sql-check.ts",
    find: "process.exit(main());",
    replace: "main();",
    planted: "an engine's entry point drops the status its own main() computed, so a run that " +
      "printed FAIL exits 0 and anything calling it in a release reads that as a pass",
  },

  {
    check: "scripts/gate/checks/build.ts",
    target: "a built package holds together",
    subject: "catalog/zz/zz-core/flow.json",
    find: '    "deck": "zz-deck",\n',
    replace: "",
    planted: "the baseline plugin stops promoting zz-deck to a command, so the skill still ships " +
      "but nobody can type it — the front door a person is told to use is simply not there",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "a probe that expects a refusal says which refusal",
    subject: "packages/tools/src/testing/chain-check.ts",
    find: '      await call("initiative_open", { slug: SLUG }), true, /already taken/);',
    replace: '      await call("initiative_open", { slug: SLUG }), true);',
    planted: "a probe that expects a refusal stops saying which one, so any error at all — a " +
      "database outage, a typo in the path — is recorded as the rule under test holding",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "a package's own version is read in one place",
    subject: "services/gateway/src/client-package.ts",
    find: "export const PLATFORM_VERSION: string = serviceVersion(import.meta.url);",
    replace: 'const ownManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };\n' +
      "void serviceVersion;\n" +
      'export const PLATFORM_VERSION: string = ownManifest.version ?? "0.0.0";',
    planted: "the version stamped into every plugin.json and into the shelf digest is read from " +
      "the manifest a second time, so one number found two ways is one rename from being two",
  },
  {
    check: "scripts/gate/checks/build.ts",
    target: "every npm script that runs a built tool has a source file",
    subject: "package.json",
    find: '"tool-report": "node packages/tools/dist/testing/tool-report.js"',
    replace: '"tool-report": "node packages/tools/dist/testing/tool-reports.js"',
    planted: "an npm script names a tool this repository does not have, so it fails with a node " +
      '"Cannot find module" against a dist path, which reads as a broken build rather than a ' +
      "script that should not exist",
  },

  /* skill-tools.ts, not build.ts: the coverage roster hands this id to `build.ts`, which only
   * mentions it in a comment. The registration is in skill-tools.ts, and the `check` field
   * below says so — a row filed against the wrong file claims coverage for a check that file
   * does not register. */
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "every tool in packages/tools is reachable from zz-tool",
    subject: "deploy/zz-tool",
    find: "  [call]=ops/call\n",
    replace: "  [call]=ops/calls\n",
    planted: "the wrapper's alias points at a tool that does not exist and the real one is left " +
      "with no alias at all, so an operator on a deploy host has no way to run it and finds " +
      "out at the moment they need it",
  },

  /* hygiene.ts */
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "an async guard in a ?? chain is awaited",
    subject: "services/zz-core/src/tenant-info/record.ts",
    // A cheap synchronous pre-check in front, the async guard in the middle, and a second
    // synchronous guard after it that a promise's non-nullishness makes unreachable. The outer
    // `await` keeps it compiling: everything resolves, everything returns, one guard never runs.
    find: "  const refusal = await preflightRefusal(io, root, request.manifest, request.blobs, zzDir, blobsDir, commitsDir);",
    replace: '  const refusal = await ((request.blobs.length > 512 ? refuse("INVALID_INPUT", "more than 512 blobs in one transaction") : null)\n' +
      "    ?? preflightRefusal(io, root, request.manifest, request.blobs, zzDir, blobsDir, commitsDir)\n" +
      '    ?? (request.manifest.file_changes.length === 0 ? refuse("INVALID_INPUT", "a commit that changes no file") : null));',
    planted: "an async guard sits mid-chain in a `??` list, and a promise is never null — so the " +
      "guard below it is deployed, exercised and absent, and a commit that changes no file is " +
      "written instead of refused",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "the MCP protocol is written once",
    subject: "scripts/deployment.ts",
    find: "                   params: { protocolVersion: mcpProtocol(), capabilities: {},",
    // SEAMED, `replace` only. Written whole, this payload is a protocol version named outside
    // @zz/mcp-client, which is the defect the target check hunts, so this file carrying it
    // verbatim turns that check red at baseline. `plant()` writes the string it is handed, so
    // the seam costs the experiment nothing; `find` quotes healthy text and must match exactly.
    replace: '                   params: { protocol' + 'Version: "2025-' + '06-18", capabilities: {},',
    planted: "the release's own handshake names a protocol version of its own instead of reading " +
      "the client's, so the day the gateway stops accepting the older one the failure lands in " +
      "the copy nobody remembered",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "every doc comment is attached to something",
    subject: "packages/mcp-client/src/index.ts",
    find: " */\nexport function lastJson(",
    replace: " */\n\nexport function lastJson(",
    planted: "a doc block is left a blank line away from the function it describes — the debris " +
      "of a symbol that moved or was deleted, which the compiler is perfectly happy with",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "a markdown table row is built, never assembled",
    subject: "services/zz-core/src/persist.ts",
    find: "    appendFileSync(ledger, tableRow(isoToday(), parts[0], outcome, hours, writes, patches));",
    replace: "    void tableRow;\n" +
      "    appendFileSync(ledger, `| ${isoToday()} | ${parts[0]} | ${outcome} | ${hours} | ${writes} | ${patches} |\\n`);",
    planted: "the outcome ledger assembles its own row again instead of calling the one builder " +
      "that escapes every cell, so an initiative folder named `a|b` produces a row every reader " +
      "parses as two different fields",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "a plugin is named the same way wherever it is named",
    subject: "services/gateway/src/client-package.ts",
    find: "        description: cardDescription(f.flow, `${f.agentName || f.flow} — ${f.whenToUse}`.slice(0, 180)),",
    replace: "        description: cardDescription(f.flow, `${f.agentName || f.flow} — ${f.whenToUse} (update: ${f.flow}@${MARKETPLACE})`.slice(0, 180)),",
    planted: "a flow's marketplace card tells a person to update a plugin by its FLOW name, which " +
      "is not what the plugin is called — install and update, in one file, naming one thing two " +
      "ways",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "the audit criteria are written once",
    subject: "catalog/sdlc/sdlc-flow/skills/sdlc-spec-audit/SKILL.md",
    find: "sdlc-audit-criteria",
    replace: "sdlc-audit-rules",
    all: true,
    planted: "the spec auditor stops naming the shared criteria skill, so its worker is dispatched " +
      "with no failure modes, no evidence shapes and no round format at all — and the plan " +
      "auditor still has them, so the two apply different standards",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "every source file is text a search can read",
    subject: "services/zz-core/src/platform-db.ts",
    find: "  const key = bound ? `${email}\\u0000${bound}` : email;",
    // The escape is written back as the raw byte. Identical behaviour, and every grep over this
    // repository — including the sweeps that find defects around it — skips the file whole.
    replace: "  const key = bound ? `${email}" + "\u0000" + "${bound}` : email;",
    planted: "a control byte goes back into a source file as a raw byte instead of an escape, so " +
      "grep calls the file binary and prints nothing, and the team cache's key is in a file no " +
      "search can read",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "the shared MCP client still behaves",
    subject: "packages/mcp-client/src/index.ts",
    // The anchor sits one line above the assignment, because both sides of that pair would
    // quote an unnarrowed `JSON.parse(…)` assertion, which this repository sweeps for — a
    // baseline already red makes every row in the run read as a weak check. Same defect, same
    // subject, and neither `find` nor `replace` quotes the construction.
    find: '    if (!t.startsWith("{")) continue;',
    replace: '    if (!t.startsWith("{") || obj !== null) continue;',
    planted: "the one MCP client keeps the FIRST data frame of a streamable-HTTP answer instead " +
      "of the last, so a progress notification is returned as the result — the exact subtle bug " +
      "the six hand-rolled copies disagreed about",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "imports run node, then packages, then this directory",
    subject: "services/gateway/src/client-package.ts",
    find: 'import { catalogEntry, catalogManifest, pluginName } from "@zz/catalog";\n' +
      'import { serviceVersion } from "@zz/mcp-http";\n' +
      "\n" +
      'import { digestOf } from "./package/describe.js";',
    replace: 'import { digestOf } from "./package/describe.js";\n' +
      'import { catalogEntry, catalogManifest, pluginName } from "@zz/catalog";\n' +
      'import { serviceVersion } from "@zz/mcp-http";',
    planted: "a relative import is put above the workspace packages, so a reader scanning this " +
      "file's head for what it depends on finds a local module where the package list should be",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "a flag given with nothing after it is refused, not read as absent",
    subject: "packages/tools/src/lib/cli.ts",
    find: '  const v = (args.flags.get(name) ?? "").trim();',
    replace: '  const v = args.flags.get(name) ?? "";',
    planted: "optional() stops treating a whitespace-only flag value as a mistyped flag and hands " +
      "it through, so `--actor '   '` narrows nothing and the tool answers about everybody while " +
      "the operator reads it as one run's calls",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "a function is never mistaken for what it returns",
    subject: "services/zz-core/src/chain.ts",
    find: "    const own = chainForFlow(declaredHere);",
    replace: "    const own = chainForFlow && chainForFlow(declaredHere);",
    planted: "a guard tests the FUNCTION rather than what it returns — a declaration is always " +
      "truthy, so the guard is decoration and whatever a reader thinks it protects against is " +
      "unreachable",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "no comment repeats a line of itself",
    subject: "services/zz-core/src/chain.ts",
    find: "  // documents declare `flow: sdlc-flow@1` — the envelope carries the flow's\n",
    replace: "  // documents declare `flow: sdlc-flow@1` — the envelope carries the flow's\n" +
      "  // documents declare `flow: sdlc-flow@1` — the envelope carries the flow's\n",
    planted: "a comment line is left duplicated under itself — the debris an edit that rewrites a " +
      "paragraph and keeps the original leaves, which reads as deliberate emphasis until " +
      "somebody compares the two",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "no source file is larger than one subject usually is",
    subject: "scripts/tenant-info/benchmark-report.ts",
    // Measured the way the check measures it: the ceiling is `split("\n").length`, not `wc -l`,
    // and the two differ by one on a file ending in a newline. Comment lines, because code
    // would risk the build for no extra evidence.
    find: "/**\n * The benchmark report: how one is assembled from what is actually observable, written into a\n",
    replace: "/**\n * The benchmark report: how one is assembled from what is actually observable, written into a\n" +
      " *\n" +
      " * WHAT A READER HAS TO HOLD IN THEIR HEAD TO CHANGE THIS FILE, written down here rather\n" +
      " * than reconstructed from the call sites every time somebody comes back to it:\n" +
      " *   - the workspace a report is written into, and who is responsible for clearing it\n" +
      " *   - which evidence is raw and which is derived, and why only the raw half is kept\n" +
      " *   - the structural validation, which runs before anybody evaluates a number in it\n" +
      " *   - the one caller that reads a report back, and what it does with a missing field\n" +
      " *   - the thresholds the agreement fixes, and where each one is restated\n" +
      " *   - the bindings hashed off disk, and which of them a reader re-checks\n" +
      " *   - the input files an operator drops in, and what each absence becomes\n" +
      " *   - the two profiles, and what the baseline profile is allowed to leave unsupported\n" +
      " *   - the per-corpus distribution contract, and why it is never an overall average\n" +
      " *   - the language slices, and why a zero denominator is refused\n" +
      " *   - the qrels hashes, and who has to have approved them\n" +
      " *   - the evaluation block, and why it is re-derived rather than trusted\n" +
      " *\n",
    planted: "a source file grows past the 700-line ceiling, which is where a file usually " +
      "turns out to be holding a second subject",
  },

  /* image.ts */
  {
    check: "scripts/gate/checks/image.ts",
    target: "the build context cannot carry a stale dist into the image",
    subject: ".dockerignore",
    find: "**/node_modules\ndist\n**/dist\n",
    replace: "**/node_modules\ndist\n",
    planted: "the exclusion that covers packages/*/dist is tidied away as redundant, leaving one " +
      "that matches the context root only — so a build on a machine that has ever built locally " +
      "hands tsc that machine's output and the image ships whatever the working tree held",
  },
  {
    check: "scripts/gate/checks/image.ts",
    target: "the image installs from the manifests, then copies the source",
    subject: "Dockerfile",
    find: "COPY packages/indexing/package.json   packages/indexing/\n",
    replace: "",
    planted: "a workspace member is left off the hand-kept list of manifests copied before " +
      "`npm ci`, so npm's glob matches one directory fewer, installs less, and the image ships " +
      "missing that package's dependencies — with nothing failing loudly",
  },
  {
    check: "scripts/gate/checks/image.ts",
    target: "a store the team can walk away with has git in the image",
    subject: "Dockerfile",
    find: "RUN apk add --no-cache git",
    replace: "RUN apk add --no-cache ca-certificates",
    planted: "the runtime stage stops installing git, and commitStore never throws — so every " +
      "document write succeeds, logs `git_failed`, and leaves a team's store with no history " +
      "that nobody notices until they go looking for one",
  },
  {
    check: "scripts/gate/checks/image.ts",
    target: "one image, one recipe",
    subject: "scripts/release/build.ts",
    find: '["build", "--platform", PLATFORM, "-f", "Dockerfile", "-t"',
    replace: '["build", "--platform", PLATFORM, "-f", "deploy/ts.Dockerfile", "-t"',
    planted: "the release builds the application image from a second recipe while development " +
      "builds it from the root one — the exact drift that once had development able to commit a " +
      "store and production unable to, with the check for it reading the file production was " +
      "not built from",
  },
];
