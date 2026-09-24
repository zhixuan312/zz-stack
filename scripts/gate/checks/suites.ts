/**
 * The offline check suites, actually run.
 *
 * The suites live beside the code they are about: the write guards, the pure document rules,
 * redaction, scope and authority, door resolution, the identity port and the
 * fetched-before-approval record. Each needs no database, no network and no environment
 * variable, which is why the gate can run them.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asRecord, codeOnly, envNamesIn, isGateLaunchSource, readJson, root, trackedFiles, unbuilt, withoutComments }
  from "../read.ts";
import { check } from "../run.ts";
import { execFields, suiteSources } from "../suite-runner.ts";
import { generateJudgedDataset, judgedDatasetToJsonl } from "../../tenant-info/judged-dataset.ts";


/** Run one of the offline check tools that live beside the code they are about. */
const runsClean = (tool: string) => (): string | null => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `services/gateway/dist/${tool}.js`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`;
    return out.split("\n").filter((l) => /fail|expected|FAIL/.test(l)).join("; ") || `${tool} failed`;
  }
};

check("a door that refuses ends the request", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Cases against the real resolveThrough, with stub doors. The property is an
  // authentication bypass: a refusing adapter that fell through would let the forwarded-header
  // door answer for a revoked PAT. The bug is a missing early return, and the code reads
  // identically with and without it.
  try {
    execFileSync("node", [join(root, "services/gateway/dist/identity-check.js")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`;
    return out.split("\n").filter((l) => /failed|expected/.test(l)).join("; ")
        || "identity adapter-walk check failed";
  }
});

/* A check that runs the code, not one that reads it.
 *
 * Everything above asks what the source says; this one calls the function, through a prepared
 * script rather than one composed on the spot.
 *
 * The gate has already run `npm run -s build` by here, so dist is current. */
check("the record knows whether a document was fetched before its gate", () => {
  try {
    execFileSync("node", ["checks/attest-shown.ts"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`.trim();
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ")
      || `checks/attest-shown.ts exited non-zero: ${out.slice(-300)}`;
  }
});

check("the write guards refuse what they say they refuse", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, "checks/write-guards.ts")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`;
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ") || "write-guards failed";
  }
});

check("the pure document rules do what they say", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, "checks/document-rules.ts")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`;
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ") || "document-rules failed";
  }
});

check("redaction lets no secret through, on the real predicate", runsClean("redact-check"));

check("scope and authority refuse what they say they refuse", runsClean("scope-check"));

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
  const tagged = trackedFiles() && execFileSync("git", ["tag", "--list", `v${version}`],
    { cwd: root, encoding: "utf8" }).trim();
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
  const sources = ["scripts/gate.ts", ...execFileSync("git", ["ls-files", "scripts/gate/"],
    { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)];
  const trackedGate = new Set(execFileSync("git", ["ls-files", "scripts/"],
    { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  const unresolvable = [];
  for (const src of sources) {
    const body = readFileSync(join(root, src), "utf8");
    for (const m of body.matchAll(/(?:^|\n)\s*import\s+(?:[^"']*from\s*)?["'](\.[^"']+)["']/g)) {
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






























































check("the committed judged dataset is exactly what its generator produces, byte for byte", () => {
  // H1 signs testing/tenant-info/queries.jsonl and qrels.jsonl by hash, so those hashes have
  // to be re-derivable rather than merely committed. `generateJudgedDataset` is the only
  // producer and this check is its only tracked caller.
  const problems: string[] = [];
  const { queries, qrels } = generateJudgedDataset();
  const expected: [string, string][] = [
    [join(root, "testing/tenant-info/queries.jsonl"), judgedDatasetToJsonl(queries)],
    [join(root, "testing/tenant-info/qrels.jsonl"), judgedDatasetToJsonl(qrels)],
  ];
  for (const [path, generated] of expected) {
    const committed = readFileSync(path, "utf8");
    if (committed !== generated) problems.push(`${path.slice(root.length + 1)} no longer matches its generator`);
  }
  return problems.length ? problems.join("; ") : null;
});

// The two checks written as bash. The check at the bottom of this file counts `.sh` as well
// as `.ts`, because the rule that hunts for unregistered checks reads the extension.



// Nothing in `checks/` is invisible to this file

/**
 * Files in `checks/` this gate deliberately does not register, and why. Empty: every check in
 * the directory is registered.
 *
 * Named one by one, because a rule that exempted a check for failing would exempt every broken
 * check dropped in this directory.
 *
 * COUPLED: `working-checks-registered.ts` parses this map, so a name here exempts a file from
 * both rules.
 */
const notRegistered = new Map<string, string>([]);

check("every check in checks/ is registered here, or named here with a reason", () => {
  // DELIBERATE: a cross-validator, not a loop. Registering the directory with a `for` would be
  // one textual `check(` line however many files it visited, and `report()` in run.ts compares
  // the names written under gate/checks/ against the number that ran — so a loop would end the
  // gate with GATE INCOMPLETE and no verdict. Adding a check costs one line, and not adding it
  // costs a red gate naming the file.
  //
  // A check that arrives broken is the case neither this rule nor
  // `working-checks-registered.ts` covers on its own: that one reports an unregistered check
  // only when it passes.
  //
  // DELIBERATE: comments are stripped here and not in the rule above. `suiteSources()` hands
  // back raw text, and the two rules disagree about stripping for reasons written beside each.
  const declared = withoutComments(suiteSources());
  // Comments stripped first: a sentence naming `checks/foo.ts` in a paragraph explaining why
  // foo is unregistered would otherwise register it, and this file argues in exactly that way.
  const registered = new Set([
    ...[...declared.matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)]
      .map((m) => m[1]),
    // The older spelling: three checks are registered by an inline execFileSync naming the
    // path, which the helper form alone does not find.
    ...[...declared.matchAll(/["'`]checks\/([A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1]),
  ]);

  // The two exempt categories, read off the file rather than off its name. A break-test spawns
  // `scripts/gate.ts`, so registering one makes the gate invoke itself. A host-dependent check
  // reaches a deployment, and the offline gate has none, so it belongs to the release's live
  // step. The `gate-` prefix decides nothing: not every such file carries it.
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
