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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readJson, root, trackedFiles, unbuilt } from "../read.mjs";
import { check } from "../run.mjs";

/** Run one of the offline check tools that live beside the code they are about.
 *
 * A HELPER, but each check is still registered by its own top-level `check("...")` below —
 * "STATE.md counts the checks this gate actually has" counts `^check(` at the start of a
 * line, so a loop registering two would be invisible to it and the declared total would drift
 * by exactly the number of checks anybody was clever about. Written down because the next
 * person to add a pair will reach for the loop. */
const runsClean = (tool) => () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `services/gateway/dist/${tool}.js`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return out.split("\n").filter((l) => /fail|expected|FAIL/.test(l)).join("; ") || `${tool} failed`;
  }
};

/** Run a check that lives in `checks/`, the same way `runsClean` runs one that lives in dist.
 *
 * WHY THIS EXISTS. Everything in `checks/` was invoked by hand and nothing else: the gate
 * registered three of them and the other forty-one ran only when somebody typed their name.
 * Five checks this initiative wrote were mutation-tested, reported green, and were never once
 * executed by `scripts/gate.mjs` — so "the gate passes" and "the checks pass" were two
 * separate claims that sounded like one. A check nobody runs automatically is documentation.
 *
 * NOT EVERY FILE IN `checks/` BELONGS HERE. Three kinds live in that directory:
 *   - plain checks, which assert a property by reading or importing — these, registered below;
 *   - `gate-*.mjs` break-tests, which plant a defect and SPAWN `scripts/gate.mjs` to prove it
 *     goes red — registering one of those here makes the gate invoke itself, forever;
 *   - host-dependent checks (`returns-sees-a-backtrack.mjs` reaches the live database over
 *     ssh) — those belong to the release, which has a deployment to reach.
 * The `gate-` prefix is the marker for the second kind. */
const runsCheck = (file) => () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, `checks/${file}`)],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return out.split("\n").filter((l) => l.trim()).join("; ").slice(0, 400)
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
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
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
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
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
    execFileSync("node", ["checks/attest-shown.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ")
      || `checks/attest-shown.mjs exited non-zero: ${out.slice(-300)}`;
  }
});

check("the write guards refuse what they say they refuse", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, "checks/write-guards.mjs")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ") || "write-guards failed";
  }
});

check("the pure document rules do what they say", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  try {
    execFileSync("node", [join(root, "checks/document-rules.mjs")],
                 { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return out.split("\n").filter((l) => /FAIL|failed/.test(l)).join("; ") || "document-rules failed";
  }
});

check("redaction lets no secret through, on the real predicate", runsClean("redact-check"));

check("scope and authority refuse what they say they refuse", runsClean("scope-check"));

/* A RELEASED VERSION WHOSE CHANGELOG ENTRY STILL SAYS "Unreleased".
 *
 * Stamping the section is a judgement step done by hand on a release branch — nothing in
 * release.mjs touches CHANGELOG.md, deliberately, because deciding what a release SAYS is not
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
  const version = readJson("package.json").version;
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

check("a plugin's content identity moves with its content and not with its address",
      runsCheck("digest-per-plugin.mjs"));

check("the committed lock is reproducible from what git carries",
      runsCheck("lock-reproducible.mjs"));

check("a check that works is a check the gate runs",
      runsCheck("working-checks-registered.mjs"));

check("a file that resolves renamed tools never matches a pre-rename name",
      runsCheck("pre-rename-literals.mjs"));

check("an aggregate nothing measured renders as null, never a confident zero",
      runsCheck("console-nulls.mjs"));

check("every check this gate registers is a file git will carry", () => {
  // suites.mjs is TRACKED and the files it names were not. Eight registered checks existed only
  // in the working tree, so `scripts/gate.mjs` was green here and would have failed on a fresh
  // clone with "cannot find module" — eight times. Wiring a tracked runner to an untracked file
  // is a worse failure than leaving the check unwired: unwired is merely inert, this is a gate
  // that passes for the author and breaks for everybody else.
  if (!trackedFiles()) return null;              // not a checkout; nothing to be tracked in
  const known = new Set(execFileSync("git", ["ls-files", "checks/"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(Boolean).map((f) => f.replace(/^checks\//, "")));
  const missing = [...readFileSync(join(root, "scripts/gate/checks/suites.mjs"), "utf8")
    .matchAll(/runsCheck\("([^"]+)"\)/g)].map((m) => m[1]).filter((f) => !known.has(f));
  return missing.length
    ? `registered but not tracked by git: ${missing.join(", ")} — green here, "cannot find ` +
      'module" on a fresh clone. `git add` them by path (never `git add -A`).'
    : null;
});

check("every tool the spec renamed resolves through one frozen map", runsCheck("alias-maps.mjs"));

check("the resolvers are applied wherever a stored name is read", runsCheck("alias-applied.mjs"));

check("a column nothing reads is not proof a column nothing needs", runsCheck("tool-key-read.mjs"));

check("the record's own columns exist, and a gap is nullable", runsCheck("migration-050.mjs"));

check("every tool call says which plugin it was made for", runsCheck("attribution.mjs"));

check("what a call cost is a column, and detail keeps no second copy",
      runsCheck("telemetry-columns.mjs"));

check("the chain check runs where a deployment exists, and not in this gate",
      runsCheck("chain-check-wiring.mjs"));

check("every completion the judge asks for is recorded, and an unreported figure stays null",
      runsCheck("judge-usage.mjs"));

check("what a recorded eval run cost is readable without paying for it again, and nothing caps spend",
      runsCheck("eval-cost.mjs"));

check("the manifest can express what the standard requires, and not what it replaced",
      runsCheck("contract-fields.mjs"));

check("a command is what a manifest declares, not what a function derives from a skill name",
      runsCheck("commands-declared.mjs"));

check("a flow is a plugin that declares documents, and zz-access is not one",
      runsCheck("flow-classification.mjs"));

check("every plugin declares what it is, what it ships, and what each stage leaves behind",
      runsCheck("manifests-conform.mjs"));

check("the core door speaks noun-first, and no caller still says the old name",
      runsCheck("core-names.mjs"));
