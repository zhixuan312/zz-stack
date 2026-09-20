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

import { asRecord, codeOnly, envNamesIn, readJson, root, trackedFiles, unbuilt, withoutComments }
  from "../read.ts";
import { check } from "../run.ts";
import { generateJudgedDataset, judgedDatasetToJsonl } from "../../tenant-info/benchmark.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. Here it is an `execFileSync` failure, which carries `stdout`/`stderr`
 *  rather than a plain `message`. */
function execFields(err: unknown): { stdout: string; stderr: string } {
  const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return { stdout: e.stdout !== undefined ? String(e.stdout) : "", stderr: e.stderr !== undefined ? String(e.stderr) : "" };
}

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

/** Run a check that lives in `checks/`, the same way `runsClean` runs one that lives in dist.
 *
 * WHY THIS EXISTS. Everything in `checks/` was invoked by hand and nothing else: the gate
 * registered three of them and the other forty-one ran only when somebody typed their name.
 * Five checks this initiative wrote were mutation-tested, reported green, and were never once
 * executed by `scripts/gate.ts` — so "the gate passes" and "the checks pass" were two
 * separate claims that sounded like one. A check nobody runs automatically is documentation.
 *
 * NOT EVERY FILE IN `checks/` BELONGS HERE. Three kinds live in that directory:
 *   - plain checks, which assert a property by reading or importing — these, registered below;
 *   - break-tests, which plant a defect and SPAWN `scripts/gate.ts` to prove it goes red —
 *     registering one of those here makes the gate invoke itself, forever;
 *   - host-dependent checks (`returns-sees-a-backtrack.ts` reaches the live database over
 *     ssh) — those belong to the release, which has a deployment to reach.
 *
 * SPAWNING THE GATE IS THE MARKER for the second kind, and the `gate-` prefix is a naming
 * convention over it rather than the test itself. This paragraph said the prefix WAS the
 * marker, and the file that would have caught an unwired check — `all-checks-wired.ts` —
 * spawns the gate and carries no prefix, so a rule reading the name would have registered it
 * and the gate would have invoked itself until something ran out. The check at the bottom of
 * this file reads the file's own text instead, and reports a `gate-` prefix on a file that
 * spawns nothing as the naming lie it is. */
const runsCheck = (file: string) => (): string | null => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`.trim();
    return out.split("\n").filter((l) => l.trim()).join("; ").slice(0, 400)
      || `checks/${file} exited non-zero`;
  }
};

/** The same, for the two checks in `checks/` written as bash rather than as a module.
 *
 * A SECOND HELPER RATHER THAN A FLAG ON THE FIRST, because what differs is the interpreter and
 * nothing else, and `runsCheck(file, { shell: true })` is a parameter every future reader has
 * to go and look up. Both scripts print `FAIL:` lines and exit non-zero, exactly as the .mjs
 * checks do, so the failure text needs no separate handling. */
const runsShell = (file: string) => (): string | null => {
  try {
    execFileSync("bash", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${execFields(err).stdout}${execFields(err).stderr}`.trim();
    return out.split("\n").filter((l) => /FAIL/.test(l)).join("; ").slice(0, 400)
      || `checks/${file} exited non-zero`;
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

check("the node floor is one decision written in package.json and .nvmrc, and the image does not move with it",
      runsCheck("engines-floor.ts"));

check("an unsupported Node fails naming both versions and why, as a runtime problem rather than a syntax error in the code",
      runsCheck("node-floor.ts"));

check("the node floor check fails, and fails informatively, when the floor is not met",
      runsCheck("node-floor-breaks.ts"));

check("the tooling project runs standalone through typecheck:tooling, is deliberately absent from tsc -b's reference graph, and inherits its strictness rather than softening it locally",
      runsCheck("tooling-project.ts"));

check("no file this rename touched went missing, and every sibling that imports one now names it by its .ts extension",
      runsCheck("rename-complete.ts"));

check("no discovery site under scripts/ or checks/ filters on .mjs alone, matching nothing after the rename",
      runsCheck("no-mjs-filters.ts"));

check("every literal path a script or check names under scripts/ or checks/ is a file that exists, so an import, a spawn or a read cannot outlive its target",
      runsCheck("literal-paths-resolve.ts"));

check("every entry point a human types — an npm script, a deploy script — names the .ts file that exists, not the .mjs file that no longer does",
      runsCheck("entry-points-resolve.ts"));

check("checks/ carries zero strict errors, and none of them was reached by widening to any",
      runsCheck("strict-checks-dir.ts"));

check("scripts/gate/ carries zero strict errors, the registry it runs is unchanged, and none of them was reached by widening to any",
      runsCheck("strict-gate-dir.ts"));

check("the rest of scripts/ and testing/ carry zero strict errors, and none of them was reached by widening to any",
      runsCheck("strict-scripts-dir.ts"));

check("the five shipped skill scripts carry zero strict errors, every construct in them is erasable, and none was reached by widening to any",
      runsCheck("strict-catalog-skills.ts"));

check("what consumers receive is JavaScript, never the source, and rebuilding it changes nothing",
      runsCheck("marketplace-ships-js.ts"));

check("the command a model is told to run names a file the consumer will actually have",
      runsCheck("skill-commands-runnable.ts"));

check("a lock regenerated from the converted tree comes back unchanged, byte for byte",
      runsCheck("lock-current.ts"));

check("the whole tooling project carries zero strict errors, measured as one project rather than subtree by subtree",
      runsCheck("strict-tooling-zero.ts"));

check("the checks a stricter tooling project superseded are gone, not merely duplicated, and the incident they existed to prevent is still on record",
      runsCheck("bespoke-checks-gone.ts"));

check("every script or check a document or a thrown error names by path is a file that exists, and CHANGELOG.md alone is left free to remember one that isn't",
      runsCheck("docs-name-real-files.ts"));

check("a plugin's content identity moves with its content and not with its address",
      runsCheck("digest-per-plugin.ts"));

check("a check that works is a check the gate runs",
      runsCheck("working-checks-registered.ts"));

check("a file that resolves renamed tools never matches a pre-rename name",
      runsCheck("pre-rename-literals.ts"));

check("an aggregate nothing measured renders as null, never a confident zero",
      runsCheck("console-nulls.ts"));

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
  const missing = [...readFileSync(join(root, "scripts/gate/checks/suites.ts"), "utf8")
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

check("every tool the spec renamed resolves through one frozen map", runsCheck("alias-maps.ts"));

check("the resolvers are applied wherever a stored name is read", runsCheck("alias-applied.ts"));

check("a column nothing reads is not proof a column nothing needs", runsCheck("tool-key-read.ts"));

check("an insert names as many values as it names columns",
      runsCheck("insert-arity.ts"));

check("a query binds as many parameters as its statement names",
      runsCheck("query-arity.ts"));

check("the definition this platform is built on holds in its source",
      runsCheck("definition-rules.ts"));

check("the record's own columns exist, and a gap is nullable", runsCheck("migration-050.ts"));

check("every tool call says which plugin it was made for", runsCheck("attribution.ts"));

check("what a call cost is a column, and detail keeps no second copy",
      runsCheck("telemetry-columns.ts"));

check("the chain check runs where a deployment exists, and not in this gate",
      runsCheck("chain-check-wiring.ts"));

check("every completion the judge asks for is recorded, and an unreported figure stays null",
      runsCheck("judge-usage.ts"));

check("the manifest can express what the standard requires, and not what it replaced",
      runsCheck("contract-fields.ts"));

check("a command is what a manifest declares, not what a function derives from a skill name",
      runsCheck("commands-declared.ts"));

check("a flow is a plugin that declares documents, and zz-access is not one",
      runsCheck("flow-classification.ts"));

check("every plugin declares what it is, what it ships, and what each stage leaves behind",
      runsCheck("manifests-conform.ts"));

check("the core door speaks noun-first, and no caller still says the old name",
      runsCheck("core-names.ts"));

check("a revision names its cause — one route or the other, never neither and never both",
      runsCheck("revise-cause.ts"));

check("a document read takes a list and a version, and history never vouches for the present",
      runsCheck("document-reads.ts"));

check("the two tools that left the core door are gone from it and from every caller",
      runsCheck("core-surface-19.ts"));

check("the core door introduces itself to a client that reads nothing else, and the pointer survives",
      runsCheck("orientation.ts"));

check("opening is explicit and dated by the platform, and freeform gets no next move",
      runsCheck("initiative-open.ts"));

check("the /manage door is cut by role, the duplicates are gone, and the exception is kept",
      runsCheck("manage-surface.ts"));

check("the evaluation door serves its own tools, and the gateway reaches that door and not the other",
      runsCheck("eval-door.ts"));

check("sdlc closes on its review, gates it, and leaves its audits ungated",
      runsCheck("sdlc-documents.ts"));

check("the evaluation modules are on the evaluation side, and attest stays on the core one",
      runsCheck("eval-tools-moved.ts"));

check("the three verification stages leave a document, and keep their independence",
      runsCheck("verification-stages-write.ts"));

check("the evaluation door speaks four nouns, three names are deliberately untouched, and the graders and the chain check follow",
      runsCheck("eval-names.ts"));

check("every skill ships from the plugin that owns it, and its commands follow with it",
      runsCheck("skill-homes.ts"));

check("the two misnamed core skills are renamed, every caller moved, and an old step still resolves",
      runsCheck("skill-renames.ts"));

check("no shipped file states a count of this platform's own surface",
      runsCheck("derived-counts.ts"));

check("the written record matches the delivered surface, and no document outgrew the ceiling",
      runsCheck("docs-current.ts"));

check("a renamed plugin still resolves, and the updater's copy of the map is the contract's",
      runsCheck("plugin-alias.ts"));

check("tenant-info's workspace and suite guards refuse what they say they refuse, and its CLI carries no import-time side effects",
      runsCheck("tenant-info-cli.ts"));

check("a baseline receipt carries every required field with its measurement evidence, and never a credential",
      runsCheck("tenant-info-baseline-fields.ts"));

check("corpus planning arithmetic refuses a fractional fixture count, and the deterministic text generator hits its exact byte target",
      runsCheck("tenant-info-corpus-shape.ts"));

check("the judged dataset holds its exact category/language/split counts, no family leaks across dev and held-out, and every qrel resolves to an existing query and an authorized fixture ref",
      runsCheck("tenant-info-qrels-integrity.ts"));

check("the PostgreSQL 17 lock, Dockerfile and config agree on the pinned major/patch, base digest, pg_textsearch release and actual preload membership",
      runsCheck("postgres-image-pinned.ts"));

check("the artifact reference and semantic payload schemas reject malformed input and agree on the one semantic-field order",
      runsCheck("tenant-information-contract.ts"));

check("a commit manifest hashes over its own canonical fields, never over bytes containing that hash, and a commit's basename refuses a non-positive sequence",
      runsCheck("tenant-record-durability.ts"));

check("a mutation request hashes canonically regardless of key order, changes with its payload or expected_etag, and a commit outcome classifies to true/false/unknown exactly as the spec's publication/durability table says",
      runsCheck("tenant-kernel-codes.ts"));

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

check("the deck skill names one destination, and never the platform's document-write tool",
      runsShell("deck-destination.sh"));

check("the deck chassis carries no slides and the guidebook carries all of them",
      runsShell("deck-chassis-sections.sh"));

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
  const declared = withoutComments(
    readFileSync(join(root, "scripts/gate/checks/suites.ts"), "utf8"));
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
  // THE PATH IS INSIDE THE SPAWN CALL, not merely somewhere in the same file, and the first
  // spelling of this — the path anywhere AND a spawner anywhere — reported
  // `chain-check-wiring.ts` as a break-test on its first run. That check READS
  // `scripts/gate.ts` to ask what the gate is wired to and names the spawners in a regex, so
  // both halves were true of a file that spawns nothing. Exempting it would have taken a
  // registered, working check out of the gate on the strength of a coincidence.
  const spawnsGate = (code: string): boolean =>
    /(?:execFileSync|spawnSync|execSync)\s*\([^;]{0,200}["'`]scripts\/gate\.ts["'`]/.test(code);
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
    return [f, { gate: spawnsGate(withoutComments(src)), host: needsHost(withoutComments(src), codeOnly(src)) }];
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
