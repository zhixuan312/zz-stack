/**
 * Reading a skill off the image: the platform's own, and the ones a block ships.
 *
 * `/blocks/<block>/skills/<skill>/SKILL.md` is the same path zz-core reads its skill roots
 * from — a block's skills are one fact, not two. Two kinds of thing share that shelf and
 * whose they are decides how they age, which is why `origin` is carried rather than inferred
 * at each call site.
 */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { catalogEntries } from "@zz/catalog";
import { fmField, withoutFrontmatter } from "../package/skills.js";


/** Where a block's own skills live in the image. Same path zz-core reads its skill roots
 *  from — a block's skills are one fact, not two. */
const BLOCKS_DIR = "/blocks";

/** The platform's own skills. Overridable exactly as the packaging code's copy is, and
 *  for the same reason: nothing outside a container has a `/skills`. */
const PLATFORM_SKILLS_DIR = process.env.ZZ_SKILLS_DIR || "/skills";

/** THE SKILLS A BLOCK CARRIES, and whose they are.
 *
 * `/blocks/<block>/skills/<skill>/SKILL.md`. Two kinds of thing share this shelf and the
 * difference matters more than anything else on the page:
 *
 *   THEIRS  — the block team's own published method, vendored. Every one carries a
 *             `source:` line saying so: "the block team owns the content; the version
 *             and when_to_use lines are this platform's." Improving one means agreeing
 *             a change with them.
 *   OURS    — what we worked out by calling their server. True against the version we
 *             checked it on, and ours to change.
 *
 * The `source:` line IS the test. Not a list here, which would have to be edited every
 * time a block publishes another skill, and would be wrong in exactly the direction that
 * matters — a new skill of theirs defaulting to "ours".
 */
interface BlockSkill {
  name: string; origin: "theirs" | "ours"; version: string | null;
  description: string | null; source: string | null;
  /** Where it was found. Never serialised — it exists so the skill endpoint can read
   *  the file from a directory this walk ALREADY resolved, rather than joining a route
   *  parameter into a path. A traversal you never construct is one you never guard. */
  dir: string;
}

export function blockSkills(): Map<string, BlockSkill[]> {
  const out = new Map<string, BlockSkill[]>();
  // THE PLATFORM'S OWN SKILLS ARE NOT UNDER /blocks, and that is not an accident of
  // layout — they are ours, true wherever this runs, and they live beside the catalog
  // rather than inside it. But we are an MCP surface like any block, so on this page
  // they belong on our shelf: `/skills` (zz-backbone and the rest) plus every package
  // the platform owns in the catalog (zz-access, zz-journal, zz-knowledge, zz-okr…).
  const roots: [string, string][] = [["platform", PLATFORM_SKILLS_DIR]];
  for (const e of catalogEntries()) {
    if (e.owner === "zz") roots.push(["platform", join(e.dir, "skills")]);
  }
  let blocks: string[];
  try { blocks = readdirSync(BLOCKS_DIR).sort(); } catch { blocks = []; }
  for (const b of blocks) roots.push([b, join(BLOCKS_DIR, b, "skills")]);
  for (const [block, dir] of roots) {
    if (!existsSync(dir)) continue;
    const list: BlockSkill[] = out.get(block) ?? [];
    // Directories only, and a missing SKILL.md is skipped rather than thrown: a stray file
    // in a skills directory must not take down the console's block list.
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const f = join(dir, e.name, "SKILL.md");
      if (!existsSync(f)) continue;
      const md = readFileSync(f, "utf8");
      const source = fmField(md, "source") ?? null;
      list.push({
        dir: join(dir, e.name),
        name: e.name,
        origin: source ? "theirs" : "ours",
        version: fmField(md, "version") ?? null,
        description: fmField(md, "description") ?? null,
        source,
      });
    }
    if (list.length) out.set(block, list.sort((a, b) => a.name.localeCompare(b.name)));
  }
  return out;
}

  /** A SKILL, READ — its text with the frontmatter off, and everything shipped beside it.
 *
 * One reader for both containers. A skill is the same kind of thing whether a flow runs it
 * or a block publishes it, and the two endpoints that serve one differ only in how they
 * FIND the directory — never in what they do once they have it.
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
    // ship a loose asset it names — sdlc-deck has a deck-template.html — and an allowlist
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
