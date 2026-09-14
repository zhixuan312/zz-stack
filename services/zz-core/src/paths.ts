/**
 * Every path this store will accept, and the refusals that teach the ones it will not.
 *
 * ONE PLACE, because a path rule spelled at each call site is a rule that holds at most of
 * them. `safePath` resolves a caller's path against the store they may write to and refuses
 * anything that leaves it; `pathShapeRefusal` is the sentence that teaches the shape, and it
 * teaches nothing from behind a guard — which is why every tool resolves before it judges.
 *
 * The token patterns are here rather than beside their callers for the same reason: a name,
 * a tag and a document reference each have exactly one shape on this platform.
 */
import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { parseCaller } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";
import { ARTIFACTS_DIR, teamFor } from "./platform-db.js";

export const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9@._-]/g, "_");
/** A filename-safe slug from a human title, with a fallback for when nothing survives.
 *
 * Written out three times — for a source file, a journal node and a captured revision —
 * which is three chances to fix one of them and leave the others. And all three produced
 * the EMPTY STRING for a title written in any script without ASCII letters, so a node
 * landed as `0014-.md` and a source as `2026-08-24-.md`. The id and the date still made
 * those unique; what they lost is the only reason a slug is in the name at all, which is a
 * person reading the directory. */
export function titleSlug(title: string, fallback: string): string {
  // Trimmed AFTER the cut, not before it. Trimming first and then slicing leaves a hyphen on
  // the end whenever the 60th character is where a word broke — `…-collection-.md` — which
  // is the one thing a slug in a filename is there to avoid.
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "")
    || fallback;
}
/** A lesson like "a success response is never evidence" is true for every team on
 * the deployment. Filed only in the store of the team that hit it, the next team
 * to hit the same wall could not find it, and each team numbered its own nodes
 * from 0001, which made two teams' node 1 indistinguishable in any view that
 * showed both. That is what `scope: "platform"` is for.
 *
 * The team that owns platform-scoped knowledge is the platform's own team, which
 * already exists and is already reserved: team_create refuses this slug precisely
 * so no tenant can claim it.
 *
 * Team-level knowledge is no longer a later decision: `scope: "team"` files a
 * node under the caller's own team shelf instead, resolved by userRoot(). Each
 * shelf — the platform's and every team's — keeps its own index.md, log.md and
 * id sequence; nothing is shared across them but the tool that writes to both.
 *
 * Documents, initiatives and OKRs stay with their team regardless of scope. */
export const KNOWLEDGE_TEAM = "zz-platform";
/** The store a platform-scoped journal node is written to and read from.
 *
 * Deliberately NOT userRoot(): every platform-scoped writer has to land in the
 * same place or the shelf fragments again, one team at a time, exactly as it
 * did before `scope` existed. A team-scoped node instead resolves userRoot(). */
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
 * safePath() guards the tools that build a full path with it. Several tools instead did
 * `join(root, initiative, ...)` directly, and an initiative of "../other-team/x" resolved
 * outside the caller's store — proven on the live gateway, where a member of one team
 * listed the sources of a directory belonging to another.
 *
 * A segment cannot contain a separator, cannot be a traversal, cannot be empty, and cannot
 * begin with a dot. That is the whole rule, and it is cheaper to apply than to reason about
 * per call site.
 *
 * THE DOT IS NOT COSMETIC. `walk()` skips every dot-entry — it has to, because the store is
 * a git repository and a lister that did not report `.git/COMMIT_EDITMSG` as the team's
 * first document. So a name like `.hidden` was accepted here and then invisible to
 * document_list and to the index: written, and gone. And `.git` itself was accepted, which
 * writes documents into the repository's own directory — the history a team keeps when they
 * walk away from this platform. */
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
/** A path RELATIVE to a directory the platform already resolved.
 *
 * safeName above refuses every path; this one permits exactly the shape a skill's own
 * supporting file has — `references/verified-traps.md` — and refuses everything that could
 * leave the directory. Segment by segment rather than by scanning the whole string, because
 * "contains no `..`" is a substring test and `..%2f`, `a/../../b` and a leading `/` are the
 * three ways that test has historically been passed by a path that escapes anyway.
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
/** What may appear inside a frontmatter LIST, which is written by interpolation and read
 * back by a comma-splitter: no separator, no bracket, no newline, no quote. */
export const PLAIN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A journal TAG, which is a plain token or a subject key — `block:casebox`, `flow:ops-flow`.
 *
 * The subject key is the whole point of the tag argument. knowledge_add's own description asks
 * for one in capitals, subjectTagError exists to check its kind against a closed set, five
 * skills teach the form, and the platform's own db.ts calls it out as what makes the journal
 * queryable. Every one of those calls was refused, because the loop immediately after
 * subjectTagError tested the tag against PLAIN_TOKEN, which has no colon in it — so
 * `block:casebox` passed the rule written for it and was then rejected as not "a plain word".
 *
 * A validated, documented, taught feature that could not be used once. Complete and
 * unreachable is the shape: every piece of it exists except a character class.
 *
 * The colon is safe everywhere the value travels. parseEnvelope splits a frontmatter line on
 * its FIRST colon, so a colon in the value is ordinary; the list reader splits on commas and
 * knows nothing about colons. What PLAIN_TOKEN is actually guarding against — a comma, a
 * bracket, a newline, a quote — is still guarded, on both halves of the key. */
const TAG_TOKEN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/;
/** A tag this document or node may not carry, or null.
 *
 * ONE RULE, THREE WRITE PATHS. knowledge_add checked its tags and document_write and
 * document_revise checked nothing — the same column, zz.doc.tags, filled by three tools
 * under two different rules, one of which was no rule.
 *
 * LOWERCASE, because a tag is matched by EQUALITY and nothing else. knowledge_search's tag
 * leg lowercases the words a person typed and intersects them with the stored array, so a
 * tag written `Booking` can never be reached by anyone searching for booking — it is stored,
 * indexed, and unfindable. subjectTagError's own docblock names this exact failure two
 * paragraphs in: "`casebox`, `block:casebox`, `CaseBox` — each variant silently removes nodes from the
 * answer without removing them from the store, which is the worst shape a knowledge base can
 * fail in". Half of that was checked and half was not.
 *
 * Refused rather than folded. A silent rewrite of somebody's tag is the same trade safePath
 * refuses for a path: the call succeeds, the value stored is not the value sent, and nothing
 * says so. */
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
 * Its own function, and synchronous, because the shape of a path is decidable without
 * resolving anybody's store — safePath used to await the root before saying a path was
 * malformed, which put a rule about strings behind an I/O call and behind an `async`.
 * It is also the only way this rule can be tested by running it. */
export function pathShapeRefusal(path: string): string | null {
  // A `.zz/` prefix is REFUSED, not stripped.
  //
  // It stripped `~/.zz/` and `.zz/` silently, which dates from when the store was a
  // directory on someone's disk. Nothing writes that any more — the skills were corrected —
  // and a silent rewrite is the worst of the three options: the write succeeds, the file
  // lands somewhere other than the path the model named, and nothing in the conversation
  // says so. Refusing teaches the form once; stripping hides it forever.
  if (/(^|\/)\.zz\//.test(path) || path.includes("~/")) {
    return "paths are relative to your team's store — write `<initiative>/spec.md`, " +
      "never `.zz/<initiative>/spec.md` and never a home-relative path";
  }
  // NO DOT SEGMENT ANYWHERE IN THE PATH.
  //
  // safeName has refused a dot-prefixed name since walk() learned to skip dot-entries, and
  // its own message says why: "the store skips dot-entries, so it would be written and then
  // invisible to document_list and to search, and `.git` is the store's own history". But
  // safeName guards an `initiative` ARGUMENT, and document_write takes a `path` — so the rule
  // was stated in one place and applied nowhere near the tool that needed it.
  //
  // The store became a git repository this release, so `.git` now sits at the root of every
  // team's store and nothing refused a write into it. `.git/hooks/pre-commit` is the sharp
  // end: commitStore runs `git commit` after every single write, so a file the model chose
  // becomes an executable the service runs. The quiet end is that the repository is what a
  // team keeps when they leave this platform, and it is the one thing here with no other copy.
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
  // `Refusal`, not a plain `Error` — safePath is called bare from nine tools with nothing
  // between it and the tool boundary, so a plain throw here used to reach the caller as
  // whatever the SDK's default `isError` handling produced rather than this file's own
  // "ERROR: …" style. The registerTool wrapper turns a `Refusal` into `text(message)`.
  if (shape) throw new Refusal(`ERROR: ${shape}`);
  const base = await userRoot();
  const target = resolve(base, path.replace(/^\/+/, ""));
  if (target !== base && !target.startsWith(base + sep)) {
    // NAMES THE OFFENDING SEGMENT AND THE VALID SHAPE, same as every other refusal in
    // pathShapeRefusal above — "path escapes the artifact store" said WHAT was wrong and
    // nothing about which part of `path` caused it or what to write instead.
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
 * Not a `scope` parameter on safePath: every OTHER caller of safePath is a mutation or a
 * listing that must stay inside the caller's own team, and a shelf argument threaded through
 * all of them is nine chances to pass the wrong one. Reading is the only thing that crosses,
 * so the crossing is its own function.
 *
 * pathShapeRefusal and the escape check are duplicated in shape and not in code — both call
 * the same helpers safePath does, so a `..` cannot walk out of the journal either. */
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
/** Every record this server writes MECHANICALLY, and therefore the model never may.
 *
 * It matched activity.jsonl alone, while two more grew beside it and neither was guarded:
 *
 *   _ledger.md          appended by ledgerOnClose from the activity log when an initiative
 *                       closes — the outcome, the elapsed hours, the write counts. Reporting
 *                       grades key results FROM this table, so a model that can rewrite it
 *                       can grade its own work.
 *   _knowledge/log.md   appended by journalLog on every journal action.
 *
 * zz-kb-usage already told people all three were "system-written, and the platform refuses
 * anyway". One of the three was true. */
const SYSTEM_FILES = /(^|\/)(_?activity\.jsonl|_ledger\.md|_knowledge\/log\.md)$/;

/** Guards EVERY mutation of the artifact store passes, whichever tool asks.
 *
 * These lived inline in document_write, and document_patch had only the first of them — so a patch
 * could rewrite anything under _versions/, which is the frozen copy of what was approved.
 * snapshotOnApproval exists to make that record un-writable by the model, and one of the
 * two write paths simply did not know. Provenance the platform cannot vouch for is worse
 * than none, because it is still presented as evidence.
 *
 * One function, called by both, so a guard added later cannot land on one path only. */
export function writeGuard(rawPath: string): string | null {
  // NORMALISED FIRST. Every pattern below was matched against the path as the caller wrote
  // it, and one of them anchors at the start — so `a/../_knowledge/nodes/0001-x.md` slipped
  // past the journal guard, and safePath then resolved it to exactly the file the guard
  // exists to protect. document_write could mint a journal node with no evidence, no index.md
  // row and no line in the append-only log, which are the things this guard's own comment
  // says knowledge_add is there to guarantee, and could rewrite a node that the log
  // averages.
  //
  // The other two patterns survived traversal by accident: they match anywhere in the path
  // or at its end. Resolving once here means none of them depends on that luck. Clamping at
  // the root is safe — safePath separately refuses anything that leaves the store.
  const relPath = resolve("/", rawPath).slice(1);
  if (SYSTEM_FILES.test(relPath)) {
    // Names the class, not one member of it: this guard covers the activity log, the
    // outcome ledger and the journal log, and a message about "activity logs" reads as a
    // mismatch when what you tried to write was _ledger.md.
    return "ERROR: that file is a mechanical record — the platform writes it, nothing else may";
  }
  if (/(^|\/)_versions\//.test(relPath)) {
    return "ERROR: _versions/ holds the frozen copy of each approval — written mechanically, never by hand";
  }
  // The whole of _knowledge/, not just its log.
  //
  // log.md was guarded and the nodes beside it were not, so document_write could rewrite a
  // journal node — around knowledge_supersede, which is what makes "knowledge evolves,
  // nothing is deleted" true rather than aspirational — or mint one outright at any id it
  // liked. That node would be indexed and returned by knowledge_search carrying no
  // evidence, no index.md row and no line in the append-only log, which are the four things
  // knowledge_add exists to guarantee.
  //
  // Every legitimate writer here — knowledge_add and knowledge_supersede — writes the file
  // directly and never through this path. (OKR sheets used to live under _knowledge/okrs/
  // and are gone: okr_set and okr_grade were never called once, by anybody, and an opt-in
  // mechanism nobody opted into is a surface to remove rather than a feature to keep.)
  if (/^_knowledge(\/|$)/.test(relPath)) {
    return "ERROR: _knowledge/ is the team's knowledge base, minted by knowledge_add and " +
      "knowledge_supersede — they number the nodes, require the evidence, and write the index " +
      "and the append-only log. A node written by hand has none of that.";
  }
  return null;
}
