/**
 * A skill's own shape: its frontmatter, its headings, its fences, its version — a name that does
 * not match its directory, an unclosed code fence that swallows the rest of the document, a
 * skill whose content changed and whose version did not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { everySkill, readLock, readSkill, stateOf } from "../../skill-versions.ts";
import { root, sourceFiles } from "../read.ts";
import { check } from "../run.ts";
import { flows, platformSkills, skillsOf } from "../facts.ts";

check("every SKILL.md has frontmatter whose name matches its directory", () => {
  // Covers the platform's own skills too, not just the catalog's: walking catalog entries alone
  // leaves skills/ unchecked. when_to_use is how a model decides to load a skill at all.
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
  // A statement repeated within a single line, where the existing duplicate checks — which look
  // for a statement repeated on the next line — step straight over it. It reaches the reader: a
  // skill is served to an agent verbatim, so the agent reads the stutter too.
  const bad = [];
  for (const rel of sourceFiles(["catalog", "skills", "docs"], [".md"])) {
    const txt = readFileSync(join(root, rel), "utf8");
    for (const line of txt.split("\n")) {
      const m = /^(#{1,6}\s+\S.*?)\1/.exec(line.trim());
      if (m) bad.push(`${rel}: ${m[1].slice(0, 50)}…`);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

// No two skills in a flow carry the same page.
//
// Counted as shared lines, not as a run at matching indices: comparing line i to line i passes a
// block pasted back into both files at different offsets, and two skills are never the same
// length.
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
  // A closing fence may not carry an info string, so a yaml-tagged fence nested inside a
  // markdown-tagged one closes nothing, while the bare fence that ends it closes the outer block
  // and the bare fence meant to end the outer one opens a block running to the end of the file.
  // Nesting needs a four-backtick outer fence.
  //
  // The signal is the file ending inside a block: a nested fence is legitimate content, so
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
  // The improvement loop rests on being able to say which version of a skill produced a
  // measurement, and a version a person types is a claim. The hash is what makes it true:
  // skills.lock.json records both, and this refuses a skill whose text moved while its version
  // did not, and a version that is not MAJOR.MINOR — "may these two numbers be compared" is
  // answered by the first digit, and a scheme admitting `1` or a build date cannot answer it.
  //
  // COUPLED: the rule is imported from skill-versions.ts, the tool that fixes what this checks.
  const skills = everySkill(root).map(readSkill);
  const prev = readLock();
  const bad = [];
  for (const skill of skills) {
    const state = stateOf(skill, prev);
    if (state.bad) bad.push(`${skill.name} ${state.bad} — bump the minor for a reliability change, the major for a change to what the skill is FOR, then re-run \`node scripts/skill-versions.ts --write\``);
  }
  const names = new Set(skills.map((s) => s.name));
  for (const name of Object.keys(prev)) {
    if (!names.has(name)) bad.push(`skills.lock.json still lists ${name}, which no SKILL.md declares — re-run \`node scripts/skill-versions.ts --write\``);
  }
  return bad.length ? bad.join("; ") : null;
});
