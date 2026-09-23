/**
 * Running the rows N at a time, each in a checkout of its own.
 *
 * WHY THIS SPAWNS THE SERIAL RUNNER INSTEAD OF MAKING ITS LOOP ASYNC. The loop is not the
 * valuable part of `mutation-run.ts` — the CONTRACT around each row is: plant exactly once and
 * count it, build, run the whole gate, restore, and prove the tree came back to the snapshot
 * digest or die. That contract is synchronous by construction and has been shown to hold over
 * thousands of rows. Rewriting it to interleave would put every one of those properties back in
 * question to buy the same speed this buys by leaving it alone. So each worker IS the serial
 * runner, unmodified, pointed at a work directory of its own.
 *
 * WHY THE WORK IS ALREADY SAFE TO SPLIT. `makeWorkspace` does `cp -a` of the whole checkout,
 * node_modules included, into its own directory, and takes a lock named after its pid. Two
 * runners therefore share no mutable state at all — not the build output, not
 * `node_modules/.zz-psql-echo.sh` that `data-sql.ts` writes during a gate run, not the
 * `marketplace/` tree the gate regenerates. The one thing that made concurrent gate runs unsafe
 * in this repository was two of them in ONE tree; there is no such case here.
 *
 * WHY SHARDS ARE BALANCED BY ROW COUNT AND NOT BY FILE. `--only` selects whole check FILES, and
 * the files are wildly uneven: `suites.ts` carries 92 rows and thirty-odd files carry one. Round
 * robin over files hands one worker the 92 and finishes forty minutes after everybody else, so
 * the shards are filled longest-first into whichever worker currently has the fewest rows.
 *
 * WHY EVERY WORKER RUNS ITS OWN BASELINE. A baseline is one gate run over a particular copy, and
 * a copy is what a worker restores to. Sharing one would be a claim about a tree no other worker
 * is using. They cost 31 seconds each and they run at the same time, so the price is one gate
 * run of wall clock — and N independently computed baselines that DISAGREE is a fact worth
 * having: it means the source moved while the pass was in flight.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { treeDigest } from "./workspace.ts";

interface Row { readonly check: string }
interface Report {
  readonly results: Row[];
  readonly source_commit?: string;
  readonly source_dirty_paths?: number;
  readonly baseline_verdict?: string;
  readonly baseline_failed_ids?: string[];
  readonly produced_at?: string;
  [k: string]: unknown;
}

/** Longest-first into the emptiest worker. Returns `workers` lists of check files. */
function shard(wanted: readonly string[], rowsFor: (f: string) => number,
                      workers: number): string[][] {
  const bins: { files: string[]; rows: number }[] =
    Array.from({ length: workers }, () => ({ files: [], rows: 0 }));
  for (const f of [...wanted].sort((a, b) => rowsFor(b) - rowsFor(a))) {
    const into = bins.reduce((min, b) => (b.rows < min.rows ? b : min), bins[0]);
    into.files.push(f);
    into.rows += Math.max(1, rowsFor(f));
  }
  return bins.filter((b) => b.files.length).map((b) => b.files);
}

function child(runner: string, files: string[], work: string, out: string,
               extras: readonly string[], label: string): Promise<number> {
  const args = [runner, ...files.flatMap((f) => ["--only", f]), "--work", work, "--out", out,
                ...extras];
  return new Promise((resolve) => {
    const p = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    const line = (b: Buffer): void => {
      for (const l of b.toString().split("\n")) if (l.trim()) console.log(`  ${label} ${l.trim()}`);
    };
    p.stdout.on("data", line);
    p.stderr.on("data", line);
    p.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Run `wanted` across `workers` processes and merge their reports into `out`.
 *
 * THE MERGE IS BY OWNERSHIP, NOT BY UNION. Every worker is given the CURRENT report as its seed,
 * so each one writes a complete report: its own fresh rows plus every prior row it did not
 * re-run. Unioning those would count the untouched rows N times and, worse, would let a stale
 * copy of a row this pass re-measured win. So each worker contributes exactly the rows for the
 * files it owned, and the rows nobody owned are taken from one worker's copy of them -- which
 * is current, because every worker re-stamped them against the checkout before writing. The
 * seed is kept only to prove afterwards that nothing it held went missing.
 */
export async function runSharded(opts: {
  runner: string; source: string; workAt: string; out: string; wanted: string[];
  rowsFor: (f: string) => number; workers: number; extras: readonly string[];
  /** Injected rather than re-implemented: `mutation-run.ts` owns the serialisation, and a
   *  second copy of it here is the duplicated-constant shape this repository refuses. */
  reportText: (doc: Record<string, unknown>) => string;
}): Promise<void> {
  const { runner, source, workAt, out, wanted, rowsFor, workers, extras, reportText } = opts;
  if (!existsSync(out)) {
    console.error(`  REFUSED — a sharded run seeds every worker from ${out}, which does not exist`);
    process.exit(2);
  }
  const seed = JSON.parse(readFileSync(out, "utf8")) as Report;
  // BEFORE ANYTHING IS COPIED. What every worker is about to duplicate, digested once, so the
  // same measurement at the end says whether it stayed still.
  const sourceBefore = treeDigest(source);
  const groups = shard(wanted, rowsFor, workers);
  console.log(`  ${wanted.length} check file(s), ${wanted.reduce((n, f) => n + Math.max(1, rowsFor(f)), 0)} row(s), ${groups.length} worker(s):`);
  groups.forEach((g, k) => console.log(`      w${k}: ${g.reduce((n, f) => n + Math.max(1, rowsFor(f)), 0)} row(s) in ${g.length} file(s)`));

  const shards = groups.map((_, k) => ({ work: `${workAt}-w${k}`, out: `${workAt}-w${k}.json` }));
  for (const s of shards) copyFileSync(out, s.out);

  const codes = await Promise.all(groups.map((g, k) =>
    child(runner, g, shards[k].work, shards[k].out, extras, `w${k}`)));

  const failed = codes.map((c, k) => ({ c, k })).filter((x) => x.c !== 0);
  if (failed.length) {
    console.error(`  REFUSED — worker(s) ${failed.map((f) => `w${f.k} (exit ${f.c})`).join(", ")} did not finish; ` +
      `${out} is untouched and the shard reports are left at ${workAt}-w*.json`);
    process.exit(5);
  }

  const reports = shards.map((s) => JSON.parse(readFileSync(s.out, "utf8")) as Report);

  // THE TREE MUST HAVE BEEN ONE TREE, AND THE WORKERS CANNOT ANSWER THAT.
  //
  // This compared their `snapshot_tree_sha256` and refused when they differed — and they always
  // differ, by construction. `makeWorkspace` runs `seedProvisional` INSIDE the copy before it
  // takes the snapshot, and what that seeds is the worker's OWN `--only` set, so five workers
  // produce five legitimately different snapshots. The first sharded pass measured all 105 rows
  // correctly and then threw them away on that comparison. A cross-check between things that are
  // meant to differ is not a check, it is a coin toss that happened to come up wrong.
  //
  // The question was always about the SOURCE, so the source is what is asked. The parent digests
  // it before spawning and again now: identical means nothing edited the checkout while the pass
  // was in flight, whatever each worker's copy of it grew afterwards.
  const sourceAfter = treeDigest(source);
  if (sourceAfter !== sourceBefore) {
    console.error(`  REFUSED — the checkout changed while the pass was running ` +
      `(${sourceBefore} -> ${sourceAfter}). Every row was measured against a tree that no longer ` +
      "exists, and two of them may have been measured against different ones.");
    process.exit(6);
  }
  // AND THEY MUST HAVE COPIED THE SAME COMMIT. Weaker than the digest above and free: it catches
  // a worker launched against a different checkout entirely, which the digest cannot see.
  const provenance = new Set(reports.map((r) => `${r.source_commit ?? "?"}@${r.source_dirty_paths ?? "?"}`));
  if (provenance.size !== 1) {
    console.error(`  REFUSED — the workers report different provenance (${[...provenance].join(", ")})`);
    process.exit(6);
  }
  // A RED BASELINE IS NOT THE FAULT — DISAGREEMENT IS. Re-running drifted rows means the tree
  // arrives with `mutation-coverage.ts` already failing, because a drifted row is exactly what
  // it reports; that is the reason for the run, not a reason to refuse it. The serial runner has
  // always handled it: whatever is red before anything is planted is excluded from
  // `new_failures`, so a row still answers about its own target. What CANNOT be tolerated is two
  // workers disagreeing, because they are supposed to be looking at one tree — the digests above
  // say they are, so a different baseline means the run is not reproducible and no row from it
  // can be compared with any other.
  const baselines = new Set(reports.map((r) => [...(r.baseline_failed_ids ?? [])].sort().join("|")));
  if (baselines.size !== 1) {
    console.error(`  REFUSED — the workers did not agree on the baseline: ` +
      `${[...baselines].map((b) => b || "(clean)").join("  vs  ")}. They copied one tree and ` +
      "got two answers from it, so nothing they measured can be compared.");
    process.exit(7);
  }
  const wasRed = [...baselines][0];
  if (wasRed) console.log(`  every worker started from the same already-red baseline (${wasRed.split("|").join(", ")}), which is excluded from every row's new_failures`);

  const owned = groups.map((g) => new Set(g));
  const merged: Row[] = [];
  const seen = new Set<string>();
  reports.forEach((r, k) => {
    for (const row of r.results) if (owned[k].has(row.check)) { merged.push(row); seen.add(row.check); }
  });
  // THE ROWS NOBODY RE-RAN COME FROM A WORKER, NOT FROM THE SEED. Every worker carried them
  // forward AND re-stamped `live_check_sha256`/`stale` against the checkout as it is now, which
  // is the binding that makes a carried row honest. Taking them from the seed instead would put
  // yesterday's verdict about the tree back into today's artifact — the exact staleness the
  // stamping exists to expose. Any worker's copy will do; they all did the same thing.
  const everyone = new Set(wanted);
  for (const row of reports[0].results) if (!everyone.has(row.check)) { merged.push(row); seen.add(row.check); }

  // NOTHING MAY BE LOST, and a missing row is silent in exactly the way this whole artifact
  // exists to refuse: the coverage check reads a row per declared check, so a merge that
  // dropped one turns a measured check into an uncovered one with nothing saying so.
  const lost = seed.results.map((r) => r.check).filter((c) => !seen.has(c));
  const unmeasured = wanted.filter((f) => !seen.has(f));
  if (lost.length || unmeasured.length) {
    console.error(`  REFUSED — the merge would ${lost.length ? `drop ${lost.length} prior row(s) (${lost.slice(0, 4).join(", ")})` : ""}` +
      `${lost.length && unmeasured.length ? " and " : ""}` +
      `${unmeasured.length ? `leave ${unmeasured.length} requested file(s) unmeasured (${unmeasured.slice(0, 4).join(", ")})` : ""}`);
    process.exit(8);
  }

  // The envelope comes from a worker rather than being rebuilt here: every worker composed it
  // from the same source in the same run — the digests above have just proved that was ONE
  // source — and a second copy of that hundred-line `method` block is the duplicated-constant
  // shape this repository refuses everywhere else. `produced_at` is the latest of them, so the
  // artifact is dated when the pass ENDED rather than when its first worker happened to finish.
  const envelope = reports[0];
  const doc: Report = { ...envelope, results: merged,
                        produced_at: reports.map((r) => r.produced_at ?? "").sort().pop() ?? envelope.produced_at };
  writeFileSync(out, reportText(doc as unknown as Record<string, unknown>));
  console.log(`\n  ${merged.length} row(s) written to ${out} by ${groups.length} worker(s)`);
  for (const s of shards) { rmSync(s.out, { force: true }); rmSync(s.work, { recursive: true, force: true }); rmSync(`${s.work}.lock`, { force: true }); }
}
