/**
 * pinned-read.ts — I-18's cursor/pinned-read adapters and the artifact-level boolean matcher
 * over `retrieval.ts`'s `QueryAst`. One-directional import FROM `retrieval.ts`, the same seam
 * `lanes.ts` (I-17) established: `retrieval.ts` keeps the two functions the frozen check
 * (`checks/tenant-query-syntax.ts`) imports directly (`parseQuery`, `serializeResults`); this
 * file holds everything downstream this task's Contract also names — pinned reads, provenance
 * cursors and read-your-write freshness — without growing `retrieval.ts` past the 700-line
 * ceiling with I-18 layered onto I-16/I-17's own 466 lines.
 *
 * WIRING NOTE. The orchestrator that turns a raw HTTP/tool request into `parseQuery` +
 * `search()` (`lanes.ts`, I-17's own file) + `serializeResults` calls end to end is not in this
 * task's edit surface — `lanes.ts` is I-17's, and this task's Output names "query
 * parsing/serialization, pinned-read/cursor adapters", not the request handler, and the plan's
 * own boundary line says "final deliverable content is not in this plan." `matchesArtifact`
 * below is accordingly a real, independently tested pure function ready for that orchestrator
 * to call — not yet called from inside `lanes.ts`'s `search()`, which this task does not touch.
 *
 * A NAMED GAP ON `record_digest`. `checkVisibility`'s own SELECT (`retrieval.ts`) reads
 * `content_hash` from `zz.search_current/evidence/history` — migration 070
 * (`services/gateway/migrations/070_artifacts_revisions_events_and_scoped_search.sql`) declares
 * no separate `record_digest` column on any of those three tables. `dereferencePinned` below
 * surfaces `content_hash` as `record_digest` rather than inventing a second value nothing in
 * this schema carries; if a future migration adds a genuinely distinct record digest, this is
 * the one place that needs to start reading it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { BooleanClause, CorpusDescriptor, QueryAst, RetrievalClient, RetrievalContext } from "./retrieval.js";
import { checkVisibility, RetrievalError } from "./retrieval.js";

// ── artifact-level AND/OR/NOT, evaluated across passages/fields ────────────────────────────
//
// "Evaluate artifact-level AND/OR/NOT across passages; phrases remain within a field and can
// straddle passage boundaries" (Contract). `fields` maps a field name to every passage
// representation of it this artifact carries — a term may occur in ANY passage of ANY field
// (artifact-level truth, not "all terms in one passage"); a phrase must occur inside ONE
// passage's own text (never spliced across two). Case-insensitive substring matching stands in
// for the real BM25/tsquery match here deliberately: this function proves the AND/OR/NOT
// *structure* is evaluated correctly, the same separation `lanes.ts`'s own header draws between
// "the match predicate is real SQL" and "the ranking expression is unverified."

function containsAnywhere(fields: Readonly<Record<string, readonly string[]>>, needle: string): boolean {
  const target = needle.toLowerCase();
  if (target.length === 0) return true;
  return Object.values(fields).some((passages) => passages.some((p) => p.toLowerCase().includes(target)));
}

/** Inside an `"or"` group, "OR introduces alternatives of which at least one matches" (spec) is
 *  itself a hard condition, unqualified by mode — so an alternative's own `required: false` (a
 *  natural-mode plain word's usual ranking-hint softness) does not apply once it is one of an
 *  OR's operands; every alternative is checked for real containment here. */
function leafMatches(clause: BooleanClause, fields: Readonly<Record<string, readonly string[]>>): boolean {
  return clause.kind === "or" ? clause.alternatives.some((alt) => leafMatches(alt, fields)) : containsAnywhere(fields, clause.value);
}

function clauseMatches(clause: BooleanClause, fields: Readonly<Record<string, readonly string[]>>): boolean {
  if (clause.kind === "phrase") return containsAnywhere(fields, clause.value);
  if (clause.kind === "term") return clause.required ? containsAnywhere(fields, clause.value) : true;
  return leafMatches(clause, fields);
}

/**
 * True when `fields` satisfies `ast`'s whole boolean structure: every top-level clause AND'd,
 * every exclusion NOT'd, an `"or"` clause satisfied by at least one alternative. An unquoted
 * natural-mode word (`required: false`) never fails the match on its own — it is a ranking
 * hint, exactly as `retrieval.ts`'s own `BooleanClause` doc says — so `matchesArtifact` can
 * return `true` for an artifact naming none of a natural query's plain words, so long as it
 * fails no phrase, no required websearch word and no exclusion.
 */
export function matchesArtifact(ast: QueryAst, fields: Readonly<Record<string, readonly string[]>>): boolean {
  if (ast.exclusions.some((term) => containsAnywhere(fields, term))) return false;
  return ast.clauses.every((clause) => clauseMatches(clause, fields));
}

// ── provenance cursors: caller, owner, artifact, revision, sequence and digest, signed ─────
//
// "A cursor pins caller, owner, artifact, revision, effective provenance sequence and record
// digest" (Contract). An opaque, HMAC-signed token — never a bare JSON blob a caller could
// edit — so `decodeCursor` can tell "malformed", "tampered" and "well-formed" apart, all three
// as `INVALID_INPUT` (this layer refuses; it is `checkVisibility`, called separately, that
// decides `NOT_FOUND_OR_FORBIDDEN` for a cursor that authenticates but no longer resolves).

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

/** Refuses, `INVALID_INPUT`, on a wrong version marker, a bad signature (`timingSafeEqual`,
 *  never `===`, so verification time does not leak how much of the signature matched) or a
 *  payload that fails to round-trip through JSON — "invalid or unavailable pinned cursors fail
 *  specifically and never switch to latest" (Contract): there is no fallback branch here to an
 *  unpinned read. */
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

// ── pinned dereference: reauthorize every time, never fall back to latest ──────────────────

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
 * Dereferences one pinned target — "recheck publication/access before ... every dereference/
 * cursor page; revocation is not deferred until index refresh" (spec). Reauthorizes through
 * `checkVisibility` on every call, never trusting a previously issued cursor's own claim: a
 * revoked publication, a since-deleted artifact and an unauthorized caller all answer
 * `NOT_FOUND_OR_FORBIDDEN` here, the same class `checkVisibility` already gives each of them —
 * there is no branch in this function that falls back to an unpinned "current" read on refusal.
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

// ── read-your-write freshness: min_commit_sequence versus indexed_through ──────────────────

export interface FreshnessOutcome {
  readonly ready: boolean;
  readonly reason?: "projection_pending";
}

/**
 * Own-store `min_commit_sequence` waits WITHIN `deadlineMs` for `indexed_through[ownerId]` to
 * reach it, polling `refresh()` — never by reporting success on stale state: "stale results
 * never claim read-your-write" (spec). Timing out still-behind reports `projection_pending`
 * rather than silently serving whatever the projection happened to have. `now`/`sleep` are
 * injected so a suite case can drive this deterministically, without a real clock or a real
 * wait.
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
