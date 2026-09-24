/**
 * pinned-read.ts — the cursor and pinned-read adapters, and the artifact-level boolean matcher over
 * `retrieval.ts`'s `QueryAst`. One-directional import from `retrieval.ts`, the same seam `lanes.ts`
 * established: `retrieval.ts` keeps the two functions the frozen check
 * (`checks/tenant-query-syntax.ts`) imports directly (`parseQuery`, `serializeResults`); this file
 * holds pinned reads, provenance cursors and read-your-write freshness.
 *
 * `matchesArtifact` below is a pure function; `search.ts` calls it after ranking, not `lanes.ts`.
 *
 * A named gap on `record_digest`: `checkVisibility`'s own SELECT reads `content_hash` from
 * `zz.search_current/evidence/history`, and the schema declares no separate `record_digest` column on
 * any of the three. `dereferencePinned` below surfaces `content_hash` as `record_digest` rather than
 * inventing a second value nothing in this schema carries; if a future migration adds a genuinely
 * distinct record digest, this is the one place that needs to start reading it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { BooleanClause, CorpusDescriptor, QueryAst, RetrievalClient, RetrievalContext, RetrievalScope } from "./retrieval.js";
import { resolveCorpora, RetrievalError, scopeTable } from "./retrieval.js";

// Artifact-level AND/OR/NOT, evaluated across passages. `fields` maps a field name to every passage
// representation of it this artifact carries — a term may occur in any passage of any field
// (artifact-level truth, not "all terms in one passage"); a phrase must occur inside one passage's
// own text, never spliced across two. Case-insensitive substring matching stands in for the real
// BM25/tsquery match: this function proves the AND/OR/NOT structure is evaluated correctly, not that
// the ranking expression is.

function containsAnywhere(fields: Readonly<Record<string, readonly string[]>>, needle: string): boolean {
  const target = needle.toLowerCase();
  if (target.length === 0) return true;
  return Object.values(fields).some((passages) => passages.some((p) => p.toLowerCase().includes(target)));
}

/** Inside an `"or"` group, "at least one alternative matches" is itself a hard condition, unqualified
 *  by mode — an alternative's own `required: false` (a natural-mode plain word's ranking-hint
 *  softness) does not apply once it is one of an OR's operands. */
function leafMatches(clause: BooleanClause, fields: Readonly<Record<string, readonly string[]>>): boolean {
  return clause.kind === "or" ? clause.alternatives.some((alt) => leafMatches(alt, fields)) : containsAnywhere(fields, clause.value);
}

function clauseMatches(clause: BooleanClause, fields: Readonly<Record<string, readonly string[]>>): boolean {
  if (clause.kind === "phrase") return containsAnywhere(fields, clause.value);
  if (clause.kind === "term") return clause.required ? containsAnywhere(fields, clause.value) : true;
  return leafMatches(clause, fields);
}

/**
 * True when `fields` satisfies `ast`'s whole boolean structure: every top-level clause AND'd, every
 * exclusion NOT'd, an `"or"` clause satisfied by at least one alternative. An unquoted natural-mode
 * word (`required: false`) never fails the match on its own — it is a ranking hint — so this can
 * return `true` for an artifact naming none of a natural query's plain words, so long as it fails no
 * phrase, no required websearch word and no exclusion.
 */
export function matchesArtifact(ast: QueryAst, fields: Readonly<Record<string, readonly string[]>>): boolean {
  if (ast.exclusions.some((term) => containsAnywhere(fields, term))) return false;
  return ast.clauses.every((clause) => clauseMatches(clause, fields));
}

// Provenance cursors: caller, owner, artifact, revision, effective provenance sequence and record
// digest, HMAC-signed — never a bare JSON blob a caller could edit — so `decodeCursor` can tell
// "malformed", "tampered" and "well-formed" apart, all three as `INVALID_INPUT`. `checkVisibility`,
// called separately, decides `NOT_FOUND_OR_FORBIDDEN` for a cursor that authenticates but no longer
// resolves.

export interface CursorPayload {
  readonly caller_id: string;
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly sequence: number;
  readonly record_digest: string;
}

const CURSOR_VERSION = "c1";

function sign(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

function isCursorPayload(v: unknown): v is CursorPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.caller_id === "string" && typeof o.owner_id === "string" && typeof o.artifact_id === "string"
    && typeof o.revision === "number" && typeof o.sequence === "number" && typeof o.record_digest === "string";
}

export function encodeCursor(key: string, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${CURSOR_VERSION}.${body}.${sign(key, body)}`;
}

/** Refuses with `INVALID_INPUT` on a wrong version marker, a bad signature (`timingSafeEqual`, never
 *  `===`, so verification time does not leak how much of the signature matched) or a payload that
 *  fails to round-trip through JSON. There is no fallback branch here to an unpinned read. */
export function decodeCursor(key: string, cursor: string): CursorPayload {
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) {
    throw new RetrievalError("INVALID_INPUT", "malformed provenance cursor");
  }
  const [, body, sig] = parts as [string, string, string];
  const expected = sign(key, body);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new RetrievalError("INVALID_INPUT", "provenance cursor failed authentication");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new RetrievalError("INVALID_INPUT", "provenance cursor payload is not valid JSON");
  }
  if (!isCursorPayload(payload)) throw new RetrievalError("INVALID_INPUT", "provenance cursor payload is malformed");
  return payload;
}

// Pinned dereference: reauthorize every time, never fall back to latest

export interface PinnedReadTarget {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly scope: "current" | "evidence" | "history";
  readonly revision?: number | null;
}

export interface PinnedReadResult {
  readonly ref: { readonly owner_id: string; readonly artifact_id: string; readonly revision: number; readonly content_hash: string };
  readonly record_digest: string;
  readonly source_refs: readonly unknown[];
  readonly source_refs_truncated: boolean;
  readonly source_refs_cursor: string | null;
}

/**
 * Dereferences one pinned target, reauthorizing through `checkVisibility` on every call and never
 * trusting a previously issued cursor's own claim: a revoked publication, a since-deleted artifact
 * and an unauthorized caller all answer `NOT_FOUND_OR_FORBIDDEN`. No branch in this function falls
 * back to an unpinned "current" read on refusal.
 */
export async function dereferencePinned(
  client: RetrievalClient,
  context: RetrievalContext,
  registry: readonly CorpusDescriptor[],
  target: PinnedReadTarget,
): Promise<PinnedReadResult> {
  const outcome = await checkVisibility(client, context, registry, {
    owner_id: target.owner_id, artifact_id: target.artifact_id, scope: target.scope, revision: target.revision,
  });
  if (!outcome.ok) throw new RetrievalError("NOT_FOUND_OR_FORBIDDEN", "pinned target is not visible");
  const row = outcome.row;
  return {
    ref: { owner_id: row.owner_id, artifact_id: row.artifact_id, revision: row.revision, content_hash: row.content_hash },
    record_digest: row.content_hash,
    source_refs: [],
    source_refs_truncated: false,
    source_refs_cursor: null,
  };
}

// Read-your-write freshness: min_commit_sequence versus indexed_through

export interface FreshnessOutcome {
  readonly ready: boolean;
  readonly reason?: "projection_pending";
}

/**
 * Own-store `min_commit_sequence` waits within `deadlineMs` for `indexed_through[ownerId]` to reach
 * it, polling `refresh()`. Timing out still-behind reports `projection_pending` rather than silently
 * serving whatever the projection happened to have. `now`/`sleep` are injected so a suite case can
 * drive this deterministically, without a real clock or a real wait.
 */
export async function waitForOwnStoreFreshness(
  ownerId: string,
  minCommitSequence: number | undefined,
  refresh: () => Promise<Readonly<Record<string, number>>>,
  deadlineMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
): Promise<FreshnessOutcome> {
  if (minCommitSequence === undefined) return { ready: true };
  const startedAt = now();
  let indexedThrough = await refresh();
  while ((indexedThrough[ownerId] ?? 0) < minCommitSequence) {
    if (now() - startedAt >= deadlineMs) return { ready: false, reason: "projection_pending" };
    await sleep(25);
    indexedThrough = await refresh();
  }
  return { ready: true };
}

// The visibility recheck every dereference and cursor read issues.
//
// COUPLED: `checkVisibility` lives here rather than in `retrieval.ts` because three frozen checks pin
// `budgets`/`resultKey`/`rrf`, `parseQuery`/`serializeResults` and `resolveCorpora` to `retrieval.js`
// by name, and a frozen check's bytes cannot be edited to follow a symbol somewhere else. This file
// is `checkVisibility`'s only caller in the service.
//
// The `scopeTable` accessor is `retrieval.ts`'s own closed 3-entry lookup with a fail-closed guard,
// the same one `lanes.ts` resolves its lane tables through. The registry parameter is typed
// `CorpusDescriptor`, which `retrieval.ts` declares as exactly `CorpusRegistryEntry`.

/** What a caller is asking to dereference — an `ArtifactRef`-shaped target, not a search
 *  result: `scope` is supplied by the caller's own prior authorized resolution (which lane
 *  or scope it came from), never guessed here. */
interface DereferenceTarget {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly scope: RetrievalScope;
  /** Required when `scope === "history"` — history identity is owner+artifact+revision, and `zz.search_history`'s own primary key
   *  carries `revision` for exactly that reason. */
  readonly revision?: number | null;
}

interface VisibilityQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Builds the one statement `checkVisibility` runs — separated out so an isolated integration case can
 * assert on its text and params directly, and so a mutation test can remove the `owner_id` conjunct
 * from exactly this function and watch the behavioural case go red naming `checkVisibility`, never a
 * source-text scan of this file.
 *
 * `descriptor.corpus_key`/`descriptor.owner_id` are bound, never `target`'s own fields: the registry,
 * not user input, determines which value the query text is ever built from. The table keys off
 * `target.scope` instead, because that field carries the narrow `RetrievalScope` type this closed
 * 3-entry map is declared over, and `resolveCorpora` filtering on `scopes.has(entry.scope)` already
 * guarantees `descriptor.scope === target.scope`.
 */
function buildVisibilityQuery(descriptor: CorpusDescriptor, target: DereferenceTarget): VisibilityQuery {
  const table = scopeTable(target.scope); // closed 3-entry map, never caller text
  if (target.scope === "history") {
    if (typeof target.revision !== "number") {
      throw new RetrievalError("INVALID_INPUT", "a history dereference requires an explicit revision");
    }
    return {
      text: `select corpus_key, owner_id, artifact_id, revision, content_hash from ${table} `
        + "where corpus_key = $1 and owner_id = $2 and artifact_id = $3 and revision = $4",
      params: [descriptor.corpus_key, descriptor.owner_id, target.artifact_id, target.revision],
    };
  }
  return {
    text: `select corpus_key, owner_id, artifact_id, revision, content_hash from ${table} `
      + "where corpus_key = $1 and owner_id = $2 and artifact_id = $3",
    params: [descriptor.corpus_key, descriptor.owner_id, target.artifact_id],
  };
}

interface VisibilityRow {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
}

type VisibilityOutcome =
  | { readonly ok: true; readonly row: VisibilityRow }
  | { readonly ok: false; readonly code: "NOT_FOUND_OR_FORBIDDEN" };

/**
 * Re-verifies one artifact is visible to `context` right now — before response serialization, direct
 * dereference and cursor paging. Two gates, in order:
 *
 *   1. `resolveCorpora` against the same registry and context a search request would use, scoped to
 *      `target.scope` alone. No entry naming `target.owner_id` → `NOT_FOUND_OR_FORBIDDEN` with no
 *      query issued: an unauthorized owner never reaches the database.
 *   2. The real query `buildVisibilityQuery` produces, against the resolved descriptor's own
 *      `corpus_key`/`owner_id`. Empty rows → `NOT_FOUND_OR_FORBIDDEN`, the same code step 1 gives, so
 *      an unauthorized target and one that genuinely has nothing there are indistinguishable.
 */
export async function checkVisibility(
  client: RetrievalClient,
  context: RetrievalContext,
  registry: readonly CorpusDescriptor[],
  target: DereferenceTarget,
): Promise<VisibilityOutcome> {
  const authorized = resolveCorpora(context, { scopes: [target.scope] }, registry)
    .find((descriptor) => descriptor.owner_id === target.owner_id);
  if (!authorized) return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" };

  const query = buildVisibilityQuery(authorized, target);
  const result = await client.query<VisibilityRow>(query.text, query.params);
  const row = result.rows[0];
  if (!row) return { ok: false, code: "NOT_FOUND_OR_FORBIDDEN" };
  return { ok: true, row };
}
