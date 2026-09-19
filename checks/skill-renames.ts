// Two skills renamed, every caller moved, and history still resolves.
//
// ── WHICH `zz-platform` THIS MEANS ───────────────────────────────────────────────────────
//
// `zz-platform` is THREE things in this repository and only one of them is the skill:
//   - the SKILL at `skills/zz-platform/SKILL.md`, which is what everything below asserts;
//   - the platform's own TEAM slug — `PLATFORM_TEAM` in `services/gateway/src/identity.ts:564`,
//     `KNOWLEDGE_TEAM` in `services/zz-core/src/paths.ts:53` — a directory under
//     `ARTIFACTS_DIR/teams/`, which `admin/teams.ts:101` reserves so no tenant can claim it.
//     It held the name first and most of the tree's occurrences are it;
//   - the RETIRED MARKETPLACE name, in `zz-doctor/doctor.ts` and `scripts/probes/
//     package-shape.ts` as `p.id.endsWith("@zz-platform")` — see `package/describe.ts:147`.
//
// The namespaces do not meet: a team is only ever reached by joining its slug under `teams/`,
// a skill only by `allSkillRoots()` over `<root>/skills/<name>/SKILL.md`, and nothing takes a
// bare slug and asks which it is. Ordering settles the one case that looks like a collision —
// `SKILL_ROOTS` comes first and the caller's own team store last, so not even a member of the
// `zz-platform` team can shadow the `zz-platform` skill.
//
// SO NOTHING HERE MATCHES THE BARE STRING. Every assertion is anchored to a path
// (`skills/zz-platform/SKILL.md`, the rendered shelf, the manifest's array) or to a resolver
// lookup — including the `readdirSync("skills")` membership test, which asks for a DIRECTORY
// and not for an occurrence. A check that counted `zz-platform` would pass on the team's.
//
// ── WHAT THE PLAN'S VERSION OF THIS CHECK COULD NOT DO ───────────────────────────────────
//
// Measured 2026-09-14 against untouched code, before a byte of this task was written. The
// plan's check asserted the renamed skills at `catalog/zz/zz-core/skills/<name>/SKILL.md` and
// it did not fail — it CRASHED, uncaught:
//
//   Error: ENOENT: no such file or directory,
//     open 'catalog/zz/zz-core/skills/zz-platform/SKILL.md'
//     at checks/skill-renames.ts:10  (exit 1)
//
// and it would have crashed identically AFTER the rename, because the baseline plugin's skills
// are not read from the catalog at all. `client-package.ts`'s `baselineFiles()` walks
// `ZZ_SKILLS_DIR` — this repository's top-level `skills/` — and `residentFiles()`, the one that
// does read a catalog entry's `skills/`, is never called for `zz-core`. So the plan's check was
// anchored to a path the packager never reads: red before, red after, for the same irrelevant
// reason, and a hedged implementation that created BOTH trees would have satisfied it while
// shipping the rename in no plugin. `checks/skill-homes.ts` established the same thing for the
// four skills that moved in task I-25, and its comment records it.
//
// Everything below is anchored at `skills/`, and the catalog path is asserted EMPTY rather than
// full, so the hedge is red rather than green.
//
// ── THE FOUR PROPERTIES ──────────────────────────────────────────────────────────────────
//
//   1. the directories moved, the frontmatter moved with them, and nothing was left behind at
//      the old name or duplicated into the dead catalog path;
//   2. no caller still says an old name — swept over source, manifests and shell,
//      not just over the two trees the rename touched;
//   3. EVERY `skills/<name>/SKILL.md` literal in a script or a check resolves to a directory
//      that exists. This is the property the plan's site table could not be, because
//      `build-marketplace.ts` ASSEMBLES its path — `join(market, "zz-core/skills/…")` — so a
//      grep for the whole path finds nothing and the failure arrives at BUILD time, as a thrown
//      Error, rather than as a red check. The build is therefore also run, for real;
//   4. an old `zz.event.step` value still resolves, and resolves to a skill that EXISTS. A
//      frozen map pointing at a directory nobody shipped is an alias that is correct and inert,
//      which is the failure `alias.ts`'s own header records for the surface key.
//
// ── WHY COMMENTS ARE STRIPPED FROM SOURCE, AND FROM SOURCE ONLY ──────────────────────────
//
// `checks/pre-rename-literals.ts` already settled this for the tool renames and states the
// reason: "prose recording an old name is history, not a comparison". Eight comments in this
// tree are dated measurements or past incidents that name a version string which only ever
// existed under the old name — `zz-knowledge 2.0` was never called `zz-handover 2.0`, and
// rewriting it would falsify the record rather than update it. Markdown, JSON, YAML and shell
// carry no such exemption: a skill's prose, a manifest and an eval grader are all live text,
// read by an agent or by the harness, and every word of them is a claim about now.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SKILL_ALIAS } from "../packages/contracts/dist/index.js";

const fail = [];
const PAIRS = Object.entries(SKILL_ALIAS);
if (PAIRS.length !== 2) fail.push(`SKILL_ALIAS carries ${PAIRS.length} pairs, not the two renames`);

// ── 1. the directories, and only the right ones ──────────────────────────────────────────
const SKILLS = "skills";
for (const [oldName, newName] of PAIRS) {
  const md = `${SKILLS}/${newName}/SKILL.md`;
  if (!existsSync(md)) { fail.push(`${md} does not exist — the baseline ships from ${SKILLS}/`); continue; }
  if (existsSync(`${SKILLS}/${oldName}`)) fail.push(`${SKILLS}/${oldName} still exists — a copy at the old name is not a rename`);
  // THE DEAD PATH, asserted empty. A directory here is invisible to the packager, so an
  // implementation that hedged by writing both trees would ship the rename nowhere.
  if (existsSync(`catalog/zz/zz-core/skills/${newName}`)) {
    fail.push(`catalog/zz/zz-core/skills/${newName} — the baseline's skills are read from ${SKILLS}/, so nothing under its catalog entry ships`);
  }
  const fm = readFileSync(md, "utf8");
  if (!new RegExp(`^name:\\s*${newName}\\s*$`, "m").test(fm)) {
    fail.push(`${md}'s frontmatter does not declare \`name: ${newName}\` — skill_read takes the declared name, not the directory`);
  }
  if (!new RegExp(`^# ${newName}\\s*$`, "m").test(fm)) {
    fail.push(`${md}'s heading is not \`# ${newName}\` — the body still introduces itself by another name`);
  }
  if (new RegExp(`(^|[^a-z-])${oldName}([^a-z-]|$)`).test(fm)) {
    fail.push(`${md} still names ${oldName} in its own text`);
  }
}
// The manifest that lists what the baseline ships has to agree with the directory. A skill that
// is neither a command nor a library is not declared at all, and `manifests-conform` reads this
// field rather than the directory — so a renamed directory with an unrenamed manifest ships a
// plugin that declares a skill it does not carry.
const manifest = JSON.parse(readFileSync("catalog/zz/zz-core/flow.json", "utf8"));
const declared = [...(manifest.libraries ?? []), ...Object.values(manifest.commands ?? {})];
for (const [oldName, newName] of PAIRS) {
  if (!declared.includes(newName)) fail.push(`catalog/zz/zz-core/flow.json does not declare ${newName} — it declares ${declared.join(", ")}`);
  if (declared.includes(oldName)) fail.push(`catalog/zz/zz-core/flow.json still declares ${oldName}`);
}

// ── 2. no caller left behind ─────────────────────────────────────────────────────────────
//
// runs, `testing/` holds a shell prompt that names the skill to an agent, `deploy/` documents
// the skills root, and `checks/` is where the alias's own consumers live — all outside a sweep
// over `services packages scripts catalog marketplace skills`, and every one of them a live
// caller.
const ROOTS = ["services", "packages", "scripts", "catalog", "skills", "checks",
               "testing", "deploy", "blocks", "docs", "."];
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "marketplace", "results", "migrations", "runs"]);
// `marketplace/` is a RENDER of `skills/`, rebuilt by the gate itself — reading it mid-gate is a
// torn view, and property 3 below proves the render instead, by running the renderer.
// `migrations/` is applied SQL: its comments are the schema's history and are not re-run.
const SKIP_FILE = new Set([
  "CHANGELOG.md",                     // the record of what happened, under the names it happened under
  "packages/contracts/src/alias.ts",  // the map itself
  "checks/alias-applied.ts",         // feeds an old name to the resolver on purpose
  "checks/alias-maps.ts",            // pins the map's entries, old half included
  "checks/skill-renames.ts",         // this file
]);
const SWEPT = /\.(ts|mjs|js|json|md|ya?ml|sh|example)$/;
const SOURCE = /\.(ts|mjs|js)$/;

/** Comments out, for source only — see the header. Block and line, no string-literal parsing:
 *  a `//` inside a string would be stripped too, and that direction is safe here because
 *  stripping can only ever HIDE a name, never invent one, and every string this cares about is
 *  a bare skill name with no slashes in it. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const walk = (dir: string, out: string[] = []) => {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIR.has(e)) continue;
    const p = dir === "." ? e : join(dir, e);
    if (statSync(p).isDirectory()) { if (dir === ".") continue; walk(p, out); }
    else out.push(p);
  }
  return out;
};
const seen = new Set();
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const p of walk(root)) {
    if (seen.has(p) || SKIP_FILE.has(p) || !SWEPT.test(p)) continue;
    seen.add(p);
    const body = SOURCE.test(p) ? stripComments(readFileSync(p, "utf8")) : readFileSync(p, "utf8");
    for (const [oldName] of PAIRS) {
      if (new RegExp(`(^|[^a-z-])${oldName}([^a-z-]|$)`).test(body)) {
        fail.push(`${p} still names ${oldName} — it is not a skill any more, so this reaches nothing`);
      }
    }
  }
}
if (!seen.size) fail.push("the sweep read no files at all, so finding nothing proves nothing");

// ── 3. every skill path a script names is a skill that is there ──────────────────────────
//
// Four gate checks hold `skills/<name>/SKILL.md` as a literal and throw ENOENT when it moves;
// `build-marketplace.ts` holds only the SUFFIX and joins the rest, so no grep for the whole
// path finds it. Both shapes are covered by matching the suffix wherever it appears.
//
// THE LITERAL IS READ WHOLE, from its opening quote, and resolved against the three bases these
// scripts actually join onto — the repository root, `catalog/` and `marketplace/`. Reading only
// the `skills/<name>/SKILL.md` tail instead reported five failures against a correct tree, every
// one of them the tail of a longer catalog path that resolves perfectly.
//
// A path that is a FIELD rather than a file — `digest-per-plugin.ts` hashes an in-memory
// package whose `files[].path` is `skills/a/SKILL.md` — declares itself `SYNTHETIC:` on the line
// or the line above, the same convention `pre-rename-literals.ts` uses for `RAW NAME:`, and for
// the same reason: an author saying why beats a central allowlist nobody prunes.
const BASES = ["", "catalog/", "marketplace/"];
const scripts = [...walk("scripts"), ...walk("checks")].filter((p) => /\.(ts|js)$/.test(p));
let literals = 0;
for (const p of scripts) {
  if (p === "checks/skill-renames.ts") continue;
  const lines = readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/["'`]((?:[A-Za-z0-9_.@-]+\/)*skills\/([a-z][a-z0-9-]*)\/SKILL\.md)/g)) {
      literals++;
      if (BASES.some((b) => existsSync(b + m[1]))) continue;
      if (/SYNTHETIC:/.test(lines[i]) || /SYNTHETIC:/.test(lines[i - 1] ?? "")) continue;
      fail.push(`${p}:${i + 1} reads ${m[1]}, which exists under none of ${BASES.map((b) => b || "<root>").join(", ")} — this throws rather than reporting. Mark the line \`SYNTHETIC:\` if it is a field and not a file.`);
    }
  }
}
if (literals < 5) fail.push(`only ${literals} skill-path literals were found in scripts/ and checks/; the scan's shape no longer matches the source it reads`);
// AND THE BUILD, run. The marketplace renderer's assertion fires at build time as a thrown
// Error: nothing that reads source catches it, and a rename that misses it dies in the build
// with the shelf half-written.
try {
  execFileSync("node", ["scripts/build-marketplace.ts"], { stdio: "pipe", encoding: "utf8" });
} catch (err) {
  // The thrown message, not the tail of the stack: node prints the frame list last, so slicing
  // from the end reports `at file:///…` and buries the one sentence that says what is wrong.
  const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
  const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
  const message = typeof rec.message === "string" ? rec.message : String(err);
  const out = `${stderr}${stdout}`.trim() || message;
  fail.push(`the shelf does not build: ${out.split("\n").find((l) => /^Error:/.test(l.trim())) ?? out.split("\n").slice(0, 2).join(" ")}`);
}
for (const [oldName, newName] of PAIRS) {
  if (!existsSync(`marketplace/zz-core/skills/${newName}/SKILL.md`)) {
    fail.push(`the rendered shelf has no ${newName} — zz-core ships the rename to nobody`);
  }
  if (existsSync(`marketplace/zz-core/skills/${oldName}`)) {
    fail.push(`the rendered shelf still ships ${oldName}`);
  }
}

// ── 4. history still resolves, onto something that exists ────────────────────────────────
const { resolveStep } = await import("../packages/tools/dist/testing/tool-report.js");
const onDisk = new Set(existsSync(SKILLS) ? readdirSync(SKILLS) : []);
for (const [oldName, newName] of PAIRS) {
  if (resolveStep(oldName) !== newName) fail.push(`resolveStep(${oldName}) does not give ${newName} — old rows stop resolving and coverage drops`);
  // THE AC'S OWN WORDING: a `zz.event.step` row saying the old name resolves to a KNOWN skill.
  // A map that resolves onto a name nothing ships is correct and inert.
  if (!onDisk.has(resolveStep(oldName))) {
    fail.push(`a zz.event.step row saying ${oldName} resolves to "${resolveStep(oldName)}", and no such skill is in ${SKILLS}/`);
  }
}
if (resolveStep("sdlc-spec") !== "sdlc-spec") fail.push("an unrenamed step was altered by the alias");
if (resolveStep("zz-platform") !== "zz-platform") fail.push("the NEW name resolves to something else — the map is being applied twice");

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log(`skill renames: ok (${PAIRS.map(([o, n]) => `${o}→${n}`).join(", ")}; ${seen.size} files swept)`);
