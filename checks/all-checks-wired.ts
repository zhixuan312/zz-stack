// A check that arrives in this directory cannot hide from the gate — proved by planting one.
//
// WHY THIS IS A BREAK-TEST AND NOT A READING. The first version of this file asked whether
// `suites.mjs` contained the text `readdirSync("checks")`, which is a spelling test: it passes
// on a file that reads the directory and throws the answer away, and it fails on a correct
// implementation that spells the read any other way. The property is about what the GATE DOES
// when a file appears, and the only honest way to ask that is to make one appear.
//
// WHAT WAS MEASURED. `checks/zz-temp-wiring-probe.mjs`, two lines, `process.exit(1)`, dropped
// into this directory left the gate GREEN. suites.mjs registered by hand and never looked at
// the directory, and `working-checks-registered.mjs` — the one rule that runs an unregistered
// check — reports it only when it PASSES, so a check that arrives broken was the single case
// neither half covered. Every check arrives broken on its first day.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// JUDGED AGAINST A BASELINE, NEVER AGAINST THE EXIT CODE.
//
// `gate() !== 0` is red-for-unrelated-reasons by construction, and this repository can prove
// it: at the moment this was written the gate was red on one check, because adding checks made
// STATE.md's declared total stale and that total is written by a person. A break-test that read
// the exit code would have reported every plant a success without any plant being reached, and
// would have gone on doing so while the mechanism it guards rotted. So the gate is run once
// before anything is touched, the names of the checks that failed are kept, and each plant is
// judged on the failure it ADDS and on that failure naming the planted file.
// ─────────────────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = [];
const SUITES = "scripts/gate/checks/suites.ts";
const PROBE = "checks/zz-temp-wiring-probe.ts";
const ONLINE = "checks/zz-temp-online-probe.ts";

// EVERY PLANT IS REMOVED EVEN IF THIS DIES, and by exact path — an agent working in this
// repository once restored a directory with `cp -r` into a stale path and destroyed two source
// trees. Three named files, no directory, and the original of the one file that is edited is
// held in memory and written back.
const original = readFileSync(SUITES, "utf8");
if (!original.trim()) { console.error(`FAIL: ${SUITES} is empty`); process.exit(1); }
const cleanup = () => {
  if (readFileSync(SUITES, "utf8") !== original) writeFileSync(SUITES, original);
  rmSync(PROBE, { force: true });
  rmSync(ONLINE, { force: true });
};
process.on("exit", cleanup);

/** The gate's failing check NAMES, and its whole output. `--quiet` still prints every failure
 *  with its detail; it drops the passing lines, which are what makes the output long. */
const gate = () => {
  const r = spawnSync("node", ["scripts/gate.ts", "--quiet"], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { out, names: new Set([...out.matchAll(/^\s*✗ (.+)$/gm)].map((m) => m[1])) };
};

const base = gate();
const WIRED = "every check in checks/ is registered here, or named here with a reason";
if (!base.out.includes("GATE")) {
  console.error(`FAIL: the gate produced no verdict at all\n${base.out.slice(-2000)}`);
  process.exit(1);
}
if (base.names.has(WIRED)) {
  fail.push(`"${WIRED}" is already failing before anything was planted — this break-test ` +
            "cannot tell its own plants from that, so fix the gate first");
}

/** Plant `file` with `body`, run the gate, remove the file, and return what the plant added. */
const planted = (file: string, body: string) => {
  writeFileSync(file, body);
  try {
    const run = gate();
    return { ...run, added: [...run.names].filter((n) => !base.names.has(n)) };
  } finally {
    rmSync(file, { force: true });
  }
};

// ── 1. A NEW CHECK THAT FAILS TURNS THE GATE RED, WITH NO EDIT TO ANY LIST ────────────────
//
// The exact file that was green before. Nothing else in the repository is touched: no
// registration is added, no list is edited, the file simply exists.
{
  const r = planted(PROBE, "// planted by checks/all-checks-wired.mjs\nprocess.exit(1);\n");
  if (!r.names.has(WIRED)) {
    fail.push(`a newly added FAILING check did not turn the gate red — it added ` +
              `${JSON.stringify(r.added)} and none of it is the wiring check`);
  } else if (!r.out.includes(`${PROBE} exists and nothing runs it`)) {
    fail.push(`the gate reddened but did not name ${PROBE}; a verdict nobody can act on is ` +
              `half a verdict:\n${r.out.slice(-600)}`);
  }
}

// ── 2. AND SO DOES A NEW CHECK THAT PASSES ───────────────────────────────────────────────
//
// A mechanism that only notices failures is half a mechanism: a check that works and is not
// registered is the worse case of the two, because its author has evidence it passes and
// reasonably believes the gate is holding it. Same path, same absence of any list edit, exit 0.
{
  const r = planted(PROBE, "// planted by checks/all-checks-wired.mjs\nprocess.exit(0);\n");
  if (!r.names.has(WIRED)) {
    fail.push(`a newly added PASSING check did not turn the gate red — it added ` +
              `${JSON.stringify(r.added)} and none of it is the wiring check`);
  } else if (!r.out.includes(`${PROBE} exists and nothing runs it`)) {
    fail.push(`the gate reddened on a passing probe but did not name ${PROBE}`);
  }
}

// ── 3. THE OFFLINE GATE STILL REFUSES A CHECK THAT NEEDS A DEPLOYMENT ────────────────────
//
// This rule had to be made NARROWER to stop it reporting the scanners that enforce it —
// `working-checks-registered.mjs` carries the literal ZZ_GATEWAY inside its own exclusion
// regex, and a rule grepping for the bare name reported it as needing the deployment it exists
// to keep out. Narrowing a rule is how a rule quietly stops working, so the narrowing is proved
// here rather than asserted: a check that GENUINELY reads the variable, and is registered, is
// still caught.
//
// It has to be registered as well as present, because an unregistered host-dependent check is
// legitimate — `returns-sees-a-backtrack.mjs` is one, and it reaches the live database over
// ssh for the release to run. The defect is the offline gate acquiring an online dependency.
const registerIn = (file: string) => writeFileSync(SUITES,
  `${original}\ncheck("planted by all-checks-wired.mjs", runsCheck("${file.slice("checks/".length)}"));\n`);

const REACHES = `${ONLINE} is registered in this gate and reaches a deployment`;
{
  registerIn(ONLINE);
  const r = planted(ONLINE,
    "// planted by checks/all-checks-wired.mjs\n" +
    "const where = process.env.ZZ_GATEWAY;\nif (!where) process.exit(0);\nprocess.exit(0);\n");
  writeFileSync(SUITES, original);
  if (!r.out.includes(REACHES)) {
    fail.push("a check that reads the deployment's address was registered in the offline gate " +
              `and nothing objected — the rule has been narrowed into silence:\n${r.out.slice(-600)}`);
  }
}

// CONTROL, and it is the half that stops the one above being theatre. The same plant, the same
// registration, the same untracked file — everything except the variable read. If the sentence
// still appears, it was fired by registering an unknown file rather than by the dependency, and
// the check above would pass however narrow the rule became, including if it never read a file.
{
  registerIn(ONLINE);
  const r = planted(ONLINE, "// planted by checks/all-checks-wired.mjs\nprocess.exit(0);\n");
  writeFileSync(SUITES, original);
  if (r.out.includes(REACHES)) {
    fail.push("a registered check that reads no deployment variable was reported as reaching a " +
              "deployment — the rule fires on registration alone, so the case above proves nothing");
  }
}

// ── 4. AND THE GATE IS WHERE IT WAS ──────────────────────────────────────────────────────
//
// Not "green": green is not this break-test's to promise, and demanding it would make every
// plant unreadable the next time somebody else's work is briefly red. What is promised is that
// nothing here left anything behind — the same checks fail now as failed before the first plant.
//
// RESIDUE AND DRIFT ARE REPORTED APART, because they need different people. Residue is this
// file's own fault and is asked of the exact paths it wrote. Drift is somebody else editing the
// same checkout — measured on the first run of this version, when a sibling agent added a
// package between the baseline and here — and it does not mean the plants failed; it means the
// plants were judged against a tree that no longer exists, so nothing above can be relied on.
{
  const after = gate();
  const moved = [...new Set([...after.names, ...base.names])]
    .filter((n) => after.names.has(n) !== base.names.has(n));
  if (readFileSync(SUITES, "utf8") !== original) fail.push(`${SUITES} was not restored`);
  for (const p of [PROBE, ONLINE]) {
    if (existsSync(p)) fail.push(`${p} was left behind — remove it before trusting this gate`);
  }
  if (moved.length) {
    fail.push(`the gate's failures changed while this ran, on checks nothing here touches: ` +
              `${JSON.stringify(moved)}. Nothing was left behind, but the plants above were ` +
              "judged against a tree that moved under them — run this again when it is still.");
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("all checks wired: ok");
