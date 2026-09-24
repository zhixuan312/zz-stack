// The evaluation door's renames: the renamed tools are registered, the rest keep their names,
// and the skills follow.
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
                    "round_scores", "finding_record"]) {
  if (!registered.has(want)) fail.push(`${want} is not registered`);
}
// Control: the three correct names must be unchanged. A sweep that renamed everything fails here.
for (const keep of ["plugin_locate", "plugin_profile", "plugin_conform"]) {
  if (!registered.has(keep)) fail.push(`${keep} was renamed; it was already correct`);
}
for (const old of Object.keys(EVAL_ALIAS)) {
  if (registered.has(old)) fail.push(`${old} is still registered`);
}
// The set, not the size. A count fails identically whether a tool was lost or one was added, and
// says neither. A missing name is a tool that vanished; an unexpected one is a tool nobody wrote
// into the door's own description.
const EXPECTED = new Set([
  "plugin_locate", "plugin_profile", "plugin_conform",
  "ruler_read", "ruler_record", "ruler_affirm",
  "round_judge", "round_scores", "round_score",
  "finding_record", "finding_decide",
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

// Every description on this door says when / returns / refuses.
//
// The window is a silent skip waiting to happen, and the count below is what stops it being one.
// A description longer than the `{0,N}` span between `description:` and `inputSchema` never
// enters the loop, so the check reports nothing about the tool whose prose is longest — the one
// most likely to have gone wrong. So the span is wide, and the number of descriptions read is
// compared with the number of registrations found.
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

// A caller the clauses above cannot see: `chain-check.ts` calls the door for real, at release,
// against a live deployment, so a stale name there is a tool call that 404s in front of a
// deployment.
//
// COUPLED: checked against `registered`, read off the source above rather than listed here, so
// a later rename moves both together or this goes red.

// The chain check. Its first argument is the tool name sent over the wire.
//
// The walk, not one file. chain-check.ts is split by subject — chain-bugs, chain-shelf,
// chain-freeform, chain-eval — so reading the entry file alone finds no `callEval` and reports
// every eval tool as unexercised. Every chain-*.ts file is part of one walk, so the subject is
// the directory.
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
