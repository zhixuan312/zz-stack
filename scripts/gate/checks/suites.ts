/**
 * The offline check suites, actually run.
 *
 * The suites live beside the code they are about: the write guards, the pure document rules,
 * redaction, scope and authority, door resolution, the identity port and the
 * fetched-before-approval record. Each needs no database, no network and no environment
 * variable, which is why the gate can run them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asRecord, codeOnly, envNamesIn, firstOf, isGateLaunchSource, readJson, root, trackedFiles, unbuilt, withoutComments }
  from "../read.ts";
import { check } from "../run.ts";
import { execFields, failureDetail, runsCheck, suiteSources } from "../suite-runner.ts";

/** Run one of the offline check tools that live beside the code they are about. */
const runsClean = (tool: string) => (): string | null => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `services/gateway/dist/${tool}.js`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    return failureDetail(execFields(err).stderr, execFields(err).stdout) || `${tool} failed`;
  }
};

// Cases against the real resolveThrough, with stub doors. The property is an authentication
// bypass: a refusing adapter that fell through would let the forwarded-header door answer for a
// revoked PAT. The bug is a missing early return, and the code reads identically with and
// without it.
check("a door that refuses ends the request", runsClean("identity-check"));

check("the record knows whether a document was fetched before its gate", runsCheck("attest-shown.ts"));

check("the write guards refuse what they say they refuse", runsCheck("write-guards.ts"));

check("the pure document rules do what they say", runsCheck("document-rules.ts"));

check("redaction lets no secret through, on the real predicate", runsClean("redact-check"));

check("scope and authority refuse what they say they refuse", runsClean("scope-check"));

check("a call is filed under the initiative its argument or path names", runsClean("call-attribution-check"));

check("a stage that produces a source is credited only by its own rounds: under sources/, typed by the stage, supporting its document",
      runsClean("stage-sources-check"));

/* A released version whose changelog entry still says "Unreleased".
 *
 * Stamping the section is a judgement step done by hand on a release branch — nothing in
 * release.ts touches CHANGELOG.md.
 *
 * DELIBERATE: asked of the git tags, not of package.json. A version bumped in a reviewed
 * commit is not yet a release, so asking package.json would fire on every version bump. */
check("the version that shipped has a changelog section of its own", () => {
  // The current version, not every tag. Older tags without a changelog section stay without
  // one: writing them now would be reconstruction from git history, and a check demanding
  // invented entries would be satisfied by invented entries. What this catches is a version shipped, deployed and tagged
  // with its entry still under `## [Unreleased]`.
  const version = String(asRecord(readJson("package.json"), "package.json").version);
  if (!trackedFiles()) return null;       // not a checkout; there are no tags to ask
  // A checkout with no tags at all cannot say whether anything shipped, and reading that as "not
  // yet released" made this check pass without looking in every CI run until the mutation
  // suite's first full run showed it green over a changelog with no version headings at all.
  const anyTag = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).trim();
  if (!anyTag) {
    return "this checkout carries no release tags, so whether the current version shipped cannot " +
      "be answered — a CI checkout needs `fetch-tags: true`";
  }
  const tagged = execFileSync("git", ["tag", "--list", `v${version}`], { cwd: root, encoding: "utf8" }).trim();
  if (!tagged) return null;               // bumped in a reviewed commit, not yet released
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  return new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(log)
    ? null
    : `${version} is tagged and has no \`## [${version}]\` section — its entry is still under ` +
      "[Unreleased], where the next release will write beside it";
});

check("every check this gate registers is a file git will carry", () => {
  // suites.ts is tracked and the files it names may not be. A registered check that exists
  // only in the working tree is green here and fails on a fresh clone with "cannot find
  // module": a gate that passes for the author and breaks for everybody else.
  if (!trackedFiles()) return null;              // not a checkout; nothing to be tracked in
  const known = new Set(execFileSync("git", ["ls-files", "checks/"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => f.replace(/^checks\//, "")));
  // Both runners: `runsShell` registers the two bash checks, and reading only `runsCheck`
  // would carry neither. The capture requires an extension, which is what separates a filename
  // from a sentence about filenames — the advice this check prints contains the spelling it is
  // advising.
  //
  // COUPLED: `suiteSources()` reads every gate module rather than this file by name, so a
  // registration that moves into another `suites-*.ts` is still seen.
  const missing = [...suiteSources()
    .matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)]
    .map((m) => m[1]).filter((f) => !known.has(f));
  // And the modules the gate imports. The rule above reads a runsCheck registration against
  // `checks/`, so it sees a registered suite and is blind to a gate module — which is wired by
  // an `import` in scripts/gate.ts, one directory over. An unresolvable `import` does not fail
  // the gate, it throws before a single check runs, so a fresh clone gets no verdict at all.
  //
  // Every relative import under scripts/gate is followed, not just gate.ts's own, because
  // facts.ts and read.ts are imported by the modules and would take the whole gate down the
  // same way.
  // `existsSync`: `git ls-files` still lists a file deleted but not yet staged, and reading one
  // would take the whole gate down with an ENOENT instead of reporting anything about the tree.
  const sources = ["scripts/gate.ts", ...execFileSync("git", ["ls-files", "scripts/gate/"],
    { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && existsSync(join(root, f)))];
  // Every tracked file, not only scripts/: a gate module may import from the repository root —
  // data-sql.ts reads SCHEMA_TARGET from schema-target.ts — and a set drawn from scripts/ alone
  // reported that tracked file as one git does not carry.
  const trackedGate = new Set(execFileSync("git", ["ls-files"],
    { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  const unresolvable = [];
  for (const src of sources) {
    const body = readFileSync(join(root, src), "utf8");
    // `await load("…")` is gate.ts's spelling for every module after the build.
    for (const m of body.matchAll(/(?:^|\n)\s*(?:import\s+(?:[^"']*from\s*)?|await\s+load\(\s*)["'](\.[^"']+)["']/g)) {
      const target = join(dirname(src), m[1]).replace(/\\/g, "/");
      if (!trackedGate.has(target)) unresolvable.push(`${src} imports ${target}`);
    }
  }

  const problems = [
    ...missing.map((f) => `registered but not tracked: checks/${f}`),
    ...unresolvable.map((u) => `${u}, which git does not carry`),
  ];
  return problems.length
    ? `${problems.join("; ")} — green here, and on a fresh clone the suite either cannot find ` +
      'the module or the gate throws before it runs. `git add` them by path (never `git add -A`).'
    : null;
});

check("the gate loads nothing built before its own build has run", () => {
  // Node links and evaluates a module's whole static import graph before its body runs, so a
  // check module that gate.ts imports statically has loaded `@zz/contracts` or `@zz/indexing`
  // from the dist that existed before build.ts's `tsc -b`. It judges stale code, and on a clone
  // with no dist the gate cannot start. So gate.ts imports build.ts statically and loads every
  // other module afterwards, and nothing in the static graph it starts with reaches a package.
  const problems: string[] = [];
  const seen = new Set<string>();
  const follow = (rel: string): void => {
    if (seen.has(rel) || !existsSync(join(root, rel))) return;
    seen.add(rel);
    const code = withoutComments(readFileSync(join(root, rel), "utf8"));
    for (const m of code.matchAll(/^import\s+(?:[^"';]*?from\s*)?"([^"]+)"/gm)) {
      const spec = m[1];
      if (spec.startsWith("@zz/")) problems.push(`${rel} imports ${spec} statically`);
      if (!spec.startsWith(".")) continue;
      const target = join(dirname(rel), spec).replace(/\\/g, "/");
      if (rel === "scripts/gate.ts" && target.startsWith("scripts/gate/checks/") &&
          target !== "scripts/gate/checks/build.ts") {
        problems.push(`scripts/gate.ts imports ${target} statically, so it loads before the build`);
      }
      follow(target);
    }
  };
  follow("scripts/gate.ts");
  return firstOf(problems, 6);
});

check("gate-launch classification reads the syntax — a spawner named in a comment, a string or a regex literal is not a launch, and an aliased or namespaced one still is",
      runsCheck("tenant-checks-registered.ts"));
check("a migration needing an extension declares it, and the runner still defers rather than taking the database down",
      runsCheck("migration-extension-declared.ts"));
check("the layer's tables, its files and its extension are gone from the tree",
      runsCheck("artifact-layer-deleted.ts"));

// Nothing in `checks/` is invisible to this file

/**
 * Files in `checks/` this gate deliberately does not register, and why.
 *
 * Named one by one, because a rule that exempted a check for failing would exempt every broken
 * check dropped in this directory.
 */
const notRegistered = new Map<string, string>([
  // Not a check: the Work rounds and request helpers checks/console-isolation.ts and
  // checks/console-isolation-destinations.ts import, split out so no file passes the 700-line
  // ceiling. Run alone it does nothing, so registering it would be a check green by absence.
  ["console-isolation-work.ts",
   "a module checks/console-isolation.ts and checks/console-isolation-destinations.ts import, not a check of its own"],
  // Not a check: the request helpers and the shared window, bucket, rows, where and first-day cases
  // checks/console-work-query.ts and checks/console-work-query-destinations.ts import, split out so
  // neither passes the 700-line ceiling.
  ["console-work-query-harness.ts",
   "a module checks/console-work-query.ts and checks/console-work-query-destinations.ts import, not a check of its own"],
  // Not checks: the seed checks/console-platform-query.ts reads and the platform query's isolation
  // round checks/console-isolation.ts runs, split out so neither passes the 700-line ceiling.
  ["console-platform-query-seed.ts", "a module checks/console-platform-query.ts imports, not a check of its own"],
  ["console-platform-query-isolation.ts", "a module checks/console-isolation.ts imports, not a check of its own"],
  // Not a check: the failure round's table map and its part at the member's own addresses, which
  // checks/console-isolation.ts runs, split out so it does not pass the 700-line ceiling.
  ["console-isolation-failures.ts", "a module checks/console-isolation.ts imports, not a check of its own"],
  // Not checks: the fakes checks drive the services in-process with — the core door, the stub pool, the route caller.
  ["in-process.ts", "a module checks import to drive the services in-process, not a check of its own"],
  // Not a check: what the SQL statement scanners share beside the statement reader.
  ["sql-scan.ts", "a module the SQL statement scanners import, not a check of its own"],
]);

check("every check in checks/ is registered here, or named here with a reason", () => {
  // DELIBERATE: a cross-validator, not a loop. Registering the directory with a `for` would be
  // one textual `check(` line however many files it visited, and `report()` in run.ts compares
  // the names written under gate/checks/ against the number that ran — so a loop would end the
  // gate with GATE INCOMPLETE and no verdict. Adding a check costs one line, and not adding it
  // costs a red gate naming the file.
  //
  // DELIBERATE: comments are stripped here and not in the rule above. `suiteSources()` hands
  // back raw text, and the two rules disagree about stripping for reasons written beside each.
  const declared = withoutComments(suiteSources());
  // Comments stripped first: a sentence naming `checks/foo.ts` in a paragraph explaining why
  // foo is unregistered would otherwise register it, and this file argues in exactly that way.
  const registered = new Set([...declared.matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)]
    .map((m) => m[1]));

  // The two exempt categories, read off the file rather than off its name. A break-test spawns
  // `scripts/gate.ts`, so registering one makes the gate invoke itself. A host-dependent check
  // reaches a deployment, and the offline gate has none, so registering it would fail wherever
  // there is no deployment to reach. The `gate-` prefix decides nothing: not every such file
  // carries it.
  //
  // DELIBERATE: no check in `checks/` reaches a deployment today. The rule stays because it is
  // judged on the syntax rather than on a list: the next such check is exempt the moment it is
  // written, without an edit here.
  //
  // Judged on the syntax, not the text. `isGateLaunchSource` resolves the callee through the
  // file's real imports and reads its statically-known arguments, so a comment, a string and a
  // regex literal are data and an alias is still a launcher. A regex over spellings answers
  // "not a break-test" for `execFileSync("npm", ["run", "gate"])`, for `spawnSync as launch`
  // and for `cp.execSync("npm run gate")`.
  //
  // A read of the variable, not a mention of its name: `envNamesIn` reads `process.env.X` and
  // `envRequired("X")` over source whose string literals are blanked, so a name appearing only
  // inside a scanner's own exclusion pattern is not a read, and no file needs an exemption.
  const needsHost = (code: string, plain: string): boolean =>
    /(?:execFileSync|spawnSync|execSync)\(\s*["'](?:ssh|docker)["']/.test(code) ||
    envNamesIn(plain).some((n) => n === "ZZ_GATEWAY" || n === "ZZ_PAT");

  const files = readdirSync(join(root, "checks")).filter((f) => /\.(ts|sh)$/.test(f)).sort();
  const seen = new Map(files.map((f) => {
    const src = readFileSync(join(root, `checks/${f}`), "utf8");
    // DELIBERATE: the raw source, not `withoutComments(src)`. The classifier parses it, so a
    // commented-out spawn is a comment to it for the same reason it is to the compiler.
    return [f, { gate: isGateLaunchSource(src), host: needsHost(withoutComments(src), codeOnly(src)) }];
  }));

  const problems = [];
  for (const [f, { gate, host }] of seen) {
    if (registered.has(f)) {
      if (notRegistered.has(f)) {
        problems.push(`checks/${f} is registered above AND named as deliberately unregistered`);
      }
      if (host) {
        problems.push(`checks/${f} is registered in this gate and reaches a deployment — it ` +
                      "belongs to release.ts's live step, which has one to reach");
      }
      if (gate) {
        problems.push(`checks/${f} is registered in this gate and spawns scripts/gate.ts — ` +
                      "the gate would invoke itself");
      }
      continue;
    }
    if (gate || host || notRegistered.has(f)) continue;
    problems.push(`checks/${f} exists and nothing runs it — add one \`check("…", ` +
                  `runsCheck("${f}"))\` line above, or name it in notRegistered with a reason`);
  }
  // A name here for a file that is gone is the same staleness one directory over: the reason
  // stays readable and describes nothing.
  for (const f of notRegistered.keys()) {
    if (!seen.has(f)) problems.push(`notRegistered names checks/${f}, which does not exist`);
  }
  // And the convention is held to its meaning in the one direction it can be: a file that
  // announces itself a break-test and spawns nothing is a name that will be believed.
  for (const [f, { gate }] of seen) {
    if (f.startsWith("gate-") && !gate) {
      problems.push(`checks/${f} is named for a break-test and spawns no gate`);
    }
  }
  return problems.length ? problems.join("; ") : null;
});
