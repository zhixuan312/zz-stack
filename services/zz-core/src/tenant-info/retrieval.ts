/**
 * retrieval.ts — I-16's authorized corpus registry/resolution and visibility checks: the one
 * gate every later search lane (I-17), parser/serializer (I-18) and dereference/cursor read
 * consumes before a query ever reaches `zz.search_current`/`evidence`/`history`.
 *
 * TWO FUNCTIONS, ONE CONTRACT. `resolveCorpora` decides WHICH corpus/scope/index
 * combinations this authenticated context may query at all — a pure function over a
 * server-owned registry, never the database. `checkVisibility` decides whether one SPECIFIC
 * artifact is still visible RIGHT NOW — a real query, because "recheck publication/access
 * before serializing results/counts and on every dereference/cursor page; revocation is not
 * deferred until index refresh" (spec, retrieval contract) means the registry's static grant
 * is necessary but not sufficient: a corpus a context may query can still contain, at any one
 * moment, a row that was authorized when the search index last ran and is not any more.
 *
 * THE OWNER PREDICATE LIVES IN THE QUERY TEXT, NEVER ONLY IN A PRIOR JS CHECK OR A PARTIAL
 * INDEX. `buildVisibilityQuery` below binds `owner_id` as an explicit `where` conjunct on
 * every statement it builds — `resolveCorpora`'s own registry gate runs first (so an owner
 * this context cannot see for the requested scope never reaches a query at all, matching "a
 * private descriptor from another owner is excluded before ranking"), but the SQL predicate
 * is not removed just because an earlier gate also checked: this task's own contract says a
 * partial index's `where` clause is "an optimisation, not a permission filter" and that
 * "selecting owner_id in SQL is not accepted as proof of a filtering predicate" — the
 * predicate has to be the thing that actually narrows the result set. `checkVisibility`'s own
 * isolated integration cases (this task's report, not a file this task's edit surface names)
 * prove it behaviorally: two rows sharing a corpus_key and, deliberately, the same
 * artifact_id but different owners, where only the real `where owner_id = $2` clause returns
 * the one the caller actually asked for.
 *
 * WHAT THIS FILE DOES NOT DO. No lane, no ranking, no BM25/GiST query, no query parsing, no
 * wire serialization — I-17 and I-18 add those to this same file. No `audience`/publication
 * write path — that is `policies.ts`'s `publish`/`unpublish` transitions. And the recheck
 * below is honest about a named, inherited gap: `zz.artifact.audience` is always `null` today
 * (`packages/indexing/src/tenant-rebuild.ts`'s own `toProjectionManifest`, `audience: null`),
 * and the search tables migration 070 created carry no audience column of their own — so
 * "still present in the authorized corpus projection right now" is the honest reading of
 * "recheck visibility" available from what I-15 populates today, not a live read of a
 * system-of-record publication flag. I-19's own output line ("completed shared visibility
 * enforcement in all retrieval/read paths") is where that gap closes; this file does not
 * paper over it by pretending `audience` says something it does not yet say.
 */
import { z } from "zod";

// ── the one error every refusal in this file throws ─────────────────────────────────────────
//
// The frozen check (`checks/tenant-scope-predicates.ts`) drives `resolveCorpora` with
// `assert.throws`, never a returned error object — unlike `policies.ts`'s mutation outcomes,
// which are data because a caller commits or does not. Corpus resolution has no such
// two-sided outcome to represent; an invalid request is a programming defect in the caller,
// not a business outcome, so it throws. `code` is carried so a later caller (I-17/I-18, both
// landing in this same file) can build a `MutationError`-shaped response without a second
// error hierarchy — `RESERVED_PAYLOAD_KEYS` in `@zz/contracts` makes the same "unknown/
// disallowed field is a defect, not silently ignored input" argument for `MutationRequestSchema`.

// `REGISTRY_MISCONFIGURED` is deliberately NOT `INVALID_INPUT`. The other two codes are both
// verdicts on a CALLER: it sent a malformed request, or it asked for something it may not
// have. This one is a verdict on the SERVER'S OWN configuration, and a caller can do nothing
// about it and must never be told it did something wrong. It is also why the refusal throws
// rather than returning an empty descriptor list: silently resolving nothing would turn a
// misconfigured deployment into "this tenant has no corpora", which reads as an ordinary
// empty result at every call site above this one.
type RetrievalErrorCode = "INVALID_INPUT" | "NOT_FOUND_OR_FORBIDDEN" | "REGISTRY_MISCONFIGURED";

// Exported at I-18: `pinned-read.ts` (I-18's own split, see this file's tail) throws the same
// error class for cursor/dereference refusals rather than inventing a second hierarchy, the
// same reasoning this section's own comment already gives for carrying `code` in the first
// place.
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

// ── registry, context and request shapes ────────────────────────────────────────────────────

const RetrievalScopeSchema = z.enum(["current", "evidence", "history"]);
/** Exported because `pinned-read.ts`'s `DereferenceTarget` is declared over it — the
 *  visibility recheck moved there at the ceiling and its target type moved with it. */
export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;

/** One row of the server-owned registry `resolveCorpora` is handed — never read from a
 *  database by this function itself; the caller (a future wiring task) owns loading it.
 *  `audience` is the registry's OWN declared grant for this corpus/owner/scope, distinct from
 *  a single artifact's live publication state, which `checkVisibility` re-verifies.
 *
 *  `scope`/`audience` are plain `string`, not the narrower `RetrievalScope`/`"private" |
 *  "published"` unions — the same reasoning `policies.ts`'s `TransitionContext` states for
 *  itself: the frozen check (`checks/tenant-scope-predicates.ts`) builds registry entries as
 *  object literals with no `as const`, and a narrower field type fails that check's own
 *  `typecheck:tooling` pass rather than exercise `resolveCorpora`'s runtime decision. An
 *  unrecognized value in either field is refused at runtime, fail-closed — see the loop
 *  below, which admits an entry only through one of exactly two named branches. */
interface CorpusRegistryEntry {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly scope: string;
  readonly audience: string;
  readonly index_name: string;
}

/** `CorpusDescriptor` is deliberately the same shape as a registry entry — `resolveCorpora`
 *  never adds or drops a field, it only filters which entries this context may see. Exported
 *  for `lanes.ts` (I-17's own file): every lane builder takes one already-authorized
 *  descriptor, never the raw registry or an unauthenticated request. */
export type CorpusDescriptor = CorpusRegistryEntry;

export interface RetrievalContext {
  readonly owner_id: string;
  readonly shared_allowed: boolean;
}

// Filters named by the spec's query grammar section ("type/initiative/flow/tags filters") —
// the only filter vocabulary this task's Contract has anything to validate against. Pushdown
// into a lane's own predicate is I-17's job; this schema only refuses a request naming
// something outside that vocabulary, which is what "unsupported filter... combinations fail
// INVALID_INPUT" asks of THIS task (no lane exists yet to push a filter down into).
const CorpusFiltersSchema = z.object({
  type: z.string().optional(),
  initiative: z.string().optional(),
  flow: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

/** `.strict()`, deliberately, on both this and the filters schema above — the same argument
 *  `MutationRequestSchema` makes in `@zz/contracts` (see that file's own comment): an unknown
 *  top-level field is exactly how a caller would try to smuggle `owner_id`/`index_name` past
 *  the request shape and have it read as data rather than refused. `scopes`, when present,
 *  must be nonempty — an explicitly empty array is "adding history/evidence is explicit"
 *  read backwards (asking for nothing, explicitly) and is refused rather than silently
 *  defaulting to `current` for a caller who deliberately sent `[]`. */
const CorpusRequestSchema = z.object({
  scopes: z.array(RetrievalScopeSchema).min(1).optional(),
  filters: CorpusFiltersSchema.optional(),
}).strict();

function invalidRequest(request: unknown): never {
  const parsed = CorpusRequestSchema.safeParse(request);
  const detail = parsed.success ? "" : parsed.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(request)"}: ${i.message}`).join("; ");
  throw new RetrievalError("INVALID_INPUT",
    `resolveCorpora request is invalid${detail ? ` — ${detail}` : ""}`);
}

/**
 * ONE PHYSICAL INDEX CARRIES ONE OWNER'S DOCUMENTS. A registry that points two owners at the
 * same `index_name` is refused outright, before a single entry is read for scope.
 *
 * WHAT THIS CLOSES, and how it was found. `testing/tenant-info/isolation.ts`'s mutation case
 * takes owner B's corpus, changes nothing but its `index_name` to owner A's, and measures what
 * owner A then sees: A's returned `artifact_id`s are byte-identical before and after — the
 * row-level `owner_id = $n` predicate is untouched and still perfectly correct — and A's bm25
 * scores move anyway, because term and document frequencies live in the index structure the
 * query names, not in the predicate that filters which rows come back. Every row-level check
 * in this delivery passes on that configuration. So does `tenant-scope-predicates`.
 *
 * Which meant the delivery's most emphasised property — one tenant's writes cannot move
 * another's ranking — rested on nothing but a registry nobody validated. The isolation suite
 * could demonstrate the leak but could not name a code change that caused it, because there
 * was no code to change: the invariant existed only as an assumption about configuration.
 * This function is that invariant written down, which is what makes the leak reachable by a
 * mutation test at all.
 *
 * ONE OWNER PER INDEX, NOT ONE CORPUS PER INDEX. The stricter rule would also refuse a single
 * owner serving two scopes from one index, which leaks nothing across tenants and which
 * nothing here has evidence against. This is exactly the property the mutation case proves is
 * load-bearing, and no more.
 *
 * BEFORE THE SCOPE FILTER, deliberately. Checking only the entries a request happens to
 * select would let a misconfigured registry resolve cleanly for `current` and refuse for
 * `history`, so whether the deployment was safe would depend on what the caller asked for.
 */
function assertOneOwnerPerIndex(registry: readonly CorpusRegistryEntry[]): void {
  const ownerByIndex = new Map<string, string>();
  for (const entry of registry) {
    const seen = ownerByIndex.get(entry.index_name);
    if (seen !== undefined && seen !== entry.owner_id) {
      throw new RetrievalError(
        "REGISTRY_MISCONFIGURED",
        `corpus registry points index ${JSON.stringify(entry.index_name)} at two owners ` +
        `(${seen} and ${entry.owner_id}) — one physical index carries one owner's documents, ` +
        "or their term statistics are shared and each one's writes move the other's scores",
      );
    }
    ownerByIndex.set(entry.index_name, entry.owner_id);
  }
}


/**
 * Resolves every corpus/scope/index combination `context` may query for `request` — the
 * ONLY function in this file (or, per the plan, anywhere in the retrieval path) that decides
 * "may this context see this owner's data at this scope". `request` is untrusted input:
 * `owner_id`/`index_name`/anything else it might carry to try to widen access is refused by
 * `.strict()` before a single registry entry is read, which is what "no public owner/index
 * override is accepted" means as code rather than as a promise.
 *
 * "Omitting scopes means current" — `scopes` absent resolves as `["current"]`; `scopes: []`
 * is refused above, not silently read the same way. `filters` is validated but not yet
 * consumed: no lane exists in this task to push a filter down into, so accepting a
 * well-shaped `filters` object without doing anything with it would be pretending to filter.
 * It is kept on the parsed request only so a future lane can read `request.filters` without
 * this function's own validation being duplicated.
 */
export function resolveCorpora(
  context: RetrievalContext,
  request: unknown,
  registry: readonly CorpusRegistryEntry[],
): CorpusDescriptor[] {
  const parsed = CorpusRequestSchema.safeParse(request);
  if (!parsed.success) invalidRequest(request);
  assertOneOwnerPerIndex(registry);

  // `Set<string>`, not `Set<RetrievalScope>` — `entry.scope` is the registry's own widened
  // `string` field (see `CorpusRegistryEntry`'s comment), and membership here is compared
  // against that same width rather than forcing a narrower cast at every call.
  const scopes = new Set<string>(parsed.data.scopes ?? ["current"]);
  const out: CorpusDescriptor[] = [];
  for (const entry of registry) {
    if (!scopes.has(entry.scope)) continue;
    // "Private descriptors require the authenticated owner; published-shared descriptors
    // require shared access and explicit publication." Exactly these two branches, and
    // nothing else ever admits an entry — an audience value this registry format does not
    // declare (neither "private" nor "published") is excluded by falling through both, the
    // same fail-closed shape `decideTransition` (policies.ts) uses for an unrecognized class.
    if (entry.audience === "private" && entry.owner_id === context.owner_id) { out.push(entry); continue; }
    if (entry.audience === "published" && context.shared_allowed) { out.push(entry); continue; }
  }
  return out;
}

// ── what every reader of a search table shares: a client, and the three table names ────────
//
// THE VISIBILITY RECHECK ITSELF LEFT during the registry-isolation fix, at the 700-line
// ceiling — `DereferenceTarget`, `buildVisibilityQuery` and `checkVisibility` are in
// `pinned-read.ts` now, beside the pinned/dereference reader that is their only caller in
// this service. Which half moved was decided by the frozen checks, as it was for inventory.ts
// and policies.ts before it: `tenant-fusion-arithmetic`, `tenant-query-syntax` and
// `tenant-scope-predicates` pin `budgets`/`resultKey`/`rrf`, `parseQuery`/`serializeResults`
// and `resolveCorpora` to THIS module by name, and a frozen check's bytes cannot be edited to
// follow a symbol somewhere else. Nothing pinned `checkVisibility`, so it is what could go.
//
// `RetrievalClient` and `scopeTable` stayed because they are not the visibility path's: the
// client shape is every lane's and every pinned read's, and one migration (070) names these
// three tables while one function says so — `lanes.ts` resolves its lane tables through it.

export interface RetrievalClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

const SCOPE_TABLE: Readonly<Record<RetrievalScope, string>> = {
  current: "zz.search_current",
  evidence: "zz.search_evidence",
  history: "zz.search_history",
};

/** The same closed 3-entry map `buildVisibilityQuery` keys off internally, exported so
 *  `lanes.ts`'s lane builders resolve the identical table name rather than repeating this
 *  mapping — one migration (070) names these three tables; one function says so. Plain
 *  `string` in, fail-closed on anything outside the three scopes this schema actually has. */
export function scopeTable(scope: string): string {
  if (scope !== "current" && scope !== "evidence" && scope !== "history") {
    throw new RetrievalError("INVALID_INPUT", `no search table for scope ${JSON.stringify(scope)}`);
  }
  return SCOPE_TABLE[scope];
}


// ── I-17: budgets, result-key identity and cross-corpus RRF fusion ─────────────────────────
//
// The three pure functions the frozen check (`checks/tenant-fusion-arithmetic.ts`) drives —
// `budgets`, `resultKey`, `rrf` — plus `collapseBeforeCap`, the primitive that makes "passage/
// alias collapse precedes unique-artifact caps" true in code rather than only in prose. Lane
// SQL (exact/BM25/fuzzy/graph) and the orchestrator that calls them live in `lanes.ts`
// (I-17's own split of this file, cleared with the plan owner once `retrieval.ts` was going to
// exceed the 700-line ceiling with I-18 still to land after it) and consume every export below.

/** The four recall lanes, in a fixed order — never the order a caller's `laneLists` happens to
 *  arrive in. `rrf` sums each lane's own max-over-corpora contribution, and summing floats in
 *  a fixed lane order (rather than Map insertion order, which tracks input order) is what
 *  makes `rrf(lists)` and `rrf([...lists].reverse())` produce bit-identical scores — addition
 *  of more than two floats is not associative in general, so "the same inputs produce the same
 *  order" needs a fixed summation order, not just a correct total. */
const LANE_ORDER = ["exact", "lexical", "fuzzy", "graph"] as const;

export interface LaneBudgets {
  readonly exact: number;
  readonly lexical: number;
  readonly fuzzy: number;
  readonly graph: number;
}

/**
 * `exact=min(50,5L)`, `lexical=min(1000,max(200,20L))`, `fuzzy=min(500,max(100,10L))`,
 * `graph=min(200,max(50,5L))` — the spec's fixed functions of the result limit, verbatim.
 * `L` must be an integer 1–50; every other value (including `NaN`, which fails every
 * comparison and would otherwise silently produce budgets of `NaN`) is refused rather than
 * clamped, matching "invalid limit fails" in this task's own Contract.
 */
export function budgets(L: number): LaneBudgets {
  if (!Number.isInteger(L) || L < 1 || L > 50) {
    throw new RetrievalError("INVALID_INPUT", `limit must be an integer between 1 and 50, got ${L}`);
  }
  return {
    exact: Math.min(50, 5 * L),
    lexical: Math.min(1000, Math.max(200, 20 * L)),
    fuzzy: Math.min(500, Math.max(100, 10 * L)),
    graph: Math.min(200, Math.max(50, 5 * L)),
  };
}

/** The fields `resultKey` reads — deliberately plain `string` for `scope`, not the narrower
 *  `RetrievalScope` union, for the same reason `CorpusRegistryEntry`'s own fields are widened
 *  above: the frozen check builds `row` as an object literal with no `as const`, and a
 *  narrower field type here fails `typecheck:tooling` on the check itself rather than exercise
 *  this function's runtime decision. An unrecognized scope is refused, fail-closed. */
export interface ResultIdentity {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly scope: string;
}

/**
 * Scope-specific owner-qualified identity — "current/evidence identity is owner+artifact;
 * history additionally includes revision/hash" (this task's own Contract, and the retrieval
 * contract's own sentence). Two passages or aliases of the SAME artifact collapse to the same
 * key here, before any lane budget is ever applied — that ordering is `collapseBeforeCap`'s
 * job, not this function's, but this is the identity it collapses on.
 */
export function resultKey(record: ResultIdentity): string {
  const { owner_id, artifact_id, revision, content_hash, scope } = record;
  if (scope !== "current" && scope !== "evidence" && scope !== "history") {
    throw new RetrievalError("INVALID_INPUT", `resultKey does not recognize scope ${JSON.stringify(scope)}`);
  }
  return scope === "history"
    ? `${scope}:${owner_id}:${artifact_id}:${revision}:${content_hash}`
    : `${scope}:${owner_id}:${artifact_id}`;
}

/** One lane's ranked key list for one authorized corpus — `lane`/`corpus` deliberately plain
 *  `string`, the same widening `resultKey.scope` uses and for the same reason: the frozen
 *  check builds these as object literals with no `as const`. */
export interface LaneKeyList {
  readonly lane: string;
  readonly corpus: string;
  readonly keys: readonly string[];
}

export interface FusedResult {
  readonly key: string;
  readonly score: number;
}

/**
 * Reciprocal rank fusion, k=60, over positions alone — never a raw lane score, because scores
 * from independent corpora (or independent ranking methods) are not on a comparable scale;
 * that is the whole reason the lanes are fused by RRF rather than by summing whatever each one
 * happened to return. For result key `d`:
 *
 *   score(d) = sum over lanes l of [ max over corpora c of 1 / (60 + r(l,c,d)) ]
 *
 * where `r(l,c,d)` is `d`'s 1-based rank within lane `l`'s list for corpus `c`. A key repeated
 * within one list uses its FIRST rank (the lane's own best local position for it), and a lane
 * takes the BEST of its per-corpus contributions rather than summing them — "the same artifact
 * in private and shared corpus contributes at most once per lane" (retrieval contract). Ties
 * break on `key` ascending; a richer tie-break (tag overlap, then owner/artifact/revision) needs
 * the actual records this function never sees, and lives one level up in `lanes.ts`'s
 * orchestrator, which has them.
 */
export function rrf(laneLists: readonly LaneKeyList[]): FusedResult[] {
  const perLane = new Map<string, Map<string, number>>();
  for (const list of laneLists) {
    const firstRank = new Map<string, number>();
    list.keys.forEach((key, index) => {
      if (!firstRank.has(key)) firstRank.set(key, index + 1);
    });
    let corpusMax = perLane.get(list.lane);
    if (!corpusMax) {
      corpusMax = new Map<string, number>();
      perLane.set(list.lane, corpusMax);
    }
    for (const [key, rank] of firstRank) {
      const contribution = 1 / (60 + rank);
      const best = corpusMax.get(key);
      if (best === undefined || contribution > best) corpusMax.set(key, contribution);
    }
  }

  // Sum in LANE_ORDER, plus any lane the caller passed that isn't one of the four named ones
  // (sorted, appended after) — so an unrecognized lane name still fuses deterministically
  // rather than being silently dropped, while the four real lanes always sum in the same order
  // regardless of `laneLists`' own order.
  const laneNames = [...perLane.keys()];
  const orderedLanes = [
    ...LANE_ORDER.filter((l) => perLane.has(l)),
    ...laneNames.filter((l) => !(LANE_ORDER as readonly string[]).includes(l)).sort(),
  ];

  const totals = new Map<string, number>();
  for (const lane of orderedLanes) {
    const corpusMax = perLane.get(lane);
    if (!corpusMax) continue;
    for (const [key, contribution] of corpusMax) {
      totals.set(key, (totals.get(key) ?? 0) + contribution);
    }
  }

  return [...totals.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
}

/** One raw row a lane query returned, ordered by that lane's own local rank (position in the
 *  array is the rank `collapseBeforeCap` reads) — `identity` is what `resultKey` collapses on;
 *  the row itself carries whatever a lane needs downstream (tags for tie-break, etc). */
export interface RankedRow<T> {
  readonly identity: ResultIdentity;
  readonly row: T;
}

/**
 * Collapses passages/aliases of the same artifact to one entry — keeping the row at the BEST
 * (lowest) local rank — and only THEN slices to `cap`. Doing it in the other order is exactly
 * the mutation this task's report calls out: cap first and a page of "cap" results can really
 * be one artifact's first `cap` passages, or `cap` aliases of two or three real artifacts. This
 * function is deliberately the one place that ordering happens, so a mutation swapping the two
 * steps has exactly one call site to touch and exactly one suite case to fail against.
 */
export function collapseBeforeCap<T>(rows: readonly RankedRow<T>[], cap: number): RankedRow<T>[] {
  const seen = new Map<string, RankedRow<T>>();
  for (const entry of rows) {
    const key = resultKey(entry.identity);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()].slice(0, cap);
}

// ── I-18: query grammar and the actual wire response ────────────────────────────────────────
//
// The two functions the frozen check (`checks/tenant-query-syntax.ts`) imports directly from
// THIS file — everything downstream of a parsed query (matcher, cursors, pinned reads,
// freshness) lives in `pinned-read.ts`, importing FROM here, the same one-directional seam
// `lanes.ts` (I-17) established.
//
// GRAMMAR RECOGNITION PRECEDES IDENTIFIER NORMALIZATION (Contract): `tokenize` recognizes
// quotes, a leading `-` against the next scalar, and the bare word `OR` on the RAW token text,
// before any identifier splitting (dot/underscore/slash/hyphen/colon — `packages/indexing`'s
// job, never this one's) runs. A hyphen inside `plugin-judge` survives as one word; a dot
// inside `zz.eval_finding` is never touched.

export type QueryMode = "natural" | "websearch";

/** The "complete boolean structure" the Contract asks for. `clauses` is an AND across its
 *  top-level entries; `"or"` folds consecutive `OR`-joined operands into one alternatives
 *  group. `"term".required` is `false` in natural mode (an unquoted word is a ranking hint) and
 *  always `true` in websearch mode (which ANDs every word); `"phrase"` is always hard. */
export type BooleanClause =
  | { readonly kind: "term"; readonly value: string; readonly required: boolean }
  | { readonly kind: "phrase"; readonly value: string }
  | { readonly kind: "or"; readonly alternatives: readonly BooleanClause[] };

export interface QueryAst {
  readonly original_text: string;
  readonly mode: QueryMode;
  readonly phrases: readonly string[];
  readonly exclusions: readonly string[];
  readonly clauses: readonly BooleanClause[];
  /** True once nothing is left to rank or require ("no query ... performs metadata browsing",
   *  spec). Only the "no query" half: no stopword list exists in this checkout for PostgreSQL's
   *  pinned `english` configuration, so a non-empty stopword-only query is NOT detected — a
   *  named, carried-forward gap (the same reason `lanes.ts` declines pg_textsearch's DDL). */
  readonly browse: boolean;
}

const MAX_QUERY_SCALARS = 2048;
const MAX_PHRASE_SCALARS = 256;

function isWhitespaceScalar(ch: string | undefined): boolean {
  return ch === undefined || /\s/u.test(ch);
}

interface RawToken {
  readonly kind: "word" | "phrase";
  /** Raw text, unsplit and unnormalized: for `"word"`, after a leading `-` is stripped; for
   *  `"phrase"`, the quoted content. */
  readonly text: string;
  readonly scalarStart: number;
  readonly excluded: boolean;
}

/** Scans `scalars` left to right, recognizing quotes/exclusions/whitespace boundaries alone —
 *  no lowercasing, no splitting on internal punctuation. An unterminated quote in natural mode
 *  is `INVALID_INPUT` naming the opening quote's scalar offset; in websearch mode it is
 *  PostgreSQL's documented tolerance (Text Search §12.3.3) — the phrase runs to end of input,
 *  as if the string's end were an implicit closing quote. */
function tokenize(scalars: readonly string[], mode: QueryMode): RawToken[] {
  const tokens: RawToken[] = [];
  const n = scalars.length;
  let i = 0;
  while (i < n) {
    if (isWhitespaceScalar(scalars[i])) { i++; continue; }
    const tokenStart = i;
    let excluded = false;
    if (scalars[i] === "-" && !isWhitespaceScalar(scalars[i + 1])) {
      excluded = true;
      i++;
    }
    if (scalars[i] === "\"") {
      const contentStart = i + 1;
      let j = contentStart;
      while (j < n && scalars[j] !== "\"") j++;
      if (j >= n) {
        if (mode === "natural") {
          throw new RetrievalError("INVALID_INPUT",
            `unterminated quote at scalar offset ${tokenStart}`);
        }
        tokens.push({ kind: "phrase", text: scalars.slice(contentStart, n).join(""), scalarStart: tokenStart, excluded });
        break;
      }
      tokens.push({ kind: "phrase", text: scalars.slice(contentStart, j).join(""), scalarStart: tokenStart, excluded });
      i = j + 1;
      continue;
    }
    let k = i;
    while (k < n && !isWhitespaceScalar(scalars[k])) k++;
    tokens.push({ kind: "word", text: scalars.slice(i, k).join(""), scalarStart: tokenStart, excluded });
    i = k;
  }
  return tokens;
}

/** Natural's `OR` is the spec's own words — "uppercase OR" — matched case-sensitively; a
 *  lowercase "or" is an ordinary word. Websearch matches case-insensitively, per PostgreSQL's
 *  documented parser (Text Search §12.3.3: "the word `or` will be converted to the `|`
 *  operator") — a documented reading, not a live differential run (no database access here). */
function isOrKeyword(word: string, mode: QueryMode): boolean {
  return mode === "natural" ? word === "OR" : word.toLowerCase() === "or";
}

interface ParsedClauses { readonly clauses: BooleanClause[]; readonly phrases: string[]; readonly exclusions: string[] }

/** Folds `tokens` into the AND-of-(term|phrase|or) structure `QueryAst.clauses` carries. A
 *  dangling `OR` — nothing before it, or nothing after it — contributes no operator and is
 *  dropped rather than guessed at. Exclusions never enter `clauses` or an `OR` group — hard
 *  conditions keep a `-`-prefixed operand in `exclusions` alone. */
function buildClauses(tokens: readonly RawToken[], mode: QueryMode): ParsedClauses {
  const phrases: string[] = [];
  const exclusions: string[] = [];
  const clauses: BooleanClause[] = [];
  let pendingOr = false;
  for (const tok of tokens) {
    if (tok.kind === "word" && !tok.excluded && isOrKeyword(tok.text, mode)) {
      if (clauses.length > 0) pendingOr = true;
      continue;
    }
    let clause: BooleanClause;
    if (tok.kind === "phrase") {
      if ([...tok.text].length > MAX_PHRASE_SCALARS) {
        throw new RetrievalError("INVALID_INPUT", `phrase exceeds ${MAX_PHRASE_SCALARS} scalar values`);
      }
      if (!tok.excluded) phrases.push(tok.text);
      clause = { kind: "phrase", value: tok.text };
    } else {
      clause = { kind: "term", value: tok.text, required: mode === "websearch" };
    }
    if (tok.excluded) {
      exclusions.push(tok.text);
      pendingOr = false;
      continue;
    }
    if (pendingOr && clauses.length > 0) {
      const last = clauses[clauses.length - 1]!;
      clauses[clauses.length - 1] = last.kind === "or"
        ? { kind: "or", alternatives: [...last.alternatives, clause] }
        : { kind: "or", alternatives: [last, clause] };
      pendingOr = false;
    } else {
      clauses.push(clause);
    }
  }
  return { clauses, phrases, exclusions };
}

/** Parses `text` under `mode`'s grammar — natural (new API default) or websearch (legacy
 *  adapters' default). The 2048-scalar query limit applies before tokenizing; the 256-scalar
 *  phrase limit is enforced per phrase inside `buildClauses` — "documented query/phrase length
 *  limits still apply in both modes" (Contract). `original_text` is returned untouched. */
export function parseQuery(text: string, mode: QueryMode): QueryAst {
  const scalars = [...text];
  if (scalars.length > MAX_QUERY_SCALARS) {
    throw new RetrievalError("INVALID_INPUT", `query exceeds ${MAX_QUERY_SCALARS} scalar values`);
  }
  const tokens = tokenize(scalars, mode);
  const { clauses, phrases, exclusions } = buildClauses(tokens, mode);
  return {
    original_text: text,
    mode,
    phrases,
    exclusions,
    clauses,
    browse: clauses.length === 0 && phrases.length === 0 && exclusions.length === 0,
  };
}

// ── I-18: the actual wire response ───────────────────────────────────────────────────────────
//
// `serializeResults` emits the spec's exact `SearchResponse` (schema version 2) directly — the
// candidates it is handed are already `SearchResult`-shaped, so there is no helper-only
// bounded/omitted wrapper and no separate "convert" step.

const RESPONSE_BYTE_BUDGET = 24000;
/** Fields a real search/browse run already knows (exhaustion from `lanes.ts`'s `search()`,
 *  `mode_used` from `parseQuery`) — folded with `"response_budget"`, never replaced. */
export interface ResultEnvelope {
  readonly index_generation: string;
  readonly indexed_through: Readonly<Record<string, number>>;
  readonly candidate_total: number;
  readonly mode_used: "natural" | "websearch" | "browse";
  readonly incomplete: boolean;
  readonly reasons: readonly string[];
}

/** Widened the same way `CorpusRegistryEntry`/`ResultIdentity` already are: the frozen check's
 *  fixture rows carry no `as const`, so enum fields are plain `string` here, not
 *  `SearchResultSchema`'s narrower unions — `safeParse` still proves the runtime shape. */
interface WireResult {
  readonly ref: { readonly owner_id: string; readonly artifact_id: string; readonly revision: number | null; readonly content_hash: string; readonly selector?: string };
  readonly record_digest: string; readonly etag: string; readonly path: string; readonly title: string;
  readonly artifact_class: string; readonly type: string; readonly scope: string; readonly shelf: string;
  readonly gate_status: string | null; readonly knowledge_status: string | null; readonly profile: string;
  readonly source_refs: readonly unknown[]; readonly source_refs_truncated: boolean; readonly source_refs_cursor: string | null;
  readonly snippet: string; readonly snippet_byte_start: number; readonly snippet_byte_end: number;
  readonly via: readonly string[]; readonly corpora: readonly string[]; readonly score: number;
}

/** Builds the JSON wire string for `SearchResponseSchema`, holding results+metadata+cursors to
 *  at most 24000 UTF-8 bytes. Tries the full candidate list first; on overflow, drops one
 *  trailing candidate at a time and re-measures — never stops mid-record. The request's own
 *  `limit` (1–50) bounds `candidateResults.length` in production, so at most 51 stringify
 *  passes. Truncation is disclosed: `incomplete: true`, `"response_budget"` in `reasons`, and
 *  `withheld_candidates` counting exactly what this function withheld. */
export function serializeResults(candidateResults: readonly WireResult[], envelope: ResultEnvelope): string {
  for (let n = candidateResults.length; n >= 0; n--) {
    const truncated = n < candidateResults.length;
    const reasons = new Set(envelope.reasons);
    if (truncated) reasons.add("response_budget");
    const response = {
      schema_version: 2 as const,
      results: candidateResults.slice(0, n),
      index_generation: envelope.index_generation,
      indexed_through: envelope.indexed_through,
      returned: n,
      candidate_total: envelope.candidate_total,
      withheld_candidates: candidateResults.length - n,
      incomplete: envelope.incomplete || truncated,
      reasons: [...reasons],
      mode_used: envelope.mode_used,
    };
    const wire = JSON.stringify(response);
    if (Buffer.byteLength(wire, "utf8") <= RESPONSE_BYTE_BUDGET) return wire;
  }
  // Even zero results overflow: every remaining byte is envelope metadata this function has
  // nothing left to drop. Surfacing this beats emitting a wire string over the disclosed budget.
  throw new RetrievalError("INVALID_INPUT", "response envelope metadata alone exceeds the response byte budget");
}
