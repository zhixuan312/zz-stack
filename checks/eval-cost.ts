// Cost is parsed from what is already stored, and nothing anywhere caps spend.
//
// THE FIRST HALF IS BEHAVIOURAL, not a spelling test. The stub this replaces asserted the
// no-skip rule with /costUsd[^;\n]*continue/, which any two-line spelling of the same bug
// walks straight past:  const cost = num(r, "costUsd");  \n  if (cost === null) continue;
// So this imports the compiled parser and runs it over two payloads — one with cost, one with
// every cost field deleted — and asserts the case count is the same either way. A regex
// cannot tell "reads the field" from "requires the field"; running it can.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];
const SELF = "checks/eval-cost.ts";

interface Arm {
  score: number; costUsd?: number; judgeCostUsd?: number; turns?: number; error?: string;
}
interface CaseEntry {
  name: string; runsPerCase: number;
  aggregates: { score: number; scoreWithout?: number; delta?: number; passRate?: number };
  arms: Record<string, Arm[]>;
}
interface Payload {
  costUsd?: number; partial: boolean; partialReason?: string; cases: CaseEntry[];
}

const PARSER = "services/zz-core/dist/eval/plugin-cases.js";
if (!existsSync(PARSER)) {
  console.error(`${PARSER} does not exist — this check runs the parser rather than reading it`);
  process.exit(1);
}
const { parseCaseRun, worthRecording } = await import(`../${PARSER}`);

// The payload's real shape, cut down to one case. Inlined rather than read from
// evals/results/, which is one person's run output and not a fixture anything may depend on.
// `judgeCostUsd` sits OUTSIDE the top-level `costUsd`: on the frozen 2.1.269 run the per-run
// costUsd sum to the top-level 4.266979 exactly, and grading added 0.059725 beyond it.
const withCost = (): Payload => ({
  costUsd: 0.5, partial: false,
  cases: [{
    name: "a-case", runsPerCase: 2,
    aggregates: { score: 1, scoreWithout: 0, delta: 1 },
    arms: {
      with: [{ score: 1, costUsd: 0.3, judgeCostUsd: 0.02 }],
      without: [{ score: 0, costUsd: 0.2, judgeCostUsd: 0.01 }],
    },
  }],
});
// The same run recorded before the CLI printed any cost at all.
const noCost = (): Payload => {
  const p = withCost();
  delete p.costUsd;
  for (const c of p.cases) for (const runs of Object.values(c.arms)) {
    for (const r of runs) { delete r.costUsd; delete r.judgeCostUsd; }
  }
  return p;
};
const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;

const paid = parseCaseRun(withCost(), "2026-09-13T11:02:43Z", "d");
const free = parseCaseRun(noCost(), "2026-09-13T11:02:43Z", "d");

// AC-2.4: the figures the payload carries are readable without re-running the case.
if (!near(paid.cost_usd, 0.5)) fail.push(`run cost not read: ${paid.cost_usd}`);
if (!near(paid.judge_cost_usd, 0.03)) fail.push(`judge cost not read: ${paid.judge_cost_usd}`);
if (!near(paid.cases[0]?.cost_usd, 0.5)) fail.push(`per-case cost not read: ${paid.cases[0]?.cost_usd}`);
if (!near(paid.cases[0]?.judge_cost_usd, 0.03)) {
  fail.push(`per-case judge cost not read: ${paid.cases[0]?.judge_cost_usd}`);
}

// A MISSING COST DOES NOT SKIP A CASE, the way a missing delta does. Same payload, same count.
if (free.count !== paid.count) {
  fail.push(`a case is skipped for want of a cost: ${free.count} of ${paid.count} survive`);
}
// And it is reported as unavailable rather than zero. `+null` is 0 in JavaScript, and a 0 here
// would read as "this run was instant and free" for a run nobody measured.
for (const [where, v] of [["run", free.cost_usd], ["judge", free.judge_cost_usd],
                          ["case", free.cases[0]?.cost_usd]]) {
  if (v !== null) fail.push(`a missing ${where} cost reported as ${JSON.stringify(v)}, not null`);
}
// A REAL ZERO SURVIVES AS ZERO. Six runs of the frozen suite timed out having cost exactly
// 0.000000; if absence and zero collapsed in either direction this is the half that catches it.
const zeroed = withCost();
for (const c of zeroed.cases) for (const runs of Object.values(c.arms)) {
  for (const r of runs) { r.costUsd = 0; r.judgeCostUsd = 0; }
}
delete zeroed.costUsd;
const measuredZero = parseCaseRun(zeroed, "2026-09-13T11:02:43Z", "d");
if (measuredZero.cost_usd !== 0) {
  fail.push(`a measured zero cost became ${JSON.stringify(measuredZero.cost_usd)}`);
}

// ── EVERY RUN FACT SURVIVES AN UNREADABLE PAYLOAD, NOT JUST THE COST ──────────────────────
//
// The cost was carried past the delta skip first, and the argument for carrying it applies
// word for word to the other three facts about the run: what it cost to grade, how many of
// its runs died, and whether the CLI itself says the suite finished. The frozen 2.1.269 run
// is the payload that proves it — one arm, so no delta, so no readable case, so it returned
// through the empty path, which hardcoded `errored_runs: 0` and `partial: false`. Nine runs
// timed out and three were interrupted, the CLI set `partial: true, partialReason:
// "interrupted"`, and the platform reported a clean, complete suite that cost $4.27.
//
// So the fixture below is that payload's shape: errors and a partial flag on a run no delta
// can be read from. A check that only fed the readable path would have stayed green through
// the entire defect, because the readable path always reported both correctly.
const unreadable = (): Payload => ({
  costUsd: 0.5, partial: true, partialReason: "interrupted",
  cases: [{
    name: "a-case", runsPerCase: 3,
    aggregates: { score: 0, passRate: 0 },              // no scoreWithout, no delta
    arms: {
      with: [{ score: 0, costUsd: 0, judgeCostUsd: 0, turns: 0, error: "timed out after 300s" },
             { score: 0, costUsd: 0, judgeCostUsd: 0, turns: 0, error: "interrupted" },
             { score: 1, costUsd: 0.3, judgeCostUsd: 0.02 }],
    },
  }],
});
const dead = parseCaseRun(unreadable(), "2026-09-13T11:02:43Z", "d");
if (dead.count !== 0) {
  fail.push(`the fixture is meant to be unreadable and ${dead.count} cases parsed — ` +
            "it no longer exercises the path it was written for");
}
if (dead.errored_runs !== 2) {
  fail.push(`a run with no readable case reports errored_runs: ${dead.errored_runs}, not 2 — ` +
            "a suite that half fell over reads as a clean one");
}
if (dead.partial !== true) {
  fail.push("a run the CLI marked partial reports partial: false once its cases stop parsing");
}
if (!near(dead.cost_usd, 0.5)) fail.push(`the unreadable path lost the run cost: ${dead.cost_usd}`);
if (!near(dead.judge_cost_usd, 0.02)) {
  fail.push(`the unreadable path lost the judge cost: ${dead.judge_cost_usd}`);
}
// CONTROL: none of the four is hardcoded the other way. The same assertions on a clean,
// readable payload must report a clean, readable run — otherwise `errored_runs = 2` could be
// satisfied by a constant and `partial = true` by never reading the flag at all.
if (paid.errored_runs !== 0) fail.push(`a clean run reports errored_runs: ${paid.errored_runs}`);
if (paid.partial !== false) fail.push("a run the CLI did not mark partial reports partial: true");
// And the error count is per RUN, not per case: the readable path counts them too, or a
// suite whose deltas happen to parse hides its dead runs instead.
const halfDead = withCost();
halfDead.cases[0].arms.with[0].error = "timed out after 300s";
const scored = parseCaseRun(halfDead, "2026-09-13T11:02:43Z", "d");
if (scored.count !== 1 || scored.errored_runs !== 1) {
  fail.push(`a scored case with one dead run reports ${scored.errored_runs} errors over ` +
            `${scored.count} cases, not 1 over 1`);
}

// The raw payload keeps being stored whole — parsing more of it changes nothing there.
const sql = readFileSync("services/gateway/migrations/047_plugin_eval.sql", "utf8");
if (!/result\s+jsonb\s+not\s+null/.test(sql)) {
  fail.push("047 no longer stores the run payload whole");
}

// PROSE IS EXCLUDED BY WHAT IT IS, NOT BY WHERE IT LIVES. Extension alone was the stub's
// filter and it is not enough: this task writes comments explaining that the platform never
// caps spend, and a check that fired on the sentence describing the rule it enforces would be
// the third such false positive in this initiative. Comments are stripped before any match, so
// only executable text counts. `(^|[^:])` keeps `https://` from opening a hole where the rest
// of a line stops being read.
const strip = (p: string, src: string) => {
  if (p.endsWith(".json")) return src;                          // JSON has no comment syntax
  if (/\.ya?ml$/.test(p)) return src.replace(/(^|\s)#.*$/gm, "$1");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
};

// ── A COSTED PAYLOAD CAN ACTUALLY BE STORED ───────────────────────────────────────────────
//
// The parser above is unreachable for the run it was written for unless the recording door
// admits it. `case_record` is the only writer of zz.plugin_case_run, and it refused on
// `!read.count`: no readable delta, no row, and the $4.27 the suite spent thrown away at the
// door that 047 keeps the payload whole to protect.
//
// The rule itself is run, not read — `worthRecording` is pure and exported for exactly that.
const asRead = (o: Partial<{ count: number; cost_usd: number | null; judge_cost_usd: number | null }>) =>
  ({ count: 0, cost_usd: null, judge_cost_usd: null, ...o });
if (!worthRecording(asRead({ cost_usd: 4.266979 }))) {
  fail.push("a payload with a cost and no readable case is refused; its money is thrown away");
}
if (!worthRecording(asRead({ judge_cost_usd: 0.059725 }))) {
  fail.push("a payload with only a grading cost is refused");
}
if (!worthRecording(asRead({ count: 3 }))) fail.push("a payload with cases is refused");
// CONTROL: the guard is not simply off. Neither a case nor a cost is noise, not a measurement.
if (worthRecording(asRead({}))) {
  fail.push("a payload with neither a case nor a cost is stored; the refusal has been removed");
}

// And the door uses it. A rule that is correct and uncalled is the defect this closes.
const door = strip("x.ts", readFileSync("services/zz-core/src/eval/plugin-eval.ts", "utf8"));
if (!/worthRecording\s*\(/.test(door)) {
  fail.push("case_record does not decide with worthRecording");
}
if (/if\s*\(\s*!\s*read\.count\s*\)/.test(door)) {
  fail.push("case_record still refuses on !read.count, which discards a costed payload");
}
// What it just cost comes back to the caller, on the path where no case parsed as well as the
// one where some did — that is the moment the person has spent the money.
//
// THE ASSERTION IS SCOPED TO THE RETURNED OBJECT, not to the file. `door.includes("cost_usd")`
// was the first spelling of this and it stayed green while `...spend` was deleted from the
// response, because the sentence built for the note mentions `read.cost_usd` too. A whole-file
// grep cannot tell a value that is returned from one that is merely computed.
// Scoped to the tool by its guard, not by position: case_record is one of several
// tools in that file and every one of them ends in a `return json(`.
const returned = (src: string) => {
  const from = src.indexOf("worthRecording(read)");
  const at = from < 0 ? -1 : src.indexOf("return json(", from);
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + "return json".length; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")" && (depth -= 1) === 0) return src.slice(at, i + 1);
  }
  return "";
};
const answer = returned(door);
if (!answer) fail.push("case_record no longer answers with a json object");
// The money AND how much of the suite actually ran. `errored_runs` and `partial` are on this
// list for the same reason the costs are: the caller has just spent it, and this is the last
// moment re-running is cheap. Scoped to the returned object, not the file — the comment above
// the return names both fields, and a whole-file grep would pass on the comment alone.
for (const f of ["cost_usd", "judge_cost_usd", "errored_runs", "partial"]) {
  if (!answer.includes(f)) fail.push(`case_record does not return ${f}`);
}
if (!/warning\s*:/.test(answer)) {
  fail.push("case_record reports a half-dead suite without saying so");
}
if (!/note\s*:/.test(answer)) {
  fail.push("case_record answers a stored-but-unreadable run with bare counts");
}

// ── AND THE CONSOLE SAYS IT TOO, BESIDE THE DELTA IT SHOWS ────────────────────────────────
//
// Fixing the count in zz-core and stopping there would have left the wrong answer on the
// surface people actually read: the catalogue page runs its own SQL over the same payload and
// showed a mean delta with nothing next to it. A suite in which twelve of thirty-six runs died
// rendered exactly like a clean one.
const cat = strip("x.ts", readFileSync("services/gateway/src/console/catalog.ts", "utf8"));
const evalObj = (() => {
  const at = cat.indexOf("eval: rel?.ran_at");
  if (at < 0) return "";
  const open = cat.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < cat.length; i += 1) {
    if (cat[i] === "{") depth += 1;
    else if (cat[i] === "}" && (depth -= 1) === 0) return cat.slice(open, i + 1);
  }
  return "";
})();
if (!evalObj) {
  fail.push("the catalogue page no longer projects an `eval` object — this check reads nothing");
} else {
  for (const f of ["erroredRuns", "partial"]) {
    if (!evalObj.includes(f)) {
      fail.push(`the console shows a delta without ${f}; a suite that half fell over renders ` +
                "as a clean one");
    }
  }
  // The guard that must stay, on the one field of the four that can genuinely be SQL null:
  // avg over no matching row returns null with the run row right there, and `+null` is 0.
  if (!/meanDelta:\s*rel\.mean_delta\s*===\s*null/.test(evalObj)) {
    fail.push("meanDelta lost its null guard — an unmeasurable delta renders as a confident 0");
  }
}
// A LATERAL THAT COULD BE PLANNED INTO THROWING. jsonb_each on a non-object raises 22023, and
// `where jsonb_typeof(...) = 'object'` only saves the page for as long as the planner pushes
// that qual below the function expansion — which it does today and is nowhere obliged to do.
// One malformed row would take the whole catalogue page down. The CASE form cannot be planned
// into throwing, so every jsonb expansion in this file is required to carry one.
for (const m of cat.matchAll(/cross join lateral\s+(jsonb_each|jsonb_array_elements)\s*\(([^)]*)/g)) {
  if (!/case\s+when\s+jsonb_typeof/.test(m[2])) {
    fail.push(`console/catalog.ts expands ${m[1]} without an inline jsonb_typeof CASE guard — ` +
              "a malformed payload can be planned into a 22023 that takes the page down");
  }
}

// ── NO SPEND CEILING ANYWHERE THE PLATFORM CONTROLS (FR-8a) ───────────────────────────────
//
// Walk the trees rather than guess a file: the flag could be added by any caller of the CLI.
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "coverage"]);
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  if (SKIP_DIR.has(f)) return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// PROSE IS EXCLUDED BY WHAT IT IS, NOT BY WHERE IT LIVES. Extension alone was the stub's
// filter and it is not enough: this very task writes a .ts comment explaining that the
// platform never caps spend, and a check that fired on the sentence describing the rule it
// enforces would be the third such false positive in this initiative. Comments are stripped
// before the match, so only executable text counts. `(^|[^:])` keeps `https://` from opening
// a hole where the rest of a line stops being read.
// `checks` is walked too, so this file is inside its own scan and the exclusion below is a
// live rule rather than a decoration: the regex two lines down names the flag in executable
// text, and without the guard this check would report itself.
for (const dir of ["services", "packages", "scripts", "catalog", "skills", "checks"]) {
  for (const p of walk(dir)) {
    if (p === SELF) continue;      // this file names the flag in a regex, which is code
    if (!/\.(ts|mjs|js|json|ya?ml)$/.test(p)) continue;
    const line = strip(p, readFileSync(p, "utf8")).split("\n")
      .findIndex((l: string) => /max-cost-usd|maxCostUsd/.test(l));
    if (line >= 0) fail.push(`${p}:${line + 1} sets a spend ceiling; FR-8a forbids one`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval cost: ok");
