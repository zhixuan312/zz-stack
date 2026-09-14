// 30 tools, 16 for a member, three duplicates gone, one exception kept.
import { readFileSync } from "node:fs";
import { MANAGE_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];
const files = ["services/gateway/src/access-door.ts", "services/gateway/src/admin.ts",
               "services/gateway/src/admin/flows.ts"];
const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
const names = [...all.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);

if (names.length !== 31) fail.push(`/manage registers ${names.length} tools, expected 31`);
for (const gone of ["issue_my_access_token", "my_access_tokens", "revoke_my_access_token"]) {
  if (names.includes(gone)) fail.push(`${gone} is a duplicate and must be deleted`);
}
for (const old of Object.keys(MANAGE_ALIAS)) {
  if (names.includes(old)) fail.push(`${old} was not renamed`);
}
const NOUNS = ["person", "team", "member", "pat", "flow", "install", "tool",
               "enrolment", "block", "platform", "credential", "client", "catalog", "knowledge"];
for (const n of names) {
  if (n === "whoami") continue;                       // the one exception, deliberately kept
  if (!NOUNS.some((x) => n.startsWith(`${x}_`))) fail.push(`${n} does not start with a noun`);
}
// Control: whoami must still be here. A convention sweep that renamed it broke the exception.
if (!names.includes("whoami")) fail.push("whoami was renamed; it is the shape's one exception");
// AC-2.13: every description on this door says when / returns / refuses.
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"[\s\S]{0,80}?description:\s*([\s\S]{0,1200}?)(inputSchema|\}\s*,)/g)) {
    const [, tool, desc] = m;
    if (!/when\b/i.test(desc)) fail.push(`${tool}'s description does not say WHEN it is called`);
    if (!/return|comes back|answers/i.test(desc)) fail.push(`${tool}'s description does not say what it RETURNS`);
    if (!/refus|reject|never|cannot/i.test(desc)) fail.push(`${tool}'s description does not say what it REFUSES`);
  }
}
// The stale count comment is gone rather than corrected.
if (/twenty tools|thirty-four/i.test(readFileSync(files[0], "utf8"))) {
  fail.push("access-door.ts still states a hand-maintained tool count");
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("manage surface: ok");
