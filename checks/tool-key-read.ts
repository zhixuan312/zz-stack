// tool_key is a write-time snapshot of resolveToolKey(subject) — asserting the SELECT
// mentions it is not enough, because that was true and dormant: the column was fetched from
// the database and discarded, its own docstring describing a use that did not exist.
import { readFileSync } from "node:fs";

const fail = [];
const FILE = "packages/tools/src/testing/tool-report.ts";
const src = readFileSync(FILE, "utf8");

if (!/\btool_key\b/.test(src)) {
  fail.push(`${FILE} does not select tool_key`);
}

// tool_key must be the ARGUMENT resolveToolKey resolves — not read outright, and not read
// beside it. `e.tool_key ?? resolveToolKey(e.subject)` mentions tool_key and calls
// resolveToolKey right next to it, which passes any check that only asks "does this file
// mention both" — and it is wrong: tool_key is a snapshot made at write time, so a tool
// renamed AGAIN after that row was written leaves the OLD-OF-TWO name sitting in `tool_key`
// forever, un-resolved, splitting the exact series this file exists to keep whole. Resolving
// the snapshot again is idempotent when nothing further changed and folds forward when it
// did, so `tool_key` has to be inside resolveToolKey's own parentheses.
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

// AND EVERY OTHER PLACE THAT ASKS "WHICH TOOL WAS THIS".
//
// The rule above was pinned to one file while three surfaces grouped tool calls by the raw
// `subject`, and each one reported a rename as two unrelated tools. The worst of them was
// plugin_profile's `never_called`: it is built by subtracting the called set from the
// reachable set, so an un-resolved name made the list say a tool in daily use had never been
// called — and "a tool its skills name that was never called" is one of the two questions the
// evaluation flow exists to answer. A ruler written from that list recommends deleting a tool
// somebody is using.
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
  // SQL ONLY, AND COMMENTS STRIPPED. Two things would otherwise be read as defects and are
  // not: the prose beside each query, which explains why the raw column is the wrong one, and
  // `e.subject` on a JAVASCRIPT row object — `rows.map((e) => e.subject)` reads a field named
  // by the SELECT's own alias and has nothing to do with the column. The subject of this rule
  // is the statement, so only template literals are read, with their comments removed.
  // A template literal is SQL when it reads like SQL. Every other backtick string in these
  // files is output — `${e.at}  ${e.subject}` builds the transcript line a judge reads, from a
  // row object whose field is named by the SELECT's own alias, and calling that a defect would
  // make the rule unsatisfiable.
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
