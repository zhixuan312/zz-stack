#!/usr/bin/env node
// DISCOVER on zz-core (initiative 2026-09-26-eval-zz-core) split one refusal family into three
// candidates by the document each refusal named, and answered owner_kind unknown because Jev's
// distribution summed to 0.99. Both against what production recorded:
//   1. the four real refusals (events 19321, 19385, 19405, 19451), normalised the way
//      NORMALIZED_REFUSAL_SQL does, fold into two groups — the three "cite the source added
//      after the version you are replacing" refusals are one rule, whatever document and however
//      many sources they named; the document_patch refusal stays its own;
//   2. a category reply whose native distribution sums to 0.99 over six keys (two-decimal
//      rounding) is answered, and one summing to 0.9 is still refused.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { foldByRule, refusalRule, refusalKey, returnKey } = await load("services/zz-core/dist/eval/discover-groups.js");
const { interpret } = await load("packages/contracts/dist/assessment.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const norm = (s: string) => s.toLowerCase().replace(/[0-9]+/g, "#");
const REVISE = "core:document_revise";
const group = (tool: string, text: string, id: string) => ({
  kind: "refusal", tool, normalized_text: norm(text), owner: "guardrail", count: 1,
  sample_event_ids: [id], sample_raw_texts: [text],
});
const groups = [
  group(REVISE, "ERROR: sources/<initiative>.md supports spec.md and was added after the version you are replacing, so it is what this revision answers. Cite it: `…`. A version that does not name what changed it cannot be checked by anybody later.", "19321"),
  group(REVISE, "ERROR: sources/<initiative>.md supports plan.md and was added after the version you are replacing, so it is what this revision answers. Cite it: `…`. A version that does not name what changed it cannot be checked by anybody later.", "19385"),
  group(REVISE, "ERROR: sources/<initiative>.md, sources/<initiative>.md support spec.md and were added after the version you are replacing, so they are what this revision answers. Cite them: `…`. A version that does not name what changed it cannot be checked by anybody later.", "19451"),
  group("core:document_patch", "ERROR: `…` occurs <n> times, need exactly <n>", "19405"),
];
const folded = foldByRule(groups);
is(folded.length === 2, `four refusals of two rules folded into ${folded.length} group(s): ${JSON.stringify(folded.map((g: { normalized_text: string }) => g.normalized_text))}`);
const revise = folded.find((g: { tool: string }) => g.tool === REVISE);
is(revise?.count === 3 && revise.sample_event_ids.length === 3,
   `the three cite-the-source refusals are not one group of 3: ${JSON.stringify(revise)}`);
is(!/spec\.md|plan\.md|sources\//.test(revise?.normalized_text ?? ""),
   `the folded rule still names a file: ${revise?.normalized_text}`);
is(/after the version you are replacing, so it is what/.test(revise?.normalized_text ?? ""),
   `the folded group's text is not the refusal's own words with its files folded: ${revise?.normalized_text}`);
is(refusalRule(norm("ERROR: `…` occurs <n> times, need exactly <n>")) === norm("ERROR: `…` occurs <n> times, need exactly <n>"),
   "a refusal that names no file is changed by folding");
is(folded[0].tool === REVISE, "folded groups are not most-frequent-first");

const KEYS = ["plugin", "dependency", "platform", "environment", "user_input", "unknown"];
const question = { question_id: "discover.owner_kind", answer_spec: { kind: "category", options: KEYS.map((key) => ({ key, meaning: "" })) } };
const reply = (dist: number[]) => ({ category: "platform",
  native: { distribution: Object.fromEntries(KEYS.map((k, i) => [k, dist[i]])) } });
const rounded = interpret(question, reply([0.05, 0.02, 0.86, 0.02, 0.02, 0.02]));
is(rounded.status === "answered", `a two-decimal-rounded distribution summing to 0.99 is ${rounded.status}: ${rounded.failure_reason}`);
const wrong = interpret(question, reply([0.05, 0.02, 0.77, 0.02, 0.02, 0.02]));
is(wrong.status === "invalid_response", `a distribution summing to 0.9 is ${wrong.status}, not refused`);

// A failure mode keeps its identity across snapshots: the same rule found in another window, in
// another order, is the same key, so DISCOVER records it as merged rather than new.
const again = foldByRule([...groups].reverse()).find((g: { tool: string }) => g.tool === REVISE);
is(revise && again && refusalKey(revise) === refusalKey(again),
   `the same refusal rule found in another order has another key: ${revise && refusalKey(revise)} vs ${again && refusalKey(again)}`);
const patch = folded.find((g: { tool: string }) => g.tool === "core:document_patch");
is(patch && revise && refusalKey(patch) !== refusalKey(revise), "two rules share one key");
is(returnKey({ from_step: "sdlc-plan", back_to_step: "sdlc-spec" }) === "return:sdlc-plan->sdlc-spec", "a return's key names its two stages");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-discover-rules");
