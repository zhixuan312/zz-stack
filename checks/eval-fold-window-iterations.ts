#!/usr/bin/env node
// Three pure rules of the evaluation door, each a defect the final read found:
//   1. one refusal rule of one tool is one group, whatever owner the platform attributed each of
//      its rows to — `refusalKey` is (tool, rule), and a group per owner wrote two sightings of one
//      failure-mode identity in one discovery. The group keeps the owner of its largest row,
//      whichever order the rows arrive in;
//   2. a snapshot stores the window it resolved, whatever form its two bounds are written in — the
//      bounds were compared as strings, so `2026-10-01T09:00:00+08:00` against
//      `2026-10-01 02:00:00Z` stored a real window as none. Only the no-run sentinel stores NULL;
//   3. `UncertaintyPolicy.iterations` is clamped to `MAX_BOOTSTRAP_ITERATIONS` — a protocol
//      naming 1e8 held the shared zz-core process, and `Infinity` never returned.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { foldByRule, refusalKey } = await load("services/zz-core/dist/eval/discover-groups.js");
const { storedWindow } = await load("services/zz-core/dist/eval/observe.js");
const { MAX_BOOTSTRAP_ITERATIONS, resolveUncertainty } = await load("services/zz-core/dist/eval/evaluate-interval.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. One rule, two owners: one group, one key, the larger row's owner.
const TEXT = "error: cause_required — <file> is approved, so a change to its body opens a new version";
const row = (owner: string, count: number, id: string) => ({
  kind: "refusal", tool: "core:document_edit", normalized_text: TEXT, owner, count,
  sample_event_ids: [id], sample_raw_texts: [`${TEXT} (${owner})`],
});
for (const rows of [[row("unattributed", 2, "e1"), row("guardrail", 5, "e2")],
                    [row("guardrail", 5, "e2"), row("unattributed", 2, "e1")]]) {
  const folded = foldByRule(rows);
  is(folded.length === 1, `one rule attributed to two owners folded into ${folded.length} group(s)`);
  is(folded[0]?.count === 7, `the folded group counts ${folded[0]?.count}, not the 7 refusals behind it`);
  is(folded[0]?.owner === "guardrail", `the folded group's owner is ${folded[0]?.owner}, not its largest row's`);
  is(new Set(folded.map(refusalKey)).size === folded.length, "two groups of one discovery share one key");
}

// 2. Real windows in mixed forms are stored; the sentinel alone is not.
const windows = [
  { from: "2026-10-01T09:00:00+08:00", to: "2026-10-01 02:00:00Z" },
  { from: "2026-10-01 00:00:00+00", to: "2026-10-01T12:00:00Z" },
  { from: "2026-09-30", to: "2026-10-01T00:00:00Z" },
];
for (const w of windows) {
  const stored = storedWindow(w);
  is(stored.from === w.from && stored.to === w.to,
     `the window ${w.from} to ${w.to} was stored as ${JSON.stringify(stored)}`);
}
const none = storedWindow({ from: "infinity", to: "-infinity" });
is(none.from === null && none.to === null, `the no-run sentinel was stored as ${JSON.stringify(none)}`);

// 3. The bootstrap is bounded, and an unusable count still defaults.
is(MAX_BOOTSTRAP_ITERATIONS > 1000, `MAX_BOOTSTRAP_ITERATIONS ${MAX_BOOTSTRAP_ITERATIONS} is below the default`);
for (const asked of [1e8, Infinity]) {
  const got = resolveUncertainty({ iterations: asked }, "run").iterations;
  is(got === MAX_BOOTSTRAP_ITERATIONS, `iterations ${asked} resolved to ${got}, not ${MAX_BOOTSTRAP_ITERATIONS}`);
}
is(resolveUncertainty({ iterations: 2500 }, "run").iterations === 2500, "iterations within the bound were changed");
for (const asked of [0, -5, Number.NaN, "1000"]) {
  const got = resolveUncertainty({ iterations: asked }, "run").iterations;
  is(got === 1000, `iterations ${String(asked)} resolved to ${got}, not the default 1000`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok eval-fold-window-iterations");
