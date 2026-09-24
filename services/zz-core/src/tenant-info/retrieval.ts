/**
 * Authorized corpus resolution for tenant search: the gate every search lane, parser and
 * dereference read passes before a query reaches `zz.search_current`/`evidence`/`history`.
 *
 * `resolveCorpora` decides which corpus/scope/index combinations a context may query — pure
 * over a server-owned registry, never the database. The visibility recheck (`pinned-read.ts`)
 * decides whether one artifact is visible right now, with a real query: a corpus a context may
 * query can still hold a row that was authorized when the index last ran and is not any more.
 *
 * DELIBERATE: the visibility query binds `owner_id` as an explicit `where` conjunct even
 * though the registry gate already ran. A partial index's `where` clause is an optimisation,
 * not a permission filter; the SQL predicate has to be what narrows the result set.
 *
 * `zz.artifact.audience` is `null` for every row today and the search tables carry no audience
 * column, so the recheck means "still in the authorized corpus projection", not a read of a
 * publication flag. COUPLED: `packages/indexing/src/tenant-rebuild.ts`'s
 * `toProjectionManifest` sets that null; publication transitions live in `policies.ts`.
 */
import { z } from "zod";

// The one error every refusal in this file throws
//
// Corpus resolution throws rather than returning an outcome object: an invalid request is a
// caller defect, not a two-sided outcome the way `policies.ts`'s mutations are. `code` is
// carried so a caller can build a `MutationError`-shaped response without a second hierarchy.
// COUPLED: `checks/tenant-scope-predicates.ts` drives `resolveCorpora` with `assert.throws`.

// DELIBERATE: `REGISTRY_MISCONFIGURED` is not `INVALID_INPUT` — it is a verdict on the
// server's own configuration, which the caller can do nothing about. It throws rather than
// resolving an empty descriptor list, which would read as "this tenant has no corpora".
type RetrievalErrorCode = "INVALID_INPUT" | "NOT_FOUND_OR_FORBIDDEN" | "REGISTRY_MISCONFIGURED";

// COUPLED: `pinned-read.ts` throws this same error class for cursor and dereference refusals.
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

// Registry, context and request shapes

const RetrievalScopeSchema = z.enum(["current", "evidence", "history"]);
/** COUPLED: `pinned-read.ts`'s `DereferenceTarget` is declared over this. */
export type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;

/** One row of the server-owned registry `resolveCorpora` is handed — never read from a
 *  database by this function; the caller owns loading it. `audience` is the registry's declared
 *  grant for this corpus/owner/scope, distinct from an artifact's live publication state. An
 *  unrecognized value in `scope` or `audience` is refused at runtime by the loop below.
 *
 *  DELIBERATE: both are plain `string`, not the narrower unions.
 *  COUPLED: `checks/tenant-scope-predicates.ts` builds registry entries as object literals with
 *  no `as const`, and a narrower field type fails its `typecheck:tooling` pass. */
interface CorpusRegistryEntry {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly scope: string;
  readonly audience: string;
  readonly index_name: string;
}

/** Same shape as a registry entry: `resolveCorpora` never adds or drops a field, it only
 *  filters which entries a context may see. COUPLED: `lanes.ts`'s lane builders each take one
 *  already-authorized descriptor, never the raw registry. */
export type CorpusDescriptor = CorpusRegistryEntry;

export interface RetrievalContext {
  readonly owner_id: string;
  readonly shared_allowed: boolean;
}

// The whole filter vocabulary this schema validates against. A request naming anything outside
// it is refused; pushdown into a lane's own predicate happens in `lanes.ts`, not here.
const CorpusFiltersSchema = z.object({
  type: z.string().optional(),
  initiative: z.string().optional(),
  flow: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

/** `.strict()` on both this and the filters schema: an unknown top-level field is how a caller
 *  would smuggle `owner_id`/`index_name` past the request shape and have it read as data.
 *  `scopes`, when present, must be nonempty — an explicit `[]` is refused rather than silently
 *  defaulting to `current`. */
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
 * One physical index carries one visibility scope — one owner and one audience. A registry
 * pointing two owners, or two audiences of the same owner, at one `index_name` is refused.
 * Term and document frequencies live in the index structure a query names, not in the row
 * predicate, so a shared index moves ranking scores while every returned row stays correct.
 *
 * DELIBERATE: one owner per index, not one corpus per index — a single owner serving two
 * scopes from one index is allowed.
 * DELIBERATE: this runs before the scope filter, so a misconfigured registry cannot resolve
 * cleanly for `current` and refuse for `history`.
 */
function assertOneVisibilityScopePerIndex(registry: readonly CorpusRegistryEntry[]): void {
  const seenByIndex = new Map<string, { owner_id: string; audience: string }>();
  for (const entry of registry) {
    const seen = seenByIndex.get(entry.index_name);
    if (seen !== undefined && seen.owner_id !== entry.owner_id) {
      throw new RetrievalError(
        "REGISTRY_MISCONFIGURED",
        `corpus registry points index ${JSON.stringify(entry.index_name)} at two owners ` +
        `(${seen.owner_id} and ${entry.owner_id}) — one physical index carries one owner's ` +
        "documents, or their term statistics are shared and each one's writes move the other's scores",
      );
    }
    if (seen !== undefined && seen.audience !== entry.audience) {
      throw new RetrievalError(
        "REGISTRY_MISCONFIGURED",
        `corpus registry points index ${JSON.stringify(entry.index_name)} at two audiences ` +
        `(${seen.audience} and ${entry.audience}) for owner ${entry.owner_id} — a shared reader's ` +
        "ranking would be moved by that owner's private content, which they cannot see and " +
        "cannot ask about",
      );
    }
    seenByIndex.set(entry.index_name, { owner_id: entry.owner_id, audience: entry.audience });
  }
}


/**
 * Resolves every corpus/scope/index combination `context` may query for `request` — the only
 * place that decides "may this context see this owner's data at this scope". `request` is
 * untrusted: `owner_id`/`index_name`/any other field is refused by `.strict()` before a
 * registry entry is read.
 *
 * `scopes` absent resolves as `["current"]`; `scopes: []` is refused above. `filters` is
 * validated and kept on the parsed request but not consumed here.
 */
export function resolveCorpora(
  context: RetrievalContext,
  request: unknown,
  registry: readonly CorpusRegistryEntry[],
): CorpusDescriptor[] {
  const parsed = CorpusRequestSchema.safeParse(request);
  if (!parsed.success) invalidRequest(request);
  assertOneVisibilityScopePerIndex(registry);

  // `Set<string>` matches `entry.scope`'s widened `string` type, rather than forcing a narrower
  // cast at every membership test.
  const scopes = new Set<string>(parsed.data.scopes ?? ["current"]);
  const out: CorpusDescriptor[] = [];
  for (const entry of registry) {
    if (!scopes.has(entry.scope)) continue;
    // Exactly two branches admit an entry: private requires the authenticated owner, published
    // requires shared access. An audience value that is neither falls through both, fail-closed.
    if (entry.audience === "private" && entry.owner_id === context.owner_id) { out.push(entry); continue; }
    if (entry.audience === "published" && context.shared_allowed) { out.push(entry); continue; }
  }
  return out;
}

// What every reader of a search table shares: a client, and the three table names
//
// COUPLED: the visibility recheck — `DereferenceTarget`, `buildVisibilityQuery`,
// `checkVisibility` — lives in `pinned-read.ts`. The frozen checks `tenant-fusion-arithmetic`,
// `tenant-query-syntax` and `tenant-scope-predicates` pin `budgets`/`resultKey`/`rrf`,
// `parseQuery`/`serializeResults` and `resolveCorpora` to this module by name, so those cannot
// move. `lanes.ts` resolves its lane tables through `scopeTable`.

export interface RetrievalClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

const SCOPE_TABLE: Readonly<Record<RetrievalScope, string>> = {
  current: "zz.search_current",
  evidence: "zz.search_evidence",
  history: "zz.search_history",
};

/** The same closed 3-entry map the visibility query keys off, exported so `lanes.ts`'s lane
 *  builders resolve the identical table name. Plain `string` in, fail-closed on anything
 *  outside the three scopes. */
export function scopeTable(scope: string): string {
  if (scope !== "current" && scope !== "evidence" && scope !== "history") {
    throw new RetrievalError("INVALID_INPUT", `no search table for scope ${JSON.stringify(scope)}`);
  }
  return SCOPE_TABLE[scope];
}
// Budgets, result-key identity and cross-corpus RRF fusion
//
// COUPLED: `checks/tenant-fusion-arithmetic.ts` drives `budgets`, `resultKey` and `rrf`. Lane
// SQL (exact/BM25/fuzzy/graph) and the orchestrator that calls them live in `lanes.ts` and
// consume every export below.

/** The four recall lanes, in a fixed order — never the order a caller's `laneLists` arrives in.
 *  DELIBERATE: `rrf` sums in this order rather than Map insertion order. Float addition is not
 *  associative, so a fixed summation order is what makes `rrf(lists)` and
 *  `rrf([...lists].reverse())` produce bit-identical scores. */
const LANE_ORDER = ["exact", "lexical", "fuzzy", "graph"] as const;

export interface LaneBudgets {
  readonly exact: number;
  readonly lexical: number;
  readonly fuzzy: number;
  readonly graph: number;
}

/**
 * `exact=min(50,5L)`, `lexical=min(1000,max(200,20L))`, `fuzzy=min(500,max(100,10L))`,
 * `graph=min(200,max(50,5L))`. `L` must be an integer 1–50; every other value, `NaN` included,
 * is refused rather than clamped.
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

/** The fields `resultKey` reads. DELIBERATE: `scope` is plain `string`, not `RetrievalScope`.
 *  COUPLED: the frozen check builds `row` as an object literal with no `as const`, and a
 *  narrower type here fails `typecheck:tooling` on the check. An unrecognized scope is
 *  refused, fail-closed. */
export interface ResultIdentity {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly scope: string;
}

/**
 * Scope-specific owner-qualified identity: current/evidence is owner+artifact, history adds
 * revision and content hash. Two passages or aliases of the same artifact collapse to the same
 * key, which `collapseBeforeCap` applies before any lane budget.
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

/** One lane's ranked key list for one authorized corpus. `lane`/`corpus` are plain `string`
 *  for the same reason as `ResultIdentity.scope`. */
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
 * Reciprocal rank fusion, k=60. DELIBERATE: over positions alone, never a raw lane score —
 * scores from independent corpora or ranking methods are not on a comparable scale.
 *
 *   score(d) = sum over lanes l of [ max over corpora c of 1 / (60 + r(l,c,d)) ]
 *
 * where `r(l,c,d)` is `d`'s 1-based rank within lane `l`'s list for corpus `c`. A key repeated
 * within one list uses its first rank; a lane takes the best of its per-corpus contributions
 * rather than summing them, so one artifact in a private and a shared corpus contributes at
 * most once per lane. Ties break on `key` ascending; the richer tie-break needs records this
 * function never sees and lives in `lanes.ts`'s orchestrator.
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

  // Sum in LANE_ORDER, then any lane the caller passed that is not one of the four, sorted and
  // appended — an unrecognized lane name still fuses deterministically instead of being dropped.
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

/** One raw row a lane query returned; array position is that lane's local rank. `identity` is
 *  what `resultKey` collapses on, and the row carries whatever a lane needs downstream. */
export interface RankedRow<T> {
  readonly identity: ResultIdentity;
  readonly row: T;
}

/**
 * Collapses passages and aliases of the same artifact to one entry — keeping the row at the
 * best (lowest) local rank — and only then slices to `cap`. DELIBERATE: capping first turns a
 * page of `cap` results into one artifact's first `cap` passages.
 */
export function collapseBeforeCap<T>(rows: readonly RankedRow<T>[], cap: number): RankedRow<T>[] {
  const seen = new Map<string, RankedRow<T>>();
  for (const entry of rows) {
    const key = resultKey(entry.identity);
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()].slice(0, cap);
}

// Query grammar and the wire response
//
// COUPLED: `checks/tenant-query-syntax.ts` imports `parseQuery` and `serializeResults` from
// this file. Matcher, cursors, pinned reads and freshness live in `pinned-read.ts`.
//
// Grammar recognition precedes identifier normalization: `tokenize` recognizes quotes, a
// leading `-` against the next scalar, and the bare word `OR` on the raw token text, before any
// identifier splitting (`packages/indexing`'s job). A hyphen inside `plugin-judge` survives as
// one word; a dot inside `zz.eval_finding` is never touched.

export type QueryMode = "natural" | "websearch";

/** `clauses` is an AND across its top-level entries; `"or"` folds consecutive `OR`-joined
 *  operands into one alternatives group. `"term".required` is `false` in natural mode (an
 *  unquoted word is a ranking hint) and always `true` in websearch mode; `"phrase"` is always
 *  hard. */
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
  /** True once nothing is left to rank or require, which makes the request metadata browsing.
   *  Detects only an empty query: no stopword list exists in this checkout for PostgreSQL's
   *  pinned `english` configuration, so a stopword-only query is not detected. */
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

/** Scans `scalars` left to right, recognizing quotes, exclusions and whitespace boundaries
 *  alone — no lowercasing, no splitting on internal punctuation. An unterminated quote is
 *  `INVALID_INPUT` in natural mode, naming the opening quote's scalar offset; in websearch mode
 *  the phrase runs to end of input, matching PostgreSQL's documented tolerance. */
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

/** Natural mode matches `OR` case-sensitively, so a lowercase "or" is an ordinary word.
 *  Websearch matches case-insensitively, per PostgreSQL's documented parser. */
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

/** Parses `text` under `mode`'s grammar. The 2048-scalar query limit applies before tokenizing;
 *  the 256-scalar phrase limit is enforced per phrase inside `buildClauses`. `original_text` is
 *  returned untouched. */
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

// The wire response
//
// `serializeResults` emits the spec's `SearchResponse` (schema version 2) directly; the
// candidates it is handed are already `SearchResult`-shaped.

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

/** Enum fields are plain `string`, not `SearchResultSchema`'s narrower unions, because the
 *  frozen check's fixture rows carry no `as const`. `safeParse` still proves the runtime shape. */
interface WireResult {
  readonly ref: { readonly owner_id: string; readonly artifact_id: string; readonly revision: number | null; readonly content_hash: string; readonly selector?: string };
  readonly record_digest: string; readonly etag: string; readonly path: string; readonly title: string;
  readonly artifact_class: string; readonly type: string; readonly scope: string; readonly shelf: string;
  readonly gate_status: string | null; readonly knowledge_status: string | null; readonly profile: string;
  readonly source_refs: readonly unknown[]; readonly source_refs_truncated: boolean; readonly source_refs_cursor: string | null;
  readonly snippet: string; readonly snippet_byte_start: number; readonly snippet_byte_end: number;
  readonly via: readonly string[]; readonly corpora: readonly string[]; readonly score: number;
}

/** Builds the JSON wire string for `SearchResponseSchema`, held to RESPONSE_BYTE_BUDGET. Tries
 *  the full candidate list, then drops one trailing candidate at a time and re-measures — never
 *  stops mid-record. Truncation is disclosed: `incomplete: true`, `"response_budget"` in
 *  `reasons`, and `withheld_candidates`. */
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
