// The migration declares what the record needs, with nullability that tells a gap from a zero.
import { readFileSync } from "node:fs";
const sql = readFileSync("services/gateway/migrations/050_record_and_cost.sql", "utf8").toLowerCase();
const fail = [];

for (const col of ["duration_ms", "request_bytes", "response_bytes", "batched",
                   "plugin", "plugin_version", "tool_key"]) {
  if (!new RegExp(`add column if not exists\\s+${col}\\b`).test(sql)) {
    fail.push(`zz.event is missing an idempotent add for ${col}`);
  }
}
if (!/create table if not exists zz\.model_call/.test(sql)) fail.push("zz.model_call is not created");
for (const col of ["input_tokens", "output_tokens", "cache_read_tokens", "duration_ms"]) {
  if (!new RegExp(`${col}\\s+integer`).test(sql)) fail.push(`zz.model_call lacks ${col}`);
  // Scoped to ONE column definition. `[^,);]*` excludes the statement terminator as well as
  // the comma and paren: without the `;` an `alter table … duration_ms integer;` would let the
  // scan run into the NEXT statement and report a nullable column as NOT NULL, failing a
  // correct migration written in a different but equally valid style. A check that only passes
  // one spelling of a correct answer is a check that constrains style, not correctness.
  if (new RegExp(`${col}\\s+integer[^,);]*not null`).test(sql)) {
    fail.push(`${col} is NOT NULL — a gap would read as a measured zero`);
  }
  if (new RegExp(`${col}\\s+integer[^,);]*default\\s+0`).test(sql)) {
    fail.push(`${col} defaults to 0 — a gap would read as a measured zero`);
  }
}
// Control: `batched` SHOULD be not-null, so a check that rejects every not-null is too broad.
if (!/batched\s+boolean\s+not null/.test(sql)) {
  fail.push("batched must be NOT NULL — whether a call was batched always has an answer");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("migration 050: ok");
