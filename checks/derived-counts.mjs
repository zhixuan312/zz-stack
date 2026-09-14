// No file that describes this platform states a count of its own surface as a literal.
//
// THE DEFECT, FOUR TIMES. `access-door.ts` said "A member sees twenty tools they can all use;
// a superadmin sees thirty-four" against a real 19 and 33. `zz-backbone` — `zz-platform` since
// Task I-26 — headed its tool table "THE PLATFORM'S TOOLS ARE THESE TWENTY-NINE" above a table
// of 31. `admin.ts` claimed "all twenty tools" and "twenty-eight refusals" beside each other.
// The fourth was a pair of tool NAMES rather than a count, and one of them had reached a
// security check's case name for a tool nobody serves. Every one of them was a person keeping
// a description beside the thing instead of computing it from the thing.
//
// ── WHAT THIS RULE SEPARATES, AND IT IS THE WHOLE PROBLEM ────────────────────────────────
//
// Not every number next to the word "tools" is that defect, and this codebase's comments are
// MADE of numbers next to the word "tools" — they are how it argues. "three tools were renamed
// during the 2026-08 pass" is a HISTORICAL MEASUREMENT: it was true when it was written, it
// stays true for ever, and freezing it is correct. "A member sees twenty tools" is a
// DESCRIPTION OF THE CURRENT SURFACE: it is a claim about now, and it goes stale silently the
// next time anybody registers anything.
//
// The draft of this check could not tell them apart. Its rule was a spelled number beside a
// surface noun, which fires 127 times on untouched source — on "One skill", "two doors",
// "Three tools answer some form of 'who am I'" — and its control could not have said so: the
// control sample it tested was about `checks`, a noun the rule does not look for, so it could
// not fire however broad the rule became. A control that cannot fail detects nothing.
//
// TWO PROPERTIES DO THE SEPARATING, and both are grammar rather than a list of the numbers or
// the files that happen to be wrong today. An enumerated list of either would be the same
// hand-maintained thing this check exists to delete, reproduced inside it.
//
//   1. THE COUNT IS BOUND TO A WHOLE SURFACE, by a determiner of totality or a possessive —
//      "all twenty tools", "these ten tools", "this door's ten tools", "its seventeen skills",
//      "the nineteen tools" — or by a copula that makes the count the predicate, which is the
//      "ARE THESE TWENTY-NINE" shape exactly.
//
//   2. OR THE COUNT IS THE OBJECT OF A PRESENT-TENSE CLAIM ABOUT WHAT THE PLATFORM HAS —
//      sees, serves, registers, ships, carries, holds, offers, lists, exposes, mounts. This
//      arm exists because the real access-door.ts defect had no determiner at all: "A member
//      sees twenty tools". Definiteness alone would have missed the site the plan named first.
//
// THERE IS NO PAST-TENSE VETO ARM. A veto list is an exception list wearing a different hat,
// and it would rot the same way. Where a historical sentence trips an arm, the number comes
// out of the sentence — the argument never needed it — and that is recorded below.
//
// AND A FLOOR AT FOUR. Below four, English uses the number to enumerate things it names in the
// same breath, and this repository does exactly that: "Three tools answer some form of 'who am
// I' and they are", "the two doors that exist today are two adapters", "THE TWO TOOLS THAT
// WRITE DOWN WHAT A PERSON DECIDED". The number is checkable by the reader against the same
// sentence, so it cannot go quietly stale. At four and above the number stands in for a list
// the reader cannot see, which is the thing that drifts. This is the rule's softest edge and
// it is stated rather than hidden: a fourth door would make "the three doors" wrong, and
// nothing here would say so.
//
// ── WHAT IT READS ────────────────────────────────────────────────────────────────────────
//
// Everything git carries, because a hardcoded directory list stops covering whatever is added
// tomorrow — the reason `ourDocs()` gives for asking git and not the tree. Two exclusions,
// each structural rather than a name somebody remembered:
//
//   - `marketplace/` is the rendered copy of `catalog/` and `skills/`. Its counts are checked
//     at their source, and it is build output nobody edits.
//   - repo-ROOT documents are this repository's narrative rather than a description of what
//     runs: CHANGELOG.md is history and must not be rewritten, STATE.md is the gate's own
//     ledger, DESIGN-platform.md is this initiative's argument about the very defect above and
//     quotes it verbatim. They are reported out of band, not failed on.
//
// ── WHERE IT IS KNOWN TO BE BLIND ────────────────────────────────────────────────────────
//
// A count written NOUN-FIRST — "seven skills ship from the plugin that owns them" — matches
// neither arm. That form is live at `scripts/gate/checks/suites.mjs`, in a check's own name,
// and that file is off limits to this task, so an arm for it would hand back a red gate rather
// than a fixed one. Named here instead of chased.
//
// A bare count in a module header with no determiner and no verb — "Four tools, and not one of
// them returns a judgement" — also matches neither. Same shape, same reason, not chased.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { root, trackedFiles, zzCoreTools } from "../scripts/gate/read.mjs";

const fail = [];

// A number GRAMMAR, and the floor at four is the paragraph above. `\d` gets the same floor
// because a digit is more literal than a word, not less: "The 21 tools on zz-core" is the
// identical defect written with the shift key down.
const ONES = "(four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
             "sixteen|seventeen|eighteen|nineteen)";
const TENS = "(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const DIGITS = "([4-9]|[1-9]\\d{1,2})";
const WORDS = `(${TENS}([- ]${ONES})?|${ONES}|${DIGITS})`;
// The three nouns AC-3.5 names, singular and plural. Nothing else: this is about the
// platform's own surface, not about every countable thing in the repository.
const NEAR = "(tools?|doors?|skills?)";
// Totality and possession — the count is the whole of something, not some of it.
const WHOLE = "(the|these|those|all|every|its|our|your|[a-z]+['’]s)";
// A present-tense claim about what the platform has. Present tense is the point: it is the
// grammatical mark of "this is true now", which is the only kind of sentence that can go stale.
const CLAIM = "(sees?|serves?|registers?|ships?|carries|carry|has|have|holds?|offers?|" +
              "lists?|exposes?|mounts?)";

const BOUND = new RegExp(`\\b${WHOLE}\\s+${WORDS}\\s+${NEAR}\\b`, "i");
const CLAIMED = new RegExp(`\\b${CLAIM}\\s+${WORDS}\\s+${NEAR}\\b`, "i");
const PREDICATE = new RegExp(`\\b${NEAR}\\s+(are|is)\\s+(these\\s+)?${WORDS}\\b`, "i");

/** Does this line assert a count of the platform's own surface? */
const assertsACount = (line) =>
  BOUND.test(line) || CLAIMED.test(line) || PREDICATE.test(line);

// ── the controls, and they run BEFORE the sweep ──────────────────────────────────────────
//
// A control that cannot fail proves nothing, so each of these is asserted in BOTH directions.
//
// THE NEGATIVE CONTROL IS PROVED CAPABLE OF FIRING FIRST. `naive` is the draft's rule — a
// number beside a surface noun — and the sample must MATCH it. That is what makes the second
// half meaningful: the sample is inside the rule's reach, the noun is one this check looks
// for, the number is above the floor, and the full rule still declines it because it is a
// historical statement rather than a description of the surface.
const naive = new RegExp(`\\b${WORDS}\\s+${NEAR}\\b`, "i");
const HISTORICAL = "three tools were renamed during the 2026-08 pass";
const HISTORICAL_ABOVE_FLOOR = "sixteen tools were renamed during the 2026-08 pass";
if (!naive.test(HISTORICAL_ABOVE_FLOOR)) {
  fail.push("the negative control is vacuous: the sample does not even match a bare " +
            "number-beside-a-noun rule, so it could not detect an over-broad one");
}
if (assertsACount(HISTORICAL_ABOVE_FLOOR)) {
  fail.push(`the rule flags a historical measurement: ${JSON.stringify(HISTORICAL_ABOVE_FLOOR)}`);
}
// And the same sentence below the floor, which is the form it is actually written in.
if (assertsACount(HISTORICAL)) {
  fail.push(`the rule flags a historical measurement: ${JSON.stringify(HISTORICAL)}`);
}
// A partitive figure inside a prose argument — the plan's own example of what must stay frozen,
// rewritten onto a noun this rule DOES look for so that it is a real test and not a word the
// pattern was never going to see.
const PARTITIVE = "six of eleven tools passed on a deliberately broken tree";
if (!naive.test(PARTITIVE)) {
  fail.push("the partitive control is vacuous: it is outside the naive rule's reach");
}
if (assertsACount(PARTITIVE)) {
  fail.push(`the rule flags a figure inside a prose argument: ${JSON.stringify(PARTITIVE)}`);
}

// AND THE FLOOR HAS A CONTROL OF ITS OWN, because the floor is this rule's softest edge and
// nothing else here guards it. `ENUMERATING` is a real line out of services/gateway/src/
// identity.ts, and it is the shape the floor exists for: a small count the same sentence names
// its members for, which cannot go quietly stale. It must NOT fire.
//
// PROVED CAPABLE OF FIRING, the same way. `floorless` is this check's own arms with the floor
// taken out — built from the same strings, so it cannot drift from them — and the sample must
// match it. Drop the floor and this control is what says so, rather than 35 findings in the
// sweep and no explanation of which change caused them.
const NO_FLOOR = "(one|two|three)";
const floorless = new RegExp(`\\b${WHOLE}\\s+${NO_FLOOR}\\s+${NEAR}\\b`, "i");
const ENUMERATING = "So the two doors that exist today are two adapters, and adding Keycloak";
if (!floorless.test(ENUMERATING)) {
  fail.push("the floor control is vacuous: the sample does not match these same arms with the " +
            "floor removed, so it could not tell you the floor had moved");
}
if (assertsACount(ENUMERATING)) {
  fail.push(`the floor has gone: ${JSON.stringify(ENUMERATING)} is a count the sentence names ` +
            "its own members for, and this rule is not about those");
}

// THE POSITIVE CONTROLS ARE THE TWO DEFECTS THIS TASK DELETED, in the spelling they shipped in.
// A rule that has been narrowed until it no longer catches them is a rule that has been
// narrowed too far, and these are what says so.
for (const shipped of [
  "THE PLATFORM'S TOOLS ARE THESE TWENTY-NINE, AND NOTHING ELSE IS ONE.",
  "A member sees twenty tools they can all use; a superadmin sees thirty-four.",
  'admin.ts claimed all twenty tools were gated',
]) {
  if (!assertsACount(shipped)) {
    fail.push(`the rule no longer catches a count this task deleted: ${JSON.stringify(shipped)}`);
  }
}

// ── the sweep ────────────────────────────────────────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);
const tracked = trackedFiles();
if (!tracked || tracked.size === 0) {
  fail.push("git listed no files, so this check read nothing and vouches for nothing");
}
const outOfBand = [];
let read = 0;
for (const rel of [...(tracked ?? [])].sort()) {
  if (!/\.(ts|mjs|js|md)$/.test(rel)) continue;
  if (rel.startsWith("marketplace/")) continue;
  // The file holding the controls is the one file that HAS to contain these shapes. Compared as
  // a resolved path and not by string arithmetic on `root` — a symlinked checkout makes those
  // two spellings differ, and the check would then flag its own controls and blame the tree.
  if (join(root, rel) === SELF) continue;
  let body;
  try { body = readFileSync(`${root}/${rel}`, "utf8"); } catch { continue; }
  read++;
  const atRoot = !rel.includes("/");
  body.split("\n").forEach((line, i) => {
    if (!assertsACount(line)) return;
    const where = `${rel}:${i + 1}: ${line.trim().slice(0, 110)}`;
    if (atRoot) outOfBand.push(where); else fail.push(where);
  });
}

// ── zz-platform's tool table names what zz-core actually registers ───────────────────────
//
// THE TABLE IS THE COUNT. Deleting the word "TWENTY-NINE" from its heading removed the number
// and left the thing the number was about — a hand-written list of 30 tool names in a skill
// every agent on this platform is told to read — free to say whatever it likes. So the
// assertion is the set, not the size: a count passes when two errors cancel and a name set
// does not, which is the argument core-surface-19.mjs already makes for itself.
//
// DERIVED FROM ONE PLACE. `zzCoreTools()` is the registration scan `platformSurface()` is
// built on; this reads the same function rather than growing a second one.
//
// WHICH DOOR, FROM THE DOOR'S OWN SOURCE. `eval-door.ts` imports exactly the modules whose
// tools it registers, so the eval door's list is the tools declared in the files that file
// imports, and the core door's is everything else zz-core registers. Not a directory
// convention, and not a list kept here.
const TABLE = "skills/zz-platform/SKILL.md";
const evalDoorSrc = readFileSync(`${root}/services/zz-core/src/eval-door.ts`, "utf8");
const evalModules = new Set([...evalDoorSrc.matchAll(/from\s+"\.\/([^"]+)\.js"/g)]
  .map((m) => `services/zz-core/src/${m[1]}.ts`));
if (evalModules.size === 0) {
  fail.push("services/zz-core/src/eval-door.ts imports no local module, so which tools are on " +
            "the evaluation door could not be derived and the table below was checked against " +
            "nothing");
}
const registered = new Map();   // tool name -> the door path it is served on
for (const { name, file } of zzCoreTools()) {
  registered.set(name, evalModules.has(file) ? "/eval/mcp" : "/core/mcp");
}

const tabled = new Map();
for (const line of readFileSync(`${root}/${TABLE}`, "utf8").split("\n")) {
  if (!/^\s*\|/.test(line)) continue;
  const door = /\/(?:core|eval)\/mcp/.exec(line)?.[0];
  if (!door) continue;
  for (const m of line.matchAll(/`([a-z][a-z0-9_]+)`/g)) tabled.set(m[1], door);
}

// FAIL LOUDLY ON AN EMPTY LIST, both sides. An empty table reads as "this platform has no
// tools", which is worse than a stale count; an empty derivation would pass an empty table.
if (registered.size === 0) {
  fail.push("no tool was derived from zz-core's registrations — the scan is blind, and a blind " +
            "scan would vouch for any table at all, including an empty one");
}
if (tabled.size === 0) {
  fail.push(`${TABLE} renders no tool table. A skill that tells every agent on this platform ` +
            "what the platform's tools are, and then lists none, says the platform has none");
}
for (const [name, door] of tabled) {
  if (!registered.has(name)) {
    fail.push(`${TABLE} lists \`${name}\`, which zz-core registers nowhere`);
  } else if (registered.get(name) !== door) {
    fail.push(`${TABLE} puts \`${name}\` on ${door}; zz-core registers it on ${registered.get(name)}`);
  }
}
for (const [name, door] of registered) {
  if (!tabled.has(name)) fail.push(`zz-core registers \`${name}\` on ${door} and ${TABLE} omits it`);
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log(`derived counts: ok — ${read} files read, none states a count of this platform's ` +
            `own tools, doors or skills; ${TABLE} names exactly the ${registered.size} tools ` +
            "zz-core registers, each on the door its own source puts it on." +
            (outOfBand.length
              ? `\n           NOT FAILED ON, REPORTED — the repository's root documents are its ` +
                `narrative rather than a description of what runs, and are excluded by ` +
                `construction. ${outOfBand.length} count(s) live in them, in ` +
                [...new Set(outOfBand.map((o) => o.split(":")[0]))].sort().join(", ") +
                ". Run this file's rule over them by hand before citing any of those numbers."
              : ""));
