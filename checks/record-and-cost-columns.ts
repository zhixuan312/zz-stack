// The record's own columns exist, with nullability that tells a gap from a zero. The claim is
// about the schema in `001_init.sql`, not about any one migration file.
import { readFileSync } from "node:fs";

const SCHEMA = "services/gateway/migrations/001_init.sql";
const sql = readFileSync(SCHEMA, "utf8");
const fail: string[] = [];

/** One table's column definitions, from `create table <name> (` to the closing paren.
 *
 *  Anchored on the table rather than grepped file-wide: `duration_ms` is a column of both
 *  zz.event and zz.model_call, and the nullability asserted below differs by table. */
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

// Control: `batched` should be not-null, so a check that rejects every not-null is too broad.
if (!/^boolean\b[^\n]*not null/i.test(column("zz.event", "batched"))) {
  fail.push("batched must be NOT NULL — whether a call was batched always has an answer");
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("record and cost columns: ok");
