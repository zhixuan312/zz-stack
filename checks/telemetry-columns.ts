// The figures live in columns, and NOTHING keeps a second copy in detail.
//
// This check was written believing tool-report.ts was the only reader of `detail.ms` /
// `detail.bytes` — the plan said so in as many words. It was wrong: three more live readers
// and one staged index were reaching into the bag, and none of them was named by any task.
// A check scoped to the one file a task happens to touch cannot find that; only a repo-wide
// scan can. So the negative half of this check is repo-wide, and the task list is not what
// decides where it looks.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];
const SELF = "checks/telemetry-columns.ts";

// Applied migrations are history: 017 and 020 backfilled from the bag when the bag was the
// only place the figures were, and rewriting an applied file changes nothing on any host.
// migrations-next/ is NOT history — it is unapplied text that still has to be right.
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIP_PATH = ["services/gateway/migrations/"];

const walk = (dir: string, out: string[] = []) => {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js|sql)$/.test(e)) out.push(p);
  }
  return out;
};

const files = ["packages", "services", "scripts", "checks"].flatMap((d) => walk(d));

// A RECEIVER is required on the TS form (`e.detail.ms`, not a bare `detail.ms`) so that prose
// recording what the field USED to be — events.ts keeps exactly such a comment — is not read
// as a live access. The SQL forms need no receiver: `detail->>'ms'` and `detail ? 'bytes'`
// are reaches into the bag wherever they appear.
// ALL SEVEN COLUMNS 050 ADDED, not just the two that moved out of the bag. The scan used to
// name `ms` and `bytes` alone, because those were the fields the migration relocated — but the
// same mistake is available for the other five, and a future `detail.plugin` or
// `detail.tool_key` read would have landed silently with nothing to say so. The bag is not a
// place any of these live; the list is the migration's, so it stays complete by construction.
const BAG = "ms|bytes|duration_ms|request_bytes|response_bytes|batched|plugin|plugin_version|tool_key";
const READS: [RegExp, string][] = [
  [new RegExp(`[A-Za-z_$][\\w$]*\\.detail\\.(?:${BAG})\\b`), "e.detail.<a column's name>"],
  [new RegExp(`detail\\s*->>\\s*'(?:${BAG})'`), "detail->>'<a column's name>'"],
  [new RegExp(`detail\\s*\\?\\s*'(?:${BAG})'`), "detail ? '<a column's name>'"],
];
// A `--` comment in a .sql file is inert by definition, so prose there recording what the
// index USED to be over is not a read — 022 keeps exactly such a note. Only the text before
// `--` is tested, so a real reach sharing a line with a trailing comment is still caught.
// This is NOT done for .ts: SQL inside a template literal has `--` comments too, but so does
// a line of TypeScript that merely contains two hyphens, and a check that guesses wrong there
// would open a hole. A .ts comment describing old SQL will fire; that false positive is
// cheaper than a missed reader, and rewording the prose is the fix.
const strip = (f: string, l: string) => (f.endsWith(".sql") ? l.replace(/--.*$/, "") : l);

for (const f of files) {
  if (f === SELF || SKIP_PATH.some((s) => f.startsWith(s))) continue;
  const src = readFileSync(f, "utf8");
  for (const [re, what] of READS) {
    const line = src.split("\n").findIndex((l) => re.test(strip(f, l)));
    if (line >= 0) {
      fail.push(`${f}:${line + 1} still reads ${what} — the gateway stopped writing them`);
    }
  }
}

// The writer puts them in columns, and does not also put them in the bag.
const tel = readFileSync("services/gateway/src/tool-telemetry.ts", "utf8");
for (const col of ["duration_ms", "request_bytes", "response_bytes", "batched"]) {
  if (!tel.includes(col)) fail.push(`tool-telemetry does not write ${col}`);
}
if (/detail\s*:\s*\{[^}]*\bms\b/s.test(tel)) fail.push("detail still carries ms — two sources of truth");
if (/detail\s*:\s*\{[^}]*\bbytes\b/s.test(tel)) fail.push("detail still carries bytes — two sources of truth");

// And the readers read the columns. Absence of the old spelling is only half the claim:
// a file that reads neither is not migrated, it is broken.
const READERS = {
  "packages/tools/src/testing/tool-report.ts": ["duration_ms", "response_bytes"],
  "packages/tools/src/ops/watch-results.ts": ["duration_ms"],
  "packages/tools/src/ops/refresh-block-tools.ts": ["response_bytes", "duration_ms"],
  "services/gateway/src/runs.ts": ["response_bytes"],
};
for (const [f, cols] of Object.entries(READERS)) {
  const src = readFileSync(f, "utf8");
  for (const c of cols) if (!src.includes(c)) fail.push(`${f} does not read ${c}`);
}

// Control: the batched caveat must survive. Dropping it would silently mis-attribute latency.
if (!/batched/.test(readFileSync("packages/tools/src/testing/tool-report.ts", "utf8"))) {
  fail.push("tool-report no longer distinguishes batched rows");
}
// A run's total is nullable: a run whose calls were never measured has no total, and that is
// a different fact from a run that transferred nothing. FR-7a, in the one table that had it
// backwards.
// Missing reads as empty rather than throwing: a check that crashes exits nonzero but prints
// a stack trace instead of the sentence saying what is wrong.
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const runsSql = read("services/gateway/migrations/051_run_bytes_nullable.sql");
if (!/drop\s+not\s+null/i.test(runsSql)) fail.push("051 does not drop bytes_total's NOT NULL");
if (!/drop\s+default/i.test(runsSql)) fail.push("051 does not drop bytes_total's zero default");
const runs = readFileSync("services/gateway/src/runs.ts", "utf8");
if (/coalesce\s*\(\s*sum\s*\(\s*e\.response_bytes/i.test(runs)) {
  fail.push("runs.ts still coalesces an unmeasured total to 0");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("telemetry columns: ok");
