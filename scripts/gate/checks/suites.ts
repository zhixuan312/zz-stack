/**
 * The offline check suites, actually run.
 *
 * Seven suites live beside the code they are about — the write guards, the pure document
 * rules, redaction, scope and authority, markdown sanitisation, the identity port, the
 * fetched-before-approval record. Each needs no database, no network and no environment
 * variable, which is why the gate can run them.
 *
 * TWO OF THEM RAN NOWHERE FOR MONTHS. `check:redaction` and `check:scope` drive the real
 * predicates over 38 cases between them, both passed, and neither the gate nor the release
 * ever invoked them — their npm scripts existed and nothing called those either. Every
 * mention of them in the source was a comment saying they drive the real predicate, which
 * was true and described something that had never happened. That is why they are a module
 * with a name rather than four calls at the bottom of a long file.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asRecord, codeOnly, envNamesIn, isGateLaunchSource, readJson, root, trackedFiles, unbuilt, withoutComments }
  from "../read.ts";
import { check } from "../run.ts";
import { execFields, suiteSources } from "../suite-runner.ts";
import { generateJudgedDataset, judgedDatasetToJsonl } from "../../tenant-info/judged-dataset.ts";


/** Run one of the offline check tools that live beside the code they are about.
 *
 * A HELPER, but each check is still registered by its own top-level `check("...")` below —
 * "STATE.md counts the checks this gate actually has" counts `^check(` at the start of a
 * line, so a loop registering two would be invisible to it and the declared total would drift
 * by exactly the number of checks anybody was clever about. Written down because the next
 * person to add a pair will reach for the loop. */
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



check("a hostile document cannot become script in a reader's browser", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Twenty hostile documents through the REAL renderer, plus six ordinary ones to prove the
  // fix did not simply break rendering. Two holes have been found there, both against the
  // live deployment, both fixed by reading the code and never once run.
  try {
    execFileSync("node", [join(root, "services/gateway/dist/markdown-check.js")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`;
    return out.split("\n").filter((l) => /FAIL/.test(l)).join("; ") || "markdown render check failed";
  }
});

check("a door that refuses ends the request", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Five cases against the REAL resolveThrough, with stub doors. Its own docstring says it is
  // "exported so the ORDERING can be tested" — and nothing tested it, so the export existed
  // for a check nobody wrote. The property is an authentication bypass: a refusing adapter
  // that fell through would let the forwarded-header door answer for a REVOKED PAT, turning a
  // revoked token into an unauthenticated header claim. None of that is visible in the loop —
  // the bug is a missing early return, and the code reads identically with and without it.
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

/* A CHECK THAT RUNS THE CODE, not one that reads it.
 *
 * Everything above asks what the source SAYS. This one asks what a function DOES, by calling
 * it — and it is delegated to a prepared script rather than written inline, which is the
 * point of it existing at all. The behaviour it guards was first confirmed by a throwaway:
 * the compiled function pulled out of dist with a regular expression and run through
 * `new Function`. That was right once and unrepeatable, so nothing would have caught the day
 * it changed. A script that is chosen and run beats one composed on the spot — same answer,
 * and it is still there next time.
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

/* A RELEASED VERSION WHOSE CHANGELOG ENTRY STILL SAYS "Unreleased".
 *
 * Stamping the section is a judgement step done by hand on a release branch — nothing in
 * release.ts touches CHANGELOG.md, deliberately, because deciding what a release SAYS is not
 * something a script should do. But nothing checked it either, and 0.25.0 shipped, deployed and
 * tagged with its entry still under `## [Unreleased]`. The next release then wrote its own
 * sections beside it and the "one list per kind of change" check went red — which is how this
 * was found, one release too late.
 *
 * ASKED OF THE TAGS, not of package.json: a version bumped in a reviewed commit is not yet a
 * release, and refusing that would make this fire on every version bump before its release. A
 * git tag is the proof this repository's own release step treats as final. */
check("the version that shipped has a changelog section of its own", () => {
  // THE CURRENT VERSION, not every tag, and the narrowing is deliberate rather than convenient.
  //
  // Twelve older tags — 0.15.0, 0.15.1, 0.16.0-0.16.3, 0.20.0, 0.21.0-0.21.3, 0.22.0 — have no
  // changelog section anywhere. That is a real gap and a DIFFERENT one: those releases shipped
  // without an entry at all, and writing twelve now would be reconstruction from git history
  // rather than a record of what a person felt at the time. It is written down in this comment
  // instead of being enforced, because a check that demands twelve invented entries would be
  // satisfied by twelve invented entries.
  //
  // What this catches is the failure that actually happened: 0.25.0 was written up, shipped,
  // deployed and tagged with its entry still under `## [Unreleased]`. The next release then
  // wrote its own sections beside it, and "a release groups each kind of change once" went red
  // — which is how it was found, one release late.
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

// ── the initiative's own checks, each registered the moment its task completed ────────────
//
// One `check()` per line, deliberately not a loop: STATE.md counts `^check(` and a loop would
// collapse these seven into one, drifting the declared total by six.























check("every check this gate registers is a file git will carry", () => {
  // suites.ts is TRACKED and the files it names were not. Eight registered checks existed only
  // in the working tree, so `scripts/gate.ts` was green here and would have failed on a fresh
  // clone with "cannot find module" — eight times. Wiring a tracked runner to an untracked file
  // is a worse failure than leaving the check unwired: unwired is merely inert, this is a gate
  // that passes for the author and breaks for everybody else.
  if (!trackedFiles()) return null;              // not a checkout; nothing to be tracked in
  const known = new Set(execFileSync("git", ["ls-files", "checks/"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => f.replace(/^checks\//, "")));
  // BOTH RUNNERS, and a capture that is actually a FILENAME. `runsShell` registers the two
  // bash checks and reading only `runsCheck` would carry neither. And `[^"]+` matched the
  // sentence the check below prints to tell somebody how to write a registration — the advice
  // contains the spelling it is advising, so this reported `checks/${f}` as untracked, which is
  // true of a file that has never existed. An extension is what separates a name from a
  // sentence about names.
  // EVERY GATE MODULE, not this one. The registrations moved into `suites-*.ts` the day
  // suites.ts was split; a rule still reading this file by name would have called all eighty-five
  // of them untracked. `suiteSources()` reads the whole directory, so it cannot miss the next
  // module either.
  const missing = [...suiteSources()
    .matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)]
    .map((m) => m[1]).filter((f) => !known.has(f));
  // AND THE MODULES THE GATE IMPORTS, which this did not cover and had to. The rule above reads
  // a runsCheck registration against `checks/`, so it sees a registered SUITE and is blind to a gate
  // MODULE — and a module is wired by an `import` in scripts/gate.ts, one directory over.
  // Measured on this tree: `plugin-declaration.ts` and `prose-names.ts` were imported by a
  // tracked gate.ts while untracked themselves, four checks rode on them, and this check was
  // green. The consequence is worse than the one the comment above describes, not equal to it:
  // an unresolvable `import` does not fail the gate, it throws before a single check runs, so a
  // fresh clone gets no verdict at all rather than a red one.
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
  // H1 signs testing/tenant-info/queries.jsonl and qrels.jsonl BY HASH. A signature over
  // bytes nobody can reproduce is a rubber stamp, not a review — this is what makes those
  // hashes re-derivable rather than merely committed: `generateJudgedDataset` is the only
  // producer, and this check is its only tracked caller, which is exactly the shape
  // "nothing is exported that nobody imports" (hygiene.ts) asks every export to have.
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

// ── the two checks written as bash, unwired since the day they were written ───────────────
//
// Both passed every time somebody typed their name and neither was ever registered, which is
// the exact shape of the defect the block above exists to remove — the shell spelling simply
// hid it from the check that hunts for it, because that one reads `.mjs` and these are `.sh`.
// The check at the bottom of this file counts both extensions for that reason.



// ── NOTHING IN `checks/` IS INVISIBLE TO THIS FILE ───────────────────────────────────────

/**
 * Files in `checks/` this gate deliberately does not register, and why.
 *
 * NAMED ONE BY ONE, because neither has a property a rule could read: they are checks written
 * ahead of the work they describe, and "fails today" is not the marker it looks like. A rule
 * that exempted a check for failing would exempt every check a person drops in this directory
 * broken, which is precisely the file the check below exists to catch — the probe that proved
 * this gate blind exits 1 and nothing else.
 *
 * NOT A PARKING SPACE. `working-checks-registered.ts` runs every unregistered check and goes
 * red the moment one of them PASSES, and it is deliberately not taught about this map: a name
 * here buys silence only for as long as the check cannot pass, and the day it can, the other
 * rule demands a registration. Neither rule is weakened by the other's existence.
 */
const notRegistered = new Map<string, string>([]);

check("every check in checks/ is registered here, or named here with a reason", () => {
  // WHY A CROSS-VALIDATOR AND NOT A LOOP. Registering the directory with a `for` would be one
  // textual `check(` line however many files it visited, and `report()` in run.ts compares the
  // names written under gate/checks/ against the number that ran — so a loop registering
  // twelve would end the gate with GATE INCOMPLETE and no verdict at all. The list stays
  // explicit and this makes forgetting a line impossible, which is the property that matters:
  // adding a check still costs one line, and NOT adding it costs a red gate naming the file.
  //
  // THE MEASURED HOLE. `checks/zz-temp-wiring-probe.mjs`, two lines, `process.exit(1)`, could
  // be dropped in this directory and the gate stayed green — suites.ts registered by hand and
  // never read the directory, and `working-checks-registered.ts` runs an unregistered check
  // and reports it only when it PASSES. A check that arrives broken was the one case neither
  // half covered, and a check that arrives broken is what every new check is on its first day.
  // EVERY GATE MODULE, for the reason the rule above gives. Comments are stripped HERE and not
  // there, which is why `suiteSources()` hands back the raw text: the two rules disagree about
  // stripping on purpose, each for a reason written beside it, and a helper that decided for
  // them would quietly settle an argument neither had lost.
  const declared = withoutComments(suiteSources());
  // COMMENTS STRIPPED FIRST. A sentence naming `checks/foo.mjs` in a paragraph explaining why
  // foo is unregistered would otherwise register it, and this file argues in exactly that way.
  const registered = new Set([
    ...[...declared.matchAll(/runs(?:Check|Shell)\("([A-Za-z0-9._-]+\.(?:ts|sh))"\)/g)]
      .map((m) => m[1]),
    // The older spelling: three checks are registered by an inline execFileSync naming the
    // path. Reading only the helper form reported all three as unwired once already.
    ...[...declared.matchAll(/["'`]checks\/([A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1]),
  ]);

  // ── THE TWO EXEMPT CATEGORIES, READ OFF THE FILE RATHER THAN OFF ITS NAME ───────────────
  //
  // A break-test spawns `scripts/gate.ts`; registering one makes the gate invoke itself. A
  // host-dependent check reaches a deployment; the offline gate has none, so it belongs to the
  // release's live step. Both are decided by what the file DOES, because the `gate-` prefix
  // that used to stand for the first is carried by six files and missing from a seventh.
  //
  // THE SYNTAX, NOT THE TEXT. This rule was a regular expression — "one of the three spawner
  // names, then `scripts/gate.ts` inside the same call" — and it was narrowed to that shape
  // because the looser spelling (a spawner anywhere AND the path anywhere) reported
  // `chain-check-wiring.ts`, which READS the gate and names the spawners in its own pattern,
  // as a break-test. Narrowing fixed that file and left the rule blind in the other direction:
  // measured against the frozen fixtures in `checks/tenant-checks-registered.ts`, it answers
  // "not a break-test" for `execFileSync("npm", ["run", "gate"])`, for `spawnSync as launch`
  // and for `cp.execSync("npm run gate")` — three of three. A break-test spelled any of those
  // ways would have been classified ordinary, registered here, and the gate would have invoked
  // itself. `isGateLaunchSource` resolves the callee through the file's real imports and reads
  // its statically-known arguments, so a comment, a string and a regex literal are data and an
  // alias is still a launcher.
  // A READ OF THE VARIABLE, NOT A MENTION OF ITS NAME, and the distinction is not academic:
  // `working-checks-registered.ts` and the break-test for this check both carry the literal
  // ZZ_GATEWAY inside their own exclusion regex, and a rule that grepped for the bare name
  // reported each scanner as needing the deployment it exists to keep out. `envNamesIn` reads
  // `process.env.X` and `envRequired("X")` over source whose string literals are blanked, so a
  // name that appears only inside a pattern is not a read — and no file needs an exemption,
  // which is the part that matters: an exemption would still be there the day one of those
  // scanners genuinely acquired a deployment.
  const needsHost = (code: string, plain: string): boolean =>
    /(?:execFileSync|spawnSync|execSync)\(\s*["'](?:ssh|docker)["']/.test(code) ||
    envNamesIn(plain).some((n) => n === "ZZ_GATEWAY" || n === "ZZ_PAT");

  const files = readdirSync(join(root, "checks")).filter((f) => /\.(ts|sh)$/.test(f)).sort();
  const seen = new Map(files.map((f) => {
    const src = readFileSync(join(root, `checks/${f}`), "utf8");
    // THE RAW SOURCE, not `withoutComments(src)`: the classifier parses it, so a commented-out
    // spawn is a comment to it for the same reason it is to the compiler — and handing it
    // pre-blanked text would hide which of the two rules is doing the work.
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
  // A NAME HERE FOR A FILE THAT IS GONE is the same staleness one directory over: the reason
  // stays readable, describes nothing, and the next person trusts it.
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
