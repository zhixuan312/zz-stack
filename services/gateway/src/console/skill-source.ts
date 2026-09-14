/**
 * Reading a skill off the image: what a plugin ships, and what a registered block carries.
 *
 * `/blocks/<block>/skills/<skill>/SKILL.md` is the same path zz-core reads its skill roots
 * from — a block's skills are one fact, not two. Two kinds of thing share that shelf and
 * whose they are decides how they age, which is why `origin` is carried rather than inferred
 * at each call site.
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { fmField, withoutFrontmatter } from "../package/skills.js";


/** Where a block's own skills live in the image. Same path zz-core reads its skill roots
 *  from — a block's skills are one fact, not two. */
const BLOCKS_DIR = "/blocks";

/** The platform's own skills — the `zz` plugin's content. Overridable exactly as the
 *  packaging code's copy is, and for the same reason: nothing outside a container has a
 *  `/skills`. Exported because the plugins route needs the same directory: `zz` is the one
 *  plugin that is not catalog-resident, so its skills are read from here. */
export const PLATFORM_SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** A SKILL AS SHIPPED, and whose it is.
 *
 * Two kinds of thing reach this shape and the difference matters more than anything else
 * on the page:
 *
 *   THEIRS  — the block team's own published method, vendored. Every one carries a
 *             `source:` line saying so: "the block team owns the content; the version
 *             and when_to_use lines are this platform's." Improving one means agreeing
 *             a change with them.
 *   OURS    — what we wrote: every skill a plugin of ours ships, and what we worked out
 *             by calling somebody else's server.
 *
 * The `source:` line IS the test. Not a list here, which would have to be edited every
 * time a block publishes another skill, and would be wrong in exactly the direction that
 * matters — a new skill of theirs defaulting to "ours".
 */
export interface ShippedSkill {
  name: string; origin: "theirs" | "ours"; version: string | null;
  description: string | null; source: string | null;
  /** Where it was found. Never serialised — it exists so the skill endpoint can read
   *  the file from a directory this walk ALREADY resolved, rather than joining a route
   *  parameter into a path. A traversal you never construct is one you never guard. */
  dir: string;
}

/** Every skill under ONE skills directory.
 *
 * One walk, because a plugin's skills directory and a block's are the same shelf in two
 * places: `<catalog entry>/skills`, `/skills` for the platform's own, `/blocks/<b>/skills`
 * for a registered block. This was written inline for blocks alone and the plugins route
 * needed it for the other two roots; a second copy is how one of them quietly stops
 * reading `source:` and starts calling a block team's skill ours.
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

/** THE SKILLS EACH REGISTERED BLOCK CARRIES, by block name.
 *
 * `/blocks` ONLY. This used to fold the platform's own `/skills` and every zz-owned catalog
 * package into one shelf called "platform", because the console had a Blocks page and that
 * page had nowhere else to put them. It does not any more: `zz` is a plugin row of its own
 * and so is every catalog package, each reading its own directory. Keeping the aggregation
 * would have shown the platform's skills twice under two different subjects.
 */
export function blockSkills(): Map<string, ShippedSkill[]> {
  const out = new Map<string, ShippedSkill[]>();
  let blocks: string[];
  try { blocks = readdirSync(BLOCKS_DIR).sort(); } catch { blocks = []; }
  for (const b of blocks) {
    const list = skillsIn(join(BLOCKS_DIR, b, "skills"));
    if (list.length) out.set(b, list);
  }
  return out;
}

/** A SKILL, READ — its text with the frontmatter off, and everything shipped beside it.
 *
 * One reader for every container. A skill is the same kind of thing whether a plugin ships
 * it or a block publishes it, and the callers that serve one differ only in how they FIND
 * the directory — never in what they do once they have it.
 *
 * The caller passes a directory it already resolved. Nothing here joins a route parameter
 * into a path, which is why nothing here guards against one.
 */
export function readSkillAt(dir: string, name: string, origin: "theirs" | "ours", source: string | null) {
  const md = readFileSync(join(dir, "SKILL.md"), "utf8");
  // Everything beside the SKILL.md, directories included — `references/` today,
  // `scripts/` when something ships one. A file that cannot be read is skipped rather
  // than thrown: a stray entry beside a skill must not take down the reader for the
  // skill itself.
  const references: { path: string; content: string }[] = [];
  const walk = (at: string, rel: string): void => {
    // `evals/` IS NOT REFERENCE MATERIAL. It is this platform's scoring record — its own
    // README says "how each version scored, one file per version, beside the skill it
    // judges" — so it is the raw form of what the Evaluation view already presents, and
    // listing it here put twenty rubric fixtures in front of a reader who asked what a
    // skill ships for them to read. Twenty of the twenty-two files beside a skill are
    // these; the reference tab was almost entirely our own test data.
    //
    // Excluded by name rather than by allowing only `references/`: a skill may legitimately
    // ship a loose asset it names — zz-deck has a deck-chassis.html — and an allowlist
    // would hide it. What is ours is the one thing worth naming.
    if (rel.startsWith("evals/")) return;
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
