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

const fail = [];
const SELF = "checks/eval-cost.mjs";

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
const withCost = () => ({
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
const noCost = () => {
  const p = withCost();
  delete p.costUsd;
  for (const c of p.cases) for (const runs of Object.values(c.arms)) {
    for (const r of runs) { delete r.costUsd; delete r.judgeCostUsd; }
  }
  return p;
};
const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;

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
const strip = (p, src) => {
  if (p.endsWith(".json")) return src;                          // JSON has no comment syntax
  if (/\.ya?ml$/.test(p)) return src.replace(/(^|\s)#.*$/gm, "$1");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
};

// ── A COSTED PAYLOAD CAN ACTUALLY BE STORED ───────────────────────────────────────────────
//
// The parser above is unreachable for the run it was written for unless the recording door
// admits it. `plugin_cases_record` is the only writer of zz.plugin_case_run, and it refused on
// `!read.count`: no readable delta, no row, and the $4.27 the suite spent thrown away at the
// door that 047 keeps the payload whole to protect.
//
// The rule itself is run, not read — `worthRecording` is pure and exported for exactly that.
const asRead = (o) => ({ count: 0, cost_usd: null, judge_cost_usd: null, ...o });
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
  fail.push("plugin_cases_record does not decide with worthRecording");
}
if (/if\s*\(\s*!\s*read\.count\s*\)/.test(door)) {
  fail.push("plugin_cases_record still refuses on !read.count, which discards a costed payload");
}
// What it just cost comes back to the caller, on the path where no case parsed as well as the
// one where some did — that is the moment the person has spent the money.
//
// THE ASSERTION IS SCOPED TO THE RETURNED OBJECT, not to the file. `door.includes("cost_usd")`
// was the first spelling of this and it stayed green while `...spend` was deleted from the
// response, because the sentence built for the note mentions `read.cost_usd` too. A whole-file
// grep cannot tell a value that is returned from one that is merely computed.
// Scoped to the tool by its guard, not by position: plugin_cases_record is one of several
// tools in that file and every one of them ends in a `return json(`.
const returned = (src) => {
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
if (!answer) fail.push("plugin_cases_record no longer answers with a json object");
for (const f of ["cost_usd", "judge_cost_usd"]) {
  if (!answer.includes(f)) fail.push(`plugin_cases_record does not return ${f}`);
}
if (!/note\s*:/.test(answer)) {
  fail.push("plugin_cases_record answers a stored-but-unreadable run with bare counts");
}

// ── NO SPEND CEILING ANYWHERE THE PLATFORM CONTROLS (FR-8a) ───────────────────────────────
//
// Walk the trees rather than guess a file: the flag could be added by any caller of the CLI.
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "coverage"]);
const walk = (d) => readdirSync(d).flatMap((f) => {
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
      .findIndex((l) => /max-cost-usd|maxCostUsd/.test(l));
    if (line >= 0) fail.push(`${p}:${line + 1} sets a spend ceiling; FR-8a forbids one`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval cost: ok");
