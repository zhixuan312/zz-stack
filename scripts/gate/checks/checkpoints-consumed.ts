/**
 * A checkpoint a skill names is one whose answer code reads.
 *
 * A question family asked and recorded with nothing downstream reading the answer costs a model
 * call per checkpoint and teaches the agent that the answers do not matter. So a SKILL.md may
 * name a family only where `CONSUMED` lists that (skill, family) pair, and each pair names the
 * module that routes on the reading, with the text that proves it does. A skill that tells an
 * agent to call `assess(...)` itself fails outright: nothing reads what that tool returns.
 *
 * DELIBERATE: the `reads` patterns are a tripwire, not a proof. They catch a consumer deleted
 * or renamed out from under a skill; they do not prove the branch is right — the module's own
 * behavioural checks (checks/audit-rounds.ts, checks/review-rounds.ts) do that.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { QUESTION_FAMILIES } from "@zz/contracts";

import { root, sourceFiles } from "../read.ts";
import { check } from "../run.ts";

interface Consumer { skill: string; family: string; module: string; reads: RegExp[] }

const AUDIT = "services/zz-core/src/audit-rounds.ts";
const REVIEW_ROUNDS = "services/zz-core/src/review-rounds.ts";
const REVIEW_ACCEPTANCE = "services/zz-core/src/review-acceptance.ts";

/** Every (skill, family) pair a skill may name, and where the answer is read. */
const CONSUMED: readonly Consumer[] = [
  // yes on a round that read the current version: the next move is `decide`, for the stakeholder.
  ...["sdlc-flow", "sdlc-spec-audit", "sdlc-plan-audit"].map((skill) => ({
    skill, family: "changes_commitment", module: AUDIT, reads: [/a\.changes_commitment\?\.reading === "yes"/],
  })),
  // Annotates the audit's next-move text only; it changes no move.
  ...["sdlc-spec-audit", "sdlc-plan-audit"].map((skill) => ({
    skill, family: "repeats_finding", module: AUDIT, reads: [/a\.repeats_finding\?\.reading === "yes"/],
  })),
  // yes: the finding does not block and does not count toward the convergence test.
  { skill: "sdlc-review", family: "repeats_finding", module: REVIEW_ROUNDS,
    reads: [/a\.family === "repeats_finding"[^\n]*\?\.reading/, /repeats\(introduced, f\.id\) === "yes"/] },
  // no refuses the row at approval; unclear asks once for sharper evidence, then the stakeholder.
  { skill: "sdlc-review", family: "evidence_relation", module: REVIEW_ACCEPTANCE,
    reads: [/family: "evidence_relation"/, /now\.reading === "no"/, /now\.reading === "unclear"/] },
];

/** Every violation, given each skill's text and a module reader. Pure, so a break-test can feed
 *  it a skill that names an unlisted family without touching the tree. */
function unconsumed(skills: ReadonlyArray<{ name: string; text: string }>,
                           registry: readonly Consumer[], readModule: (rel: string) => string): string[] {
  const bad: string[] = [];
  const listed = (skill: string, family: string) => registry.some((c) => c.skill === skill && c.family === family);
  // A snake_case family is named wherever it appears; `actionability` is also an English word,
  // so a one-word family counts only as code.
  const names = (text: string, family: string) =>
    family.includes("_") ? new RegExp(`\\b${family}\\b`).test(text) : text.includes("`" + family + "`");
  for (const { name, text } of skills) {
    for (const family of QUESTION_FAMILIES) {
      if (names(text, family) && !listed(name, family)) {
        bad.push(`${name} names \`${family}\` and no code reads that answer for it — delete it, or wire a consumer and list it in CONSUMED`);
      }
    }
    if (/(?<![\w_])assess\(/.test(text)) {
      bad.push(`${name} tells the agent to call assess(...) — nothing reads what that tool returns`);
    }
  }
  for (const c of registry) {
    if (!QUESTION_FAMILIES.includes(c.family)) bad.push(`CONSUMED lists ${c.family}, which QUESTION_FAMILIES does not register`);
    const skill = skills.find((s) => s.name === c.skill);
    if (!skill) bad.push(`CONSUMED lists ${c.skill}, which is not a shipped skill`);
    else if (!names(skill.text, c.family)) {
      bad.push(`CONSUMED lists ${c.skill} → ${c.family}, and ${c.skill} no longer names it — drop the entry`);
    }
    let src = "";
    try { src = readModule(c.module); } catch { bad.push(`${c.module} is missing — nothing reads ${c.family} for ${c.skill}`); continue; }
    for (const re of c.reads) {
      if (!re.test(src)) bad.push(`${c.module} no longer matches ${re} — ${c.skill}'s ${c.family} may be read by nothing`);
    }
  }
  return bad;
}

check("every question family a skill names is read by code that routes on it", () => {
  const skills = sourceFiles(["catalog", "skills"], ["SKILL.md"])
    .map((rel) => ({ name: basename(dirname(rel)), text: readFileSync(join(root, rel), "utf8") }));
  const bad = unconsumed(skills, CONSUMED, (rel) => readFileSync(join(root, rel), "utf8"));
  return bad.length ? bad.join("; ") : null;
});
