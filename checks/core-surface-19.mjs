// Two tools leave the core door for good, and skill_list absorbs what block_skills did.
//
// TWO OF THE THREE. Task I-18 was written as three tools leaving the core door and delivered
// two: `encode_base64` deleted, `block_skills` merged into `skill_list`. Moving
// `knowledge_reindex` to `/manage` needs `reindexTeam` and `indexDoc` extracted from
// services/zz-core/src/indexing.ts into a package the gateway can depend on — the gateway has
// no such dependency and no indexer of its own — and that extraction is TASK I-38. So
// `knowledge_reindex` is listed BELOW as a tool the core door still serves, and I-38 is the
// task that moves it out of that list and adds the `/manage` assertions this file will then
// need: registered under `if (sup)`, taking `team?` and `force?` with `team` omitted meaning
// every team, a named team meaning that one, and an unknown slug refused by name.
//
// WHY A SET AND NOT A COUNT. The plan's own draft of this file asserted `registered.size ===
// 19`, and 19 is the END STATE of the whole initiative rather than of this task. The door held
// 31 before Task I-18 and holds 29 after it; it reaches 19 only once Task I-14 adds
// `initiative_open` (+1), Tasks I-19/I-20 move the ten `plugin_*` tools to the eval door (−10),
// and `knowledge_reindex` leaves for `/manage` (−1). Registering a check that is red for four
// tasks is how a gate teaches people to read past it, so this pins the NAMES the door serves
// today instead — a stronger control than a count, because a count passes when two errors
// cancel and a name set does not.
//
// EVERY TASK THAT MOVES THE SURFACE EDITS THE LIST BELOW. That coupling is deliberate: the
// surface is the thing this initiative is about, and a task that changes it silently is
// exactly the failure the initiative exists to remove.
//
// THE DELETION IS THE HALF THAT NEEDS THE WIDER SCAN. Asserting `encode_base64` is absent from
// one directory passes an implementation that merely moved the registration to another file,
// or that unregistered the tool and left every skill still telling a model to call it — which
// fails at run time as "tool not found", mid-stage, with nothing red anywhere. So absence is
// asserted over every service and over the prose trees, not over the tools directory.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fail = [];

/** A source file with its comments taken out.
 *
 * A comment recording what a tool USED to be is history, and every file this check reads
 * legitimately carries some — including this initiative's own explanations of what merged into
 * what. Markdown is never stripped: prose in a skill IS the instruction, and a sentence telling
 * a model to call a tool that no door registers is the failure this whole check is about. */
const stripComments = (src) => {
  const out = [];
  let inBlock = false;
  for (let code of src.split("\n")) {
    if (inBlock) { const e = code.indexOf("*/"); if (e < 0) { out.push(""); continue; } code = code.slice(e + 2); inBlock = false; }
    const o = code.indexOf("/*");
    if (o >= 0) { const c = code.indexOf("*/", o); if (c < 0) { inBlock = true; code = code.slice(0, o); } }
    out.push(code.replace(/\/\/.*$/, ""));
  }
  return out;
};

/** Read a path, or say so. A CHECK THAT THROWS HAS NO FAILURE PATH.
 *
 * The plan's own draft of this file read `skills/zz-platform/SKILL.md`, which does not exist:
 * it would have ended the gate in an ENOENT stack trace rather than in the sentence it was
 * written to print, and a reader would have gone looking for a broken check instead of a
 * missing tool. Three checks in this initiative have now had an unreachable failure path. So
 * every path this file reads is guarded, and a path that has moved is reported as this scan
 * being blind — which is exactly what it is, and which is red rather than a crash. */
const missing = [];
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { missing.push(p); return null; } };
const list = (d) => { try { return readdirSync(d); } catch { missing.push(d); return []; } };

const walk = (d, out = []) => {
  for (const e of list(d)) {
    if (["node_modules", "dist", "_versions", "results"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

// ── 1. The core door's exact surface, as of Task I-18 ────────────────────────────────────
const EXPECTED = [
  "document_approve", "document_list", "document_patch", "document_present", "document_read",
  "document_revise", "document_write", "initiative_close", "initiative_status", "knowledge_add",
  "knowledge_reconcile", "knowledge_reindex", "knowledge_search", "knowledge_supersede",
  "plugin_affirm", "plugin_cases_record", "plugin_conform", "plugin_finding_record",
  "plugin_judge", "plugin_locate", "plugin_profile", "plugin_ruler", "plugin_ruler_record",
  "plugin_scores", "session_whoami", "skill_list", "skill_read", "source_add", "source_list",
];

const TOOLS_DIR = "services/zz-core/src/tools";
const core = new Set();
for (const f of list(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = read(join(TOOLS_DIR, f)) ?? "";
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) core.add(m[1]);
}
// THE CONTROL. Without it every assertion below passes on a door that registers nothing at
// all, which is precisely the state a broken extraction produces.
if (core.size === 0) fail.push(`found no registerTool calls under ${TOOLS_DIR} — the scan is broken`);
for (const want of EXPECTED) {
  if (!core.has(want)) fail.push(`the core door no longer registers ${want}`);
}
for (const got of core) {
  if (!EXPECTED.includes(got)) {
    fail.push(`the core door registers ${got}, which this task's surface does not list — ` +
              "add it here in the same change that adds it to the door");
  }
}

// ── 2. Deleted means deleted, on every door and in every caller ──────────────────────────
//
// `encode_base64` is DELETED — zero implementations, zero callers, and no alias entry, because
// nothing it used to do is done by anything now. `block_skills` is MERGED into `skill_list`, so
// it keeps its `TOOL_ALIAS` entry (its telemetry history has to resolve) and keeps nothing
// else: no registration anywhere, and no skill, grader or allowlist still naming it.
//
// NEITHER IS AN ENGLISH WORD, which is why a plain word-boundary match is enough here and
// core-names.mjs needed a shape. A comment recording what a tool USED to be is history and
// every one of these files legitimately carries some, so comments are stripped from source and
// left alone in markdown — prose in a skill is the instruction, and that is the whole point.
const GONE = ["encode_base64", "block_skills"];
// The files whose SUBJECT is the removal. Each exists to state these names, so matching them
// is the check reading its own homework back.
const EXEMPT = new Set([
  "packages/contracts/src/alias.ts", "checks/alias-maps.mjs", "checks/alias-applied.mjs",
  "checks/pre-rename-literals.mjs", "checks/core-names.mjs", "checks/core-surface-19.mjs",
]);
const TREES = ["services", "packages", "scripts", "checks", "catalog", "marketplace", "skills",
               "evals", "testing"];
const CODE = /\.(ts|tsx|mjs|js)$/;
const YAML = /\.ya?ml$/;

for (const p of TREES.flatMap((t) => walk(t))) {
  if (!/\.(ts|tsx|mjs|js|json|md|ya?ml|sh)$/.test(p) || EXEMPT.has(p)) continue;
  const raw = read(p) ?? "";
  const lines = CODE.test(p) ? stripComments(raw) : raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let code = lines[i];
    if (YAML.test(p)) code = code.replace(/(^|\s)#.*$/, "$1");
    if (!code.trim()) continue;
    for (const gone of GONE) {
      if (new RegExp(`(^|[^A-Za-z0-9_])${gone}([^A-Za-z0-9_]|$)`).test(code)) {
        fail.push(`${p}:${i + 1} names \`${gone}\`, which no door registers. ` +
                  (gone === "block_skills"
                    ? "It merged into `skill_list(owner?)` — say that instead."
                    : "It was deleted outright; there is no replacement to point at."));
      }
    }
  }
}

// ── 3. skill_list absorbed block_skills, rather than block_skills merely being deleted ───
//
// A MERGE HAS A POSITIVE HALF AND SECTION 2 ONLY CHECKS THE NEGATIVE ONE. Deleting
// `block_skills` and leaving `skill_list` exactly as it was would satisfy everything above and
// would lose the two questions block_skills existed to answer — which blocks this platform
// routes, and which usage skills each ships. So each clause of the contract that says what the
// merged tool returns is asserted against the registration's own body.
// STRIPPED, and section 2's own mutation test is why. A first draft of this section read the
// raw source, so `zz.block` in the sentence explaining WHY the registry is asked satisfied the
// clause asserting that it IS asked — the check passed on an implementation that had swapped
// the query out from under it. A comment describing a property is the one thing that must
// never be able to stand in for the property.
const skills = stripComments(read(join(TOOLS_DIR, "skills.ts")) ?? "").join("\n");
const body = skills.split('"skill_list"')[1] ?? "";
if (!body) fail.push("skills.ts registers no skill_list at all");

const CLAUSES = [
  [/owner:\s*z\.string\(\)\.optional\(\)/, "skill_list does not take an optional `owner`"],
  [/zz\.block/, "skill_list does not ask the registry which blocks this platform routes — " +
                "that is the half it took over from block_skills"],
  [/kind\s*=\s*'block_usage'/, "skill_list does not ask for a block's usage skills by kind"],
  // THE READ, not the word. `/when_to_use/` also matched the sentence said when a SKILL.md
  // declares neither field, so dropping the read and keeping the apology left this green.
  [/front\("when_to_use"\)/, "skill_list does not report each skill's when_to_use"],
  // THE PROPERTY READ, not the word. `/stages/` matched the local `stagesOf` map, so gutting
  // the stage lookup and keeping the variable left this clause green.
  [/manifest\.stages/, "skill_list does not read a package's declared stages, so it cannot " +
                       "report a skill's position in its flow"],
  [/SKILL\.md/, "skill_list does not read the skills' own files"],
  [/files:/, "skill_list does not report the supporting files beside a skill"],
  [/is not a plugin or building block/,
   "skill_list does not refuse an owner id that matches no plugin or block"],
];
for (const [re, why] of CLAUSES) if (!re.test(body)) fail.push(why);

// THE OLD RETURN SHAPE, asserted over the WHOLE FILE and not just the registration body. It
// appeared twice — once in the answer and once in the database-unavailable branch — and a
// rewrite that fixed the first and left the second still hands a flat array of strings to
// every caller on a deployment whose database is down, which is the case this tool is most
// often reached in.
if (/JSON\.stringify\(\[\.\.\.names\]\.sort\(\)\)/.test(skills)) {
  fail.push("skill_list still returns a flat array of names");
}

// A PATH THAT MOVED IS THIS SCAN GOING BLIND, and it is reported before anything else: every
// assertion above reads as satisfied when the file it reads is empty, so "nothing found" and
// "nothing to find" are the same answer unless one of them says so.
for (const p of new Set(missing)) {
  fail.unshift(`${p} could not be read — this check scans it, so every assertion about it ` +
               "passed on nothing. Point it at where the path went.");
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log(`core surface: ok — ${core.size} tools on the core door, ` +
            `${GONE.length} gone from every door and every caller`);
