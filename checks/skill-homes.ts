// Skills move to the plugin that owns them, their commands follow, and none is left behind
// or duplicated. The count that opened this line said seven; `gone` below is the list, and a
// list a reader can count is worth more than a number they have to trust.
//
// THE PLAN'S VERSION OF THIS CHECK COULD NOT DISCRIMINATE, and the reason is worth writing
// down because it is the same reason twice. It asserted the skills arriving at the
// baseline were at `catalog/zz/zz-core/skills/` — a path client-package.ts never reads. The
// baseline is the ONE plugin whose files are not resolved from the catalog: `baselineFiles`
// walks `ZZ_SKILLS_DIR` (this repository's `skills/`) and synthesises `zz-router` on top,
// because the router is generated per person from the flows they installed. `residentFiles`,
// which does read a catalog entry's `skills/`, is never called for it. So a `zz-deck`
// directory created under the catalog would have satisfied the plan's check exactly while
// shipping in no plugin at all — measured 2026-09-14 against untouched code, where the check
// reported nineteen failures, of which nine named a destination that would not have worked.
//
// Hence the two halves below: the four are asserted at `skills/`, AND asserted absent from
// the catalog path, so an implementation that hedged by writing both is red.
//
// zz-platform and zz-handover are named here at their CURRENT names. They were zz-backbone
// and zz-knowledge until task I-26 renamed them, and this list was edited in that same
// change — a list naming a skill before its rename lands registers a check that is red until
// an unrelated task fixes it, which is how a gate teaches people to read past it.
import { readFileSync, existsSync, readdirSync } from "node:fs";
const fail: string[] = [];

/** Where each plugin's skills ACTUALLY come from, in the packager's terms. */
const SOURCE: Record<string, string> = {
  "zz-core":   "skills",                     // baselineFiles(), over ZZ_SKILLS_DIR
  "zz-access": "catalog/zz/zz-access/skills", // residentFiles()
  "sdlc-flow": "catalog/sdlc/sdlc-flow/skills",
  "zz-plugin-eval": "catalog/zz/zz-plugin-eval/skills",
};
const MANIFEST: Record<string, string> = {
  "zz-core":   "catalog/zz/zz-core/flow.json",
  "zz-access": "catalog/zz/zz-access/flow.json",
  "sdlc-flow": "catalog/sdlc/sdlc-flow/flow.json",
  "zz-plugin-eval": "catalog/zz/zz-plugin-eval/flow.json",
};
const ships = (p: string) => (existsSync(SOURCE[p]) ? readdirSync(SOURCE[p]) : []);

const expect = {
  "zz-core":   ["zz-platform", "zz-handover", "zz-deck", "zz-tldr", "zz-breakout", "zz-authoring"],
  "zz-access": ["zz-access", "zz-admin", "zz-doctor", "zz-update", "zz-migrate"],
};
const gone = {
  "sdlc-flow": ["sdlc-deck", "sdlc-tldr", "sdlc-breakout", "sdlc-authoring"],
  "zz-core":   ["zz-doctor", "zz-update", "zz-migrate"],
};
for (const [p, want] of Object.entries(expect)) {
  for (const s of want) if (!ships(p).includes(s)) fail.push(`${p} does not ship ${s} (looked in ${SOURCE[p]}/)`);
}
for (const [p, must] of Object.entries(gone)) {
  for (const s of must) if (ships(p).includes(s)) fail.push(`${p} still ships ${s} at ${SOURCE[p]}/${s}`);
}
// THE DEAD PATH. A skill here is invisible to the packager, so it is worse than absent: the
// tree looks right and the plugin ships nothing.
for (const s of existsSync("catalog/zz/zz-core/skills") ? readdirSync("catalog/zz/zz-core/skills") : []) {
  fail.push(`catalog/zz/zz-core/skills/${s} — the baseline's skills are read from skills/, ` +
            "so nothing under its catalog entry ships");
}
// No skill in two plugins.
const seen = new Map();
for (const p of Object.keys(SOURCE)) {
  for (const s of ships(p)) {
    if (seen.has(s)) fail.push(`${s} exists in both ${seen.get(s)} and ${p}`);
    seen.set(s, p);
  }
}

/* ── the commands follow the skills ───────────────────────────────── */

const manifest = (p: string) => JSON.parse(readFileSync(MANIFEST[p], "utf8"));
const wantCommands = {
  // zz-core gains commands, which it had none of before this initiative: a person typing
  // "make this a deck" is doing a core operation, not a delivery one.
  "zz-core":   { deck: "zz-deck", tldr: "zz-tldr", breakout: "zz-breakout" },
  "zz-access": { connect: "zz-access", admin: "zz-admin", doctor: "zz-doctor",
                 update: "zz-update", migrate: "zz-migrate" },
  "sdlc-flow": { flow: "sdlc-flow" },
};
for (const [p, want] of Object.entries(wantCommands)) {
  const have = manifest(p).commands ?? {};
  // EXACTLY, both directions. A stale `doctor: zz-doctor` left in zz-core names a skill it no
  // longer ships, and promoteCommands FILTERS those out silently — the command simply does not
  // exist in the built package and nothing says why.
  for (const [cmd, skill] of Object.entries(want)) {
    if (have[cmd] !== skill) fail.push(`${p} declares command ${cmd} -> ${have[cmd] ?? "nothing"}, expected ${skill}`);
  }
  for (const cmd of Object.keys(have)) {
    if (!(cmd in want)) fail.push(`${p} declares an unexpected command ${cmd} -> ${have[cmd]}`);
  }
}
// Every command anywhere resolves to a skill its own plugin really ships.
for (const p of Object.keys(SOURCE)) {
  for (const [cmd, skill] of Object.entries(manifest(p).commands ?? {})) {
    if (!existsSync(`${SOURCE[p]}/${skill}/SKILL.md`)) {
      fail.push(`${p} maps ${cmd} to ${skill} and ${SOURCE[p]}/${skill}/SKILL.md does not exist`);
    }
  }
}
// zz-authoring is a LIBRARY, not a command: loaded by zz-deck and zz-tldr, never run alone.
const core = manifest("zz-core");
if (core.commands?.authoring) fail.push("zz-authoring is a library and must not be a command");
if (!(core.libraries || []).includes("zz-authoring")) fail.push("zz-authoring is not declared a library");
if ((manifest("sdlc-flow").libraries || []).includes("sdlc-authoring")) {
  fail.push("sdlc-flow still declares sdlc-authoring a library");
}

/* ── the supporting files travelled ───────────────────────────────── */

// A skill promoted to a command ships as `commands/<cmd>.md` and leaves its ASSETS in
// `skills/<name>/`. Those assets are the whole of what three of these seven do, so a move
// that took only SKILL.md is a command that runs nothing.
for (const [rel, why] of [
  ["skills/zz-deck/deck-chassis.html", "the deck's chassis"],
  ["skills/zz-deck/deck-guidebook.html", "the deck's guidebook"],
  ["catalog/zz/zz-access/skills/zz-doctor/doctor.ts", "zz-doctor's script"],
  ["catalog/zz/zz-access/skills/zz-update/update.ts", "zz-update's script"],
  ["catalog/zz/zz-access/skills/zz-migrate/migrate.ts", "zz-migrate's script"],
  ["catalog/zz/zz-access/skills/zz-migrate/mcp.ts", "zz-migrate's MCP client"],
  ["catalog/zz/zz-access/skills/zz-migrate/read-mma.ts", "zz-migrate's reader"],
]) {
  if (!existsSync(rel)) fail.push(`${why} did not travel: ${rel} is missing`);
}

/* ── the four say what they are ───────────────────────────────────── */

// None of the four leaving sdlc is about software delivery, and each says so in its own
// frontmatter — the sentence a model reads when deciding whether this belongs to a sequence.
const STANDALONE = "Standalone — no initiative, no gate, no place in the sequence.";
for (const s of ["zz-deck", "zz-tldr", "zz-breakout", "zz-authoring"]) {
  const p = `skills/${s}/SKILL.md`;
  if (!existsSync(p)) continue; // already reported above
  const md = readFileSync(p, "utf8");
  const fm = md.split("---")[1] ?? "";
  if (!fm.includes(STANDALONE)) fail.push(`${s} does not say in its frontmatter: ${STANDALONE}`);
  if (!new RegExp(`^name:\\s*${s}\\s*$`, "m").test(fm)) fail.push(`${s}/SKILL.md does not declare name: ${s}`);
  // The typed name is part of the move: a skill that still tells the reader `/sdlc:deck`
  // names a command that no longer exists, in the field a person reads to find it.
  if (/\/sdlc:(deck|tldr|breakout)\b/.test(md)) fail.push(`${s} still names a /sdlc: command that no longer exists`);
}
for (const s of ["zz-doctor", "zz-update", "zz-migrate"]) {
  const p = `catalog/zz/zz-access/skills/${s}/SKILL.md`;
  if (!existsSync(p)) continue;
  if (/\/zz-core:(doctor|update|migrate)\b/.test(readFileSync(p, "utf8"))) {
    fail.push(`${s} still names a /zz-core: command that moved to /zz-access:`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("skill homes: ok");
