// Seven rename, three do not, and the skills follow.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];

const registered = new Set<string>();
for (const f of ["plugin-eval", "plugin-judge", "plugin-record"]) {
  const src = readFileSync(`services/zz-core/src/eval/${f}.ts`, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
}
for (const want of ["ruler_read", "ruler_record", "ruler_affirm", "round_judge",
                    "round_scores", "case_record", "finding_record"]) {
  if (!registered.has(want)) fail.push(`${want} is not registered`);
}
// Control: the three correct names must be UNCHANGED. A sweep that renamed everything fails here.
for (const keep of ["plugin_locate", "plugin_profile", "plugin_conform"]) {
  if (!registered.has(keep)) fail.push(`${keep} was renamed; it was already correct`);
}
for (const old of Object.keys(EVAL_ALIAS)) {
  if (registered.has(old)) fail.push(`${old} is still registered`);
}
// THE SET, NOT THE SIZE. This asserted a count of 10, which fails identically whether a tool
// was lost or one was added — and says neither. Naming the set fails on both and tells you
// which: a missing name is a tool that vanished, an unexpected one is a tool nobody wrote into
// the door's own description.
const EXPECTED = new Set([
  "plugin_locate", "plugin_profile", "plugin_conform",
  "ruler_read", "ruler_record", "ruler_affirm",
  "round_judge", "round_scores", "round_recommend",
  "case_record", "finding_record",
]);
for (const want of EXPECTED) {
  if (!registered.has(want)) fail.push(`${want} is no longer registered on the eval door`);
}
for (const got of registered) {
  if (!EXPECTED.has(got)) {
    fail.push(`${got} is registered on the eval door and this check does not expect it — add ` +
              "it here and to the door's own description, or it is a tool nobody announced");
  }
}

// AC-2.13: every description on this door says when / returns / refuses.
//
// THE WINDOW IS A SILENT SKIP WAITING TO HAPPEN, and the count below is what stops it being
// one. A description longer than the `{0,N}` span between `description:` and `inputSchema`
// does not fail this loop — it never enters it, and the check reports nothing at all about
// the tool whose prose is longest, which is the one most likely to have gone wrong.
// `round_judge` sat at 1092 characters against the plan's 1200. So the span is wide, and the
// number of descriptions read is compared with the number of registrations found.
const described = new Set();
for (const f of ["plugin-eval", "plugin-judge", "plugin-record"]) {
  const src = readFileSync(`services/zz-core/src/eval/${f}.ts`, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"[\s\S]{0,80}?description:\s*([\s\S]{0,4000}?)inputSchema/g)) {
    const [, tool, desc] = m;
    described.add(tool);
    if (!/when\b/i.test(desc)) fail.push(`${tool}'s description does not say WHEN it is called`);
    if (!/return|comes back|answers/i.test(desc)) fail.push(`${tool}'s description does not say what it RETURNS`);
    if (!/refus|reject|never|cannot/i.test(desc)) fail.push(`${tool}'s description does not say what it REFUSES`);
  }
}
for (const t of registered) {
  if (!described.has(t)) {
    fail.push(`${t} is registered and this check read no description for it — the window between ` +
              `\`description:\` and \`inputSchema\` did not reach the end of its prose, so every ` +
              `clause above was silently skipped for it`);
  }
}

// Every skill that plugin ships names the new tools and none of the old ones.
const skillsDir = "catalog/zz/zz-plugin-eval/skills";
for (const s of readdirSync(skillsDir)) {
  const body = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  for (const old of Object.keys(EVAL_ALIAS)) {
    if (new RegExp(`(^|[^a-z_])${old}([^a-z_]|$)`).test(body)) fail.push(`${s} still names ${old}`);
  }
}

// ── TWO CALLER CLASSES THE CLAUSES ABOVE CANNOT SEE ───────────────────────────────────────
//
// The registrations and the skills are both watched by the gate already. These two are not,
// and each fails only where nobody is looking:
//
//   - The eval suite's GRADERS. `case.yaml` matches a model's answer against a regex, and the
//     gate never runs evals — so a grader whose pattern names a tool that no longer exists is
//     a grader that matches nothing and passes nothing, and the first sign of it is a red
//     eval run somebody pays $0.40 a case for. All three of this flow's cases named old tools
//     in their patterns.
//   - `chain-check.ts`. It calls the door for real, and it runs at RELEASE against a live
//     deployment. A stale name there is a tool call that 404s in front of a deployment,
//     hours after the gate said the change was fine.
//
// Both are checked against `registered`, which was read off the source above rather than
// listed here — so a later rename moves them together or this goes red.

const isToolShaped = (t: string) => /^(plugin|ruler|round|case|finding)_[a-z0-9_]+$/.test(t);

// The graders. Every alternative in a `pattern:` that is SHAPED like one of this door's tool
// names must BE one — which catches the bare stem as well as the old name. `plugin_cases` was
// exactly that: not an EVAL_ALIAS key, so a sweep over the map's keys left it behind, and it
// had already stopped matching the tool it was a stem of.
const evalsDir = "catalog/zz/zz-plugin-eval/evals";
let patternsSeen = 0;
let namedARegisteredTool = 0;
for (const c of readdirSync(evalsDir)) {
  const rel = join(evalsDir, c, "case.yaml");
  const body = readFileSync(rel, "utf8");
  for (const old of Object.keys(EVAL_ALIAS)) {
    if (new RegExp(`(^|[^a-z_])${old}([^a-z_]|$)`).test(body)) fail.push(`${rel} still names ${old}`);
  }
  for (const m of body.matchAll(/^\s*pattern:\s*'([^']*)'/gm)) {
    patternsSeen += 1;
    for (const alt of m[1].split("|")) {
      const t = alt.replace(/\\/g, "").trim();
      if (!isToolShaped(t)) continue;
      if (registered.has(t)) namedARegisteredTool += 1;
      else fail.push(`${rel} greps for \`${t}\`, which this door registers no tool by — the grader matches nothing`);
    }
  }
}
// CONTROLS. Either number at zero means the scan above proved nothing: no cases found, or no
// grader names a tool at all, and every clause in the loop is vacuously satisfied.
if (patternsSeen === 0) fail.push(`no \`pattern:\` line was found under ${evalsDir} — the grader scan read nothing`);
if (namedARegisteredTool === 0) fail.push(`no grader under ${evalsDir} names a tool this door registers — the tool-name clause was never exercised`);

// The chain check. Its first argument IS the tool name sent over the wire.
//
// THE WALK, NOT ONE FILE. chain-check.ts is split by subject — chain-bugs, chain-shelf,
// chain-freeform, chain-eval — and the eval door's calls moved into chain-eval.ts when
// chain-check hit the 700-line ceiling. Reading the entry file alone then found no
// `callEval` at all and reported every eval tool as unexercised, which is this check
// failing because the code was tidied rather than because anything stopped being tested.
// Every chain-*.ts file is part of one walk, so the subject is the directory.
const CHAIN_DIR = "packages/tools/src/testing";
const CHAIN_FILES = readdirSync(CHAIN_DIR).filter((f) => /^chain-.*\.ts$/.test(f));
const CHAIN = `${CHAIN_DIR}/chain-*.ts`;
const called = new Set<string>();
for (const f of CHAIN_FILES) {
  for (const m of readFileSync(`${CHAIN_DIR}/${f}`, "utf8").matchAll(/callEval\(\s*"([a-z0-9_]+)"/g)) called.add(m[1]);
}
if (!CHAIN_FILES.length) fail.push(`${CHAIN_DIR} holds no chain-*.ts file — the release check is gone`);
if (!called.size) fail.push(`${CHAIN} makes no callEval("…") call this check can read — the release check's names are unverified`);
for (const t of called) {
  if (!registered.has(t)) fail.push(`${CHAIN} calls \`${t}\` on the evaluation door, which registers no such tool`);
}
for (const want of Object.values(EVAL_ALIAS)) {
  if (!called.has(want)) fail.push(`${CHAIN} never exercises \`${want}\`; the release check lost a renamed tool`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("eval names: ok");
