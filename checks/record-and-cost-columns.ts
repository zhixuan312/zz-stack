// The record's own columns exist, with nullability that tells a gap from a zero.
//
// WHAT THIS USED TO READ, AND WHY IT DOES NOT ANY MORE. This file was `migration-050.ts` and it
// read `services/gateway/migrations/050_record_and_cost.sql`, asserting that that file carried
// an idempotent `add column if not exists` for each of the seven columns. 050 is applied
// everywhere and its text has been squashed into `001_init.sql` with the other seventy-three;
// rewriting an applied migration changes nothing on any host, so the idempotency of one file's
// spelling was already a claim about nothing. The claims that MATTER survive unchanged, and
// they were always about the schema rather than about a file: these columns exist, these four
// are nullable, and this one is not.
import { readFileSync } from "node:fs";

const SCHEMA = "services/gateway/migrations/001_init.sql";
const sql = readFileSync(SCHEMA, "utf8");
const fail: string[] = [];

/** One table's column definitions, from `create table <name> (` to the closing paren.
 *
 *  Anchored on the table rather than grepped across the whole file, because `duration_ms` is a
 *  column of BOTH zz.event and zz.model_call and the nullability asserted below differs by
 *  table. A file-wide regex answered about whichever one it met first. */
function body(table: string): string {
  const m = new RegExp(`create table ${table.replace(".", "\\.")} \\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
  if (!m) { fail.push(`${SCHEMA} does not create ${table}`); return ""; }
  return m[1];
}

/** One column's definition line, or "" when the table does not carry it. */
function column(table: string, col: string): string {
  const m = new RegExp(`^\\s+${col}\\s+([^\\n]*?),?$`, "im").exec(body(table));
  return m ? m[1] : "";
}

for (const col of ["duration_ms", "request_bytes", "response_bytes", "batched",
                   "plugin", "plugin_version", "tool_key"]) {
  if (!column("zz.event", col)) fail.push(`zz.event has no ${col} column`);
}

for (const col of ["input_tokens", "output_tokens", "cache_read_tokens", "duration_ms"]) {
  const def = column("zz.model_call", col);
  if (!/^integer\b/i.test(def)) { fail.push(`zz.model_call lacks ${col} integer`); continue; }
  if (/not null/i.test(def)) fail.push(`${col} is NOT NULL — a gap would read as a measured zero`);
  if (/default\s+0\b/i.test(def)) fail.push(`${col} defaults to 0 — a gap would read as a measured zero`);
}

// Control: `batched` SHOULD be not-null, so a check that rejects every not-null is too broad.
if (!/^boolean\b[^\n]*not null/i.test(column("zz.event", "batched"))) {
  fail.push("batched must be NOT NULL — whether a call was batched always has an answer");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("record and cost columns: ok");
