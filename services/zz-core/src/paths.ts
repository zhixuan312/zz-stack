/**
 * Every path this store will accept, and the refusals that teach the ones it will not.
 *
 * `safePath` resolves a caller's path against the store they may write to and refuses
 * anything that leaves it; `pathShapeRefusal` is the sentence that teaches the shape, and
 * every tool resolves before it judges so the sentence is reached.
 *
 * The token patterns live here rather than beside their callers: a name, a tag and a
 * document reference each have exactly one shape on this platform.
 */
import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { parseCaller } from "@zz/contracts";
import { ARTIFACTS_DIR } from "@zz/indexing";
import { requestHeaders } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";
import { teamFor } from "./platform-db.js";

export const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, "_");
/** A filename-safe slug from a human title, with a fallback for when nothing survives — a
 * title written in a script with no ASCII letters slugs to the empty string. Used for a
 * source file, a journal node and a captured revision. */
export function titleSlug(title: string, fallback: string): string {
  // DELIBERATE: trimmed after the cut, not before. Trimming first and then slicing leaves a
  // trailing hyphen whenever the 60th character is where a word broke.
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "")
    || fallback;
}
/** The team that owns platform-scoped knowledge — what `scope: "platform"` files under.
 * team_create refuses this slug, so no tenant can claim it.
 *
 * `scope: "team"` files a node under the caller's own shelf instead, resolved by userRoot().
 * Each shelf keeps its own index.md, log.md and id sequence; nothing is shared across them
 * but the tool that writes to both. Documents and initiatives stay with their team whatever
 * the scope. */
export const KNOWLEDGE_TEAM = "zz-platform";
/** The store a platform-scoped journal node is written to and read from.
 *
 * DELIBERATE: not userRoot(). Every platform-scoped writer has to land in the same place or
 * the shelf fragments one team at a time. A team-scoped node resolves userRoot() instead. */
export function knowledgeRoot(): string {
  const root = join(ARTIFACTS_DIR, "teams", KNOWLEDGE_TEAM);
  mkdirSync(root, { recursive: true });
  return root;
}
export async function userRoot(): Promise<string> {
  const who = parseCaller(requestHeaders());
  const email = who.email;
  const team = await teamFor(email);
  const root = team
    ? join(ARTIFACTS_DIR, "teams", sanitize(team))
    : join(ARTIFACTS_DIR, sanitize(email || who.id || "shared"));
  mkdirSync(root, { recursive: true });
  return root;
}
/** A caller-supplied name that will be joined into a path: one segment, nothing else.
 *
 * A tool that builds a path with `join(root, initiative, …)` rather than through safePath()
 * needs this: an initiative of "../other-team/x" resolves outside the caller's store.
 *
 * A segment cannot contain a separator, cannot be a traversal, cannot be empty, and cannot
 * begin with a dot. `walk()` skips every dot-entry because the store is a git repository, so
 * a name like `.hidden` would be written and then invisible to document_list and to the
 * index, and `.git` itself is the history a team keeps when they leave the platform. */
export function safeName(value: string, what: string): string | null {
  const v = value.trim();
  if (!v) return `ERROR: ${what} is required`;
  if (v.includes("/") || v.includes("\\") || v === "." || v === "..") {
    return `ERROR: ${what} must be a single name, not a path`;
  }
  if (v.startsWith(".")) {
    return `ERROR: ${what} cannot begin with a dot — the store skips dot-entries, so it would ` +
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
 * One rule for all three write paths into zz.doc.tags: knowledge_add, document_write and
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
/** A free-text value going into a frontmatter field, on one line and quoted.
 *
 * Frontmatter is terminated by a line of `---`, so a newline inside a value can end the
 * envelope early — and everything after it stops being metadata and starts being body. A
 * title is prose the caller supplies, so it is the field most likely to carry one. */
export function yamlValue(v: string): string {
  return `"${v.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim()}"`;
}
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
  // `.git` sits at the root of every team's store. `.git/hooks/pre-commit` is the sharp end:
  // commitStore runs `git commit` after every write, so a file the model chose would become
  // an executable the service runs.
  if (/(^|\/)\.[^/]/.test(path.replace(/^\/+/, ""))) {
    return "no part of a path may begin with a dot. The store skips dot-entries, so a file " +
      "written there is invisible to document_list and to search — and `.git` is the store's " +
      "own history, which is the copy a team keeps when they leave. Write " +
      "`<initiative>/<document>.md`.";
  }
  return null;
}
export async function safePath(path: string): Promise<string> {
  const shape = pathShapeRefusal(path);
  // DELIBERATE: `Refusal`, not a plain `Error`. safePath is called bare from tools with
  // nothing between it and the tool boundary, and the registerTool wrapper turns a `Refusal`
  // into `text(message)`; a plain throw reaches the caller as the SDK's default `isError`
  // handling instead of this file's "ERROR: …" style.
  if (shape) throw new Refusal(`ERROR: ${shape}`);
  const base = await userRoot();
  const target = resolve(base, path.replace(/^\/+/, ""));
  if (target !== base && !target.startsWith(base + sep)) {
    // Names the offending segment and the valid shape, like every refusal in
    // pathShapeRefusal above.
    throw new Refusal(
      `ERROR: \`${path}\` escapes your team's store — a \`..\` segment in it walks back out ` +
      "of the root every path is resolved against (a leading `/` is already stripped, so " +
      "that is the only way out). No part of a path may walk back out of the store: write " +
      "`<initiative>/<document>.md`.");
  }
  return target;
}
/** The same containment as safePath, against the shared journal's root instead of the
 * caller's team.
 *
 * DELIBERATE: a separate function rather than a `scope` parameter on safePath. Every other
 * caller of safePath must stay inside the caller's own team, and a shelf argument threaded
 * through all of them is one more chance to pass the wrong one. It calls the same helpers,
 * so a `..` cannot walk out of the journal either. */
export function platformPath(path: string): string {
  const shape = pathShapeRefusal(path);
  if (shape) throw new Refusal(`ERROR: ${shape}`);
  const base = knowledgeRoot();
  const target = resolve(base, path.replace(/^\/+/, ""));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Refusal(
      `ERROR: \`${path}\` escapes the shared journal — no part of a path may walk back out ` +
      "of the root it is resolved against. Write `_knowledge/nodes/<id>-<slug>.md`.");
  }
  return target;
}
/** Every record this server writes mechanically, and therefore the model never may:
 *
 *   activity.jsonl      the write log
 *   _ledger.md          appended by ledgerOnClose when an initiative closes — the outcome,
 *                       the elapsed hours, the write counts. A model that could rewrite it
 *                       would write its own record.
 *   _knowledge/log.md   appended by journalLog on every journal action. */
const SYSTEM_FILES = /(^|\/)(_?activity\.jsonl|_ledger\.md|_knowledge\/log\.md)$/;

/** Guards every mutation of the artifact store passes, whichever tool asks.
 *
 * COUPLED: document_write and document_patch both call this. One function, so a guard added
 * later cannot land on one path only. */
export function writeGuard(rawPath: string, via: "source_add" | null = null): string | null {
  // Normalised first: the journal pattern below anchors at the start, so
  // `a/../_knowledge/nodes/0001-x.md` would slip past it and safePath would then resolve it
  // to exactly the file the guard protects. Clamping at the root is safe — safePath
  // separately refuses anything that leaves the store.
  const relPath = resolve("/", rawPath).slice(1);
  if (SYSTEM_FILES.test(relPath)) {
    // Names the class, not one member of it: this guard covers the activity log, the
    // outcome ledger and the journal log.
    return "ERROR: that file is a mechanical record — the platform writes it, nothing else may";
  }
  if (/(^|\/)_versions\//.test(relPath)) {
    return "ERROR: _versions/ holds the frozen copy of each approval — written mechanically, never by hand";
  }
  // The whole of _knowledge/, not just its log: a node written through this path would be
  // indexed and returned by knowledge_search carrying no evidence, no index.md row and no
  // line in the append-only log. The legitimate writers, knowledge_add and
  // knowledge_supersede, write the file directly and never through here.
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
