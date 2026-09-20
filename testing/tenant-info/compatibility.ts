/**
 * compatibility.ts — the tenth suite: `verify --suite compatibility`.
 *
 * AC-8.1's question, which is not "does the new code work" but "is anything that already
 * worked now broken, and is every declared integration path accounted for by somebody". Four
 * case groups answer it:
 *
 *   readers       every declared direct reader still reads tables this delivery never touched
 *   clients       the generated client package advertises no tool schema to drift from a handler
 *   registration  every check is classified, and no break-test is registered into the gate
 *   wiring/registry (compatibility-retrieval.ts) the composed request path and its corpus registry
 *
 * "EXERCISED IMPLEMENTATION COVERAGE OR A TESTED UNCHANGED JUSTIFICATION" is the criterion, and
 * the second half is the one that is usually faked. A sentence saying "we did not change this
 * file" is not a test. What IS testable, offline, about a reader nobody changed: that every
 * table its SQL names is created by a migration older than this delivery's, and that this
 * delivery's own migration neither creates, alters nor drops any of them. That is mechanical,
 * it re-derives from the real migration directory rather than from a list, and it goes red if
 * somebody later points migration 070 at `zz.doc`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isGateLaunchSource } from "../../scripts/gate/read.ts";
import { REGISTRY_CASES, WIRING_CASES } from "./compatibility-retrieval.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

// ── readers ────────────────────────────────────────────────────────────────────────────────

/**
 * The direct readers the approved plan's ownership ledger assigns to this task, one row each.
 * Written out rather than derived from `ledger.ts`: this list is the thing under test, and a
 * test that reads its subject's own declaration of itself proves the declaration is
 * self-consistent and nothing else.
 */
const DECLARED_READERS = [
  "services/gateway/src/server.ts",
  "services/gateway/src/console/knowledge.ts",
  "services/gateway/src/client-package.ts",
  "services/gateway/src/package/skills.ts",
  "services/gateway/src/package/plugin-lock.ts",
  "services/gateway/src/console/overview.ts",
  "services/gateway/src/console/overview-metrics.ts",
  "services/gateway/src/runs.ts",
  "services/gateway/src/discussion.ts",
  "services/zz-core/src/eval/plugin-judge.ts",
] as const;

/** This delivery's own migration, by slug rather than by number — the number is assigned at
 *  merge (the spec's `<NNN>`), and a check that hardcoded 070 would stop being about anything
 *  the day it was renumbered. */
const TENANT_MIGRATION_SLUG = "artifacts_revisions_events_and_scoped_search";

function migrationFiles(): string[] {
  return readdirSync(join(repoRoot, "services/gateway/migrations")).filter((f) => f.endsWith(".sql")).sort();
}

/** Every `zz.`-qualified table name a source file mentions. */
function tablesIn(source: string): string[] {
  return [...new Set([...source.matchAll(/\bzz\.[a-z_]+/g)].map((m) => m[0]))];
}

/** Which migration first creates each table. 001_init.sql writes unqualified names under a
 *  `search_path`, later ones write `zz.`-qualified ones; both spellings name the same table, so
 *  both are recorded under the qualified name a reader actually types. */
function creatingMigration(): Map<string, string> {
  const creator = new Map<string, string>();
  for (const file of migrationFiles()) {
    const sql = read(`services/gateway/migrations/${file}`);
    for (const m of sql.matchAll(/create\s+(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?(?:zz\.)?([a-z_]+)/gi)) {
      const table = `zz.${m[1]}`;
      if (!creator.has(table)) creator.set(table, file);
    }
  }
  return creator;
}

/**
 * THE UNCHANGED JUSTIFICATION, TESTED. Every table every declared reader reads is created by a
 * migration older than this delivery's, so this delivery cannot have changed what those
 * statements return. A reader that starts reading a tenant-information table would fail here
 * and would need implementation coverage instead — which is exactly the choice AC-8.1 offers.
 */
async function caseEveryDeclaredReaderReadsOnlyPreExistingTables(): Promise<void> {
  const creator = creatingMigration();
  const tenantMigration = migrationFiles().find((f) => f.includes(TENANT_MIGRATION_SLUG));
  assert.ok(tenantMigration, "this delivery's migration must be on disk for this case to mean anything");
  const problems: string[] = [];
  let examined = 0;
  for (const reader of DECLARED_READERS) {
    assert.ok(existsSync(join(repoRoot, reader)), `${reader} is declared as a direct reader and is not on disk`);
    for (const table of tablesIn(read(reader))) {
      examined++;
      const from = creator.get(table);
      if (from === undefined) problems.push(`${reader} reads ${table}, which no migration creates`);
      else if (from === tenantMigration) problems.push(`${reader} reads ${table}, which THIS delivery creates — it needs exercised coverage, not an unchanged justification`);
    }
  }
  assert.deepEqual(problems, [], problems.join("; "));
  assert.ok(examined > 20, `only ${examined} table references were examined — the extractor is not reading these files`);
}

/**
 * AND THE DELIVERY'S OWN MIGRATION LEAVES THEM ALONE. "Every object below is NEW; nothing
 * existing is dropped, renamed, altered or moved" is that migration's own first sentence, and
 * this is that sentence as an assertion — the readers above are compatible BECAUSE of it.
 */
async function caseTheTenantMigrationAltersNothingAReaderReads(): Promise<void> {
  const file = migrationFiles().find((f) => f.includes(TENANT_MIGRATION_SLUG));
  assert.ok(file, "this delivery's migration must be on disk");
  const sql = read(`services/gateway/migrations/${file}`)
    .split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  const readTables = new Set(DECLARED_READERS.flatMap((r) => tablesIn(read(r))));
  const problems: string[] = [];
  for (const m of sql.matchAll(/\b(alter\s+table|drop\s+table|drop\s+view|rename\s+to)\s+(?:if\s+exists\s+)?(?:zz\.)?([a-z_]+)/gi)) {
    const table = `zz.${m[2]}`;
    if (readTables.has(table)) problems.push(`${m[1].toLowerCase()} on ${table}, which a declared reader reads`);
  }
  assert.deepEqual(problems, [], problems.join("; "));
}

const READER_CASES: Readonly<Record<string, () => Promise<void>>> = {
  every_declared_reader_reads_only_pre_existing_tables: caseEveryDeclaredReaderReadsOnlyPreExistingTables,
  the_tenant_migration_alters_nothing_a_reader_reads: caseTheTenantMigrationAltersNothingAReaderReads,
};

// ── clients ────────────────────────────────────────────────────────────────────────────────

/**
 * "ADVERTISED SCHEMAS MATCH ACTUAL HANDLERS" HOLDS BECAUSE NOTHING IS ADVERTISED, and that is
 * a property worth pinning rather than a technicality to lean on. `client-package.ts`'s own
 * rule is that "a client is told where the tools are and what the entry skill is called, and
 * nothing else": the generated package carries an MCP server URL, and every tool's schema is
 * fetched from the live door. There is therefore no second copy of a tool's parameters that
 * could drift from the handler — and this case fails the day somebody renders one into the
 * package, which is exactly when the drift becomes possible.
 */
async function caseTheGeneratedClientAdvertisesNoToolSchema(): Promise<void> {
  const marketplace = join(repoRoot, "marketplace");
  assert.ok(existsSync(marketplace), "the generated client package must be committed for this case to read it");
  const problems: string[] = [];
  let mcpFiles = 0;
  for (const plugin of readdirSync(marketplace)) {
    const mcp = join(marketplace, plugin, ".mcp.json");
    if (!existsSync(mcp)) continue;
    mcpFiles++;
    const declared = JSON.parse(readFileSync(mcp, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
    for (const [name, server] of Object.entries(declared.mcpServers ?? {})) {
      if (typeof server.url !== "string") problems.push(`${plugin}/${name} declares no url`);
      for (const advertised of ["tools", "inputSchema", "parameters", "toolSchemas"]) {
        if (advertised in server) {
          problems.push(`${plugin}/${name} advertises ${advertised} — a second copy of a handler's ` +
            "schema, which can drift from the handler and could not be checked against it here");
        }
      }
    }
  }
  assert.ok(mcpFiles > 0, "no generated client package was found to examine");
  assert.deepEqual(problems, [], problems.join("; "));
}

/**
 * The generated mirrors are re-rendered and compared by a REGISTERED gate check ("the committed
 * marketplace is what the catalog renders"), against the real renderer. This case asserts that
 * owner exists and runs, rather than re-rendering the marketplace from a verification suite —
 * a suite that regenerated the tree it is verifying would be mutating the checkout under the
 * run, and a second, weaker copy of a rule is how two rules come to disagree.
 */
async function caseTheMirrorRuleHasARunningOwner(): Promise<void> {
  const suites = read("scripts/gate/checks/suites.ts");
  const marketplace = read("scripts/gate/checks/marketplace.ts");
  assert.match(marketplace, /^check\("the committed marketplace is what the catalog renders"/m,
    "the mirror rule must still be a registered check");
  assert.match(read("scripts/gate.ts"), /gate\/checks\/marketplace\.ts/,
    "and its module must still be imported by the gate, or it registers nothing");
  assert.ok(suites.length > 0);
}

const CLIENT_CASES: Readonly<Record<string, () => Promise<void>>> = {
  the_generated_client_advertises_no_tool_schema: caseTheGeneratedClientAdvertisesNoToolSchema,
  the_mirror_rule_has_a_running_owner: caseTheMirrorRuleHasARunningOwner,
};

// ── registration ───────────────────────────────────────────────────────────────────────────

/** The two spellings a check is registered by, read off the gate's own suites module. */
function registeredChecks(): Set<string> {
  const suites = read("scripts/gate/checks/suites.ts");
  return new Set([
    ...[...suites.matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)].map((m) => m[1]),
    ...[...suites.matchAll(/["'`]checks\/([A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1]),
  ]);
}

/**
 * EVERY CHECK IS CLASSIFIED, AND NO BREAK-TEST IS REGISTERED. Classification is `isGateLaunchSource`
 * — the same function registration itself uses, over the same directory — so this case and the
 * gate cannot come to disagree about what a break-test is.
 *
 * The failure it exists to prevent: a break-test registered as an ordinary check makes the gate
 * spawn the gate, which does not terminate. Before this function existed the rule was a regular
 * expression that recognised only `execFileSync(… "scripts/gate.ts")`, and answered "not a
 * break-test" for `execFileSync("npm", ["run", "gate"])`, for `spawnSync as launch` and for
 * `cp.execSync("npm run gate")` — three of the four spellings this repository's own frozen
 * fixture lists.
 */
async function caseEveryCheckIsClassifiedAndNoBreakTestIsRegistered(): Promise<void> {
  const registered = registeredChecks();
  const files = readdirSync(join(repoRoot, "checks")).filter((f) => f.endsWith(".ts")).sort();
  assert.ok(files.length > 40, `only ${files.length} checks found — the directory is not being read`);
  const launchers = files.filter((f) => isGateLaunchSource(read(`checks/${f}`)));
  assert.ok(launchers.length > 0, "this repository has break-tests; finding none means the classifier is inert");
  const problems: string[] = [];
  for (const file of launchers) {
    if (registered.has(file)) problems.push(`checks/${file} launches the gate and is registered in it — the gate would invoke itself`);
  }
  // And the naming convention is held to its meaning in the one direction it can be.
  for (const file of files) {
    if (file.startsWith("gate-") && !launchers.includes(file)) problems.push(`checks/${file} is named for a break-test and launches no gate`);
  }
  assert.deepEqual(problems, [], problems.join("; "));
}

/** A word in a comment, a string or a regex literal is data, not a launch — the three places
 *  the text-matching rule this replaced could not tell apart, driven here over real source
 *  rather than over the frozen fixture, so the two are independent evidence. */
async function caseAWordIsNotALaunch(): Promise<void> {
  assert.equal(isGateLaunchSource('const help = "run npm run gate yourself";'), false);
  assert.equal(isGateLaunchSource("// execFileSync('npm', ['run', 'gate'])"), false);
  assert.equal(isGateLaunchSource('const p = /spawnSync.*scripts\\/gate\\.ts/;'), false);
  assert.equal(isGateLaunchSource('function execSync(a, b) { return a + b; } execSync("npm run gate");'), false,
    "a local function that happens to share a launcher's name is not node:child_process");
  assert.equal(isGateLaunchSource('import { execFileSync } from "node:child_process";\nconst ARGS = ["run", "gate"];\nexecFileSync("npm", ARGS);'), true,
    "arguments assembled one line above the call are still the arguments");
  // The real thing: this repository's own break-test, unmodified.
  assert.equal(isGateLaunchSource(read("checks/all-checks-wired.ts")), true);
  assert.equal(isGateLaunchSource(read("checks/chain-check-wiring.ts")), false,
    "a check that READS scripts/gate.ts and names the spawners in a pattern launches nothing");
}

/**
 * THE GATE REFUSES A GATE INSIDE A GATE, AND REFUSES A REPORT PATH INSIDE THE REPOSITORY —
 * both measured by running the real entry point, and both refusals land before a single check
 * runs, so neither costs this suite a full gate.
 *
 * This suite deliberately does NOT run the gate to completion: that would regenerate the
 * marketplace under a verification run, and producing and parsing a full report is an external
 * step the plan assigns to the finalizer rather than to a case.
 */
async function caseTheGateRefusesNestingAndAnInsideReportPath(): Promise<void> {
  const run = (args: string[], env: Record<string, string>) => {
    try {
      execFileSync("node", ["scripts/gate.ts", ...args],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
      return { status: 0, out: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const nested = run(["--quiet"], { ZZ_GATE_RUNNING: "1" });
  assert.notEqual(nested.status, 0, "a gate started inside a gate must refuse");
  assert.match(nested.out, /GATE REFUSED/);
  assert.match(nested.out, /marketplace/, "and must say what it was refusing to do");

  const inside = run(["--report", "gate-report.json"], {});
  assert.equal(inside.status, 2, "a report path inside the repository is an invalid invocation");
  assert.match(inside.out, /resolves inside the repository/);

  const bare = run(["--report"], {});
  assert.equal(bare.status, 2, "a flag given with nothing after it is refused, never read as absent");
}

const REGISTRATION_CASES: Readonly<Record<string, () => Promise<void>>> = {
  every_check_is_classified_and_no_break_test_is_registered: caseEveryCheckIsClassifiedAndNoBreakTestIsRegistered,
  a_word_is_not_a_launch: caseAWordIsNotALaunch,
  the_gate_refuses_nesting_and_an_inside_report_path: caseTheGateRefusesNestingAndAnInsideReportPath,
};

// ── the suite ──────────────────────────────────────────────────────────────────────────────

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  readers: READER_CASES,
  clients: CLIENT_CASES,
  registration: REGISTRATION_CASES,
  wiring: WIRING_CASES,
  registry: REGISTRY_CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite compatibility`'s entry point; anything not a known case group is `not_run`. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && !(cases in CASE_GROUPS)) {
    const names = Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g));
    return {
      passed: false,
      detail: {
        status: "blocked",
        cases: Object.fromEntries(names.map((n) => [n, {
          status: "not_run" as const,
          reason: `only the ${Object.keys(CASE_GROUPS).map((g) => `"${g}"`).join(", ")} case group(s) exist`,
        }])),
      },
    };
  }
  const groups = cases === undefined ? Object.keys(CASE_GROUPS) : [cases];
  const results: Record<string, CaseResult> = {};
  for (const group of groups) {
    for (const [name, run1] of Object.entries(CASE_GROUPS[group])) {
      try {
        await run1();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return {
    passed: Object.values(results).every((r) => r.status === "passed"),
    detail: { status: "ran", cases: results },
  };
}
