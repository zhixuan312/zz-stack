/**
 * Defects planted in what the build, the manifests and this repository's own hygiene checks
 * read — `build.ts`, `hygiene.ts`, `image.ts`.
 *
 * THE SUBJECT IS DATA WHEREVER THE CHECK ALLOWS IT, and that is not a stylistic preference.
 * Every check in this group judges whether the workspace COMPILES, whether the manifests
 * agree, or whether the image is built from what was compiled — so a planted defect that
 * breaks `tsc -b` turns the gate red for the wrong reason and the row proves nothing. Most of
 * the rows below land in a `package.json`, a lockfile, a `tsconfig.json`, a `Dockerfile`, a
 * `.dockerignore`, a flow manifest, a shell script or an `.env` example for exactly that
 * reason — deliberately not counted here, because a number in prose beside the thing that
 * counts it is the staleness this gate refuses everywhere else. Where a TypeScript subject
 * was unavoidable the mutation is one that still compiles:
 * an unused import is held alive with `void`, a rewritten guard keeps its consumer's type,
 * and a duplicated comment line changes no code at all.
 *
 * THE ONE EXCEPTION IS DECLARED. `tsc -b` is the check whose whole job is to fail when the
 * workspace does not compile, so its row is the only one where `build_failed` is the answer
 * rather than a spoiled experiment. It carries a caveat saying so.
 */
import type { MutationSpec } from "./plant.ts";

export const COV_BUILD: readonly MutationSpec[] = [
  /* ── build.ts ───────────────────────────────────────────────────────────── */
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
    subject: "packages/contracts/package.json",
    find: '"version": "0.62.4",',
    replace: '"version": "0.62.3",',
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
    find: '"version": "0.62.4",\n  "lockfileVersion": 3,',
    replace: '"version": "0.62.3",\n  "lockfileVersion": 3,',
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
    target: "a shell that invokes an evaluation tool passes the flow it means",
    subject: "testing/eval-step.sh",
    find: 'echo "  interviews: $INTERVIEWS"',
    replace: 'echo "  interviews: $INTERVIEWS"\n' +
      'node packages/tools/dist/testing/eval-judge.js --out "$OUT"',
    planted: "a suite driver invokes an evaluation tool without --flow, which exits 2 — and the " +
      "driver carries on, so the step reports what it did and the judging silently never ran",
    caveat: "eval-judge, eval-grade and eval-store were deleted with skill-level evaluation, so " +
      "no shell in the tree calls one today and this clause currently guards nothing. The " +
      "planted line restores the call shape the check is written about; it also names a dist " +
      "path that no longer exists, which is a second defect this check does not claim to see.",
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
    find: '"step-score": "node packages/tools/dist/testing/step-score.js"',
    replace: '"step-score": "node packages/tools/dist/testing/step-scores.js"',
    planted: "an npm script names a tool this repository does not have, so it fails with a node " +
      '"Cannot find module" against a dist path, which reads as a broken build rather than a ' +
      "script that should not exist",
  },

  /* ── skill-tools.ts, not build.ts — see the report that accompanies this file ──
   *
   * The coverage roster hands this id to `build.ts`, which only MENTIONS it in a comment
   * ("already asks whether each TOOL has a way to be run"). `check("every tool in
   * packages/tools is reachable from zz-tool"` is registered in skill-tools.ts:430, and the
   * `check` field below says so — a row filed against the wrong file would claim coverage for
   * a check that file does not register. */
  {
    check: "scripts/gate/checks/skill-tools.ts",
    target: "every tool in packages/tools is reachable from zz-tool",
    subject: "deploy/zz-tool",
    find: "  [probe-block]=ops/probe-block\n",
    replace: "  [probe-block]=ops/probe-blocks\n",
    planted: "the wrapper's alias points at a tool that does not exist and the real one is left " +
      "with no alias at all, so an operator on a deploy host has no way to run it and finds " +
      "out at the moment they need it",
  },

  /* ── hygiene.ts ─────────────────────────────────────────────────────────── */
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "an async guard in a ?? chain is awaited",
    subject: "services/zz-core/src/tenant-info/record.ts",
    // The historical shape exactly: a cheap synchronous pre-check in front, the async guard in
    // the middle, and a second synchronous guard after it that a promise's non-nullishness makes
    // unreachable. The outer `await` is what keeps it compiling, and is what kept the original
    // from being noticed — everything resolves, everything returns, and one guard never runs.
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
    target: "the platform model is one name, however many places name it",
    subject: "deploy/.env.example",
    find: "\nPLATFORM_BASE_MODEL=deepseek-v4.1-flash",
    replace: "\nPLATFORM_MODEL=deepseek-v4.1-flash",
    planted: "the one place that declares which model this platform runs on is renamed, so the " +
      "name every other place has to agree with no longer exists and nothing can be held to it",
    caveat: "this fires the check's DECLARATION clause. Its comparison clause — the four places " +
      "that must carry the same name — reads `const found = {}`, an empty object, so " +
      "`Object.entries(found)` is empty on every run and no disagreement between the front " +
      "end's model list, its titleModel, its tokenConfig key and this variable can reach it. " +
      "That clause is unexercisable until `found` is populated again.",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "the MCP protocol is written once",
    subject: "scripts/deployment.ts",
    find: "                   params: { protocolVersion: mcpProtocol(), capabilities: {},",
    // SEAMED, REPLACE ONLY. Written whole this row's payload IS a protocol version named
    // outside @zz/mcp-client, which is the defect the target check hunts — so this file
    // carrying it verbatim turned that check red at baseline. `plant()` writes the string it
    // is handed, so the seam costs the experiment nothing. `find` quotes healthy text and is
    // left exactly as it must match.
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
    replace: "        description: cardDescription(f.flow, `${f.agentName || f.flow} — ${f.whenToUse} (update: ${f.flow}@zz-platform)`.slice(0, 180)),",
    planted: "a flow's marketplace card tells a person to update a plugin by its FLOW name, which " +
      "is not what the plugin is called — install and update, in one file, naming one thing two " +
      "ways",
    caveat: "the check's pattern is pinned to the literal `@zz-platform`, and this repository's " +
      "MARKETPLACE constant is now `\"zz-stack\"` and is interpolated everywhere it is written. " +
      "So no honest defect in today's code can reach this clause: the planted line has to name " +
      "the retired marketplace to be seen at all, which is a second defect the check does not " +
      "claim to catch.",
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
    // THE ANCHOR MOVED OFF THE PARSE LINE, AND NOT FOR TASTE. The obvious anchor is the
    // assignment itself, and both sides of that pair quote an unnarrowed `JSON.parse(…)`
    // assertion — which this repository sweeps for, and which turned the gate red at BASELINE
    // when this file first landed. A baseline that is already red makes every row in the run
    // read as a weak check. The guard moved one line up instead: same defect, same subject,
    // and neither `find` nor `replace` quotes the construction. Seaming `find` was the other
    // option and is the one thing that can silently stop a mutation landing.
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
    find: "  // documents declare `flow: ops-flow@1` — the envelope carries the flow's\n",
    replace: "  // documents declare `flow: ops-flow@1` — the envelope carries the flow's\n" +
      "  // documents declare `flow: ops-flow@1` — the envelope carries the flow's\n",
    planted: "a comment line is left duplicated under itself — the debris an edit that rewrites a " +
      "paragraph and keeps the original leaves, which reads as deliberate emphasis until " +
      "somebody compares the two",
  },
  {
    check: "scripts/gate/checks/hygiene.ts",
    target: "no source file is larger than one subject usually is",
    subject: "scripts/tenant-info/benchmark-report.ts",
    // MEASURED THE WAY THE CHECK MEASURES IT. The ceiling is `split("\n").length`, not `wc -l`,
    // and the two differ by one on a file ending in a newline. This file is 697 by the check's
    // count; seven added lines put it at 704, which is over 700 by four and cannot be read as a
    // rounding argument. Comment lines, because code would risk the build for no extra evidence.
    find: "/**\n * benchmark-report.ts — the benchmark report itself: how one is assembled from what is\n",
    replace: "/**\n * benchmark-report.ts — the benchmark report itself: how one is assembled from what is\n" +
      " *\n" +
      " * WHAT A READER HAS TO HOLD IN THEIR HEAD TO CHANGE THIS FILE, written down here rather\n" +
      " * than reconstructed from the call sites every time somebody comes back to it:\n" +
      " *   - the workspace a report is written into, and who is responsible for clearing it\n" +
      " *   - which evidence is raw and which is derived, and why only the raw half is kept\n" +
      " *   - the structural validation, which runs before anybody evaluates a number in it\n" +
      " *   - the one caller that reads a report back, and what it does with a missing field\n",
    planted: "a source file grows past the 700-line ceiling, which is where a file in this " +
      "repository has always turned out to be holding a second subject",
  },

  /* ── image.ts ───────────────────────────────────────────────────────────── */
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
