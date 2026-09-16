// Three tools leave the core door for good, and skill_list absorbs what block_skills did.
//
// ALL THREE, AS OF TASK I-38. Task I-18 was written as three tools leaving the core door and
// delivered two: `encode_base64` deleted, `block_skills` merged into `skill_list`. The third,
// `knowledge_reindex`, could not go: moving it to `/manage` needs `reindexTeam` and `indexDoc`
// reachable from the gateway, and a service cannot import another service. I-38 extracted them
// into `@zz/indexing`, which both services import, and the tool now sits on `/manage` under
// `if (sup)`. So the EXPECTED list below is 19 — the surface this initiative was aimed at —
// and section 4 asserts the argument contract the move was allowed to have: `team?` and
// `force?`, `team` omitted meaning every team, a named team meaning that one, and a slug no
// team carries refused BY NAME.
//
// THE EXTRACTION IS THE HALF THAT COULD PASS WHILE BEING WRONG, and section 4 is written for
// it. Copying the two functions into the gateway and leaving zz-core's originals standing
// satisfies every assertion about where the tool is registered — and leaves this platform with
// two indexers that agree until the day one of them is edited, which is the state this whole
// initiative exists to remove. So section 4 also asserts that exactly ONE definition of each
// exists, that it is in the package, and that both services reach it there.
//
// WHY A SET AND NOT A COUNT. The plan's own draft of this file asserted `registered.size ===
// 19`, and 19 is the END STATE of the whole initiative rather than of this task. The door held
// 31 before Task I-18 and 29 after it; Task I-14 added `initiative_open` (+1) and Tasks
// I-19/I-20 moved the ten `plugin_*` tools to the eval door (−10), which left 20, and Task
// I-38 moving `knowledge_reindex` to `/manage` is the −1 that reaches 19. Registering a
// check that is red for four tasks is how a gate teaches people to read past it, so this pins
// the NAMES the door serves today instead — a stronger control than a count, because a count
// passes when two errors cancel and a name set does not. The count in the filename is true at
// last; the name set is still the thing carrying the weight.
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

const fail: string[] = [];

/** A source file with its comments taken out.
 *
 * A comment recording what a tool USED to be is history, and every file this check reads
 * legitimately carries some — including this initiative's own explanations of what merged into
 * what. Markdown is never stripped: prose in a skill IS the instruction, and a sentence telling
 * a model to call a tool that no door registers is the failure this whole check is about. */
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

/** Read a path, or say so. A CHECK THAT THROWS HAS NO FAILURE PATH.
 *
 * The plan's own draft of this file read `skills/zz-platform/SKILL.md`, which does not exist:
 * it would have ended the gate in an ENOENT stack trace rather than in the sentence it was
 * written to print, and a reader would have gone looking for a broken check instead of a
 * missing tool. Three checks in this initiative have now had an unreachable failure path. So
 * every path this file reads is guarded, and a path that has moved is reported as this scan
 * being blind — which is exactly what it is, and which is red rather than a crash. */
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

// ── 1. The core door's exact surface, as of Task I-20 ────────────────────────────────────
//
// `initiative_open` joined it at Task I-14. Registered from `registerInitiativeActTools` but
// defined in `tools/initiative-open.ts`, because initiative-acts.ts is at the 700-line ceiling
// — which is exactly why the scan below reads the whole tools directory rather than one file.
//
// THE TEN `plugin_*` TOOLS LEFT AT TASK I-20, and the scan below is why this list could not be
// edited before they did. It reads the `tools` DIRECTORY for `registerTool(`, not the factory
// that calls it, so between I-19 (which moved the ten registrations onto `buildEvalServer`)
// and I-20 (which moved their modules out of `tools/`) this file was GREEN AND WRONG: the ten
// were no longer on the core door and this list still called them "the core door's exact
// surface". Deleting them from the list then would have turned it red for the honest reason
// that the directory still held them. They now live in `services/zz-core/src/eval/`, which the
// evaluation door imports and this scan does not read — so the list and the directory agree
// again, and each says the same true thing.
const EXPECTED = [
  // `bug_report` ALONE. Filing is something anybody in any flow does and no flow owns, which is
  // this door's own rule. Reading every report on the deployment and deciding what came of one
  // are operator acts and live on /manage behind superadmin, beside knowledge_reindex.
  "bug_report",
  "document_approve", "document_list", "document_patch", "document_present", "document_read",
  "document_revise", "document_write", "initiative_close", "initiative_open",
  "initiative_status", "knowledge_add",
  "knowledge_reconcile", "knowledge_search", "knowledge_supersede",
  "session_whoami", "skill_list", "skill_read", "source_add", "source_list",
];

const TOOLS_DIR = "services/zz-core/src/tools";
const core = new Set<string>();
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
// core-names.ts needed a shape. A comment recording what a tool USED to be is history and
// every one of these files legitimately carries some, so comments are stripped from source and
// left alone in markdown — prose in a skill is the instruction, and that is the whole point.
const GONE = ["encode_base64", "block_skills"];
// The files whose SUBJECT is the removal. Each exists to state these names, so matching them
// is the check reading its own homework back.
const EXEMPT = new Set([
  "packages/contracts/src/alias.ts", "checks/alias-maps.ts", "checks/alias-applied.ts",
  "checks/pre-rename-literals.ts", "checks/core-names.ts", "checks/core-surface-19.ts",
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

const CLAUSES: [RegExp, string][] = [
  [/owner:\s*z\.string\(\)\.optional\(\)/, "skill_list does not take an optional `owner`"],
  // WHAT THIS USED TO ASSERT, and why it is gone. skill_list took over block_skills' job of
  // listing "which blocks this platform routes", from a zz.block query filtered to
  // `origin <> 'platform'`. That registry holds exactly one row and its origin IS 'platform',
  // so the query returned nothing on every call — it was answering a question about a concept
  // this platform no longer has, and answering it emptily.
  // THE READ, not the word. `/when_to_use/` also matched the sentence said when a SKILL.md
  // declares neither field, so dropping the read and keeping the apology left this green.
  [/front\("when_to_use"\)/, "skill_list does not report each skill's when_to_use"],
  // THE PROPERTY READ, not the word. `/stages/` matched the local `stagesOf` map, so gutting
  // the stage lookup and keeping the variable left this clause green.
  [/manifest\.stages/, "skill_list does not read a package's declared stages, so it cannot " +
                       "report a skill's position in its flow"],
  [/SKILL\.md/, "skill_list does not read the skills' own files"],
  [/files:/, "skill_list does not report the supporting files beside a skill"],
  [/is not a plugin you can reach/,
   "skill_list does not refuse an owner id that matches no plugin"],
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

// ── 4. knowledge_reindex is on /manage, and there is exactly ONE indexer ─────────────────
//
// THE ARGUMENT CONTRACT IS THE POINT OF THE MOVE, not a detail of it. On /core this tool
// rebuilt the CALLER's team and could reach no other, so the one situation that actually
// produces a rebuild — a store restored from a backup, a release that changes what a row
// means — had to be done by finding one person from each team and asking them to run it.
// A superadmin tool that could still only ever mean "my team" would be the same tool on a
// different door, so each half of the contract is asserted against the registration's own
// body: `team` omitted meaning EVERY team, a named team meaning that one, and a slug no team
// carries refused BY NAME.
//
// THE REFUSAL IS THE CLAUSE THAT MATTERS MOST, and it is not politeness. `reindexTeam`'s
// contract for a team with no store DIRECTORY is to delete that team's rows — right for a
// team whose store was removed, and catastrophic for a typo, which has no directory either.
// Without a guard ahead of it those two calls are indistinguishable.
//
// STRIPPED, for the same reason section 3 is: a comment saying what a tool takes must never
// be able to satisfy the clause asserting that it takes it.
const DOOR = "services/gateway/src/access-door.ts";
const door = stripComments(read(DOOR) ?? "").join("\n");
const gate = /^[ \t]*(.*?)server\.registerTool\(\s*\n?\s*"knowledge_reindex"/m.exec(door);
if (!gate) {
  fail.push(`${DOOR} does not register knowledge_reindex — it left /core at Task I-38 and ` +
            "/manage is where it went, so neither door serves it and every caller gets " +
            "\"tool not found\"");
} else {
  // THE GATE, exactly. `if (sup) ` and nothing else: an ungated registration puts a tool that
  // rebuilds any team's index in front of every member on the deployment, and reading an
  // unrecognised gate as "probably fine" is how that ships.
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
    [/from team where slug = \$1/,
     "knowledge_reindex does not look the team up before rebuilding it — reindexTeam DELETES " +
     "the rows of a team with no store directory, and a typo has no directory either"],
    [/\$\{slug\}/,
     "knowledge_reindex's refusal does not name the slug it was given — an unknown team is a " +
     "typo, and \"nothing to rebuild\" reads exactly like a team that had nothing to do"],
  ];
  for (const [re, why] of MANAGE_CLAUSES) if (!re.test(body)) fail.push(why);
}

// ONE DEFINITION OF EACH, which is the assertion a copy-paste implementation fails and every
// assertion above passes. Moving the registration to /manage and leaving zz-core's indexer
// standing beside a gateway copy satisfies the whole of this file up to here — and leaves two
// indexers that agree until the day somebody edits one. Comments stripped, because this
// file's own explanation of the move names both functions.
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
// AND EACH DOOR REACHES IT THERE, asserted against the FILE that does the work and not against
// the service around it. Written as "does this service import @zz/indexing anywhere", this was
// GREEN while the door imported its indexer from somewhere else entirely — because db.ts calls
// configureIndexing and that satisfied the whole service. Found by mutation: pointing
// access-door.ts at a local module changed nothing. A per-service test answers a question
// nobody asked; the question is whether THE CALLER of each function is calling the shared one.
const REACHES: [string, RegExp, string, string][] = [
  [DOOR, /import \{[^}]*\breindexTeam\b[^}]*\} from "@zz\/indexing"/,
   "reindexTeam", "the /manage door registers knowledge_reindex"],
  [DOOR, /import \{[^}]*\breindexAllTeams\b[^}]*\} from "@zz\/indexing"/,
   "reindexAllTeams", "the /manage door is what walks every team"],
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
