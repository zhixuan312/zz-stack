/**
 * Read an mma repository's `.mma/` directory into one plan, and touch nothing.
 *
 * Kept apart from the driver so the mapping can be read, tested and argued with WITHOUT a
 * token, a network, or a store to write into. The riskiest part of an import is the part that
 * decides what a thing becomes; that decision is all here, in functions that take a file and
 * return an object.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** What goes over as SUPPORTING MATERIAL, and what each kind was for.
 *
 * `worktrees/` and `flow-state/` are deliberately absent. They are operational state — which
 * checkout was where, which run was mid-flight — true only while the daemon that wrote them
 * was running, and importing them would move a machine's scratch notes into a permanent store
 * as though they were findings.
 *
 * `journal/` is absent for the opposite reason: it is not supporting material at all, it is
 * the knowledge base, and it has its own route below.
 */
const SOURCE_KINDS = {
  specs:          "Spec",
  plans:          "Plan",
  explorations:   "Exploration",
  audits:         "Audit",
  backlogs:       "Backlog",
  verifications:  "Verification",
  notes:          "Note",
  retros:         "Retro",
  decks:          "Deck",
  deployment:     "Deployment note",
};

/** mma's node types are zz's node types — the same six words, and not by coincidence: the
 * platform's knowledge model was taken from the journal's. So there is no mapping table here,
 * only the assertion that a type is one of them, because an unknown one means the schema moved
 * and a silent default would file the node under the wrong kind for good. */
const TYPES = new Set(["decision", "design", "behavior", "process", "knowledge", "style"]);

/** One journal node, as read off disk — mma's frontmatter plus the prose it wrapped. */
export type JournalNode = {
  mmaId: string;
  title: string;
  type: string | null;
  rawType: string;
  status: string;
  topic: string;
  timestamp: string;
  tags: string[];
  links: { type: string; target: string }[];
  supersededBy: string;
  description: string;
  body: string;
  file: string;
};

/** One historical document, on its way in as a source. */
export type SourceDoc = {
  key: string;
  kind: string;
  date: string;
  slug: string;
  title: string;
  content: string;
};

export type Survey = { repo: string; mmaDir: string; nodes: JournalNode[]; sources: SourceDoc[] };

const frontmatter = (md: string): { fm: string; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  return m ? { fm: m[1], body: md.slice(m[0].length) } : { fm: "", body: md };
};
const scalar = (fm: string, key: string): string =>
  fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]*?)"?\\s*$`, "m"))?.[1]?.trim() || "";
/** A YAML block list: `tags:` then `  - value` lines, stopping at the next unindented key. */
const list = (fm: string, key: string): string[] => {
  const at = fm.match(new RegExp(`^${key}:\\s*$`, "m"));
  if (!at || at.index === undefined) return [];
  const rest = fm.slice(at.index + at[0].length);
  const out: string[] = [];
  for (const line of rest.split(/\r?\n/)) {
    const m = /^\s+-\s*"?([^"\n]*?)"?\s*$/.exec(line);
    if (m) { out.push(m[1].trim()); continue; }
    if (/^\S/.test(line)) break;
  }
  return out.filter(Boolean);
};

/** Every journal node, in id order, as the platform would state it.
 *
 * Import order is id order and that is load-bearing: a node cannot be superseded before the
 * node that supersedes it exists, and mma's ids ascend with time. */
export function journal(mmaDir: string): JournalNode[] {
  const dir = join(mmaDir, "journal", "nodes");
  if (!existsSync(dir)) return [];
  const out: JournalNode[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const md = readFileSync(join(dir, f), "utf8");
    const { fm, body } = frontmatter(md);
    const id = scalar(fm, "id") || f.slice(0, 4);
    const type = scalar(fm, "type");
    const status = scalar(fm, "status") || "adopted";
    const title = scalar(fm, "title") || f.replace(/^\d+-/, "").replace(/\.md$/, "").replace(/-/g, " ");

    // A node with no `## Context` and no `## Consequences` still has its description, and 64
    // of 167 in the corpus this was built against are exactly that. Dropping them would lose
    // a third of the journal to a section heading somebody never filled in; the description
    // IS the node in that case, truncated by whatever wrote it.
    // The SECTIONS are kept, demoted. mma wrote `## Context` and `## Consequences`; stripping
    // every heading ran the two together into one run of paragraphs with a blank line where
    // the structure used to be, so "what happened" and "what it cost us" became
    // indistinguishable. They are demoted rather than kept level because a knowledge node's
    // body sits under its own title, and a `##` here would outrank it. Empty sections still go.
    const prose = body
      .replace(/^#+\s*(.+)$/gm, (_match: string, t: string) => `**${t.trim()}**`)
      .replace(/\*\*([^*\n]+)\*\*\s*(?=\n\s*(?:\*\*|$))/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const description = scalar(fm, "description");
    out.push({
      mmaId: id,
      title,
      type: TYPES.has(type) ? type : null,
      rawType: type,
      status,
      topic: scalar(fm, "topic"),
      timestamp: scalar(fm, "timestamp"),
      tags: list(fm, "tags"),
      links: [...fm.matchAll(/-\s*type:\s*"?([\w-]+)"?\s*\n\s*target:\s*"?(\d+)"?/g)]
        .map((m) => ({ type: m[1], target: m[2] })),
      supersededBy: (scalar(fm, "supersededBy") || "").replace(/^null$/, ""),
      description,
      body: prose,
      file: f,
    });
  }
  return out;
}

/** Every historical document, by kind, newest last. */
export function sources(mmaDir: string): SourceDoc[] {
  const out: SourceDoc[] = [];
  for (const [dirName, kind] of Object.entries(SOURCE_KINDS)) {
    const dir = join(mmaDir, dirName);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const abs = join(dir, f);
      if (!statSync(abs).isFile()) continue;
      if (!/\.(md|json|txt)$/.test(f)) continue;
      const date = /^(\d{4}-\d{2}-\d{2})-/.exec(f)?.[1] ?? "";
      const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.(md|json|txt)$/, "");
      out.push({
        key: `${dirName}/${f}`,
        kind, date, slug,
        title: `${kind}: ${slug.replace(/-/g, " ")}${date ? ` (${date})` : ""}`,
        content: readFileSync(abs, "utf8"),
      });
    }
  }
  // One timeline. The store lists sources in the order they arrive, so importing directory by
  // directory would interleave 2026-04 specs with 2026-08 retros and make the archive unreadable
  // as history — which is the only thing it is for.
  return out.sort((a, b) => (a.date + a.key).localeCompare(b.date + b.key));
}

/** Everything an import needs to know about one repository. */
export function survey(repoRoot: string): Survey {
  const mmaDir = join(repoRoot, ".mma");
  if (!existsSync(mmaDir)) {
    throw new Error(`No .mma directory in ${repoRoot} — this is not an mma repository. ` +
      "Run this from the repository whose history you want to bring over.");
  }
  return { repo: basename(repoRoot), mmaDir, nodes: journal(mmaDir), sources: sources(mmaDir) };
}

export { SOURCE_KINDS, TYPES };
