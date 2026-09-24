// A check that works and is not wired is a check nobody runs. COUPLED: suites.ts enforces the
// other direction — every registered check is a file git will carry — which cannot see a check
// that was written, passes, and was never registered.
//
// No exemption list is needed. A check materialised for a task that has not run yet fails, so
// it exempts itself; the moment its task lands and it starts passing, this goes red until
// somebody registers it.
//
// DELIBERATE: only unregistered files are executed here. The registered ones are already run
// by the gate around this check.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { isGateLaunchSource } from "../scripts/gate/read.ts";
import { suiteSources } from "../scripts/gate/suite-runner.ts";

const fail = [];
// Every gate module, not suites.ts alone: registrations are split across `suites-*.ts` because
// `check_sha256` is per file.
const suites = suiteSources();
// Two spellings of "registered", both live: the `runsCheck` helper, and an inline execFileSync
// naming `checks/<file>` directly, which attest-shown, write-guards and document-rules use.
const registered = new Set([
  ...[...suites.matchAll(/runsCheck\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...suites.matchAll(/["'`]checks\/([A-Za-z0-9._-]+\.ts)["'`]/g)].map((m) => m[1]),
]);

// A break-test spawns scripts/gate.ts to prove a planted defect turns it red. Running one here
// would run the whole gate inside the gate, and registering one would make the gate invoke
// itself forever. `isGateLaunchSource` below identifies them; the `gate-` prefix is not
// consulted, and suites.ts holds that convention to its meaning from the other side.
const SELF = "working-checks-registered.ts";

// A declared exemption counts as registration. COUPLED: `notRegistered` in the suites modules
// maps a check file to the reason it is deliberately not wired, and both this check and the
// registration side must honour it. Parsed from there rather than copied, so the two cannot
// drift.
const declared = new Set(
  [...suiteSources()
    .matchAll(/\[\s*"([A-Za-z0-9._-]+\.(?:ts|sh))"\s*,\s*\n?\s*"/g)].map((m) => m[1]));

for (const f of readdirSync("checks").filter((f) => f.endsWith(".ts"))) {
  if (f === SELF || registered.has(f) || declared.has(f)) continue;
  const src = readFileSync(`checks/${f}`, "utf8");
  // COUPLED: the same classifier registration uses, `isGateLaunchSource` in
  // scripts/gate/read.ts. A second text rule diverges on the spellings a break-test is most
  // likely to use — `execFileSync("npm", ["run", "gate"])`, an aliased import, a namespace
  // import — and running one of those here runs the whole gate inside the gate.
  if (isGateLaunchSource(src)) continue;
  // A host-dependent check cannot pass offline, so it fails and exempts itself — but skip it
  // explicitly rather than waiting 30s for ssh to time out inside the gate.
  if (/\bssh\b|docker exec|ZZ_GATEWAY|ZZ_PAT/.test(src)) continue;

  const r = spawnSync("node", [`checks/${f}`], { encoding: "utf8", timeout: 60_000 });
  if (r.status === 0) {
    fail.push(`checks/${f} passes and is not registered in any suites module — the gate does not run ` +
              `it, so it is green by absence. Add one top-level check(...) line via runsCheck.`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("working checks registered: ok");
