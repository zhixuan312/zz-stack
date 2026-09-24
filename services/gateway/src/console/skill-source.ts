/**
 * Reading a skill off the image: what a plugin ships. `origin` is carried on the result rather
 * than inferred at each call site.
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { fmField, withoutFrontmatter } from "../package/skills.js";


/** The platform's own skills — the `zz-core` plugin's content. Overridable because nothing
 *  outside a container has a `/skills`.
 *
 *  COUPLED: the packaging code keeps the same constant and override. Exported because `zz-core`
 *  is the one plugin whose skills are not catalog-resident, so the plugins route reads it from
 *  here. */
export const PLATFORM_SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** A skill as shipped, and whose it is.
 *
 *   theirs — another team's published method, vendored. Each carries a `source:` line saying
 *            so; changing one means agreeing the change with them.
 *   ours   — every skill a plugin of ours ships.
 *
 * DELIBERATE: the `source:` line is the test, not a list here. A list would need editing
 * whenever another team publishes a skill, and a new skill of theirs would default to "ours".
 */
export interface ShippedSkill {
  name: string; origin: "theirs" | "ours"; version: string | null;
  description: string | null; source: string | null;
  /** Where it was found. Never serialised: it exists so the skill endpoint reads the file
   *  from a directory this walk already resolved, rather than joining a route parameter into
   *  a path. */
  dir: string;
}

/** Every skill under one skills directory: `<catalog entry>/skills`, or `/skills` for the
 * platform's own. One walk for both, so only one place reads `source:`.
 *
 * Directories only, and a missing SKILL.md is skipped rather than thrown: a stray file in a
 * skills directory must not take down the listing for every plugin.
 */
export function skillsIn(dir: string): ShippedSkill[] {
  if (!existsSync(dir)) return [];
  const out: ShippedSkill[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const f = join(dir, e.name, "SKILL.md");
    if (!existsSync(f)) continue;
    const md = readFileSync(f, "utf8");
    const source = fmField(md, "source") ?? null;
    out.push({
      dir: join(dir, e.name),
      name: e.name,
      origin: source ? "theirs" : "ours",
      version: fmField(md, "version") ?? null,
      description: fmField(md, "description") ?? null,
      source,
    });
  }
  return out;
}

/** A skill, read: its text with the frontmatter off, and everything shipped beside it. One
 * reader for every container — callers differ only in how they find the directory.
 *
 * The caller passes a directory it already resolved. Nothing here joins a route parameter
 * into a path, which is why nothing here guards against one.
 */
export function readSkillAt(dir: string, name: string, origin: "theirs" | "ours", source: string | null) {
  const md = readFileSync(join(dir, "SKILL.md"), "utf8");
  // Everything beside the SKILL.md, directories included. A file that cannot be read is
  // skipped rather than thrown: a stray entry must not take down the reader.
  const references: { path: string; content: string }[] = [];
  const walk = (at: string, rel: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(at, e.name);
      if (e.isDirectory()) { walk(abs, `${rel}${e.name}/`); continue; }
      if (e.name === "SKILL.md" && rel === "") continue;
      try { references.push({ path: `${rel}${e.name}`, content: readFileSync(abs, "utf8") }); }
      catch { /* unreadable beside a readable skill is not the skill's problem */ }
    }
  };
  walk(dir, "");
  return {
    skill: name, origin, source,
    version: fmField(md, "version") ?? null,
    description: fmField(md, "description") ?? null,
    whenToUse: fmField(md, "when_to_use") ?? null,
    body: withoutFrontmatter(md),
    references,
  };
}
