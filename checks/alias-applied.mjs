// A window spanning a rename must read as one series per tool.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOOL_ALIAS, MANAGE_ALIAS, EVAL_ALIAS, SKILL_ALIAS } from "../packages/contracts/dist/index.js";

const fail = [];

// 1. The resolver folds an old name onto its new one.
const { resolveToolKey, resolveStep } = await import("../packages/tools/dist/testing/tool-report.js");
if (resolveToolKey("core:write_file") !== resolveToolKey("core:document_write")) {
  fail.push("write_file and document_write resolve to different series");
}
if (resolveToolKey("manage:add_person") !== resolveToolKey("manage:person_add")) {
  fail.push("add_person and person_add resolve to different series");
}
if (resolveStep("zz-backbone") !== resolveStep("zz-platform")) {
  fail.push("zz-backbone and zz-platform resolve to different steps");
}
// Control: two genuinely different tools must NOT fold together.
if (resolveToolKey("core:document_read") === resolveToolKey("core:document_write")) {
  fail.push("distinct tools collapsed into one series");
}
// A deleted tool keeps its own series rather than merging into a survivor.
if (resolveToolKey("manage:issue_my_access_token") === resolveToolKey("manage:pat_issue")) {
  fail.push("a deleted tool was merged into a surviving one");
}

// 2. No per-tool grouper reads `subject` raw. Any file that groups by subject must import
//    the resolver — this is the check that catches a SECOND grouper added later.
const dir = "packages/tools/src/testing";
for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
  const src = readFileSync(join(dir, f), "utf8");
  const groups = /perTool|byTool|group.*subject|subject.*group/i.test(src);
  if (groups && !/resolveToolKey/.test(src)) {
    fail.push(`${f} groups by tool without resolving through the alias`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("alias applied: ok");
