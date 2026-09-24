// No file that describes this platform states a count of its own surface as a literal.
//
// What the rule separates. "three tools were renamed during the 2026-08 pass" is a historical
// measurement: it was true when written, it stays true, and freezing it is correct. "A member sees
// twenty tools" is a description of the current surface: a claim about now, and it goes stale
// silently the next time anybody registers anything.
//
// Two grammatical properties do the separating, rather than a list of the numbers or the files
// that happen to be wrong today:
//
//   1. The count is bound to a whole surface, by a determiner of totality or a possessive — "all
//      twenty tools", "these ten tools", "its seventeen skills" — or by a copula that makes the
//      count the predicate.
//   2. Or the count is the object of a present-tense claim about what the platform has: sees,
//      serves, registers, ships, carries, holds, offers, lists, exposes, mounts. This arm exists
//      because "A member sees twenty tools" has no determiner at all.
//
// DELIBERATE: there is no past-tense veto arm. A veto list is an exception list wearing a
// different hat, and it would rot the same way. Where a historical sentence trips an arm, the
// number comes out of the sentence.
//
// The floor is four. Below four English uses the number to enumerate things it names in the same
// breath, so the reader can check it against the same sentence and it cannot go quietly stale. At
// four and above the number stands in for a list the reader cannot see. This is the rule's
// softest edge: a fourth door would make "the three doors" wrong, and nothing here would say so.
//
// What it reads: everything git carries, because a hardcoded directory list stops covering
// whatever is added tomorrow. Two structural exclusions:
//
//   - `marketplace/` is the rendered copy of `catalog/` and `skills/`. Its counts are checked at
//     their source, and it is build output nobody edits.
//   - repo-root documents are this repository's narrative rather than a description of what runs:
//     CHANGELOG.md is history. They are reported out of band, not failed on.
//
// Known blind spot: a count that is neither bound to a whole, nor the object of a present-tense
// claim, nor the subject of its own sentence — "the ten `plugin_*` tools" puts a word between the
// number and the noun, and no arm looks across it. Reaching it means matching a number near a noun
// with anything in between, which is the draft rule the controls below exist to refuse.
// `checks/manage-surface.ts` is out of reach for a different reason: its count follows a colon,
// and admitting a colon as a sentence boundary makes this rule report fenced ruler definitions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { root, trackedFiles, zzCoreTools } from "../scripts/gate/read.ts";

const fail = [];

// A number grammar, with the floor at four. `\d` gets the same floor because a digit is more
// literal than a word, not less.
const ONES = "(four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
             "sixteen|seventeen|eighteen|nineteen)";
const TENS = "(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const DIGITS = "([4-9]|[1-9]\\d{1,2})";
const WORDS = `(${TENS}([- ]${ONES})?|${ONES}|${DIGITS})`;
// The three nouns AC-3.5 names, singular and plural. Nothing else: this is about the platform's
// own surface, not every countable thing in the repository.
const NEAR = "(tools?|doors?|skills?)";
// Totality and possession — the count is the whole of something, not some of it.
const WHOLE = "(the|these|those|all|every|its|our|your|[a-z]+['’]s)";
// A present-tense claim about what the platform has — the grammatical mark of "this is true now",
// which is the only kind of sentence that can go stale.
const CLAIM = "(sees?|serves?|registers?|ships?|carries|carry|has|have|holds?|offers?|" +
              "lists?|exposes?|mounts?)";

// The count as the sentence's subject: the noun-first form and the bare-header form at once.
// "Seven skills move, their commands follow" and "Four tools, and not one of them returns a
// judgement" carry no determiner and no verb the arms below look for, and both go stale the moment
// the surface changes. What they share is position: the sentence opens by counting the surface.
//
// DELIBERATE: past tense is excluded explicitly here, and only here, because this is the one arm
// with no verb list of its own. The others get "true now" from CLAIM; without the same discipline
// this one reads a repository that documents its own history as full of defects.
//
// The window is the next five words, because that is where the verb sits in this shape. Widening
// it trades a false positive for the chance of masking a real count near a past-tense word.
// `\w+ed` carries most of it; `went` and the auxiliaries are the irregulars this tree contains.
//
// A sentence may also begin mid-line, after a full stop: both module headers this arm was added
// for put a title first. DELIBERATE: a colon is not a boundary — it introduces a clause or a field
// rather than ending a sentence, and admitting it made the rule report a line inside a fenced
// ruler definition.
//
// The separator is non-word, not whitespace. Written `\s+`, the window could not step over a
// comma, leaving a past-tense verb one punctuation mark out of reach.
const PAST = "(?:\\w+ed|was|were|had|went|grew|took|made|ran|came|got|left|lost|wrote|kept|held|gave|became)";
//
// A quote opens a sentence too. One site is a check's own name — `check("seven skills ship from
// the plugin that owns them", …)` — which the gate prints on every run, so it is shipped prose by
// any reading. The count still has to be the first thing in the sentence; the sentence is simply
// allowed to begin at a quotation mark.
const OPENS = new RegExp(
  `(?:^|["'\`]|\\.\\s+)\\W*${WORDS}\\s+${NEAR}\\b(?!(?:\\W+[\\w'’-]+){0,5}\\W+${PAST}\\b)`, "i");

const BOUND = new RegExp(`\\b${WHOLE}\\s+${WORDS}\\s+${NEAR}\\b`, "i");
const CLAIMED = new RegExp(`\\b${CLAIM}\\s+${WORDS}\\s+${NEAR}\\b`, "i");
const PREDICATE = new RegExp(`\\b${NEAR}\\s+(are|is)\\s+(these\\s+)?${WORDS}\\b`, "i");

/** Does this line assert a count of the platform's own surface? */
const assertsACount = (line: string) =>
  BOUND.test(line) || CLAIMED.test(line) || PREDICATE.test(line) || OPENS.test(line);

// The controls, and they run before the sweep
//
// Each is asserted in both directions, because a control that cannot fail proves nothing.
//
// The negative control is proved capable of firing first: `naive` is the draft's rule — a number
// beside a surface noun — and the sample must match it. That is what makes the second half
// meaningful: the sample is inside the rule's reach, the noun is one this check looks for, the
// number is above the floor, and the full rule still declines it as historical.
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
// A partitive figure inside a prose argument, rewritten onto a noun this rule does look for so
// that it is a real test rather than a word the pattern was never going to see.
const PARTITIVE = "six of eleven tools passed on a deliberately broken tree";
if (!naive.test(PARTITIVE)) {
  fail.push("the partitive control is vacuous: it is outside the naive rule's reach");
}
if (assertsACount(PARTITIVE)) {
  fail.push(`the rule flags a figure inside a prose argument: ${JSON.stringify(PARTITIVE)}`);
}

// The floor has a control of its own, because the floor is this rule's softest edge and nothing
// else here guards it. `ENUMERATING` is a real line from services/gateway/src/identity.ts and is
// the shape the floor exists for: a small count the same sentence names its members for. It must
// not fire.
//
// Proved capable of firing the same way: `floorless` is this check's own arms with the floor taken
// out, built from the same strings so it cannot drift from them.
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

// The subject arm has controls of its own, in both directions, because it is the only arm whose
// tense test is written by hand rather than inherited from CLAIM. It must fire on the two
// spellings it was added for — one a comment header, one a check's own name, which is why the
// quote case exists — and stay quiet on four historical lines taken verbatim from this tree.
for (const subject of [
  "// Seven skills move, their commands follow, and none is left behind or duplicated.",
  'check("seven skills ship from the plugin that owns them, and their commands follow",',
  " * THE FACTS ABOUT ONE PLUGIN. Four tools, and not one of them returns a judgement.",
  " * A PLUGIN AS THE SUBJECT OF THE JUDGE. Four tools: what a ruler is written from, the record",
]) {
  if (!assertsACount(subject)) {
    fail.push(`the subject arm no longer catches a count that opens its sentence: ${JSON.stringify(subject)}`);
  }
}
for (const history of [
  "// four skills that moved in task I-25, and its comment records it.",
  " * Five tools each carried this: collect-turns, watch-results, evolve-report, flow-compare and",
  "// Four tool descriptions went on offering `23-08-2026-sample-intake` as the example. That is",
  '// 31 tools, expected 31" — a failure a reader cannot act on, on a check that was right.',
  '// THE DOORS ARE IN THE LINE, because "29 tools" is the number that was true before this',
]) {
  // Capable of firing, or the quiet half proves nothing: each must match the same arm with its
  // tense test removed, built from the same strings so it cannot drift from them.
  const tenseless = new RegExp(`(?:^|["'\`]|\\.\\s+)\\W*${WORDS}\\s+${NEAR}\\b`, "i");
  if (!tenseless.test(history)) {
    fail.push(`a tense control is vacuous — it does not match the subject arm with the tense ` +
              `test removed, so it could not tell you the test had gone: ${JSON.stringify(history)}`);
  }
  if (assertsACount(history)) {
    fail.push(`the rule flags a past-tense line: ${JSON.stringify(history)}`);
  }
}

// The positive controls are two defects in the spelling they shipped in. A rule narrowed until it
// no longer catches them has been narrowed too far, and these are what says so.
for (const shipped of [
  "THE PLATFORM'S TOOLS ARE THESE TWENTY-NINE, AND NOTHING ELSE IS ONE.",
  "A member sees twenty tools they can all use; a superadmin sees thirty-four.",
  'admin.ts claimed all twenty tools were gated',
]) {
  if (!assertsACount(shipped)) {
    fail.push(`the rule no longer catches a count this task deleted: ${JSON.stringify(shipped)}`);
  }
}

// The sweep
const SELF = fileURLToPath(import.meta.url);
const tracked = trackedFiles();
if (!tracked || tracked.size === 0) {
  fail.push("git listed no files, so this check read nothing and vouches for nothing");
}
const outOfBand: string[] = [];
let read = 0;
for (const rel of [...(tracked ?? [])].sort()) {
  if (!/\.(ts|mjs|js|md)$/.test(rel)) continue;
  if (rel.startsWith("marketplace/")) continue;
  // The file holding the controls is the one file that has to contain these shapes. Compared as a
  // resolved path and not by string arithmetic on `root`: a symlinked checkout makes those two
  // spellings differ, and the check would then flag its own controls and blame the tree.
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

// Zz-platform's tool table names what zz-core actually registers
//
// The table is the count. The assertion is the name set, not the size: a count passes when two
// errors cancel and a name set does not.
//
// Derived from one place — `zzCoreTools()` is the registration scan `platformSurface()` is built
// on, read rather than reimplemented.
//
// Which door, from the door's own source. `eval-door.ts` imports exactly the modules whose tools
// it registers, so the eval door's list is the tools declared in the files that file imports, and
// the core door's is everything else zz-core registers. Not a directory convention, and not a list
// kept here.
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

// Fail loudly on an empty list, both sides. An empty table reads as "this platform has no tools",
// which is worse than a stale count; an empty derivation would pass an empty table.
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
