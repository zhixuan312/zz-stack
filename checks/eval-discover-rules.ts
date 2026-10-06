#!/usr/bin/env node
// DISCOVER on zz-core (initiative 2026-09-26-eval-zz-core) split one refusal family into three
// candidates by the document each refusal named, and answered owner_kind unknown because Jev's
// distribution summed to 0.99. Both, asserted on the folding and the reading DISCOVER runs:
//   1. four refusals of `document_edit`, normalised the way NORMALIZED_REFUSAL_SQL does, fold into
//      two groups — the three CAUSE_REQUIRED refusals are one rule, whatever initiative and
//      document they named; the MULTIPLE_MATCHES refusal stays its own. Production's own samples
//      (events 19321, 19385, 19405, 19451) were refusals of `document_revise` and `document_patch`,
//      which are no longer registered; the texts below are `document_edit`'s, in its own words, so
//      the fixture is a refusal the door can still give. The singular and plural of one rule —
//      what the number fold exists for — are kept as text: production's "supports … was added" and
//      "support … were added", which no registered tool still says, but which any rule worded both
//      ways is folded by;
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
const EDIT = "core:document_edit";
const group = (tool: string, text: string, id: string) => ({
  kind: "refusal", tool, normalized_text: norm(text), owner: "guardrail", count: 1,
  sample_event_ids: [id], sample_raw_texts: [text],
});
const CAUSE = (path: string) => `ERROR: CAUSE_REQUIRED — ${path} is approved, so a change to its body opens a new ` +
  "version and needs its cause: name an existing source in `sources` or pass the words as `source_content`";
const REPEATS = "ERROR: MULTIPLE_MATCHES — `find` occurs 2 times, on lines 3, 9 of the body. Send a longer `find` " +
  "that includes enough surrounding text to occur exactly once.";
const groups = [
  group(EDIT, CAUSE("2026-09-20-export/spec.md"), "e1"),
  group(EDIT, CAUSE("2026-09-20-export/plan.md"), "e2"),
  group(EDIT, CAUSE("2026-10-01-intake/spec.md"), "e3"),
  group(EDIT, REPEATS, "e4"),
];
const folded = foldByRule(groups);
is(folded.length === 2, `four refusals of two rules folded into ${folded.length} group(s): ${JSON.stringify(folded.map((g: { normalized_text: string }) => g.normalized_text))}`);
const cause = folded.find((g: { normalized_text: string }) => /cause_required/.test(g.normalized_text));
is(cause?.count === 3 && cause.sample_event_ids.length === 3,
   `the three CAUSE_REQUIRED refusals are not one group of 3: ${JSON.stringify(cause)}`);
is(!/spec\.md|plan\.md|export\/|intake\//.test(cause?.normalized_text ?? ""),
   `the folded rule still names a file: ${cause?.normalized_text}`);
is(/is approved, so a change to its body opens a new version/.test(cause?.normalized_text ?? ""),
   `the folded group's text is not the refusal's own words with its files folded: ${cause?.normalized_text}`);
is(refusalRule(norm(REPEATS)) === norm(REPEATS), "a refusal that names no file is changed by folding");
is(folded[0] === cause, "folded groups are not most-frequent-first");
// The number fold: one rule, said of one file and of two, is one rule.
const one = "ERROR: sources/a.md supports spec.md and was added after the version you are replacing, so it is what this revision answers.";
const two = "ERROR: sources/a.md, sources/b.md support spec.md and were added after the version you are replacing, so they are what this revision answers.";
is(refusalRule(norm(one)) === refusalRule(norm(two)),
   `the singular and the plural of one rule fold apart: ${refusalRule(norm(one))} vs ${refusalRule(norm(two))}`);

const KEYS = ["plugin", "dependency", "platform", "environment", "user_input", "unknown"];
const question = { question_id: "discover.owner_kind", answer_spec: { kind: "category", options: KEYS.map((key) => ({ key, meaning: "" })) } };
const reply = (dist: number[]) => ({ category: "platform",
  native: { distribution: Object.fromEntries(KEYS.map((k, i) => [k, dist[i]])) } });
const rounded = interpret(question, reply([0.05, 0.02, 0.86, 0.02, 0.02, 0.02]));
is(rounded.status === "answered", `a two-decimal-rounded distribution summing to 0.99 is ${rounded.status}: ${rounded.failure_reason}`);
const wrong = interpret(question, reply([0.05, 0.02, 0.77, 0.02, 0.02, 0.02]));
is(wrong.status === "invalid_response", `a distribution summing to 0.9 is ${wrong.status}, not refused`);

// A failure mode keeps its identity across snapshots: the same rule found in another window, in
// another order, is the same key, so DISCOVER resolves the same `(plugin_id, stable_key)`
// identity and writes a new sighting of it (Task I-24).
const again = foldByRule([...groups].reverse()).find((g: { normalized_text: string }) => /cause_required/.test(g.normalized_text));
is(cause && again && refusalKey(cause) === refusalKey(again),
   `the same refusal rule found in another order has another key: ${cause && refusalKey(cause)} vs ${again && refusalKey(again)}`);
const repeats = folded.find((g: { normalized_text: string }) => /multiple_matches/.test(g.normalized_text));
is(repeats && cause && refusalKey(repeats) !== refusalKey(cause), "two rules share one key");
is(returnKey({ from_step: "sdlc-plan", back_to_step: "sdlc-spec" }) === "return:sdlc-plan->sdlc-spec", "a return's key names its two stages");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-discover-rules");
