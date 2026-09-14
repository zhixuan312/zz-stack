// A check that WORKS and is not wired is a check nobody runs.
//
// This has happened three times in this initiative, and the gate was green each time. The
// existing guard in suites.mjs enforces the other direction — every REGISTERED check is a file
// git will carry — which cannot see a check that was written, passes, and was never registered.
// Both directions are needed: unwired is inert, unregistered-but-working is worse, because the
// author has evidence it passes and reasonably believes the gate is holding it.
//
// THE RULE IS MECHANICAL AND NEEDS NO LIST. A check materialised for a task that has not run yet
// FAILS — that is what makes it a stub — so it exempts itself. The moment its task lands and it
// starts passing, this goes red until somebody registers it. That is exactly when the reminder
// is useful.
//
// Only UNREGISTERED files are executed here: the registered ones are already being run by the
// gate around this check, so re-running them would double the gate's cost to learn nothing.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fail = [];
const suites = readFileSync("scripts/gate/checks/suites.ts", "utf8");
// TWO SPELLINGS OF "REGISTERED", both live. Newer checks go through the `runsCheck` helper;
// three older ones (attest-shown, write-guards, document-rules) are registered by an inline
// execFileSync naming `checks/<file>` directly. Reading only the helper form reported all three
// as unwired — a false positive that would have taught the next reader to distrust this check,
// which is worse than not having it.
const registered = new Set([
  ...[...suites.matchAll(/runsCheck\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...suites.matchAll(/["'`]checks\/([A-Za-z0-9._-]+\.ts)["'`]/g)].map((m) => m[1]),
]);

// `gate-*.mjs` SPAWN scripts/gate.mjs to prove a planted defect turns it red. Running one here
// would run the whole gate inside the gate, and registering one would make the gate invoke
// itself forever. The prefix is the marker for that class and is checked, not assumed.
const SELF = "working-checks-registered.ts";

// A DECLARED EXEMPTION COUNTS AS REGISTRATION, and reading it from suites.mjs rather than
// keeping a second list here is the whole point. Task I-34 added `notRegistered` — a map of
// check file to the reason it is deliberately not wired — and this file did not know it
// existed, so the two checks came to disagree about one rule: I-34's accepted a declared
// exemption, this one still demanded a registration line, and a check that is honestly
// declared was reported as green-by-absence.
//
// `eval-readable.mjs` is the case that surfaced it. It reads `evals/results/latest/`, which
// costs real money to produce and which `.gitignore` deliberately excludes — a suite's output
// is not part of what a checkout carries, which is the rule `lock-reproducible.mjs` enforces
// one layer down. Registering it would turn the gate red for everyone who has not just paid
// for a run. Leaving it undeclared would make it dormant. Declaring it is the third answer,
// and both checks have to honour the declaration or the declaration is decoration.
//
// PARSED, NOT DUPLICATED. A copy of the map here would drift from the real one the first time
// somebody added an entry, which is the defect this initiative removed from two hand-kept
// rosters already.
const declared = new Set(
  [...readFileSync("scripts/gate/checks/suites.ts", "utf8")
    .matchAll(/\[\s*"([A-Za-z0-9._-]+\.(?:ts|sh))"\s*,\s*\n?\s*"/g)].map((m) => m[1]));

for (const f of readdirSync("checks").filter((f) => f.endsWith(".ts"))) {
  if (f === SELF || registered.has(f) || declared.has(f) || f.startsWith("gate-")) continue;
  const src = readFileSync(`checks/${f}`, "utf8");
  if (/scripts\/gate\.ts/.test(src) && /spawnSync|execFileSync/.test(src)) continue;
  // A host-dependent check cannot pass offline, so it fails and exempts itself — but skip it
  // explicitly rather than waiting 30s for ssh to time out inside the gate.
  if (/\bssh\b|docker exec|ZZ_GATEWAY|ZZ_PAT/.test(src)) continue;

  const r = spawnSync("node", [`checks/${f}`], { encoding: "utf8", timeout: 60_000 });
  if (r.status === 0) {
    fail.push(`checks/${f} passes and is not registered in suites.mjs — the gate does not run ` +
              `it, so it is green by absence. Add one top-level check(...) line via runsCheck.`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("working checks registered: ok");
