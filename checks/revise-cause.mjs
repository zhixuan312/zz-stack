// A revision names why, one way or the other, and never both.
import { readFileSync } from "node:fs";
const fail = [];
const acts = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");
const block = acts.split('"document_revise"')[1]?.slice(0, 6000) ?? "";
if (!block) fail.push("document_revise is not registered");

if (!/self_edit/.test(block)) fail.push("self_edit was removed; a wording fix would have to invent a source");
// Both-supplied stays refused.
if (!/both/i.test(block)) fail.push("supplying both a source and a self_edit is no longer refused");
// Neither-supplied becomes refused. Look for the refusal, not merely the words.
if (!/neither|no cause|without a cause/i.test(block)) {
  fail.push("a revision with no cause is still accepted");
}
// Control: the stale description must be gone.
if (/not required|may simply edit/i.test(block)) {
  fail.push('the description still says a cause "is not required"');
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("revise cause: ok");
