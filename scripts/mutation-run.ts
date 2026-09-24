#!/usr/bin/env node
/**
 * mutation-run.ts — plant a defect in what each gate check examines, and record whether the
 * check noticed.
 *
 *   node scripts/mutation-run.ts                       # every declared check
 *   node scripts/mutation-run.ts --only scripts/gate/checks/hygiene.ts
 *   node scripts/mutation-run.ts --work /tmp/zz-mut --keep
 *
 * It writes `testing/mutation-report.json`: per row, whether the defect landed and whether the
 * check went red. Run on demand, when a check's strength is in question; the gate does not read
 * the report.
 *
 * Every run is a real `node scripts/gate.ts`, in a copy of this checkout, over a tree that is
 * byte-identical to the snapshot except for the one planted defect: same entry file, same import
 * order, same `ZZ_GATE_RUNNING` guard, same exit codes.
 *
 * DELIBERATE: it must not be registered as a gate check. It spawns gates, so a gate that ran it
 * would spawn itself. It lives outside `scripts/gate/` so registration cannot reach it, and it
 * refuses to start inside a gate as well, because a static rule cannot see every way a launch is
 * built.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { plant } from "./mutation/plant.ts";
import type { MutationSpec } from "./mutation/plant.ts";
import { guardsBlock, probeGuards } from "./mutation/guards.ts";
import { SPECS } from "./mutation/specs.ts";
import { UNEXERCISABLE } from "./mutation/unexercisable.ts";
import { runSharded } from "./mutation/parallel.ts";
import { DECLARED_BY, declaredChecks, makeWorkspace, provenanceOf, restore } from "./mutation/workspace.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Spelled out, never computed. This repository finds an environment variable by looking for its
// literal name in the source, so a name assembled at runtime is invisible to the check that
// audits the configuration surface.
if (process.env.ZZ_GATE_RUNNING === "1") {
  console.error("  REFUSED — ZZ_GATE_RUNNING=1: this launches gates, so running it inside one " +
    "is the recursion scripts/gate/run.ts refuses. Run it from a shell, never as a check.");
  process.exit(1);
}

/** A flag given with nothing after it is refused rather than read as absent. */
function flag(name: string): string | null {
  const argv = process.argv;
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return valueOrDie(name, inline.slice(name.length + 3));
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return null;
  return valueOrDie(name, argv[at + 1]);
}

/** A refusal this program can only answer by stopping: say what is wrong and exit non-zero,
 *  rather than writing an artifact that is quietly less than the one it replaced. */
function die(why: string): never {
  console.error(`  REFUSED — ${why}`);
  process.exit(6);
}

function valueOrDie(name: string, raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    console.error(`  REFUSED — --${name} was given with no value after it`);
    process.exit(2);
  }
  return raw;
}

const only = process.argv.filter((_, i) => process.argv[i - 1] === "--only");
const keep = process.argv.includes("--keep");
// `--dry` plants and restores without running a gate. It answers one question: did the
// substitution land. A spec whose text has moved reports zero replacements.
const dry = process.argv.includes("--dry");
// `--guards` drives the gate's own refusals — the two it can only be shown from outside itself —
// and merges their receipts into the report the mutation rows live in, without redoing those rows.
const guardsOnly = process.argv.includes("--guards");
const workAt = flag("work") ?? join(tmpdir(), "zz-mutation");
// How many checkouts at once. One by default. Above one this process runs no rows itself: it
// shards the check files, spawns this same script once per shard with a work directory of its own,
// then merges what they wrote. See mutation/parallel.ts for why that shape rather than an async
// loop.
const workers = Math.max(1, Number(flag("workers") ?? 1));
const out = resolve(flag("out") ?? join(root, "testing/mutation-report.json"));

interface GateRun {
  readonly verdict: string;
  readonly exit: number;
  readonly failed: string[];
  readonly ms: number;
}

/**
 * How long a child may take before it is a hang rather than a slow run. A gate run takes well under
 * a minute and a build is faster, so five minutes is a diagnosis rather than a budget, and
 * `spawnSync` without a timeout waits for ever in silence.
 *
 * SIGKILL rather than SIGTERM: what hangs is a grandchild — npm's `tsc` — and a polite signal to
 * npm leaves it running.
 */
const CHILD_TIMEOUT_MS = 300_000;

/** Kill anything the timed-out child left behind. `spawnSync`'s timeout kills the process it
 *  started, not the tree below it, and an orphaned `tsc` holding the workspace is what makes the
 *  next row hang too. */
function reapUnder(repo: string): void {
  try {
    execFileSync("pkill", ["-9", "-f", repo.replace(/[.[\]*+?^${}()|\\]/g, "\\$&")],
      { stdio: "ignore" });
  } catch { /* nothing matched, which is the ordinary case */ }
}

/**
 * The build runs before the gate, and this is not an optimisation.
 *
 * `scripts/gate.ts` statically imports every check module, and an ES module graph is instantiated
 * in full before any module body is evaluated — so `packages/contracts/dist` is already in the
 * module registry by the time `check("tsc -b")` rebuilds it, and the rebuilt output cannot reach
 * the process that produced it. A defect planted in a shared package therefore reaches its check
 * only if the build happens in a process that ends before the gate's begins.
 */
function prebuild(repo: string): string | null {
  const r = spawnSync("npm", ["run", "-s", "build"],
    { cwd: repo, encoding: "utf8", timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    reapUnder(repo);
    return `the build did not finish within ${CHILD_TIMEOUT_MS / 1000}s and was killed — ` +
      "this is a hang, not a slow build; the row it belongs to measured nothing";
  }
  if (r.status === 0) return null;
  return String(r.stdout || r.stderr || "").slice(-400);
}

/** One real gate run in the copy, read back from its own machine-readable report rather than from
 *  stdout — "did this check fail" has to be exact, and a name scraped out of a console line is
 *  not. */
function runGate(repo: string, reportPath: string): GateRun {
  const began = Date.now();
  const r = spawnSync("node", ["scripts/gate.ts", "--quiet", "--report", reportPath],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ZZ_GATE_RUNNING: "" },
      timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  const ms = Date.now() - began;
  // A timed-out gate is not a passing gate and not a failing one. It is a run that did not
  // happen, and the row has to read that way.
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    reapUnder(repo);
    return { verdict: "TIMED OUT", exit: -1, failed: [], ms };
  }
  if (!existsSync(reportPath)) {
    return { verdict: "NO REPORT", exit: r.status ?? -1, failed: [], ms };
  }
  const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as
    { verdict: string; failed_ids: string[] };
  return { verdict: parsed.verdict, exit: r.status ?? -1, failed: parsed.failed_ids, ms };
}

/** A file's sha256, or null where it is not there — the absence is itself the answer a
 *  staleness comparison needs, so it is returned rather than thrown. */
function fileDigest(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return null; }
}

/** How many checks the gate registers across the declared files, counted the way
 *  `gateCheckNames()` counts them. Rows here are per check, and the declared files carry many more
 *  checks than there are rows. */
function registeredCheckCount(repo: string, declared: readonly string[]): number {
  let n = 0;
  for (const f of declared) {
    n += (readFileSync(join(repo, f), "utf8").match(/^check\("/gm) ?? []).length;
  }
  return n;
}

/**
 * What a check's subject is, from its path, so a reader can tell the row kinds apart. A defect in
 * a `.ts` changes what the platform does; in a `.md`, shipped content, which for a check whose
 * subject is shipped prose is the only defect there is; in a manifest or configuration file, what
 * the platform declares.
 */
function subjectKind(subject: string): string {
  if (subject.endsWith(".ts")) return "source";
  if (subject.endsWith(".md")) return "shipped prose";
  return "declared data or configuration";
}

/**
 * The report as text: the envelope pretty-printed, one result row per line, so a run that moved
 * two rows produces a diff naming those rows rather than 17,000 lines.
 *
 * It is the same JSON — only whitespace between tokens differs — and a key whose value does not
 * survive `JSON.stringify` is dropped, exactly as stringifying the whole object drops it.
 */
function reportText(doc: Record<string, unknown>): string {
  const rows = Array.isArray(doc.results) ? doc.results as unknown[] : null;
  if (!rows) return `${JSON.stringify(doc, null, 2)}\n`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(doc)) {
    if (k === "results") {
      parts.push(`  "results": ${rows.length
        ? `[\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(",\n")}\n  ]`
        : "[]"}`);
      continue;
    }
    const text = JSON.stringify(v, null, 2);
    if (text === undefined) continue;
    parts.push(`  ${JSON.stringify(k)}: ${text.split("\n").join("\n  ")}`);
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

function main(): void {
  const provenance = provenanceOf(root);
  console.log(`  building a disposable copy under ${workAt}`);
  const declaredNow = declaredChecks(root);
  // Before the copy and before the baseline: a mistyped `--only` caught after a gate run has been
  // spent on it is a refusal arriving too late to be useful.
  const unknown = only.filter((o) => !declaredNow.includes(o));
  if (unknown.length) die(`--only names ${unknown.join(", ")}, which the declared set does not contain`);
  const selected = only.length ? declaredNow.filter((d) => only.includes(d)) : declaredNow;

  // Sharded, and this process then measures nothing. Everything above is cheap and happens in
  // either case — the declared set is what gets split, and a mistyped `--only` is still refused
  // before a single copy is made. Below this line the work is per-row, so a sharded run hands it to
  // children and becomes a merger. `--dry` and `--guards` are excluded: one plants without running
  // a gate and finishes in seconds, the other is two probes.
  if (workers > 1 && !dry && !guardsOnly) {
    const counts = new Map<string, number>();
    for (const sp of SPECS) counts.set(sp.check, (counts.get(sp.check) ?? 0) + 1);
    void runSharded({
      runner: join(root, "scripts/mutation-run.ts"), source: root, workAt, out, wanted: selected,
      rowsFor: (f) => counts.get(f) ?? 1, workers, extras: keep ? ["--keep"] : [],
      reportText,
    }).then(() => process.exit(0));
    return;
  }

  const ws = makeWorkspace(root, workAt);

  if (guardsOnly) {
    const probes = probeGuards(ws.repo, join(ws.reports, "control.json"));
    for (const g of probes) console.log(`  ${g.held ? "HELD" : "DID NOT HOLD"} — ${g.probe}\n      ${g.observed}`);
    const doc = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    doc.guards = guardsBlock(doc.guards, probes);
    writeFileSync(out, reportText(doc));
    console.log(`\n  ${probes.length} guard receipt(s) merged into ${out}`);
    if (!keep) execFileSync("rm", ["-rf", workAt]);
    process.exit(probes.every((g) => g.held) ? 0 : 5);
  }

  console.log(dry ? "  dry: landing only, no gate runs" : "  baseline: one gate run with nothing planted");
  if (!dry) prebuild(ws.repo);
  const baseline = dry
    ? { verdict: "SKIPPED", exit: 0, failed: [] as string[], ms: 0 }
    : runGate(ws.repo, join(ws.reports, "baseline.json"));
  console.log(`      ${baseline.verdict} in ${(baseline.ms / 1000).toFixed(1)}s` +
    (baseline.failed.length ? ` — already red: ${baseline.failed.join(", ")}` : ""));
  const alreadyRed = new Set(baseline.failed);

  const declared = declaredChecks(ws.repo);
  // One row per registered check, not per file. Many of the declared files register more than
  // one check, and a file-shaped roster lets a single mutation stand in for all of them. Rows
  // may therefore share a `check` path; each carries its own `target`, and the mutation for one
  // must fail that one.
  const specsFor = new Map<string, MutationSpec[]>();
  for (const s of SPECS) specsFor.set(s.check, [...(specsFor.get(s.check) ?? []), s]);
  const wanted = only.length ? declared.filter((d) => only.includes(d)) : declared;

  const results = [];
  const planned = wanted.reduce((n, f) => n + Math.max(1, (specsFor.get(f) ?? []).length), 0);
  let i = 0;
  for (const file of wanted) {
    for (const spec of specsFor.get(file) ?? [null]) {
    const head = `  [${++i}/${planned}] ${file}`;
    if (!spec) {
      console.log(`${head} — NO SPEC`);
      results.push({
        check: file, target: null, subject: null, planted: "no mutation was written for this check",
        find: null, replace: null, replacements: 0, failed: false, exit: null,
        verdict: null, build_failed: null, baseline_red: alreadyRed.has(file),
        failed_ids: [], new_failures: [], restored_digest: ws.digest, digest_matches: true,
        duration_ms: 0, caveat: "no spec — this check has been shown nothing and proves nothing",
      });
      continue;
    }
    // A spec that cannot be applied is recorded, never thrown: a run that died on row 24 would
    // lose the twenty-three answers it already had, and what went wrong — an anchor that moved, a
    // subject renamed — is a fact about the spec. It is still a failed experiment.
    let landed = { replacements: 0, before: "" };
    let applyError: string | null = null;
    try {
      landed = plant(ws.repo, spec);
    } catch (err) {
      applyError = err instanceof Error ? err.message : String(err);
    }
    let run: GateRun = { verdict: "NOT RUN", exit: -1, failed: [], ms: 0 };
    let prebuildError: string | null = null;
    if (landed.replacements > 0 && !dry) {
      prebuildError = prebuild(ws.repo);
      run = runGate(ws.repo, join(ws.reports, `${i}.json`));
    }
    const digest = restore(ws);
    const newly = run.failed.filter((f) => !alreadyRed.has(f));
    const failed = newly.includes(spec.target);
    console.log(`${head} — ${spec.target}: ${landed.replacements} replacement(s), ` +
      `${failed ? "CAUGHT" : "SURVIVED"} (${run.verdict}, exit ${run.exit})`);
    results.push({
      check: file, target: spec.target, assertion: spec.assertion ?? null,
      subject: spec.subject, planted: spec.planted,
      find: spec.redact ? null : spec.find,
      replace: spec.redact ? null : spec.replace,
      find_base64: spec.redact ? Buffer.from(spec.find, "utf8").toString("base64") : null,
      replace_base64: spec.redact ? Buffer.from(spec.replace, "utf8").toString("base64") : null,
      redacted: spec.redact === true,
      replacements: landed.replacements,
      failed, exit: run.exit, verdict: run.verdict,
      build_failed: run.failed.includes("tsc -b"),
      baseline_red: alreadyRed.has(spec.target),
      failed_ids: run.failed, new_failures: newly,
      snapshot_tree_sha256: ws.digest, subject_kind: subjectKind(spec.subject),
      check_sha256: fileDigest(join(ws.repo, file)),
      subject_sha256: fileDigest(join(ws.repo, spec.subject)),
      restored_digest: digest, digest_matches: digest === ws.digest,
      duration_ms: run.ms, caveat: spec.caveat ?? null, apply_error: applyError,
      prebuild_failed: prebuildError !== null, prebuild_error: prebuildError,
    });
    if (digest !== ws.digest) {
      console.error(`      RESTORE FAILED — the tree did not come back to ${ws.digest}`);
      process.exit(3);
    }
    }
  }

  // A `--only` run tops up the report it finds rather than replacing it: a narrow re-run writing
  // only its own rows would drop every other check's row.
  let carried: { check: string }[] = [];
  // Carried forward by every run, not only a top-up. A full run rebuilds the report object from
  // scratch, so guard receipts it did not read would vanish from the artifact without anything
  // saying they had.
  let priorGuards: unknown = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as { guards?: unknown }).guards ?? null
    : null;
  if (only.length) {
    // A top-up adds; it never shortens. Every one of these is a refusal, not a warning.
    if (!existsSync(out)) die(`--only tops up an existing report and ${out} does not exist`);
    const prior = JSON.parse(readFileSync(out, "utf8")) as
      { results: { check: string }[]; guards?: unknown };
    carried = prior.results.filter((r) => !wanted.includes(r.check));
    const produced = new Set([...carried, ...results].map((r) => r.check));
    const lost = prior.results.map((r) => r.check).filter((c) => !produced.has(c));
    if (lost.length) die(`this top-up would drop ${lost.length} row(s) it did not re-run: ${lost.slice(0, 5).join(", ")}`);
  }

  if (dry) {
    const missed = results.filter((r) => r.replacements === 0);
    // Two reasons a spec does not land, and they need different work. An anchor that moved is a
    // spec to repair against the current text; a refused subject is a spec that should never have
    // been written, because `plant()` freezes the checks and the gate's own entry. The rows carry
    // `apply_error` either way, and this line says which kind it was.
    const refused = missed.filter((r) => r.apply_error !== null);
    console.log(`\n  ${results.length} spec(s) applied, ${missed.length} did not land` +
      (refused.length ? ` (${refused.length} REFUSED by plant(), not a moved anchor)` : ""));
    for (const r of missed) {
      console.log(`      ${r.check} -> ${r.subject}${r.apply_error ? `\n        REFUSED: ${r.apply_error}` : ""}`);
    }
    if (!keep) execFileSync("rm", ["-rf", workAt]);
    process.exit(missed.length ? 4 : 0);
  }

  // Is each row still about this tree? A row certifies that a named check, as those bytes, failed
  // on a planted defect. So every row carries the check file's sha256 as it was when the row was measured, and each is
  // compared against the live checkout before anything is written. A row this run produced that
  // has already drifted is refused; a carried row that has drifted is marked, because the fix is
  // to re-run that one row rather than discard sixty others.
  const rows = [...carried, ...results] as Record<string, unknown>[];
  const drifted: string[] = [];
  for (const row of rows) {
    const live = fileDigest(join(root, String(row.check)));
    const was = row.check_sha256 ?? null;
    row.live_check_sha256 = live;
    row.stale = was !== null && live !== was;
    if (row.stale) drifted.push(`${row.check} (${row.target ?? "no target"})`);
  }
  // The same treatment for the entries that cannot be rows. An unexercisable entry names a check
  // and makes a claim about it, and one pastes an observed output from a real run — stronger
  // evidence than a planted mutation and weaker provenance, because nothing re-derives it. So each
  // entry carries the check's sha256 as its author read it, and gets `live`/`stale` stamped beside
  // it here exactly as a row does.
  const entries = UNEXERCISABLE.map((u) => {
    const live = fileDigest(join(root, u.check));
    return { ...u, live_check_sha256: live, stale: live !== u.observed_check_sha256 };
  });
  const staleEntries = entries.filter((e) => e.stale);
  if (staleEntries.length) {
    console.log(`\n  ${staleEntries.length} unexercisable entr(ies) describe a check file that ` +
      `has since changed — re-read each and re-observe before trusting what it says:\n      ` +
      staleEntries.map((e) => `${e.check} (${e.assertion.slice(0, 60)}…)`).join("\n      "));
  }

  // A row whose own target was already red measured nothing, and is refused rather than recorded.
  // `newly` cannot contain a check that was failing before anything was planted, so such a row
  // comes back `failed: false` and reads exactly like a check that shrugged off a defect.
  //
  // The usual cause is a spec's own payload: these spec files are tracked TypeScript and the gate
  // sweeps tracked files, so a literal import line, a credential shape, or a sentence counting the
  // platform's own tools turns the gate red at baseline and takes every row in the batch with it.
  const measuredNothing = results.filter((r) => r.baseline_red);
  if (measuredNothing.length) {
    die(`${measuredNothing.length} row(s) had their own target already failing at baseline, so ` +
      `they measured nothing and nothing was written: ` +
      `${measuredNothing.map((r) => r.target).slice(0, 5).join(", ")}. The baseline was red on: ` +
      `${baseline.failed.join(", ")} — fix that first. A spec file's own payload is the usual ` +
      `cause, since these files are tracked and the gate sweeps tracked files.`);
  }

  const mine = new Set(results.map((r) => r.check));
  const driftedInThisRun = drifted.filter((d) => mine.has(d.split(" (")[0]));
  if (driftedInThisRun.length) {
    die(`the check files moved while this run was measuring them: ${driftedInThisRun.join(", ")}` +
      " — the rows would describe bytes that are no longer there, so nothing was written");
  }
  if (drifted.length) {
    console.log(`\n  ${drifted.length} carried row(s) describe a check file that has since ` +
      `changed; re-run each with --only:\n      ${drifted.join("\n      ")}`);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, reportText({
    schema_version: 1,
    produced_at: new Date().toISOString(),
    produced_by: "scripts/mutation-run.ts",
    source_commit: provenance.commit,
    source_dirty_paths: provenance.dirty_paths,
    snapshot_tree_sha256: ws.digest,
    declared_by: DECLARED_BY,
    declared_count: declared.length,
    baseline_verdict: baseline.verdict,
    baseline_failed_ids: baseline.failed,
    method: {
      per_row: [
        "restore the copy from the pristine snapshot and verify its sha256",
        "apply one exact substitution and count it — a zero is a failed experiment, not a result",
        "npm run -s build, as its own process, before the gate",
        "node scripts/gate.ts --quiet --report <a path outside the repository>",
        "read the verdict from that report's failed_ids, restore, verify the sha256 again",
      ],
      why_the_build_is_separate:
        "scripts/gate.ts statically imports every check module, and an ES module graph is " +
        "instantiated in full before any module body is evaluated — so packages/contracts/dist " +
        "is already linked when check(\"tsc -b\") rebuilds it, and the rebuilt output cannot " +
        "reach the process that produced it. Without a separate build step a defect planted " +
        "in a shared package never reaches the check that imports it.",
      failed_means:
        "the target check is in this run's failed_ids and was not in the baseline's",
      rows_are_per_registered_check:
        "One row per registered check(), not per check file. " +
        `The ${declared.length} declared files register ${registeredCheckCount(ws.repo, declared)} ` +
        "checks between them, and a file-shaped roster would let one mutation stand in for " +
        "every check in its file. Rows may share a `check` path; each names its own `target`, " +
        "and a mutation that only trips a sibling check in the same file is a failed " +
        "experiment, not evidence about the target.",
      a_green_row_establishes_one_assertion:
        "Rows are per registered check, and a registered check may carry several independent " +
        "assertions. A green row therefore establishes that one named assertion of that check " +
        "can fail — not the check entire. Where a row is about one of several, it says which " +
        "in `assertion`; two rows may share a `target` and be about different claims.",
      what_this_artifact_is_not_evidence_about:
        "Checks with no row here. A green report is not evidence that every check the gate " +
        "registers has been shown able to fail.",
      binding_to_the_tree:
        "Each row carries `check_sha256` — the check file's bytes when the row was measured — " +
        "and `live_check_sha256`/`stale` from the moment the report was written. Compare " +
        "`check_sha256` with the file on disk to know whether a row still describes today's " +
        "check; nothing in the gate does this for you. The runner refuses to write at all if a " +
        "check file moved while this run was measuring it, and it names any carried row whose " +
        "check has changed since. The entries in `unexercisable_assertions` carry the same " +
        "three fields for the same reason: one of them records an observation from a real run " +
        "rather than a planted mutation, which is stronger evidence and weaker provenance, " +
        "since nothing re-derives it.",
    },
    results: [...carried, ...results].sort((a, b) => a.check < b.check ? -1 : 1),
    guards: guardsBlock(priorGuards, null),
    // DELIBERATE: outside `results` — see mutation/unexercisable.ts. An assertion nothing could
    // plant against is a finding, and a finding that turned the gate red would be a finding nobody
    // keeps.
    unexercisable_assertions: entries,
  }));
  console.log(`\n  ${results.length} row(s) written to ${out}` +
    (carried.length ? `, ${carried.length} carried from the previous run` : ""));
  if (!keep) execFileSync("rm", ["-rf", workAt]);
}

main();
