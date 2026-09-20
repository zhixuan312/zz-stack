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

type RetrievalErrorCode = "INVALID_INPUT" | "NOT_FOUND_OR_FORBIDDEN";

class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

// ── registry, context and request shapes ────────────────────────────────────────────────────

const RetrievalScopeSchema = z.enum(["current", "evidence", "history"]);
type RetrievalScope = z.infer<typeof RetrievalScopeSchema>;

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
 *  never adds or drops a field, it only filters which entries this context may see. */
type CorpusDescriptor = CorpusRegistryEntry;

interface RetrievalContext {
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

// ── visibility recheck: the real query every dereference/cursor read issues ────────────────

interface RetrievalClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** What a caller is asking to dereference — an `ArtifactRef`-shaped target, not a search
 *  result: `scope` is supplied by the caller's own prior authorized resolution (which lane
 *  or scope it came from), never guessed here. */
interface DereferenceTarget {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly scope: RetrievalScope;
  /** Required when `scope === "history"` — history identity is owner+artifact+revision
   *  ("history includes revision/hash", spec), and `zz.search_history`'s own primary key
   *  carries `revision` for exactly that reason. */
  readonly revision?: number | null;
}

const SCOPE_TABLE: Readonly<Record<RetrievalScope, string>> = {
  current: "zz.search_current",
  evidence: "zz.search_evidence",
  history: "zz.search_history",
};

interface VisibilityQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * Builds the one statement `checkVisibility` runs — separated out so an isolated integration
 * case can assert on its text/params directly, and so a mutation test can remove the
 * `owner_id` conjunct from exactly this function and watch the behavioral case go red naming
 * `checkVisibility`, never a source-text scan of this file.
 *
 * `descriptor.corpus_key`/`descriptor.owner_id` are bound, never `target`'s own fields
 * directly — by the time this runs, `resolveCorpora` has already proven `descriptor.owner_id
 * === target.owner_id` for an authorized scope, but binding from the descriptor rather than
 * re-reading the caller's own object is what "the registry, not user input, determines SQL
 * identifiers; values remain bound parameters" asks for as a matter of which value the query
 * text is ever built from, not only which value it happens to equal. The TABLE, though, keys
 * off `target.scope` rather than `descriptor.scope` — the caller's own field carries the
 * narrow `RetrievalScope` type this closed 3-entry map is declared over, and `resolveCorpora`
 * having filtered on `scopes.has(entry.scope)` already guarantees `descriptor.scope ===
 * target.scope` structurally; typing the lookup off the narrower field avoids re-widening a
 * value this function never needed loosely typed in the first place.
 */
function buildVisibilityQuery(descriptor: CorpusDescriptor, target: DereferenceTarget): VisibilityQuery {
  const table = SCOPE_TABLE[target.scope]; // closed 3-entry map, never caller text
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
 * Re-verifies one artifact is visible to `context` RIGHT NOW — "before response
 * serialization, direct dereference and cursor paging", per this task's own Contract. Two
 * gates, in order:
 *
 *   1. `resolveCorpora` against the SAME registry/context a search request would use, scoped
 *      to `target.scope` alone. No entry naming `target.owner_id` → `NOT_FOUND_OR_FORBIDDEN`
 *      with NO QUERY ISSUED — an unauthorized owner never reaches the database, exactly
 *      "excluded before ranking" applied to a single dereference rather than a result list.
 *   2. The real query `buildVisibilityQuery` produces, against the resolved descriptor's own
 *      `corpus_key`/`owner_id`. Empty rows → `NOT_FOUND_OR_FORBIDDEN` — the same code an
 *      unauthorized owner gets from step 1, so "public unauthorized and nonexistent reference
 *      targets share NOT_FOUND_OR_FORBIDDEN" holds whether the refusal came from the registry
 *      or from the table genuinely having nothing there (unpublished since the corpus was
 *      last indexed, or never existed at all).
 */
export async function checkVisibility(
  client: RetrievalClient,
  context: RetrievalContext,
  registry: readonly CorpusRegistryEntry[],
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
