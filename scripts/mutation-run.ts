#!/usr/bin/env node
/**
 * mutation-run.ts — plant a defect in what each gate check examines, and record whether the
 * check noticed.
 *
 * WHY THIS EXISTS. A gate check that cannot fail is decoration with a green tick on it, and
 * nothing in a passing gate run distinguishes the two. This repository has had both kinds:
 * a check whose one input took an early-return branch so its loop iterated empty arrays and
 * it reported green on every run this repository had ever done, and a guard whose window was
 * widened for a moved call and quietly started passing for a builder nobody called. Neither
 * was found by reading. Both are found by planting a defect and watching what happens.
 *
 *   node scripts/mutation-run.ts                       # every declared check
 *   node scripts/mutation-run.ts --only scripts/gate/checks/hygiene.ts
 *   node scripts/mutation-run.ts --work /tmp/zz-mut --keep
 *
 * It writes `testing/mutation-report.json`, which `scripts/gate/checks/mutation-coverage.ts`
 * reads: a check with no row, a row whose mutation never landed, and a row whose check
 * survived its defect are all release-blocking, and the middle one is the reason the
 * substitution count is measured rather than assumed.
 *
 * EVERY RUN IS A REAL `node scripts/gate.ts`, in a copy of this checkout, over a tree that is
 * byte-identical to the snapshot except for the one planted defect. Nothing is run in a
 * cut-down harness: same entry file, same import order, same `ZZ_GATE_RUNNING` guard, same
 * exit codes. It costs about half an hour for the full set and buys an answer that is about
 * the gate rather than about a simulation of it.
 *
 * IT MUST NOT BE REGISTERED AS A GATE CHECK. It spawns gates; a gate that ran it would spawn
 * itself. It lives outside `scripts/gate/` so registration cannot reach it, and it refuses to
 * start inside a gate as well, because a static rule cannot see every way a launch is built.
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

// SPELLED OUT, NEVER COMPUTED. This repository finds an environment variable by looking for
// its literal name in the source, and a name assembled at runtime is a variable no audit of
// the configuration surface can see — which has its own check two files away.
if (process.env.ZZ_GATE_RUNNING === "1") {
  console.error("  REFUSED — ZZ_GATE_RUNNING=1: this launches gates, so running it inside one " +
    "is the recursion scripts/gate/run.ts refuses. Run it from a shell, never as a check.");
  process.exit(1);
}

/** A flag given with nothing after it is refused rather than read as absent — this
 *  repository's own rule, and it has a gate check of its own. */
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
// `--dry` PLANTS AND RESTORES WITHOUT RUNNING A GATE. It answers one question and no other:
// did the substitution land. A spec whose text has moved reports zero replacements, and this
// is how that is found in seconds rather than in the half-hour it would otherwise hide inside.
const dry = process.argv.includes("--dry");
// `--guards` drives the gate's OWN refusals — the two it can only be shown from outside itself
// — and merges their receipts into the report the mutation rows already live in, without
// redoing those rows. They are about the gate as a process rather than about any one check.
const guardsOnly = process.argv.includes("--guards");
const workAt = flag("work") ?? join(tmpdir(), "zz-mutation");
// HOW MANY CHECKOUTS AT ONCE. One by default, because that is what every invocation in every
// runbook already means. Above one, this process runs no rows itself: it shards the check files
// and spawns THIS SAME SCRIPT once per shard, each with a work directory of its own, then merges
// what they wrote. See mutation/parallel.ts for why that is the shape rather than an async loop.
const workers = Math.max(1, Number(flag("workers") ?? 1));
const out = resolve(flag("out") ?? join(root, "testing/mutation-report.json"));

interface GateRun {
  readonly verdict: string;
  readonly exit: number;
  readonly failed: string[];
  readonly ms: number;
}

/**
 * HOW LONG A CHILD MAY TAKE BEFORE IT IS A HANG RATHER THAN A SLOW RUN.
 *
 * `spawnSync` WITHOUT A TIMEOUT WAITS FOR EVER, AND SAYS NOTHING WHILE IT DOES. This cost
 * three and a half hours on row 173 of a 417-row run: `npm run build` in the copy blocked
 * inside `tsc -b` — state `S`, 0% CPU, not spinning — and the runner sat behind it with no
 * output, no error and no way for a reader to tell a hang from a long build. The log's last
 * line was a row that had already finished, so nothing on screen was wrong; there was just
 * never another line.
 *
 * A measured gate run here is 27-31 seconds and a build is faster, so five minutes is not a
 * budget, it is a diagnosis: past it the child is not working. Killed with SIGKILL rather
 * than SIGTERM because the thing that hung was a grandchild — npm's `tsc` — and a polite
 * signal to npm leaves it running.
 */
const CHILD_TIMEOUT_MS = 300_000;

/** Kill anything the timed-out child left behind. `spawnSync`'s timeout kills the process it
 *  started, not the tree below it, and an orphaned `tsc` holding the workspace is what makes
 *  the NEXT row hang too — one stall becoming every stall after it. */
function reapUnder(repo: string): void {
  try {
    execFileSync("pkill", ["-9", "-f", repo.replace(/[.[\]*+?^${}()|\\]/g, "\\$&")],
      { stdio: "ignore" });
  } catch { /* nothing matched, which is the ordinary case */ }
}

/**
 * THE BUILD IS RUN BEFORE THE GATE, AND THIS IS NOT AN OPTIMISATION.
 *
 * `scripts/gate.ts` statically imports every check module, and a check that reads a shared
 * package imports `@zz/contracts`, which resolves to `dist/`. An ES module graph is INSTANTIATED
 * in full — every file read, parsed and linked — before any module body is evaluated, so
 * `dist/index.js` is already in the module registry by the time `check("tsc -b")` runs and
 * rebuilds it. The rebuilt output cannot reach the process that produced it.
 *
 * MEASURED, not reasoned: with a pristine `packages/contracts/src` and a deliberately stale
 * `dist`, one gate run rebuilt `dist` correctly AND failed "the assessment port never invents a
 * probability or an answer" — the check judged the bytes that were on disk when the process
 * started, not the ones the gate had just produced.
 *
 * So a defect planted in one of those packages reaches its check only if the build happens in
 * a process that ends before the gate's begins. Without this the experiment measures nothing:
 * every such check would "survive" a defect it never saw.
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

/** One real gate run in the copy, read back from its own machine-readable report rather than
 *  from stdout — "did THIS check fail" has to be exact, and a name scraped out of a console
 *  line is not. */
function runGate(repo: string, reportPath: string): GateRun {
  const began = Date.now();
  const r = spawnSync("node", ["scripts/gate.ts", "--quiet", "--report", reportPath],
    { cwd: repo, encoding: "utf8", env: { ...process.env, ZZ_GATE_RUNNING: "" },
      timeout: CHILD_TIMEOUT_MS, killSignal: "SIGKILL" });
  const ms = Date.now() - began;
  // A TIMED-OUT GATE IS NOT A PASSING GATE AND NOT A FAILING ONE. It is a run that did not
  // happen, and it has to read that way or the row records an answer nobody got.
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

/** How many checks the gate actually registers across the declared FILES, counted the way
 *  `gateCheckNames()` counts them. Rows here are per check; this is the number a reader needs
 *  to see that the declared files carry many more checks than this plan added. */
function registeredCheckCount(repo: string, declared: readonly string[]): number {
  let n = 0;
  for (const f of declared) {
    n += (readFileSync(join(repo, f), "utf8").match(/^check\("/gm) ?? []).length;
  }
  return n;
}

/**
 * What a check's subject IS, from its path, so a reader can tell the row kinds apart.
 *
 * A defect in `.ts` changes what the platform DOES. A defect in a `.md` changes shipped
 * content — which for a check whose whole subject is shipped prose is the only defect there
 * is, and is exactly the regression each of those checks was written after somebody shipped.
 * A defect in a manifest or a configuration file changes what the platform DECLARES.
 */
function subjectKind(subject: string): string {
  if (subject.endsWith(".ts")) return "source";
  if (subject.endsWith(".md")) return "shipped prose";
  return "declared data or configuration";
}

/**
 * The report as text: the envelope pretty-printed, ONE RESULT ROW PER LINE.
 *
 * `JSON.stringify(doc, null, 2)` gave all thirty-one fields of all four hundred-odd rows a line
 * each and made this artifact 17,053 lines, so a run that moved two rows produced a diff nobody
 * could read. One line per row is about five hundred, and the diff names the rows that changed.
 *
 * IT IS THE SAME JSON. Only whitespace between tokens differs, so every reader — the coverage
 * check, `seedProvisional`, the `--guards` merge — goes on calling `JSON.parse` and sees
 * identical values. Nothing here may change what a field says.
 *
 * A key whose value does not survive `JSON.stringify` is DROPPED, which is what stringifying
 * the whole object did with it, so both forms agree on which keys exist.
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

/**
 * Give the coverage check a row for every check it will ask about, IN THE COPY ONLY.
 *
 * `scripts/gate/checks/mutation-coverage.ts` reads this report and fails when a declared check
 * has no row — including, once it is planted, its own. So the FIRST run that covers a new check
 * would find the gate already red at baseline on the very check it is about to test, and every
 * row it produced would read "the target was already failing" instead of an answer.
 *
 * A provisional row settles that and is marked as one. It is written into the disposable copy,
 * never into the repository's report: this run's real result replaces it a few minutes later,
 * and a provisional row that reached the artifact would be a claim nothing measured.
 */
function seedProvisional(repo: string, wanted: readonly string[]): void {
  const p = join(repo, "testing/mutation-report.json");
  const doc = existsSync(p)
    ? JSON.parse(readFileSync(p, "utf8")) as { results: { check: string }[] }
    : { results: [] };
  const have = new Set(doc.results.map((r) => r.check));
  const missing = wanted.filter((w) => !have.has(w));
  for (const check of missing) {
    doc.results.push({
      check, provisional: true, replacements: 1, failed: true,
      planted: "provisional, written into this run's disposable copy so the coverage check is " +
        "answerable at baseline — this run's measured row replaces it",
    } as { check: string });
  }
  // AND A ROW WHOSE CHECK HAS SINCE CHANGED IS AS UNANSWERABLE AS A MISSING ONE.
  //
  // `mutation-coverage.ts` binds each row to its check's sha256 AT GATE TIME rather than
  // trusting the `stale` the runner froze into the artifact. That closed a real hole — the
  // report on disk claimed `stale: false` on 418 rows while thirteen commits had touched
  // `scripts/gate/checks/` — and it defeated this function, which only ever seeded rows that
  // were absent.
  //
  // The consequence was circular and would have been permanent: editing
  // `mutation-coverage.ts` drifts its own rows, the gate goes red, and a run to refresh them
  // refuses because the baseline is red on the very check it is about to test. A check that
  // cannot be satisfied is what this repository deletes; this is that shape, reached by
  // adding a check rather than by leaving one behind.
  //
  // So the same provisional treatment extends to the sha: a wanted file's rows are stamped
  // with what it hashes to NOW, in the disposable copy only. The real run rewrites them
  // minutes later with a measured verdict and the same digest.
  const want = new Set(wanted);
  for (const r of doc.results as Array<{ check: string; check_sha256?: string }>) {
    if (!want.has(r.check)) continue;
    const full = join(repo, r.check);
    if (existsSync(full)) r.check_sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, reportText(doc));
}

function main(): void {
  const provenance = provenanceOf(root);
  console.log(`  building a disposable copy under ${workAt}`);
  const declaredNow = declaredChecks(root);
  // BEFORE the copy and before the baseline. A mistyped `--only` used to be caught after a
  // gate run had already been spent on it, which is a refusal arriving too late to be useful —
  // the same argument the gate itself makes for refusing a bad `--report` path at import.
  const unknown = only.filter((o) => !declaredNow.includes(o));
  if (unknown.length) die(`--only names ${unknown.join(", ")}, which the declared set does not contain`);
  const seedFor = only.length ? declaredNow.filter((d) => only.includes(d)) : declaredNow;

  // SHARDED, AND THIS PROCESS THEN MEASURES NOTHING. Everything above is cheap and has to happen
  // in either case — the declared set is what gets split, and a mistyped `--only` is still
  // refused before a single copy is made. Below this line the work is per-row, so a sharded run
  // hands it to children and becomes a merger. `--dry` and `--guards` are deliberately excluded:
  // one plants without running a gate and finishes in seconds, the other is two probes, and
  // neither is what anybody is waiting on.
  if (workers > 1 && !dry && !guardsOnly) {
    const counts = new Map<string, number>();
    for (const sp of SPECS) counts.set(sp.check, (counts.get(sp.check) ?? 0) + 1);
    void runSharded({
      runner: join(root, "scripts/mutation-run.ts"), workAt, out, wanted: seedFor,
      rowsFor: (f) => counts.get(f) ?? 1, workers, extras: keep ? ["--keep"] : [],
      reportText,
    }).then(() => process.exit(0));
    return;
  }

  const ws = makeWorkspace(root, workAt, (repo) => seedProvisional(repo, seedFor));

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
  // ONE ROW PER REGISTERED CHECK, NOT PER FILE. Thirty-two of the declared files register
  // more than one check, and a file-shaped roster lets a single mutation stand in for all of
  // them — which is how a report can satisfy a coverage check whose name promises per-check
  // evidence while providing per-file evidence. Rows may therefore share a `check` path; each
  // carries its own `target`, and the mutation for one must fail THAT one.
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
    // A SPEC THAT CANNOT BE APPLIED IS RECORDED, NEVER THROWN. A run that died on row 24
    // would lose the twenty-three answers it already had, and what went wrong is a fact about
    // this spec — an anchor that moved, a subject renamed — which the report is the right
    // place for. It is still a failed experiment and it still has to be fixed.
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

  // A `--only` run TOPS UP the report it finds rather than replacing it. The coverage check
  // demands a row for every declared check, so a narrow re-run that wrote only its own rows
  // would turn a green report into a report claiming sixty-four checks were never covered.
  let carried: { check: string }[] = [];
  // CARRIED FORWARD BY EVERY RUN, not only a top-up. A full run rebuilds the report object
  // from scratch, so guard receipts it did not read would vanish from the artifact without
  // anything saying they had — the same silent shortening a `--only` run is refused for.
  let priorGuards: unknown = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as { guards?: unknown }).guards ?? null
    : null;
  if (only.length) {
    // A TOP-UP ADDS; IT NEVER SHORTENS. The coverage check demands a row for every declared
    // check, so a narrow re-run that dropped rows would turn a green report into one claiming
    // sixty-odd checks were never covered — and it would do it silently, which is the shape
    // this whole task exists to refuse. Every one of these is a refusal, not a warning.
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
    // TWO REASONS A SPEC DOES NOT LAND, AND THEY NEED DIFFERENT WORK. An anchor that moved is
    // a spec to repair against the current text; a REFUSED subject is a spec that should never
    // have been written, because `plant()` freezes the checks and the gate's own entry — a run
    // that edited those would be measuring itself. The rows carry `apply_error` either way, so
    // the artifact has always distinguished them; this line did not, and a spec forbidden by
    // construction read here exactly like one whose text had drifted.
    const refused = missed.filter((r) => r.apply_error !== null);
    console.log(`\n  ${results.length} spec(s) applied, ${missed.length} did not land` +
      (refused.length ? ` (${refused.length} REFUSED by plant(), not a moved anchor)` : ""));
    for (const r of missed) {
      console.log(`      ${r.check} -> ${r.subject}${r.apply_error ? `\n        REFUSED: ${r.apply_error}` : ""}`);
    }
    if (!keep) execFileSync("rm", ["-rf", workAt]);
    process.exit(missed.length ? 4 : 0);
  }

  // IS EACH ROW STILL ABOUT THIS TREE? A row certifies that a named check, as those bytes,
  // failed on a planted defect. Nothing in the frozen coverage check reads a commit or a
  // digest, so a report produced against any tree at any time satisfies it forever. The
  // binding therefore lives here: every row carries the check file's sha256 as it was when the
  // row was measured, and each is compared against the live checkout before anything is
  // written. A row THIS RUN produced that has already drifted means the tree moved underneath
  // the run, and that is refused rather than recorded. A carried row that has drifted is
  // marked, because the fix is to re-run that one row rather than to discard sixty others.
  const rows = [...carried, ...results] as Record<string, unknown>[];
  const drifted: string[] = [];
  for (const row of rows) {
    const live = fileDigest(join(root, String(row.check)));
    const was = row.check_sha256 ?? null;
    row.live_check_sha256 = live;
    row.stale = was !== null && live !== was;
    if (row.stale) drifted.push(`${row.check} (${row.target ?? "no target"})`);
  }
  // THE SAME TREATMENT FOR THE ENTRIES THAT CANNOT BE ROWS. An unexercisable entry names a
  // check and makes a claim about it, and one of them pastes an OBSERVED OUTPUT from a real
  // run — fifty routes from a sibling-less gate. That is stronger evidence than a planted
  // mutation and weaker provenance, because nothing re-derives it: if the check's message
  // changes the entry goes on asserting what it saw, with nothing comparing the two. So each
  // entry carries the check's sha256 as its author read it, and gets `live`/`stale` stamped
  // beside it here exactly as a row does. Found by a reader who checked the artifact's fields
  // rather than assuming the two kinds of record were treated alike; they were not.
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

  // A ROW WHOSE OWN TARGET WAS ALREADY RED MEASURED NOTHING, AND IS REFUSED RATHER THAN
  // RECORDED. `newly` cannot contain a check that was failing before anything was planted, so
  // such a row comes back `failed: false` and reads exactly like a check that shrugged off a
  // defect. Writing it would put a wrong conclusion in the artifact wearing the flattering
  // column, and the wrong diagnosis — "this check is weak" — sends a reader to rewrite a check
  // that is probably fine.
  //
  // The usual cause is a spec's OWN payload. These spec files are tracked TypeScript and this
  // repository sweeps tracked files, so a literal import line, a credential shape, or a
  // sentence counting the platform's own tools turns the gate red at baseline and takes every
  // row in the batch with it. That has happened three times here. Refusing costs one run;
  // recording it costs somebody a day chasing the wrong file.
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
        "apply one exact substitution and COUNT it — a zero is a failed experiment, not a result",
        "npm run -s build, as its own process, BEFORE the gate",
        "node scripts/gate.ts --quiet --report <a path outside the repository>",
        "read the verdict from that report's failed_ids, restore, verify the sha256 again",
      ],
      why_the_build_is_separate:
        "scripts/gate.ts statically imports every check module, and an ES module graph is " +
        "instantiated in full before any module body is evaluated — so packages/contracts/dist " +
        "is already linked when check(\"tsc -b\") rebuilds it, and the rebuilt output cannot " +
        "reach the process that produced it. Measured: a pristine src with a stale dist rebuilt " +
        "dist correctly AND failed the check that reads it. Without a separate build step a " +
        "defect planted in a shared package never reaches the check that imports it.",
      failed_means:
        "the target check is in this run's failed_ids and was NOT in the baseline's",
      rows_are_per_registered_check:
        "One row per registered check(), not per check FILE. That distinction is load-bearing: " +
        `the ${declared.length} declared files register ${registeredCheckCount(ws.repo, declared)} ` +
        "checks between them, and thirty-odd files register more than one — so a file-shaped " +
        "roster would let one mutation stand in for every check in its file. Rows may share a " +
        "`check` path; each names its own `target`, and a mutation that only trips a SIBLING " +
        "check in the same file is a failed experiment, not evidence about the target.",
      a_green_row_establishes_one_assertion:
        "Rows are per registered check, and a registered check may carry SEVERAL INDEPENDENT " +
        "assertions. A green row therefore establishes that one named assertion of that check " +
        "can fail — not the check entire. Where a row is about one of several, it says which " +
        "in `assertion`; two rows may share a `target` and be about different claims.",
      the_class_nobody_has_counted:
        "Per-file was fixed by going per-registered-check. Per-ASSERTION is the same problem " +
        "one level further down: a check with two independent assertions needs two mutations " +
        "to be fully established. `trial-analyzer-agreement.ts` has two and now has two rows. " +
        "`rederivation-generation.ts` — the precedent that check was modelled on — has the " +
        "same shape, an import assertion and a vector-agreement assertion, with one row " +
        "against it. NOBODY HAS COUNTED HOW MANY OTHERS THERE ARE, and this task deliberately " +
        "did not sweep for them: it is work for whoever writes the next set of checks, " +
        "alongside the dormant regions this run found (a clause guarded by a condition the " +
        "data never takes, invisible to a mutation run as much as to a reader).",
      a_subject_too_simple_to_fail:
        "The third shape, and the one that hid a real kernel defect the longest. `evaluate` " +
        "checked only the step immediately before, so a seven-step procedure was verified one " +
        "link deep and a rule-free step became a permanent hole. Two fixtures watched it and " +
        "neither could disagree with it: the second-flow fixture is two steps, so it has no " +
        "\"three steps back\" to get wrong, and the negative control gives every step a " +
        "sign-off rule, so it has no rule-free step in the middle. A test whose SUBJECT cannot " +
        "express the failure passes for the same reason an unreachable clause does, and a " +
        "mutation run cannot tell the two apart from the outside — in both cases the defect " +
        "is planted and nothing goes red. What caught it was giving the check a subject that " +
        "could fail: the procedure the release actually registers.",
      a_check_that_reads_instead_of_exercising:
        "The fourth shape, and the most expensive one found. At fa975c4 `knowledge_search` " +
        "could not serve a single plain ASCII query: a parameter was bound as a side effect " +
        "and then never referenced, so the statement numbered $1 and $3 while binding three, " +
        "and PostgreSQL refuses to parse a statement whose numbering skips one. 534 of the 535 " +
        "searches this platform has ever received are ASCII. Two checks already read that " +
        "predicate — one asks whether its text contains a substring, the other which " +
        "configuration it names — and both passed. THIS SHAPE IS UNLIKE THE OTHER THREE: the " +
        "subject is reachable, the assertion is exercised, the fixture is real. What is wrong " +
        "is the QUESTION. Reading what a thing says is not running it, and a statement can " +
        "satisfy every assertion about its text while being unparseable. A mutation run cannot " +
        "find this one either — plant a defect that changes only what the text DOES and every " +
        "text-reading check stays green, which from the outside is indistinguishable from a " +
        "check that works. What caught it asks about the relationship between two halves the " +
        "text cannot express: the numbers the SQL references must be exactly 1..args.length, " +
        "and no database is needed to ask it.",
      what_this_artifact_is_not_evidence_about:
        "Every check this PLAN adds. The declared files also carry pre-existing checks that " +
        "predate this plan and have no row here, so a reader must not read a green report as " +
        "evidence that every check the gate registers has been shown able to fail.",
      binding_to_the_tree:
        "Each row carries `check_sha256` — the check file's bytes when the row was measured — " +
        "and `live_check_sha256`/`stale` from the moment the report was written. THE FIRST OF " +
        "THOSE IS ENFORCED AT GATE TIME: mutation-coverage.ts recomputes each check file's " +
        "digest against the tree in front of it and fails on any row whose check has moved, " +
        "naming the files to re-run with --only. It does NOT read `live_check_sha256`/`stale`, " +
        "and deliberately: those were frozen when this file was written and answer about a tree " +
        "that may no longer exist. This paragraph used to say nothing enforced any of it, which " +
        "was true of an earlier coverage check and has not been true since. The runner enforces " +
        "its own half too: it refuses to write at all if a check file moved while this run was " +
        "measuring it, and it names any carried row whose check has changed since. The entries " +
        "in `unexercisable_assertions` carry the same three fields for the same reason: " +
        "one of them records an observation from a real run rather than a planted " +
        "mutation, which is stronger evidence and weaker provenance, since nothing " +
        "re-derives it.",
    },
    results: [...carried, ...results].sort((a, b) => a.check < b.check ? -1 : 1),
    guards: guardsBlock(priorGuards, null),
    // OUTSIDE `results` DELIBERATELY — see mutation/unexercisable.ts. An assertion nothing
    // could plant against is a finding, and a finding that turned the gate red would be a
    // finding nobody keeps.
    unexercisable_assertions: entries,
  }));
  console.log(`\n  ${results.length} row(s) written to ${out}` +
    (carried.length ? `, ${carried.length} carried from the previous run` : ""));
  if (!keep) execFileSync("rm", ["-rf", workAt]);
}

main();
