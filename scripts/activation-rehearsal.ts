#!/usr/bin/env node
/**
 * Rehearse the activation procedure on copied fixtures, and derive whether it may run at all.
 *
 * `deploy/activation-runbook.json` is a written procedure for switching production. This script
 * exercises the parts of it that can be exercised on copies, reports what that established and what
 * it did not, and writes that report back into the runbook's `rehearsal` block. It never performs
 * the procedure, and the runbook has no `executed` field.
 *
 * DELIBERATE: it refuses outright if any database connection variable is set. The one way a
 * rehearsal turns into an execution is by finding a real connection lying around in the
 * environment, and at least one laptop in this project runs a local container pointed at the
 * production database.
 *
 * Activation is derived, never read. {@link blockers} computes the preconditions that are not met,
 * from their eight `state` values and from nothing else, and "may activate" is the emptiness of
 * that list — there is no field somebody could set to true. {@link waiveImmunity} is the
 * behavioural proof rather than the promise: it re-derives against a copy of the document carrying
 * `waivePreconditions: true` and an `activation_allowed: true` beside it, and requires the answer
 * not to move.
 *
 *   node scripts/activation-rehearsal.ts             # rehearse and report; writes nothing
 *   node scripts/activation-rehearsal.ts --record    # the same, and write the rehearsal block
 *
 * A clean rehearsal and a permitted activation are different facts, so they have different exit
 * codes rather than one zero:
 *
 *   0  rehearsed clean, and no precondition is blocked — activation may proceed to step 2
 *   1  the rehearsal itself found a problem: a malformed runbook, or a step that misbehaved
 *   2  refused to start, because the environment names a database this must never reach
 *   3  rehearsed clean, and activation is refused because a precondition is blocked
 *
 * `--record` may write the `rehearsal` block and nothing else. It re-reads the runbook, replaces
 * that one key, and refuses if the preconditions it read at the start differ from the ones on disk
 * at the end — a rehearsal that could edit a precondition could mark its own gate met.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNBOOK = "deploy/activation-runbook.json";
const LAYOUT = "deploy/init-record-layout.sh";

/** The eight the procedure's own gate check requires. Listed here because this script must
 *  notice one going missing as loudly as it notices one being blocked — an absent precondition
 *  is not an unblocked one, and reading `Object.keys` would make a deletion look like progress. */
const REQUIRED = ["operator", "runbook", "app_version", "store_version", "database_version",
                  "restore_evidence", "parity_evidence", "switch_authorization"] as const;

/**
 * Every variable that could name a real database, and which of them this environment sets. Presence
 * of any one is a refusal rather than a warning: this script has no business connecting to
 * anything, so a connection string in the environment reads as somebody expecting it to be used.
 *
 * Each one is read by its literal name. A variable reached as `process.env[name]` is invisible to
 * `zz-tool`'s forwarding list and to `deploy/.env.example`, which both find a variable by locating
 * its literal name in the source, so a computed read silently stops being forwarded and stops being
 * documented.
 */
function databaseNamesInEnvironment(): string[] {
  const named: readonly (readonly [string, string | undefined])[] = [
    ["TEAM_DB_URL", process.env.TEAM_DB_URL],
    ["PLATFORM_DB_URL", process.env.PLATFORM_DB_URL],
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["ZZ_TENANT_INFO_ISOLATED_DB_URL", process.env.ZZ_TENANT_INFO_ISOLATED_DB_URL],
    ["POSTGRES_URL", process.env.POSTGRES_URL],
    ["PGHOST", process.env.PGHOST],
    ["PGDATABASE", process.env.PGDATABASE],
  ];
  return named.filter(([, value]) => (value ?? "") !== "").map(([name]) => name);
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function record(v: unknown, label: string): Json {
  if (!isRecord(v)) throw new Error(`${label} did not parse to an object`);
  return v;
}

// Deriving the gate

/**
 * Every precondition that does not permit activation, with why. A missing key and a key whose
 * state is anything other than `met` are both blockers, and they are reported apart because
 * they need different people: one is a document somebody truncated, the other is work.
 */
function blockers(rb: Json): string[] {
  const pre = isRecord(rb.preconditions) ? rb.preconditions : {};
  const out: string[] = [];
  for (const key of REQUIRED) {
    const value = pre[key];
    if (value === undefined || value === null || value === false || value === "") {
      out.push(`${key}: absent from the runbook, which is not the same as unblocked`);
      continue;
    }
    if (value === "unassigned") {
      out.push(`${key}: the literal "unassigned", which names nobody`);
      continue;
    }
    if (!isRecord(value)) {
      out.push(`${key}: present but not an object, so it can carry no state and no reason`);
      continue;
    }
    const state = typeof value.state === "string" ? value.state : "(no state)";
    if (state !== "met") {
      const why = typeof value.would_unblock === "string"
        ? value.would_unblock
        : "no `would_unblock` recorded, so nobody can pick this up";
      out.push(`${key}: ${state} — ${why}`);
    }
  }
  return out;
}

/**
 * The behavioural half of "a precondition is never waived". Derivation is re-run against a copy
 * of the runbook carrying every field somebody might reach for to force the switch through. If
 * the blocker list moves by so much as one entry, there is a waiver path and this fails.
 */
function waiveImmunity(rb: Json): string[] {
  const base = blockers(rb);
  const forced = JSON.parse(JSON.stringify(rb)) as Json;
  forced.waivePreconditions = true;
  forced.activation_allowed = true;
  forced.executed = true;
  forced.force = true;
  const after = blockers(forced);
  const bad: string[] = [];
  if (after.length !== base.length || after.some((b, i) => b !== base[i])) {
    bad.push(`a copy of the runbook carrying waivePreconditions/activation_allowed/executed ` +
             `derived ${after.length} blockers where the real one derives ${base.length} — ` +
             "there is a path past a blocked precondition");
  }
  return bad;
}

/** What the document must not carry at all. These are refusals in the gate check that reads
 *  this file too; asserted here so a rehearsal catches them before a gate run does. */
function forbiddenFields(rb: Json): string[] {
  const bad: string[] = [];
  if (rb.waivePreconditions) bad.push("the runbook carries a truthy waivePreconditions");
  if (rb.executed) bad.push("the runbook records itself as executed");
  if ("activation_allowed" in rb) {
    bad.push("the runbook stores activation_allowed; it is derived, so storing it creates a " +
             "second answer that can disagree with the first");
  }
  const susp = isRecord(rb.suspension) ? rb.suspension : {};
  if (susp.guaranteesWorkerStopped) {
    bad.push("suspension claims to guarantee a worker stopped, which it cannot");
  }
  if (susp.guaranteesWorkerStopped === undefined) {
    bad.push("suspension does not say whether it guarantees a worker stopped; on this question " +
             "silence reads as yes to somebody in a hurry");
  }
  const rb2 = isRecord(rb.rollback) ? rb.rollback : {};
  if (rb2.weakensCurrentSecurity) bad.push("rollback would weaken current identity or storage safeguards");
  return bad;
}

/** Every step needs both, and the reason they are checked together is that a step with a
 *  verification and no abort is the worse of the two failures: somebody knows it went wrong
 *  and has nothing written down about what to do next. */
function stepShape(rb: Json): string[] {
  const steps = Array.isArray(rb.steps) ? rb.steps : [];
  const bad: string[] = [];
  if (!steps.length) return ["the runbook has no steps"];
  steps.forEach((s, i) => {
    const step = isRecord(s) ? s : {};
    if (!step.verification) bad.push(`step ${i + 1} has no verification`);
    if (!step.abort) bad.push(`step ${i + 1} has no abort point`);
  });
  const clean = steps.filter((s) => isRecord(s) && s.last_clean_abort_point === true);
  if (clean.length !== 1) {
    bad.push(`${clean.length} steps are marked as the last clean abort point; there is exactly ` +
             "one moment after which a return stops being clean, and a procedure that does not " +
             "name it leaves somebody to discover it during an incident");
  }
  return bad;
}

// Rehearsing step 7 on copied fixtures

/** Every file under `dir` whose path does not start with `.zz`, as one digest. This is what
 *  "the script rewrites no document byte" is measured against: the store's content, with the
 *  layout the script creates deliberately excluded, hashed over sorted paths so the walk order
 *  cannot change the answer. */
function contentDigest(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d).sort()) {
      const child = join(d, e);
      const childRel = rel ? `${rel}/${e}` : e;
      if (childRel === ".zz" || childRel.startsWith(".zz/")) continue;
      if (statSync(child).isDirectory()) walk(child, childRel);
      else files.push(childRel);
    }
  };
  walk(dir, "");
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f);
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex");
}

const layoutDirs = (store: string): string[] =>
  [".zz", ".zz/blobs", ".zz/commits"].filter((d) => {
    try { return statSync(join(store, d)).isDirectory(); } catch { return false; }
  });

/** Run the layout script on one store and return what it said. It exits non-zero on a real
 *  refusal, and the refusal text is the interesting half, so both are captured. */
function runLayout(store: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync("bash", [join(root, LAYOUT), store], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (err) {
    const e = isRecord(err) ? err : {};
    return { ok: false, out: `${String(e.stdout ?? "")}${String(e.stderr ?? "")}` };
  }
}

interface Rehearsed {
  readonly established: string[];
  readonly failures: string[];
}

/**
 * Step 7, on a store copied into a temporary directory. Three states are exercised, because three
 * is how many `record.ts` distinguishes: a store with no layout, a store with a complete one, and a
 * store left half-initialised by an interrupted attempt — which refuses every write exactly as a
 * missing one does while looking initialised to anybody who lists it.
 *
 * The fixtures are copies of real files from this repository: a synthetic empty directory would
 * exercise the mkdir and not the promise that matters, which is that a store's documents come
 * through the step untouched.
 */
function rehearseLayout(): Rehearsed {
  const established: string[] = [];
  const failures: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "activation-rehearsal-"));
  try {
    const store = join(tmp, "owner-store-copy");
    mkdirSync(join(store, "documents"), { recursive: true });
    // Copied fixtures: real files, from this repository, into a store-shaped directory.
    cpSync(join(root, "deploy/README.md"), join(store, "documents/readme.md"));
    cpSync(join(root, "deploy/RESTORE-AND-CUTOVER.md"), join(store, "documents/restore.md"));
    cpSync(join(root, RUNBOOK), join(store, "documents/runbook.json"));
    const before = contentDigest(store);

    if (layoutDirs(store).length !== 0) {
      failures.push("the copied store already carried part of a record layout before anything ran");
    }

    const first = runLayout(store);
    if (!first.ok) failures.push(`the first run refused on a store with no layout: ${first.out.trim()}`);
    if (layoutDirs(store).length !== 3) {
      failures.push(`after the first run the store carries ${layoutDirs(store).length} of the 3 ` +
                    "layout directories, so a write to it would still be refused");
    } else {
      established.push("step 7 turns a copied store with no record layout into one carrying all " +
                       "three of .zz/, .zz/blobs and .zz/commits");
    }

    const second = runLayout(store);
    if (!second.ok) failures.push(`the second run refused a complete layout: ${second.out.trim()}`);
    else if (!/already complete/i.test(second.out)) {
      failures.push("a second run on a complete layout did not report it as already complete, so " +
                    "the step cannot be safely repeated after an interruption");
    } else {
      established.push("step 7 is idempotent on a copied store: a second run reports the layout " +
                       "already complete and changes nothing");
    }

    // The half-initialised state, which is the one an interrupted attempt actually leaves.
    rmSync(join(store, ".zz/commits"), { recursive: true, force: true });
    if (layoutDirs(store).length !== 2) failures.push("the partial state could not be staged");
    const repair = runLayout(store);
    if (!repair.ok) failures.push(`the repair run refused a partial layout: ${repair.out.trim()}`);
    else if (layoutDirs(store).length !== 3) {
      failures.push("a partial layout was not completed, so a store that looks initialised would " +
                    "go on refusing every write");
    } else {
      established.push("step 7 repairs a half-initialised copied store rather than refusing it — " +
                       "the state that refuses every write while looking initialised to anybody " +
                       "who lists the directory");
    }

    const after = contentDigest(store);
    if (after !== before) {
      failures.push(`the store's non-layout content changed across three runs (${before.slice(0, 16)} ` +
                    `to ${after.slice(0, 16)}) — the step is supposed to create two empty ` +
                    "directories and rewrite no document byte");
    } else {
      established.push(`the copied store's documents hash identically before and after all three ` +
                       `runs (sha256 ${before.slice(0, 16)}), so step 7 creates directories and ` +
                       "rewrites no document byte");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { established, failures };
}

// The run

function main(): number {
  const reachable = databaseNamesInEnvironment();
  if (reachable.length) {
    console.error(`REFUSED: this environment names a database — ${reachable.join(", ")}.`);
    console.error("  This script rehearses on copied fixtures and must never reach a database.");
    console.error("  A connection string lying around is how a rehearsal becomes an execution.");
    return 2;
  }

  const runbookPath = join(root, RUNBOOK);
  const rb = record(JSON.parse(readFileSync(runbookPath, "utf8")), RUNBOOK);
  const preconditionsAsRead = JSON.stringify(rb.preconditions);

  const problems = [...forbiddenFields(rb), ...stepShape(rb), ...waiveImmunity(rb)];
  const gate = blockers(rb);

  const layout = rehearseLayout();
  problems.push(...layout.failures);

  const established = [
    `the activation gate refuses while any precondition is blocked: ${gate.length} of ` +
      `${REQUIRED.length} are blocked today and the derived verdict is REFUSE`,
    "the blocker list is derived from the eight precondition states alone — a copy of the " +
      "runbook carrying waivePreconditions, activation_allowed and executed derives the " +
      "identical list, so there is no path past a blocked precondition",
    "every step carries a verification and an abort point, and exactly one step is marked as " +
      "the last moment at which aborting is a clean return",
    ...layout.established,
  ];

  const didNot = [
    "It did not run the activation. No step was performed against production and no database " +
      "was contacted; this script refuses to start if a connection variable is set.",
    "It did not rehearse steps 2 to 6 or 8 to 12. Backup and manifest, drain, freeze, restore, " +
      "migration, rederivation, the frozen-write checks, the traffic switch, the resume and the " +
      "activation record all need a deployment, and rehearsing them needs the throwaway host " +
      "deploy/RESTORE-AND-CUTOVER.md describes rather than this checkout.",
    "It did not produce restore evidence or parity evidence. Exercising step 7 on a copied " +
      "store says nothing about whether a restored deployment serves what the old one held.",
    "It did not establish native readiness. A migration staged in the working tree and a " +
      "procedure describing how to apply it are not the same claim as a platform ready to " +
      "apply it, and nothing rehearsed on a copy speaks for the unmigrated production rows.",
    "It did not verify that suspension stops a worker, because suspension does not do that and " +
      "no rehearsal could show that it did.",
  ];

  console.log(`ACTIVATION REHEARSAL — ${RUNBOOK}`);
  console.log(`\nDerived gate: ${gate.length ? "REFUSE" : "no blockers"}`);
  for (const b of gate) console.log(`  blocked  ${b}`);
  console.log("\nEstablished by this rehearsal:");
  for (const e of established) console.log(`  ok       ${e}`);
  console.log("\nNot established by this rehearsal:");
  for (const d of didNot) console.log(`  not run  ${d}`);
  if (problems.length) {
    console.error("\nPROBLEMS:");
    for (const p of problems) console.error(`  FAIL     ${p}`);
    return 1;
  }

  if (process.argv.includes("--record")) {
    const now = record(JSON.parse(readFileSync(runbookPath, "utf8")), RUNBOOK);
    if (JSON.stringify(now.preconditions) !== preconditionsAsRead) {
      console.error("\nREFUSED to record: the preconditions changed on disk while this ran.");
      return 1;
    }
    const existing = isRecord(now.rehearsal) ? now.rehearsal : {};
    now.rehearsal = {
      ...existing,
      performed_at: new Date().toISOString(),
      performed_by: "scripts/activation-rehearsal.ts",
      fixtures: "a store-shaped directory in a temporary path, holding copies of real files from this repository; removed when the run ends",
      derived_gate: gate.length ? "REFUSE" : "no blockers",
      blocked_preconditions: gate.length,
      established,
      did_not_establish: didNot,
    };
    writeFileSync(runbookPath, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`\nRecorded the rehearsal block in ${RUNBOOK}. Nothing else in it was touched.`);
  } else {
    console.log("\nReport only. Re-run with --record to write the rehearsal block.");
  }

  // The rehearsal passing and the activation being permitted are different facts. Everything above
  // can be clean while every precondition is blocked, and returning zero there hands a green exit
  // code to anybody checking for one.
  if (gate.length) {
    console.log(`\nACTIVATION REFUSED — ${gate.length} of ${REQUIRED.length} preconditions are ` +
                "blocked. The rehearsal itself is clean; exit 3 is \"rehearsed, and may not run\".");
    return 3;
  }
  console.log("\nNo precondition is blocked. The gate permits step 2.");
  return 0;
}

process.exit(main());
