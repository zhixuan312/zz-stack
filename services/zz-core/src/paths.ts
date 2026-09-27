/**
 * The two things a platform path must be: a name a row can be addressed by, and a sentence
 * that teaches the shape of one it will not accept.
 *
 * The store these used to resolve against is gone — a document's bytes are `zz.doc_revision`
 * rows and its identity is a `zz.doc` row — so a path is no longer a place on disk. What is
 * left is the SHAPE: `safePath` refuses a path that could not name a document, and
 * `pathShapeRefusal` is the sentence that teaches the form, reached before every guard so the
 * sentence is what a caller with a bad path sees.
 *
 * The token patterns live here rather than beside their callers: a name, a tag and a
 * document reference each have exactly one shape on this platform.
 */
import { resolve } from "node:path";

import { Refusal } from "./refusal.js";

/** A filename-safe slug from a human title, with a fallback for when nothing survives — a
 * title written in a script with no ASCII letters slugs to the empty string. Used for a
 * source name and a captured revision. */
export function titleSlug(title: string, fallback: string): string {
  // DELIBERATE: trimmed after the cut, not before. Trimming first and then slicing leaves a
  // trailing hyphen whenever the 60th character is where a word broke.
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "")
    || fallback;
}
/** The team that owns platform-scoped knowledge — what `scope: "platform"` files under.
 * team_create refuses this slug, so no tenant can claim it.
 *
 * `scope: "team"` files a node under the caller's own shelf instead. Documents and initiatives
 * stay with their team whatever the scope. */
export const KNOWLEDGE_TEAM = "zz-platform";
/** A caller-supplied name that will be joined into a path: one segment, nothing else.
 *
 * A tool that builds a path with `join(initiative, …)` rather than through safePath()
 * needs this: an initiative of "../other-team/x" would name a document outside the caller's
 * own scope.
 *
 * A segment cannot contain a separator, cannot be a traversal, cannot be empty, and cannot
 * begin with a dot: the store's own listings skip dot-entries, so a name like `.hidden` would
 * be written and then invisible to document_list and to search, and `.git` was the history a
 * team kept when they left. */
export function safeName(value: string, what: string): string | null {
  const v = value.trim();
  if (!v) return `ERROR: ${what} is required`;
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") {
    return `ERROR: ${what} must be a single name, not a path`;
  }
  if (v.startsWith(".")) {
    return `ERROR: ${what} cannot begin with a dot — the platform skips dot-entries, so it would ` +
           "be written and then invisible to document_list and to search, and `.git` is the " +
           "store's own history.";
  }
  return null;
}
/** A path relative to a directory the platform already resolved.
 *
 * safeName above refuses every path; this one permits exactly the shape a skill's own
 * supporting file has — `references/verified-traps.md` — and refuses everything that could
 * leave the directory. DELIBERATE: checked segment by segment rather than by scanning the
 * whole string, because `..%2f`, `a/../../b` and a leading `/` all pass a "contains no `..`"
 * substring test and still escape.
 */
export function safeRelPath(value: string, what: string): string | null {
  const v = value.trim();
  if (!v) return `ERROR: ${what} is required`;
  if (v.startsWith("/") || v.startsWith("\\") || /^[A-Za-z]:/.test(v)) {
    return `ERROR: ${what} must be relative to the skill's own directory, with no leading slash`;
  }
  const parts = v.split(/[/\\]/);
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") {
      return `ERROR: ${what} must be a path inside the skill's own directory — no '..', and no empty segments`;
    }
    if (p.startsWith(".")) {
      return `ERROR: ${what} cannot have a segment beginning with a dot`;
    }
  }
  return null;
}
/** What may appear inside a frontmatter list, which is written by interpolation and read
 * back by a comma-splitter: no separator, no bracket, no newline, no quote. */
export const PLAIN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A journal tag: a plain token, or a subject key — `plugin:sdlc`, `flow:sdlc-flow`.
 *
 * DELIBERATE: this admits a colon where PLAIN_TOKEN does not. parseEnvelope splits a
 * frontmatter line on its first colon, so a colon in the value is ordinary, and the list
 * reader splits on commas. The comma, bracket, newline and quote PLAIN_TOKEN guards against
 * are still guarded, on both halves of the key. */
const TAG_TOKEN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/;
/** A tag this document or node may not carry, or null.
 *
 * One rule for all three write paths into `zz.doc.tags`: knowledge_add, document_write and
 * document_revise.
 *
 * Lowercase, because a tag is matched by equality: knowledge_search's tag leg lowercases the
 * words a person typed and intersects them with the stored array, so a tag written `Booking`
 * is stored, indexed and unreachable.
 *
 * DELIBERATE: refused rather than folded to lowercase. A silent rewrite would succeed while
 * storing a value the caller did not send. */
export function tagRefusal(tags: string[] | undefined): string | null {
  const bad = (tags ?? []).map((t) => t.trim()).filter((t) => t && !TAG_TOKEN.test(t));
  return bad.length
    ? `ERROR: ${bad.map((t) => JSON.stringify(t)).join(", ")} ` +
      `${bad.length > 1 ? "are not tags" : "is not a tag"} — a tag is lowercase letters, ` +
      "digits, dot, dash or underscore, or a subject key of two such words " +
      "(`flow:sdlc-flow`, `platform:guardrail`). Lowercase because a tag is matched by " +
      "equality: `CaseBox` and `casebox` are two " +
      "tags, and a search finds one of them. A comma, a bracket, a quote or a newline cannot " +
      "appear at all — tags are written into one frontmatter line and read back by splitting it."
    : null;
}
/** The same, for a reference to a document inside an initiative. */
export const DOC_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** What a caller-supplied path may not look like, or null.
 *
 * Its own function, and synchronous: the shape of a path is decidable without resolving
 * anybody's store, so the rule is not behind an I/O call or an `async`, and it can be tested
 * by running it. */
export function pathShapeRefusal(path: string): string | null {
  // DELIBERATE: a `.zz/` or home-relative prefix is refused, not stripped. Stripping would
  // succeed while landing the file somewhere other than the path the model named.
  if (/(^|\/)\.zz\//.test(path) || path.includes("~/")) {
    return "paths are relative to your team's store — write `<initiative>/spec.md`, " +
      "never `.zz/<initiative>/spec.md` and never a home-relative path";
  }
  // No dot segment anywhere in the path. safeName applies the same rule to an `initiative`
  // argument; document_write takes a `path`, which is what this covers.
  //
  // `.git` sat at the root of every team's store. `.git/hooks/pre-commit` was the sharp end:
  // every write was committed, so a file the model chose would have become an executable the
  // service ran. The store is a database now and there is no repository — but a path with a
  // dot segment is not the shape of a document on this platform either, and a name that is
  // refused in one shape is refused in every shape.
  if (/(^|\/)\.[^/]/.test(path.replace(/^\/+/, ""))) {
    return "no part of a path may begin with a dot. The platform skips dot-entries, so a file " +
      "written there is invisible to document_list and to search — and `.git` is the store's " +
      "own history, which is the copy a team kept when they left. Write " +
      "`<initiative>/<document>.md`.";
  }
  return null;
}
/** The shape rule, applied, and the path returned in the form a row is addressed by.
 *
 * A document is addressed by `<initiative>/<document>.md` — the initiative slug and the name
 * inside it, which the database splits across `zz.initiative.slug` and `zz.doc.path`. So this
 * returns the path relative to the caller's own store, normalised of a leading `/`, and there
 * is no root left to prove containment against: `pathShapeRefusal` refuses every segment that
 * could walk out (`..`, a leading dot, an absolute path), which is the whole of what
 * containment was proving. */
export async function safePath(path: string): Promise<string> {
  const shape = pathShapeRefusal(path);
  // DELIBERATE: `Refusal`, not a plain `Error`. safePath is called bare from tools with
  // nothing between it and the tool boundary, and the registerTool wrapper turns a `Refusal`
  // into `text(message)`; a plain throw reaches the caller as the SDK's default `isError`
  // handling instead of this file's "ERROR: …" style.
  if (shape) throw new Refusal(`ERROR: ${shape}`);
  return path.replace(/^\/+/, "");
}
/** Every record the platform writes mechanically, and therefore the model never may:
 *
 *   _ledger.md          the historical outcome ledger, appended when an initiative closed —
 *                       the outcome, the elapsed hours, the write counts. A model that could
 *                       rewrite it would write its own record.
 *   _activity.jsonl     the historical write log, one line per tool call.
 *   _knowledge/log.md   the journal's human-readable log, which the store held as a file.
 *                       `journalLog` writes the entry as a `zz.event` row now; the name stays
 *                       reserved because a model must never be able to rewrite the record of
 *                       what it did. */
const SYSTEM_FILES = /(^|\/)(_?activity\.jsonl|_ledger\.md|_knowledge\/log\.md)$/;

/** Guards every mutation passes, whichever tool asks.
 *
 * COUPLED: document_write and document_patch both call this. One function, so a guard added
 * later cannot land on one path only. */
export function writeGuard(rawPath: string, via: "source_add" | null = null): string | null {
  // Normalised first: the journal pattern below anchors at the start, so
  // `a/../_knowledge/nodes/0001-x.md` would slip past it and safePath would then resolve it
  // to exactly the file the guard protects. Clamping at the root is safe — safePath
  // separately refuses anything that walks out.
  const relPath = resolve("/", rawPath).slice(1);
  if (SYSTEM_FILES.test(relPath)) {
    // Names the class, not one member of it: this guard covers the activity log and the
    // outcome ledger and the journal log.
    return "ERROR: that file is a mechanical record — the platform writes it, nothing else may";
  }
  // The whole of _knowledge/, not just its log: a node written through this path would be
  // stored carrying no evidence, no index and no append-only record of it. The legitimate
  // writer, knowledge_add, writes the row directly and never through here.
  if (/^_knowledge(\/|$)/.test(relPath)) {
    return "ERROR: _knowledge/ is the team's knowledge base, minted by knowledge_add and " +
      "knowledge_supersede — they number the nodes, require the evidence, and write the index " +
      "and the append-only log. A node written by hand has none of that.";
  }
  // sources/ is immutable. `document_write("<initiative>/sources/<file>.md", …)` reaches it
  // with three path segments, so `chainFor` returns an empty chain and every guard in
  // documentGuards short-circuits on `parts.length !== 2`. The overwrite would land with a
  // fresh envelope carrying no `contributed_by`, no `supports` and no `added_at`, taking the
  // source out of `source_list`'s attribution, out of
  // `initiative_status.sources_after_approval`, and out of `document_revise`'s owed-sources
  // check.
  //
  // `via` is how source_add reaches its own directory: the tool that mints a source passes
  // its name rather than being recognised by the path it built.
  if (!via && /(^|\/)sources\//.test(relPath)) {
    return "ERROR: sources/ holds the material a document cites, and it is immutable — " +
      "register one with source_add(initiative, title, content|path, supports), which stamps " +
      "who contributed it, when, and which document it bears on. A source that changed after " +
      "a document cited it is not evidence. If the material itself changed, add the new " +
      "version as a new source and revise the document with document_revise.";
  }
  return null;
}
