// The evaluation door's renames: the renamed tools are registered, the rest keep their names,
// and the skills follow.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_ALIAS } from "../packages/contracts/dist/index.js";
const fail = [];

// `subject.ts` holds `plugin_locate` — moved out of `plugin-eval.ts` when it became a mutator
// (FR-1/FR-59) and had to go through `registerSubjectTools`, its own registration module.
// `observe.ts` holds `plugin_profile` for the same reason (Task I-7): it too became a mutator,
// writing `zz.eval_observation_snapshot` through the FR-59 ledger, and moved out on its own.
// `discover.ts` holds `failure_discover` (Task I-9) — a mutator writing
// `zz.eval_failure_mode_candidate` through the FR-59 ledger, the same reason `subject.ts` and
// `observe.ts` above are their own registration modules rather than living inside plugin-eval.ts.
// `protocol.ts` (Task I-10) holds `protocol_read`/`protocol_record`/`protocol_affirm` for the
// same reason: each is a mutator (or, for `protocol_read`, reads live state no other module
// computes) writing `zz.eval_protocol_version` through the same ledger.
// `qualify.ts` (Task I-11) holds `evaluator_qualify` for the same reason again: a mutator writing
// `zz.eval_evaluator_qualification` through the same ledger.
// `evaluate.ts` (Task I-13) holds `evaluation_start`/`evaluation_assess`/`evaluation_score` for
// the same reason once more: three mutators writing `zz.eval_evidence_snapshot`/`zz.eval_run`/
// `zz.eval_assessment` through the same ledger.
// `replay-cases.ts` (Task I-14) holds `replay_case_set_build` for the same reason again: a
// mutator writing `zz.replay_case_set`/`zz.replay_case`/`zz.replay_event` through the same ledger.
// `replay-runs.ts` (Task I-16) holds `replay_start`/`replay_close` for the same reason once
// more — mutators writing `zz.replay_run` through the same ledger — with `replay_read` beside
// them because the three share one lifecycle and one file.
// `candidates.ts` (Task I-18/I-19) holds `improvement_start`/`candidate_record`/`candidate_validate`
// for the same reason again: mutators writing `zz.improvement_run`/`zz.candidate`/
// `zz.candidate_evaluation` through the same ledger.
// `replay-score.ts` (Task I-19) holds `replay_score` for the same reason once more: a mutator
// writing `zz.eval_assessment`/`zz.replay_run` through the same ledger — a replay run's own
// scoring path, distinct from `replay-runs.ts`'s lifecycle tools beside it.
const REGISTRATION_MODULES = ["subject", "observe", "discover", "protocol", "qualify", "evaluate", "replay-cases", "replay-runs", "replay-score", "plugin-eval", "plugin-judge", "plugin-record", "candidates"];

const registered = new Set<string>();
for (const f of REGISTRATION_MODULES) {
  const src = readFileSync(`services/zz-core/src/eval/${f}.ts`, "utf8");
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) registered.add(m[1]);
}
for (const want of ["protocol_read", "protocol_record", "protocol_affirm", "round_judge",
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
// Task I-10: removed completely, not renamed — see EVAL_ALIAS's own comment for why these three
// take no alias entry either.
for (const gone of ["ruler_read", "ruler_record", "ruler_affirm"]) {
  if (registered.has(gone)) fail.push(`${gone} is still registered — Task I-10 removed it`);
}
// The set, not the size. A count fails identically whether a tool was lost or one was added, and
// says neither. A missing name is a tool that vanished; an unexpected one is a tool nobody wrote
// into the door's own description.
const EXPECTED = new Set([
  "plugin_locate", "plugin_profile", "plugin_conform", "plugin_register",
  "protocol_read", "protocol_record", "protocol_affirm",
  "round_judge", "round_scores", "round_score",
  "finding_record", "finding_decide",
  "failure_discover",
  "evaluator_qualify",
  "evaluation_start", "evaluation_assess", "evaluation_score",
  "replay_case_set_build", "replay_start", "replay_read", "replay_close", "replay_score",
  "improvement_start", "candidate_record", "candidate_validate",
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
for (const f of REGISTRATION_MODULES) {
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
  // Task I-10: removed completely rather than renamed, so no alias entry carries these — checked
  // by name here instead.
  for (const gone of ["ruler_read", "ruler_record", "ruler_affirm"]) {
    if (new RegExp(`(^|[^a-z_])${gone}([^a-z_]|$)`).test(body)) fail.push(`${s} still names ${gone}`);
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
