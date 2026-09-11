#!/usr/bin/env node
/**
 * The version each skill declares, beside the hash of what it actually says.
 *
 *   node scripts/skill-versions.mjs            # print the table
 *   node scripts/skill-versions.mjs --write    # record the current state as the baseline
 *
 * WHY BOTH NUMBERS. A declared version is what a person cites — "ops-select v2 fixed it" — and
 * it is the only form that is orderable and arguable. It is also a CLAIM, and on the day this
 * was written every skill in this repository declared `version: 1.0`, including three that had
 * been edited four times that same day shipping five separate changes. Ten rounds of evidence
 * would have been filed under one version of a skill that had changed five times underneath
 * it, and every comparison drawn from it would have been wrong in the flattering direction.
 *
 * So the hash is not an alternative to the version. It is what makes the version true: this
 * file records both, the gate compares them, and a skill whose text changed without its
 * version changing is refused. That turns "v2" from something somebody typed into something
 * the repository can vouch for.
 *
 * ── WHAT THE TWO DIGITS MEAN ─────────────────────────────────────────────────
 *
 * MAJOR.MINOR, and the split is not cosmetic — it is what decides which numbers may be
 * compared with which.
 *
 *   MAJOR  a person changed what the skill is FOR. New requirements, new scope, a different
 *          job. Only a human bumps this, because only a human decides that the thing being
 *          asked for has changed.
 *
 *   MINOR  the same job, done more reliably. This is what the improvement loop produces: the
 *          requirements did not move, the skill got better at meeting them.
 *
 * ── A SKILL ATTACHED TO A BLOCK CARRIES TWO VERSIONS ─────────────────────────
 *
 * A usage skill is written ON TOP of a block nobody here controls. The block changes on its
 * own schedule, and when it does, every trap the skill records and every assembly order it
 * teaches may have stopped being true — silently, because nothing on our side moved.
 *
 * So such a skill declares `block:` and `verified_against:`, and those are NOT its version.
 * Its own `version` is still MAJOR.MINOR and still means what it means everywhere else;
 * `verified_against` records the block version the claims were last checked against.
 *
 * NOT CONCATENATED INTO ONE STRING, which is the tempting shape — "block 3.4.7 plus our 1.2"
 * — and it breaks on contact with a block that answers a build
 * timestamp rather than a version. There is no sane concatenation of that with a revision number,
 * and none of it would order or compare. Two fields stay readable whatever a block answers.
 *
 * It also makes the drift DETECTABLE rather than remembered: the platform already records the
 * block's own version on every call, from the handshake, so "casebox now reports X and the skill
 * was verified against Y" is a query, not a memory. Every attached script or skill re-enters
 * the loop when the number underneath it moves.
 *
 * THE COMPARISON RULE FALLS OUT OF IT. A refusal rate under 2.3 against one under 2.7 is a
 * fair comparison: same intent, two attempts at executing it, and the difference is the
 * change. A rate under 1.5 against one under 2.0 is NOT — the second skill was asked for
 * something the first never was, and reading the difference as a regression blames a change
 * for work it was never doing. Reliability is comparable WITHIN a major and not across one,
 * and a report that ranks them together is comparing two different questions.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "skills.lock.json");

/** Every SKILL.md, wherever it lives — flows keep theirs under catalog/, the platform's own
 * shared ones sit in skills/, and a scan is what keeps a new one from being invisible. */
export function everySkill(base = root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "dist") continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e === "SKILL.md") out.push(full);
    }
  };
  walk(join(base, "catalog"));
  walk(join(base, "skills"));
  walk(join(base, "blocks"));
  return out.sort();
}

/** The name, the declared version, and the hash of the WHOLE file — frontmatter included,
 * because the frontmatter is served to the model too and a change to `when_to_use` changes
 * when the skill is loaded at all. */
export function readSkill(file) {
  const text = readFileSync(file, "utf8");
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(text);
  const field = (k) => {
    const m = fm && new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(fm[1]);
    return m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  };
  return {
    name: field("name") || file,
    version: field("version"),
    /** Set when the skill is attached to a building block we do not control. */
    block: field("block"),
    /** The block version its claims were last checked against. */
    verifiedAgainst: field("verified_against"),
    sha: createHash("sha256").update(text).digest("hex").slice(0, 12),
  };
}

/** Only the first digit decides whether two measurements may be compared. */
const major = (v) => String(v ?? "").split(".")[0];

/** A version has to be MAJOR.MINOR for the comparison rule above to mean anything: a scheme
 * that admits `1` or `2026-08-30` cannot say whether two numbers share a major. */
const WELL_FORMED = /^\d+\.\d+$/;

/** Read the recorded baseline, or nothing if there is none yet. */
export const readLock = () => (existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {});

/** What this file says about one skill against the baseline. The gate imports it rather than
 * spelling the rule a second time — a check and the tool that fixes what it checks disagreeing
 * is worse than having neither. */
export function stateOf(skill, prev) {
  const was = prev[skill.name];
  if (!WELL_FORMED.test(skill.version)) return { bad: `declares version ${JSON.stringify(skill.version)} — it must be MAJOR.MINOR` };
  // A skill that names a block is standing on something it does not control. Which version it
  // was checked against is the difference between a trap that is still true and one that was
  // true once — and without it nothing can tell you which you are reading.
  if (skill.block && !skill.verifiedAgainst) {
    return { bad: `declares block: ${skill.block} but no verified_against — record the block version its claims were last checked against` };
  }
  if (skill.verifiedAgainst && !skill.block) {
    return { bad: "declares verified_against but no block: — say which block the version belongs to" };
  }
  if (!was) return { bad: "is not in skills.lock.json" };
  if (was.sha === skill.sha) return {};
  if (was.version === skill.version) return { bad: `changed but still declares ${skill.version}` };
  return { moved: major(was.version) !== major(skill.version) ? "major" : "minor", from: was.version };
}

// Run only when invoked directly. Imported, this file is a library and must do nothing.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("skill-versions.mjs");
const rows = invokedDirectly ? everySkill().map(readSkill) : [];

if (!invokedDirectly) {
  // nothing
} else if (process.argv.includes("--write")) {
  const lock = Object.fromEntries(rows.map((r) => [r.name, { version: r.version, sha: r.sha }]));
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`  recorded ${rows.length} skill(s) in skills.lock.json`);
} else {
  const prev = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n  ${pad("skill", 24)}${pad("declared", 11)}${pad("content", 14)}state`);
  for (const r of rows) {
    const was = prev[r.name];
    const state = !was ? "new"
      : was.sha === r.sha ? "unchanged"
      : was.version === r.version ? "CHANGED WITHOUT A VERSION BUMP"
      : major(was.version) !== major(r.version)
        ? `${was.version} -> ${r.version}  (MAJOR: what it is for changed — do not compare rates across this)`
        : `${was.version} -> ${r.version}  (minor: same job, made more reliable — comparable)`;
    console.log(`  ${pad(r.name, 24)}${pad(r.version || "(none)", 11)}${pad(r.sha, 14)}${state}`);
  }
  console.log();
}
