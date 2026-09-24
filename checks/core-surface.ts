// The core door's exact surface, the tools removed from it, and skill_list covering what
// block_skills did.
//
// The EXPECTED list below is the names the core door serves, and section 4 asserts the
// argument contract `knowledge_reindex` carries: `team?` and `force?`, `team` omitted meaning
// every team, a named team meaning that one, and a slug no team carries refused by name.
//
// A set of names rather than a count, because a count passes when two errors cancel.
//
// COUPLED: every change to the core door's surface edits EXPECTED below.
//
// Where the indexer lives can pass while being wrong: a second copy of the two indexing
// functions satisfies every assertion about where the tool is registered, and leaves two
// indexers that agree until one is edited. So section 4 also asserts that exactly one definition of each exists, that it is in
// @zz/indexing, and that both services reach it there.
//
// A removed tool needs the wider scan: asserting `encode_base64` is absent from one directory
// passes a registration moved to another file, or a tool unregistered while every skill still
// tells a model to call it. So absence
// is asserted over every service and over the prose trees, not over the tools directory.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fail: string[] = [];

/** A source file with its comments taken out.
 *
 * A comment recording what a tool used to be is history, and every file this check reads
 * carries some. Markdown is never stripped: prose in a skill is the instruction, and a sentence
 * telling a model to call a tool that no door registers is the failure this check is about. */
const stripComments = (src: string) => {
  const out: string[] = [];
  let inBlock = false;
  for (let code of src.split("\n")) {
    if (inBlock) { const e = code.indexOf("*/"); if (e < 0) { out.push(""); continue; } code = code.slice(e + 2); inBlock = false; }
    const o = code.indexOf("/*");
    if (o >= 0) { const c = code.indexOf("*/", o); if (c < 0) { inBlock = true; code = code.slice(0, o); } }
    out.push(code.replace(/\/\/.*$/, ""));
  }
  return out;
};

/** Read a path, or say so: a check that throws has no failure path.
 *
 * Every path this file reads is guarded, and a path that has moved is reported as this scan
 * being blind, which is red rather than a crash. */
const missing: string[] = [];
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { missing.push(p); return null; } };
const list = (d: string) => { try { return readdirSync(d); } catch { missing.push(d); return []; } };

const walk = (d: string, out: string[] = []) => {
  for (const e of list(d)) {
    if (["node_modules", "dist", "_versions", "results"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

// 1. The core door's exact surface
//
// `initiative_open` is registered from `registerInitiativeActTools` but defined in
// `tools/initiative-open.ts`, which is why the scan below reads the whole tools directory
// rather than one file.
//
// The scan reads the `tools` directory for `registerTool(`, not the factory that calls it, so a
// tool counts as off this door only once its module leaves `tools/`. The `plugin_*` tools
// live in `services/zz-core/src/eval/`, which the evaluation door imports and this scan does
// not read.
const EXPECTED = [
  // All four bug tools, and knowledge_reindex. A bug is one subject and it lives where it is
  // filed; the three operator ones are registered here behind `if (sup)`, so role decides who
  // sees them rather than which door serves them.
  "bug_report", "bug_list", "bug_resolve", "bug_delete", "knowledge_reindex",
  "document_approve", "document_list", "document_patch", "document_present", "document_read",
  "document_revise", "document_write", "initiative_close", "initiative_open",
  "initiative_status", "knowledge_add",
  "knowledge_reconcile", "knowledge_search", "knowledge_supersede",
  "session_whoami", "skill_list", "skill_read", "source_add", "source_list",
  // The semantic-assessment checkpoints a flow's skills cite are asked here.
  "assess",
];

const TOOLS_DIR = "services/zz-core/src/tools";
const core = new Set<string>();
for (const f of list(TOOLS_DIR).filter((f) => f.endsWith(".ts"))) {
  const src = read(join(TOOLS_DIR, f)) ?? "";
  for (const m of src.matchAll(/registerTool\(\s*\n?\s*"([a-z0-9_]+)"/g)) core.add(m[1]);
}
// The control: without it every assertion below passes on a door that registers nothing at
// all, which is the state a broken extraction produces.
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

// 2. Deleted means deleted, on every door and in every caller
//
// `encode_base64` is deleted: zero implementations, zero callers, and no alias entry.
// `block_skills` is merged into `skill_list`, so it keeps its `TOOL_ALIAS` entry — its
// telemetry history has to resolve — and keeps nothing else: no registration anywhere, and no
// skill, grader or allowlist still naming it.
//
// Neither is an English word, so a plain word-boundary match is enough here where core-names.ts
// needs a shape. Comments are stripped from source and left alone in markdown.
const GONE = ["encode_base64", "block_skills"];
// The files whose subject is the removal. Each exists to state these names, so matching them
// is the check reading its own homework back.
const EXEMPT = new Set([
  "packages/contracts/src/alias.ts", "checks/alias-maps.ts", "checks/alias-applied.ts",
  "checks/pre-rename-literals.ts", "checks/core-names.ts", "checks/core-surface.ts",
]);
const TREES = ["services", "packages", "scripts", "checks", "catalog", "marketplace", "skills",
               "testing"];
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

// 3. skill_list absorbed block_skills, rather than block_skills merely being deleted
//
// A merge has a positive half and section 2 only checks the negative one: deleting
// `block_skills` and leaving `skill_list` as it was would satisfy everything above and lose the
// questions block_skills existed to answer. So each clause of the contract that says what the
// merged tool returns is asserted against the registration's own body.
//
// Stripped: a comment describing a property must never be able to stand in for the property.
const skills = stripComments(read(join(TOOLS_DIR, "skills.ts")) ?? "").join("\n");
const body = skills.split('"skill_list"')[1] ?? "";
if (!body) fail.push("skills.ts registers no skill_list at all");

const CLAUSES: [RegExp, string][] = [
  [/owner:\s*z\.string\(\)\.optional\(\)/, "skill_list does not take an optional `owner`"],
  // The read, not the word: `/when_to_use/` also matches the sentence said when a SKILL.md
  // declares neither field, so dropping the read and keeping the apology would leave this
  // green.
  [/front\("when_to_use"\)/, "skill_list does not report each skill's when_to_use"],
  // The property read, not the word: `/stages/` matches the local `stagesOf` map, so gutting
  // the stage lookup and keeping the variable would leave this clause green.
  [/manifest\.stages/, "skill_list does not read a package's declared stages, so it cannot " +
                       "report a skill's position in its flow"],
  [/SKILL\.md/, "skill_list does not read the skills' own files"],
  [/files:/, "skill_list does not report the supporting files beside a skill"],
  [/is not a plugin you can reach/,
   "skill_list does not refuse an owner id that matches no plugin"],
];
for (const [re, why] of CLAUSES) if (!re.test(body)) fail.push(why);

// The old return shape, asserted over the whole file and not just the registration body. It
// appears twice — once in the answer and once in the database-unavailable branch — and a
// rewrite that fixes the first and leaves the second hands a flat array of strings to every
// caller on a deployment whose database is down.
if (/JSON\.stringify\(\[\.\.\.names\]\.sort\(\)\)/.test(skills)) {
  fail.push("skill_list still returns a flat array of names");
}

// 4. knowledge_reindex is on /core, and there is exactly one indexer
//
// The argument contract is asserted against the registration's own body: `team` omitted meaning
// every team, a named team meaning that one, and a slug no team carries refused by name. A tool
// that could only ever mean "my team" makes a deployment-wide rebuild one call per team.
//
// The refusal is the clause that matters most: `reindexTeam`'s contract for a team with no
// store directory is to delete that team's rows — right for a team whose store was removed,
// catastrophic for a typo, which has no directory either. Without a guard ahead of it those two
// calls are indistinguishable.
//
// Stripped, for the same reason section 3 is.
//
// The module that serves knowledge_reindex is on /core: the subject is the knowledge index and
// zz-core owns it, holding the store and rebuilding it at boot. Role decides who sees the tool
// — it is registered behind `if (sup)`.
const DOOR = "services/zz-core/src/tools/knowledge-index.ts";
const door = stripComments(read(DOOR) ?? "").join("\n");
const gate = /^[ \t]*(.*?)server\.registerTool\(\s*\n?\s*"knowledge_reindex"/m.exec(door);
if (!gate) {
  fail.push(`${DOOR} does not register knowledge_reindex — it is the module that serves it and ` +
            "/manage is where it went, so neither door serves it and every caller gets " +
            "\"tool not found\"");
} else {
  // The gate, exactly `if (sup) ` and nothing else: an ungated registration puts a tool that
  // rebuilds any team's index in front of every member on the deployment.
  if (gate[1] !== "if (sup) ") {
    fail.push(`knowledge_reindex is registered behind ${JSON.stringify(gate[1])} and not ` +
              "`if (sup) ` — it rebuilds any team's index, so it is a superadmin tool");
  }
  // The body runs to the next registration, or to the end. Unbounded, the clauses below would
  // be satisfied by whatever happens to be registered after it.
  const from = door.indexOf('"knowledge_reindex"');
  const next = door.indexOf("server.registerTool(", from);
  const body = door.slice(from, next < 0 ? door.length : next);
  const MANAGE_CLAUSES: [RegExp, string][] = [
    [/team:\s*z\.string\(\)\.optional\(\)/,
     "knowledge_reindex does not take an OPTIONAL `team` — required, it cannot mean every " +
     "team, which is the case a restore produces; absent, it is the /core tool again"],
    [/force:\s*z\.boolean\(\)\.optional\(\)/,
     "knowledge_reindex does not take `force` — the skip is correct about the CURRENT " +
     "derivation and blind to a previous one, so a rebuild that cannot ignore its own hash " +
     "cannot repair an index, which is most of what a rebuild is for"],
    [/team === undefined/,
     "knowledge_reindex does not branch on `team` being omitted, so it cannot mean every team"],
    [/reindexAllTeams\(/,
     "knowledge_reindex does not call reindexAllTeams — the every-team walk is the union of " +
     "the store directories and the slugs the index already believes in, and a team whose " +
     "store was deleted appears only in the second, so a caller that lists the directories " +
     "itself never visits the one team whose rows need cleaning"],
    [/reindexTeam\(/,
     "knowledge_reindex does not call reindexTeam, so a named team rebuilds nothing"],
    [/existsSync\(join\(ARTIFACTS_DIR, "teams"\)\)/,
     "knowledge_reindex does not check that the artifact store is MOUNTED before rebuilding " +
     "from it \u2014 the indexer reads a missing teams/ directory as \"the volume is not mounted, " +
     "touch nothing\" and answers in the same shape it uses for a team that had nothing to do, " +
     "so a gateway that can see no files at all reports \"nothing had changed\""],
    // Schema-qualified, because zz-core names its schema on every query.
    [/from zz\.team where slug = \$1/,
     "knowledge_reindex does not look the team up before rebuilding it — reindexTeam DELETES " +
     "the rows of a team with no store directory, and a typo has no directory either"],
    [/\$\{slug\}/,
     "knowledge_reindex's refusal does not name the slug it was given — an unknown team is a " +
     "typo, and \"nothing to rebuild\" reads exactly like a team that had nothing to do"],
  ];
  for (const [re, why] of MANAGE_CLAUSES) if (!re.test(body)) fail.push(why);
}

// One definition of each, which is the assertion a copy-paste implementation fails and every
// assertion above passes: two indexers agree until the day somebody edits one. Comments
// stripped, because this file's own explanation of the move names both functions.
const INDEXER = "packages/indexing/src/index.ts";
for (const fn of ["indexDoc", "reindexTeam"]) {
  const defs: string[] = [];
  for (const p of ["services", "packages"].flatMap((t) => walk(t))) {
    if (!/\.tsx?$/.test(p) || p.endsWith(".d.ts")) continue;
    const src = stripComments(read(p) ?? "").join("\n");
    if (new RegExp(`function\\s+${fn}\\s*\\(`).test(src)) defs.push(p);
  }
  if (defs.length !== 1) {
    fail.push(`${fn} is defined in ${defs.length} place(s) — ${defs.sort().join(", ") || "none"} ` +
              `— and an extraction that leaves a second copy behind is two indexers that ` +
              "agree until one of them is edited");
  } else if (defs[0] !== INDEXER) {
    fail.push(`${fn} is defined in ${defs[0]} and not ${INDEXER} — a service cannot import ` +
              "another service, so wherever it sits, one of the two doors cannot reach it");
  }
}
// And each door reaches it there, asserted against the file that does the work rather than the
// service around it. Asked as "does this service import @zz/indexing anywhere", platform-db.ts
// calling configureIndexing satisfies the whole service while the door imports its indexer from
// somewhere else. The question is whether the caller of each function calls the shared one.
const REACHES: [string, RegExp, string, string][] = [
  [DOOR, /import \{[^}]*\breindexTeam\b[^}]*\} from "@zz\/indexing"/,
   "reindexTeam", "knowledge_reindex rebuilds one team through it"],
  [DOOR, /import \{[^}]*\breindexAllTeams\b[^}]*\} from "@zz\/indexing"/,
   "reindexAllTeams", "knowledge_reindex walks every team through it"],
  ["services/zz-core/src/persist.ts", /import \{[^}]*\bindexDoc\b[^}]*\} from "@zz\/indexing"/,
   "indexDoc", "zz-core indexes every document it writes, in the same call"],
];
for (const [file, re, fn, why] of REACHES) {
  if (!re.test(read(file) ?? "")) {
    fail.push(`${file} does not import ${fn} from @zz/indexing, and ${why} — the package ` +
              "exists so both doors run ONE indexer, and a caller reaching a different one is " +
              "the second implementation this whole extraction was to remove");
  }
}

// A path that moved is this scan going blind, and it is reported before anything else: every
// assertion above reads as satisfied when the file it reads is empty, so "nothing found" and
// "nothing to find" are the same answer unless one of them says so.
for (const p of new Set(missing)) {
  fail.unshift(`${p} could not be read — this check scans it, so every assertion about it ` +
               "passed on nothing. Point it at where the path went.");
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log(`core surface: ok — ${core.size} tools on the core door, ` +
            `${GONE.length} gone from every door and every caller`);
