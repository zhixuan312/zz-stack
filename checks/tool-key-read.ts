// tool_key is a write-time snapshot of resolveToolKey(subject). Asserting the SELECT mentions
// it is not enough: a column can be fetched and discarded.
import { readFileSync } from "node:fs";

const fail = [];
const FILE = "packages/tools/src/testing/tool-report.ts";
const src = readFileSync(FILE, "utf8");

if (!/\btool_key\b/.test(src)) {
  fail.push(`${FILE} does not select tool_key`);
}

// tool_key must be the argument resolveToolKey resolves, not read outright and not read
// beside it. `e.tool_key ?? resolveToolKey(e.subject)` names both and is wrong: tool_key is a
// snapshot made at write time, so a tool renamed again after that row was written leaves the
// older of the two names sitting in `tool_key` un-resolved, splitting the series. Resolving the
// snapshot again is idempotent when nothing further changed and folds forward when it did, so
// `tool_key` has to be inside resolveToolKey's own parentheses.
const flat = src.replace(/\s+/g, " ");
const call = /resolveToolKey\(([^)]*)\)/.exec(flat);
if (!call) {
  fail.push(`${FILE} calls resolveToolKey nowhere — nothing groups by the resolved key`);
} else if (!/tool_key/.test(call[1])) {
  fail.push(
    `${FILE} selects tool_key but never reads it — resolveToolKey(...) is not given tool_key, ` +
    "so a written column is fetched and discarded",
  );
}

// And every other place that asks which tool a call was. Grouping by the raw `subject` reports
// a rename as two unrelated tools; in plugin_profile's `never_called`, built by subtracting the
// called set from the reachable set, an un-resolved name makes the list claim a tool in daily
// use has never been called.
//
// SQL cannot call resolveToolKey, so the rule for a query is narrower and mechanical: where a
// statement groups or counts tool calls, the expression must be `coalesce(<alias>.tool_key,
// <alias>.subject)` and never the bare column.
const SQL_READERS = [
  "services/zz-core/src/eval/plugin-profile.ts",
  "services/zz-core/src/eval/judge.ts",
  "services/gateway/src/console/overview.ts",
  "services/gateway/src/console/overview-metrics.ts",
  "services/gateway/src/console/skills.ts",
];
for (const f of SQL_READERS) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { fail.push(`${f} is gone — this check reads nothing`); continue; }
  // SQL only, and comments stripped. Two things would otherwise read as defects: the prose
  // beside each query, which explains why the raw column is the wrong one, and `e.subject` on a
  // JavaScript row object, which reads a field named by the SELECT's own alias and has nothing
  // to do with the column. A template literal is SQL when it reads like SQL; every other
  // backtick string in these files is output.
  const sql = [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1])
    .filter((lit) => /\b(select|insert into|update|delete from)\b/i.test(lit))
    .join("\n").replace(/^\s*--.*$/gm, " ");
  const bare = [...sql.matchAll(/\b[a-z]{1,3}\.subject\b/g)].filter((m) => {
    const before = sql.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    return !/coalesce\(\s*[a-z]{1,3}\.tool_key\s*,\s*$/.test(before);
  });
  if (bare.length) {
    fail.push(`${f} reads ${bare.length} bare <alias>.subject in SQL — group tool calls by ` +
              "coalesce(<alias>.tool_key, <alias>.subject), or a renamed tool is two series");
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("tool_key read: ok");
