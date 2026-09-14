/**
 * A skill's own shape: its frontmatter, its headings, its fences, its version.
 *
 * The cheapest failures on this platform and the least interesting to diagnose — a name
 * that does not match its directory, an unclosed code fence that swallows the rest of the
 * document, a skill whose content changed and whose version did not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { everySkill, readLock, readSkill, stateOf } from "../../skill-versions.ts";
import { root, sourceFiles } from "../read.ts";
import { check } from "../run.ts";
import { flows, platformSkills, skillsOf } from "../facts.ts";

check("every SKILL.md has frontmatter whose name matches its directory", () => {
  // Covers the platform's OWN skills too, not just the catalog's. casebox-stg-usage had no
  // when_to_use for as long as it existed, because this check walked catalog entries and
  // skills/ is not one — the platform's own skills were the ones nobody checked.
  // when_to_use is how a model decides to load a skill at all.
  const bad = [];
  for (const f of [...flows, { dir: null }]) {
    for (const s of (f.dir === null ? platformSkills() : skillsOf(f))) {
      const txt = readFileSync(s.path, "utf8");
      if (!txt.startsWith("---")) { bad.push(`${s.name}: no frontmatter`); continue; }
      const name = /^name:\s*(\S+)/m.exec(txt)?.[1];
      if (name !== s.name) bad.push(`${s.name}: frontmatter name is "${name}"`);
      if (!/^description:/m.test(txt)) bad.push(`${s.name}: no description`);
      if (!/^when_to_use:/m.test(txt)) bad.push(`${s.name}: no when_to_use`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a heading is not printed twice on one line", () => {
  // TWO OF THESE SHIPPED. zz-skill-judge carried "## A person's judgement, when there is
  // one## A person's judgement, when there is one" and zz-skill-report carried "## What
  // recurs" three times over — a paste landing inside the line rather than beside it.
  //
  // The existing duplicate checks look for a statement repeated on the NEXT line, which is
  // what a duplicated paste usually looks like. This one hides on a single line, where every
  // line-based check steps straight over it, and it reaches the reader: a skill is served to
  // an agent verbatim, so the agent reads the stutter too.
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills", "blocks", "docs"], [".md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const line of txt.split("\n")) {
      const m = /^(#{1,6}\s+\S.*?)\1/.exec(line.trim());
      if (m) bad.push(`${rel}: ${m[1].slice(0, 50)}…`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

// NO TWO SKILLS IN A FLOW CARRY THE SAME PAGE.
//
// The check above is about one pair, because that pair is where somebody noticed. The rule is
// general, and widening it found a second: sdlc-deck and sdlc-tldr shared TWENTY substantial
// lines — the whole ASD-STE100 writing-rules section and the source-selection table — and had
// already drifted, tldr carrying a scoping paragraph deck did not. Exactly the shape
// sdlc-audit-criteria was created to end, in the same flow, unchecked.
//
// Counted as SHARED LINES, not as a run at matching indices: an earlier version compared line
// i to line i, so pasting a block back into both files at different offsets passed it — which
// is how duplication actually returns, since two skills are never the same length.
//
// Substantial lines only. Skills in one flow share a vocabulary, and a handful of short
// sentences is that; a page of identical ones is a copy.
check("no two skills in a flow carry the same page", () => {
  const LIMIT = 15;
  const meaty = (t: string): Set<string> => new Set(t.split("\n").map((l) => l.trim()).filter((l) => l.length > 40));
  const bad: string[] = [];
  for (const f of flows) {
    const skills = skillsOf(f).map((sk) => ({ name: sk.name, lines: meaty(readFileSync(sk.path, "utf8")) }));
    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const shared = [...skills[j].lines].filter((l) => skills[i].lines.has(l)).length;
        if (shared > LIMIT) {
          bad.push(`${f.owner}/${f.flow}: ${skills[i].name} and ${skills[j].name} share ` +
                   `${shared} substantial lines — put them in a skill both load`);
        }
      }
    }
  }
  return bad.join("\n");
});

check("every code fence a shipped document opens is closed", () => {
  // sdlc-spec's spec skeleton is a ```markdown block with a ```yaml block inside it, and both
  // used three backticks. A closing fence may not carry an info string, so ```yaml did not
  // close anything — but the bare ``` that ended the yaml DID close the outer block, and the
  // bare ``` meant to end the skeleton then OPENED one that ran to the end of the file.
  //
  // Measured with `marked` rather than reasoned about: it saw two code blocks where the file
  // means to have one, parsed the skeleton's template headings — Problem, Goals & Requirements,
  // Alternatives, all eight — as real level-2 headings OF THE SKILL, and swallowed the whole
  // last section into an unclosed block. The fix is a four-backtick outer fence, which is what
  // nesting requires.
  //
  // The signal is the file ENDING inside a block: a nested fence is legitimate content, so
  // counting fences or flagging nesting both produce noise. This walks them the way CommonMark
  // does — an opener records its length, and only a bare run of at least that length closes it.
  const unclosed = (src: string) => {
    let open = 0;
    for (const l of src.split("\n")) {
      const m = /^(`{3,})(.*)$/.exec(l);
      if (!m) continue;
      const len = m[1].length, info = m[2].trim();
      if (!open) { open = len; continue; }
      if (!info && len >= open) open = 0;
    }
    return open > 0;
  };
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills", "docs"], [".md"])) {
    if (unclosed(readFileSync(join(root, rel), "utf8"))) {
      bad.push(`${rel} ends inside an unclosed code fence — everything after the last opener ` +
               `renders as code, and a nested block needs a longer outer fence`);
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("a skill that changed says so in its version", () => {
  // The improvement loop rests on being able to say WHICH version of a skill produced a
  // measurement. A version a person types is a claim, and this repository's claim was already
  // wrong when the check was written: every one of 35 skills declared `1.0`, including three
  // edited four times that day shipping five separate changes. Ten rounds of evidence would
  // have been filed under one version of a skill that changed five times underneath it, and
  // every comparison drawn from it wrong in the flattering direction.
  //
  // The hash is what makes the version true. skills.lock.json records both; this refuses a
  // skill whose text moved while its version did not, and a version that is not MAJOR.MINOR —
  // "may these two numbers be compared" is answered by the first digit, and a scheme admitting
  // `1` or a build date cannot answer it at all.
  //
  // The rule is IMPORTED from the tool that fixes what this checks. A check and its remedy
  // spelling one rule twice, and disagreeing, is worse than having neither.
  const skills = everySkill(root).map(readSkill);
  const prev = readLock();
  const bad = [];
  for (const skill of skills) {
    const state = stateOf(skill, prev);
    if (state.bad) bad.push(`${skill.name} ${state.bad} — bump the minor for a reliability change, the major for a change to what the skill is FOR, then re-run \`node scripts/skill-versions.mjs --write\``);
  }
  const names = new Set(skills.map((s) => s.name));
  for (const name of Object.keys(prev)) {
    if (!names.has(name)) bad.push(`skills.lock.json still lists ${name}, which no SKILL.md declares — re-run \`node scripts/skill-versions.mjs --write\``);
  }
  return bad.length ? bad.join("; ") : null;
});
