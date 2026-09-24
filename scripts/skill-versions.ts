#!/usr/bin/env node
/**
 * The version each skill declares, beside the hash of what it actually says.
 *
 *   node scripts/skill-versions.ts            # print the table
 *   node scripts/skill-versions.ts --write    # record the current state as the baseline
 *
 * A declared version is a claim; the hash is what makes it true. This file records both, the
 * gate compares them, and a skill whose text changed without its version changing is refused.
 *
 * MAJOR.MINOR decides which numbers may be compared with which. MAJOR means a person changed
 * what the skill is for — new requirements, new scope, a different job — and only a human bumps
 * it. MINOR means the same job done more reliably, which is what the improvement loop produces.
 * Reliability is comparable within a major and not across one: a refusal rate under 2.3 against
 * one under 2.7 is the same intent executed twice, while under 1.5 against under 2.0 is two
 * different questions.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "skills.lock.json");

/** Every SKILL.md, wherever it lives — flows keep theirs under catalog/, the platform's own
 * shared ones sit in skills/, and a scan is what keeps a new one from being invisible. */
export function everySkill(base: string = root): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
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
  return out.sort();
}

/** The name, the declared version, and the hash of the whole file — frontmatter included,
 * because the frontmatter is served to the model too and a change to `when_to_use` changes
 * when the skill is loaded at all. */
interface SkillRecord {
  name: string;
  version: string;
  sha: string;
}

export function readSkill(file: string): SkillRecord {
  const text = readFileSync(file, "utf8");
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(text);
  const field = (k: string): string => {
    const m = fm && new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(fm[1]);
    return m ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  };
  return {
    name: field("name") || file,
    version: field("version"),
    sha: createHash("sha256").update(text).digest("hex").slice(0, 12),
  };
}

/** Only the first digit decides whether two measurements may be compared. */
const major = (v: string | undefined) => String(v ?? "").split(".")[0];

/** A version has to be MAJOR.MINOR for the comparison rule above to mean anything: a scheme
 * that admits `1` or `2026-08-30` cannot say whether two numbers share a major. */
const WELL_FORMED = /^\d+\.\d+$/;

/** What `--write` records for one skill, and so what the baseline holds for it. */
interface LockedSkill {
  version: string;
  sha: string;
}

/** Read the recorded baseline, or nothing if there is none yet. */
export const readLock = (): Record<string, LockedSkill> =>
  (existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {});

interface SkillState {
  /** Set when this skill fails a rule outright — a malformed version or a missing lock entry. */
  bad?: string;
  /** Set when the content changed and the version moved to match — whether the move was
   *  across a major boundary or within one. */
  moved?: "major" | "minor";
  from?: string;
}

/** What this file says about one skill against the baseline. COUPLED: the gate imports this
 * rather than spelling the rule a second time — a check and the tool that fixes what it checks
 * must not disagree. */
export function stateOf(skill: SkillRecord, prev: Record<string, LockedSkill>): SkillState {
  const was = prev[skill.name];
  if (!WELL_FORMED.test(skill.version)) return { bad: `declares version ${JSON.stringify(skill.version)} — it must be MAJOR.MINOR` };
  if (!was) return { bad: "is not in skills.lock.json" };
  if (was.sha === skill.sha) return {};
  if (was.version === skill.version) return { bad: `changed but still declares ${skill.version}` };
  return { moved: major(was.version) !== major(skill.version) ? "major" : "minor", from: was.version };
}

// Run only when invoked directly. Imported, this file is a library and must do nothing.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("skill-versions.ts");
const rows = invokedDirectly ? everySkill().map(readSkill) : [];

if (!invokedDirectly) {
  // nothing
} else if (process.argv.includes("--write")) {
  const lock = Object.fromEntries(rows.map((r) => [r.name, { version: r.version, sha: r.sha }]));
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`  recorded ${rows.length} skill(s) in skills.lock.json`);
} else {
  const prev: Record<string, LockedSkill> = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : {};
  const pad = (s: string, n: number) => String(s).padEnd(n);
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
