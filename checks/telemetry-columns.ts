// The figures live in columns, and nothing keeps a second copy in the detail bag.
//
// DELIBERATE: the negative half is repo-wide rather than scoped to the files a task touches.
// A reader reaching into the bag can be anywhere, including an index definition.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];
const SELF = "checks/telemetry-columns.ts";

// Applied migrations are history: they backfilled from the bag when the bag was the only
// place the figures were, and rewriting an applied file changes nothing on any host. That is
// the whole exemption.
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

// DELIBERATE: the TS form requires a receiver (`e.detail.ms`, not a bare `detail.ms`), so
// prose naming a field is not read as a live access. The SQL forms need no receiver:
// `detail->>'ms'` and `detail ? 'bytes'` are reaches into the bag wherever they appear.
//
// Every column the migration added, not just the two that moved out of the bag: the same
// mistake is available for the other five, and the bag is not a place any of them live.
const BAG = "ms|bytes|duration_ms|request_bytes|response_bytes|batched|plugin|plugin_version|tool_key";
const READS: [RegExp, string][] = [
  [new RegExp(`[A-Za-z_$][\\w$]*\\.detail\\.(?:${BAG})\\b`), "e.detail.<a column's name>"],
  [new RegExp(`detail\\s*->>\\s*'(?:${BAG})'`), "detail->>'<a column's name>'"],
  [new RegExp(`detail\\s*\\?\\s*'(?:${BAG})'`), "detail ? '<a column's name>'"],
];
// Only the text before a `--` is tested in a .sql file, so prose there is not a read while a
// real reach sharing a line with a trailing comment still is.
//
// DELIBERATE: not done for .ts. A line of TypeScript containing two hyphens is not a SQL
// comment, and a .ts comment describing old SQL firing is cheaper than a missed reader —
// reword the prose.
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
//
// DELIBERATE: tool-telemetry is tested for the camelCase fields it sets, events.ts for the
// snake_case columns its insert names. `duration_ms` appears nowhere in tool-telemetry's code,
// so a check looking for it there can only ever resolve inside a comment.
const noComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
const tel = readFileSync("services/gateway/src/tool-telemetry.ts", "utf8");
const telCode = noComments(tel);
for (const field of ["durationMs", "requestBytes", "responseBytes", "batched"]) {
  // `field:` or the shorthand `field,` — requestBytes is written shorthand.
  if (!new RegExp(`\\b${field}\\s*[:,]`).test(telCode)) {
    fail.push(`tool-telemetry does not set ${field} on the row it writes`);
  }
}
const ev = noComments(readFileSync("services/gateway/src/events.ts", "utf8"));
for (const col of ["duration_ms", "request_bytes", "response_bytes", "batched"]) {
  if (!ev.includes(col)) fail.push(`events.ts does not name the ${col} column in its insert`);
}
if (/detail\s*:\s*\{[^}]*\bms\b/s.test(tel)) fail.push("detail still carries ms — two sources of truth");
if (/detail\s*:\s*\{[^}]*\bbytes\b/s.test(tel)) fail.push("detail still carries bytes — two sources of truth");

// And the readers read the columns. Absence of the old spelling is only half the claim: a
// file that reads neither is not migrated, it is broken.
const READERS = {
  "packages/tools/src/testing/tool-report.ts": ["duration_ms", "response_bytes"],
  "packages/tools/src/ops/watch-results.ts": ["duration_ms"],
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
// A run's total is nullable: a run whose calls were never measured has no total, which is a
// different fact from a run that transferred nothing.
//
// A missing file reads as empty rather than throwing, so a failure prints the sentence
// saying what is wrong rather than a stack trace.
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
// DELIBERATE: asked of the schema, not of the migration that got it there. The property
// worth defending is the column — nullable, with no default underneath it — and reading a
// migration for a `drop not null` is a claim about a file that a squashed schema no longer
// carries.
const runsSql = read("services/gateway/migrations/001_init.sql");
const runTable = /create table zz\.run \(([\s\S]*?)\n\);/i.exec(runsSql)?.[1] ?? "";
const bytesTotal = /^\s+bytes_total\s+([^\n]*?),?$/im.exec(runTable)?.[1] ?? "";
if (!bytesTotal) fail.push("zz.run has no bytes_total column");
if (/not null/i.test(bytesTotal)) fail.push("zz.run.bytes_total is NOT NULL — an unmeasured run cannot say so");
if (/default/i.test(bytesTotal)) fail.push("zz.run.bytes_total has a default — an unmeasured run would read as a measured zero");
const runs = readFileSync("services/gateway/src/runs.ts", "utf8");
if (/coalesce\s*\(\s*sum\s*\(\s*e\.response_bytes/i.test(runs)) {
  fail.push("runs.ts still coalesces an unmeasured total to 0");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("telemetry columns: ok");
