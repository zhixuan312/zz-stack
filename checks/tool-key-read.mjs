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

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("tool_key read: ok");
