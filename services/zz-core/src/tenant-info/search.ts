/**
 * search.ts — one tenant-information search, composed end to end: what a caller typed in, the
 * spec's `SearchResponse` out, and every decision in between made by somebody else's tested
 * code rather than reimplemented here.
 *
 * WHY THIS FILE EXISTS AT ALL. `search()` (lanes.ts), `resolveCorpora` (retrieval.ts),
 * `parseQuery`/`serializeResults` (retrieval.ts), `matchesArtifact`/`encodeCursor`
 * (pinned-read.ts) and `loadCorpusRegistry` (corpus-registry.ts) were built by I-16 through
 * I-19 and by this task, and NOTHING PUT THEM IN A LINE. Four recall lanes, RRF fusion, the
 * query grammar, cursors and the isolation guarantee were each exercised by a case that called
 * them directly and by nothing else — a stack of correct parts with no path through it.
 * `searchTenantInformation` below is that path, and `testing/tenant-info/compatibility.ts`
 * drives it as one call.
 *
 * ITS OWN FILE, AND THE SEAM IS THE ONE `tools/knowledge-search.ts` ALREADY NAMED. This began
 * inside that file — the integration target the approved specification declares — and moved
 * when it reached 703 lines against a measured, unexemptable 700-line ceiling. The two halves
 * of that file were two subjects and said so in their own banner: everything above it reads
 * `zz.doc`/`zz.knowledge_node` for the live `knowledge_search` tool, and everything below read
 * the migration-070 derived database. This is the second half, now beside the rest of the
 * stack it composes rather than beside a directory of MCP registrations.
 *
 * NO MCP HANDLER CALLS IT YET, DELIBERATELY, and that is a cutover decision rather than an
 * omission — `tools/knowledge-search.ts`'s header carries the reason in full: migration 070
 * declares `requires-extension: pg_textsearch` and `pg_trgm`, `services/gateway/src/db.ts`
 * DEFERS a migration whose extension the cluster cannot supply ("skipped, and deliberately NOT
 * recorded as applied"), and so none of the tables queried below exists on the deployment that
 * holds this team's documents. Repointing the live tool at them would answer `relation
 * "zz.search_current" does not exist` to every caller.
 */
import { search, type AnalyzedQuery, type HardPredicates } from "./lanes.js";
import { loadCorpusRegistry } from "./corpus-registry.js";
import { etagOf } from "./mutations.js";
import { encodeCursor, matchesArtifact } from "./pinned-read.js";
import { recordDigestOf } from "./policies.js";
import {
  parseQuery, resolveCorpora, RetrievalError, scopeTable, serializeResults,
  type CorpusDescriptor, type QueryAst, type QueryMode, type RetrievalClient, type RetrievalContext,
} from "./retrieval.js";


// ── the query adapter: a parsed AST is not yet a set of lane terms ─────────────────────────

/** Identifier-shaped: a token a caller would type to name a thing rather than to describe it —
 *  a path, a dotted or underscored name, a uuid. The exact lane matches these against
 *  `zz.artifact_identifier.normalized_text`, which `tenant-rebuild.ts` writes lowercased. */
const IDENTIFIER_SHAPED = /[./_\-:]|^[0-9a-f-]{8,}$/i;
const FUZZY_MIN_LENGTH = 4;

/**
 * `QueryAst` (what the grammar produced) → `AnalyzedQuery` (what the lanes consume). The two
 * are deliberately different shapes and nothing joined them: `parseQuery` reports clauses,
 * phrases and exclusions; `search()` wants exact candidates, ONE fuzzy candidate and a lexical
 * string. This is that adapter, and it is pure so a case can drive it on its own.
 *
 * `fuzzyCandidate` IS SINGULAR because the GiST lane is a distance-ordered top-k over one term
 * (`lanes.ts`'s own note). The longest identifier-shaped term wins — the most specific thing
 * the caller typed, and the one a typo is most likely to be in. An excluded term is never a
 * fuzzy candidate: recalling what the caller asked not to see is the opposite of the request.
 */
export function analyzeForLanes(ast: QueryAst): AnalyzedQuery {
  const terms: string[] = [];
  const walk = (clause: typeof ast.clauses[number]): void => {
    if (clause.kind === "term") terms.push(clause.value);
    else if (clause.kind === "phrase") terms.push(clause.value);
    else for (const alternative of clause.alternatives) walk(alternative);
  };
  for (const clause of ast.clauses) walk(clause);
  const exactCandidates = [...new Set([...ast.phrases, ...terms].map((t) => t.toLowerCase()))];
  const fuzzyPool = terms
    .filter((t) => t.length >= FUZZY_MIN_LENGTH && IDENTIFIER_SHAPED.test(t) && !ast.exclusions.includes(t))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  return {
    exactCandidates,
    fuzzyCandidate: fuzzyPool[0]?.toLowerCase() ?? null,
    // The lexical lane gets the caller's own words, untouched: `to_bm25query` does its own
    // analysis, and pre-joining normalized tokens here would hand BM25 a query it never saw.
    lexicalQuery: ast.original_text,
  };
}

// ── the request, the context a deployment supplies, and the hard predicates ────────────────

export interface TenantSearchRequest {
  readonly query: string;
  readonly mode?: QueryMode;
  readonly scopes?: readonly string[];
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly limit?: number;
}

/**
 * What the AUTHENTICATED CALLER is, plus the two facts only the serving process knows.
 *
 * `index_generation` is not a column. `tenant-rebuild.ts` builds a generation into an isolated
 * target and never flips anything live, so nothing in migration 070 records which generation is
 * currently serving — the process that mounted it is the only thing that can say, and it says
 * so here rather than this module inventing a value for a disclosed response field.
 *
 * `cursor_key` is the HMAC key `encodeCursor` signs provenance cursors with; a deployment's
 * secret, never a caller's input.
 */
export interface TenantSearchContext extends RetrievalContext {
  readonly caller_id: string;
  readonly index_generation: string;
  readonly cursor_key: string;
}

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const SOURCE_REF_CAP = 20;
const SNIPPET_BYTES = 600;

/**
 * The query grammar's `filters` are validated by `resolveCorpora` and pushed down by nobody —
 * a named gap this closes for the two it CAN close, and refuses for the two it cannot.
 *
 * `type` and `tags` are columns on all three `zz.search_*` tables, so they become
 * `HardPredicates` and `lanes.ts` pushes them into every lane's own WHERE clause. `initiative`
 * and `flow` have no column there — migration 070 never gave the search projections one — so
 * there is nothing to filter on, and this REFUSES rather than dropping them. A filter silently
 * ignored is the defect this very file's legacy path carries a paragraph about: a caller who
 * scoped a search to one initiative got rows from every other one, with nothing saying the
 * scope had been discarded. "A filter the caller asked for is not a hint to the ranker."
 */
function hardPredicatesFrom(filters: Readonly<Record<string, unknown>> | undefined): HardPredicates {
  if (!filters) return {};
  for (const name of ["initiative", "flow"]) {
    if (filters[name] !== undefined) {
      throw new RetrievalError("INVALID_INPUT",
        `the ${name} filter cannot be honoured: migration 070's search projections carry no ` +
        `${name} column for a lane to filter on, and answering as if it had been applied would ` +
        "return another initiative's documents inside a scoped search");
    }
  }
  // TAGS ARE COMPARED AS AUTHORED, and this deliberately differs from the legacy path above,
  // which lowercases a tag filter on the way in. It does that because ITS stored side is
  // lowercase. This one's is not: `tenant-rebuild.ts` writes `latest.payload.tags` into the
  // search row verbatim, and `SemanticPayloadSchema` neither lowercases nor transforms them —
  // so lowercasing here would turn `plugin:CaseBox` into a filter that matches nothing, which
  // is the same defect that paragraph records, arrived at from the other direction.
  const type = typeof filters.type === "string" ? filters.type : undefined;
  const tags = Array.isArray(filters.tags) ? filters.tags.filter((t): t is string => typeof t === "string") : undefined;
  return { ...(type !== undefined ? { type } : {}), ...(tags && tags.length > 0 ? { tags } : {}) };
}

// ── hydration: a ranked identity is not yet a result a reader can use ──────────────────────

interface HydratedRow {
  readonly corpus_key: string; readonly owner_id: string; readonly artifact_id: string;
  readonly revision: number; readonly content_hash: string; readonly title: string;
  readonly type: string; readonly tags: readonly string[] | null; readonly path: string;
  readonly gate_status: string | null; readonly knowledge_status: string | null;
  readonly raw_body: string; readonly artifact_class: string; readonly profile: string | null;
  readonly head_event_sequence: number;
}

interface WantedRow { readonly corpus: string; readonly artifact: string; readonly revision: number }

/**
 * The projection row and the artifact head behind one scope's worth of ranked candidates.
 *
 * `s.owner_id = $1` IS CARRIED IN THIS STATEMENT TOO, once per owner, for the reason every lane
 * builder carries it: a partial index's WHERE clause is an optimisation, not a permission
 * filter, and the corpora having already been authorized is not the row-level predicate.
 *
 * HISTORY BINDS THE REVISION AS PART OF THE WANTED KEY, the other two scopes do not — the same
 * split `resultKey` makes ("current/evidence identity is owner+artifact; history additionally
 * includes revision"), because `zz.search_history` is keyed by revision and holds several rows
 * per artifact. Matching on corpus and artifact alone there returns EVERY revision, and the
 * ranked candidate would then be described by whichever row arrived last: a result ranked at
 * revision 3 handed back with revision 7's body, hash, digest and etag. Current and evidence
 * hold one row per artifact, so binding a revision there would only make a page fail to
 * hydrate the moment a projection advanced between the lane query and this one.
 */
function buildHydrationQuery(scope: string, ownerId: string, wanted: readonly WantedRow[]) {
  const byRevision = scope === "history";
  const params: unknown[] = [ownerId, wanted.map((w) => w.corpus), wanted.map((w) => w.artifact)];
  if (byRevision) params.push(wanted.map((w) => w.revision));
  const columns = byRevision ? "corpus_key, artifact_id, revision" : "corpus_key, artifact_id";
  const match = byRevision
    ? "want.corpus_key = s.corpus_key and want.artifact_id = s.artifact_id and want.revision = s.revision"
    : "want.corpus_key = s.corpus_key and want.artifact_id = s.artifact_id";
  return {
    text:
      `select s.corpus_key, s.owner_id, s.artifact_id, s.revision, s.content_hash, s.title, s.type,
              s.tags, s.path, s.gate_status, s.knowledge_status, s.raw_body,
              a.artifact_class, a.profile, a.head_event_sequence
         from ${scopeTable(scope)} s
         join zz.artifact a on a.owner_id = s.owner_id and a.artifact_id = s.artifact_id
        where s.owner_id = $1
          and exists (select 1 from unnest($2::text[], $3::uuid[]${byRevision ? ", $4::int[]" : ""}) as want(${columns})
                      where ${match})`,
    params,
  };
}

interface EdgeRow {
  readonly source_owner_id: string; readonly source_artifact_id: string;
  readonly target_owner_id: string; readonly target_artifact_id: string;
  readonly target_revision: number | null; readonly target_hash: string;
}

/** The `cites` edges of the artifacts about to be returned — the provenance a result carries as
 *  `source_refs`. One query for the whole page, never one per result. */
function buildSourceRefQuery(ownerId: string, artifactIds: readonly string[]) {
  return {
    text:
      `select source_owner_id, source_artifact_id, target_owner_id, target_artifact_id,
              target_revision, target_hash
         from zz.artifact_edge
        where source_owner_id = $1
          and source_artifact_id = any($2::uuid[])
          and kind = 'cites'
          and retracted_event_id is null
        order by target_artifact_id, target_revision`,
    params: [ownerId, artifactIds] as unknown[],
  };
}

// ── the composition ────────────────────────────────────────────────────────────────────────

/** One UTF-8-safe excerpt, with the byte offsets the response contract asks for. The passage
 *  analyzer's real offsets belong to `zz.artifact_passage`, which nothing projects yet; this is
 *  the projection row's own body, so the offsets are honestly the ones this text was cut at. */
function excerpt(body: string): { snippet: string; start: number; end: number } {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength <= SNIPPET_BYTES) return { snippet: body, start: 0, end: bytes.byteLength };
  // `toString` on a cut buffer can end mid-scalar; the replacement character it would leave is
  // trimmed rather than emitted, so a snippet is never half a character wide.
  const cut = bytes.subarray(0, SNIPPET_BYTES).toString("utf8").replace(/�+$/, "");
  return { snippet: cut, start: 0, end: Buffer.byteLength(cut, "utf8") };
}

/** One map key for a hydrated row, scoped the way `resultKey` scopes a ranked one: history
 *  identity carries the revision, current and evidence do not. Keying history without it would
 *  let several revisions of one artifact collapse onto each other in the map, which is the same
 *  defect as fetching them all — see `buildHydrationQuery`. `|` is a safe separator: a scope is
 *  one of three words, the middle two are uuids, and the last is an integer. */
const hydrationKey = (scope: string, owner: string, artifact: string, revision: number): string =>
  scope === "history" ? `${scope}|${owner}|${artifact}|${revision}` : `${scope}|${owner}|${artifact}`;

/**
 * A tenant-information search, end to end: the ONE function that takes what a caller typed and
 * returns the wire response, and the only thing between an MCP handler and `search()`.
 *
 * In order, and each step is somebody else's tested code rather than a reimplementation of it:
 *   `parseQuery`          (retrieval.ts, I-18)  the grammar — phrases, OR, exclusions, mode
 *   `loadCorpusRegistry`  (above,        I-22)  which corpora exist, and each one's audience
 *   `resolveCorpora`      (retrieval.ts, I-16)  which of them THIS context may query
 *   `analyzeForLanes`     (above,        I-22)  the AST as exact/fuzzy/lexical lane terms
 *   `search`              (lanes.ts,     I-17)  four lanes, dedup-before-cap, RRF fusion
 *   hydration             (above,        I-22)  the projection row and artifact head behind an id
 *   `matchesArtifact`     (pinned-read,  I-18)  the boolean structure SQL could not express
 *   `recordDigestOf`      (policies.ts,  I-9)   the digest a later pinned read binds to
 *   `encodeCursor`        (pinned-read,  I-18)  the provenance cursor for truncated source_refs
 *   `serializeResults`    (retrieval.ts, I-18)  the 24000-byte response budget, disclosed
 *
 * `matchesArtifact` RUNS AFTER RANKING AND BEFORE THE BUDGET, deliberately. The lanes push down
 * what the schema has a column for; a phrase, an OR group and an exclusion are artifact-level
 * boolean structure no single lane's predicate carries, and `lanes.ts` never called this
 * function — so a result failing an exclusion the caller typed could be ranked and returned. It
 * cannot filter before ranking either: a candidate has no text until it is hydrated.
 *
 * METADATA BROWSING IS REFUSED, NOT FAKED. "No query performs metadata browsing" (spec) and
 * `parseQuery` reports it as `browse`, but `search()` issues no statement at all when every
 * lane term is empty — so a browse request would come back as a complete, empty, entirely
 * believable answer. There is no browse lane in this checkout; until one exists this refuses by
 * name rather than answering "nothing matched" to a question nothing ever asked the database.
 */
export async function searchTenantInformation(
  client: RetrievalClient,
  context: TenantSearchContext,
  request: TenantSearchRequest,
): Promise<string> {
  const mode: QueryMode = request.mode ?? "natural";
  const ast = parseQuery(request.query, mode);
  if (ast.browse) {
    throw new RetrievalError("INVALID_INPUT",
      "a query with no terms would be metadata browsing, and no lane in this build performs it " +
      "— answering would report an empty result as a complete one");
  }
  const limit = Math.min(Math.max(Math.trunc(request.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const predicates = hardPredicatesFrom(request.filters);

  const registry = await loadCorpusRegistry(client);
  const descriptors = resolveCorpora(
    context,
    { ...(request.scopes ? { scopes: request.scopes } : {}), ...(request.filters ? { filters: request.filters } : {}) },
    registry,
  );

  const outcome = await search(client, descriptors, analyzeForLanes(ast), predicates, limit);

  // Hydrate by (scope, owner): the scope decides the table, the owner is the predicate that
  // must appear in the statement, and one query serves every candidate sharing both.
  const groups = new Map<string, { scope: string; owner: string; wanted: WantedRow[] }>();
  for (const candidate of outcome.candidates) {
    const corpus = candidate.corpora[0];
    if (corpus === undefined) continue;                       // no corpus contributed it: unreachable
    const key = `${candidate.identity.scope}|${candidate.identity.owner_id}`;
    const group = groups.get(key)
      ?? { scope: candidate.identity.scope, owner: candidate.identity.owner_id, wanted: [] };
    group.wanted.push({ corpus, artifact: candidate.identity.artifact_id, revision: candidate.identity.revision });
    groups.set(key, group);
  }
  const hydrated = new Map<string, HydratedRow>();
  for (const group of groups.values()) {
    const q = buildHydrationQuery(group.scope, group.owner, group.wanted);
    const { rows } = await client.query<HydratedRow>(q.text, q.params);
    for (const row of rows) hydrated.set(hydrationKey(group.scope, row.owner_id, row.artifact_id, row.revision), row);
  }

  // Provenance, one query per owner rather than one per result.
  const citedBy = new Map<string, EdgeRow[]>();
  for (const group of groups.values()) {
    const ids = [...new Set(group.wanted.map((w) => w.artifact))];
    const q = buildSourceRefQuery(group.owner, ids);
    const { rows } = await client.query<EdgeRow>(q.text, q.params);
    for (const row of rows) {
      const key = `${row.source_owner_id}|${row.source_artifact_id}`;
      citedBy.set(key, [...(citedBy.get(key) ?? []), row]);
    }
  }

  // THE REQUESTED LIMIT BOUNDS THE PAGE, and this loop is the only thing that applies it.
  // `budgets(limit)` caps each LANE, not their union, so `search()` returns as many fused
  // candidates as every lane in every authorized corpus contributed — a `limit: 10` request
  // routinely fuses several times that. `serializeResults` cuts on BYTES alone, and its own
  // comment says "the request's own limit (1–50) bounds candidateResults.length in production":
  // that was an assumption about a caller which, until this line, nothing in the path enforced.
  // The cap is applied AFTER `matchesArtifact`, never before — slicing first would let an
  // artifact the caller excluded consume a slot and shorten the page it was removed from.
  const wire = [];
  for (const candidate of outcome.candidates) {
    if (wire.length >= limit) break;
    const row = hydrated.get(hydrationKey(candidate.identity.scope, candidate.identity.owner_id, candidate.identity.artifact_id, candidate.identity.revision));
    // A RANKED CANDIDATE WITH NO ROW IS DROPPED, NEVER FILLED IN. It means the projection moved
    // between the lane query and this one; inventing a title for it would put a result in front
    // of a reader that no row supports.
    if (!row) continue;
    const tags = row.tags ?? [];
    if (!matchesArtifact(ast, { title: [row.title], path: [row.path], tags: [...tags], body: [row.raw_body] })) continue;
    const { snippet, start, end } = excerpt(row.raw_body);
    const refs = citedBy.get(`${row.owner_id}|${row.artifact_id}`) ?? [];
    const truncated = refs.length > SOURCE_REF_CAP;
    const digest = recordDigestOf({ content_hash: row.content_hash, head_event_sequence: row.head_event_sequence });
    wire.push({
      ref: {
        owner_id: row.owner_id, artifact_id: row.artifact_id,
        revision: row.revision, content_hash: row.content_hash,
      },
      record_digest: digest,
      // The one format `mutations.ts`'s `etagOf` renders, imported rather than respelled: a
      // second copy of "revision, colon, head sequence" is a second thing to keep in step.
      etag: etagOf({ artifact_id: row.artifact_id, revision: row.revision, head_event_sequence: row.head_event_sequence, content_hash: row.content_hash }),
      path: row.path, title: row.title,
      artifact_class: row.artifact_class, type: row.type, scope: candidate.identity.scope,
      // "team" is the authenticated owner's own corpus; anything else this context may read is
      // a published shelf it shares, which is what `shelf: "platform"` means to every existing
      // reader of this response.
      shelf: row.owner_id === context.owner_id ? "team" : "platform",
      gate_status: row.gate_status, knowledge_status: row.knowledge_status,
      profile: row.profile ?? "native",
      source_refs: refs.slice(0, SOURCE_REF_CAP).map((e) => ({
        owner_id: e.target_owner_id, artifact_id: e.target_artifact_id,
        revision: e.target_revision, content_hash: e.target_hash,
      })),
      source_refs_truncated: truncated,
      source_refs_cursor: truncated
        ? encodeCursor(context.cursor_key, {
          caller_id: context.caller_id, owner_id: row.owner_id, artifact_id: row.artifact_id,
          revision: row.revision, sequence: row.head_event_sequence, record_digest: digest,
        })
        : null,
      snippet, snippet_byte_start: start, snippet_byte_end: end,
      via: candidate.via, corpora: candidate.corpora, score: candidate.score,
    });
  }

  const owners = [...new Set(descriptors.map((d: CorpusDescriptor) => d.owner_id))];
  const { rows: watermarks } = await client.query<{ owner_id: string; head_sequence: number }>(
    "select owner_id, head_sequence from zz.artifact_projection_watermark where owner_id = any($1::uuid[])",
    [owners],
  );
  return serializeResults(wire, {
    index_generation: context.index_generation,
    indexed_through: Object.fromEntries(watermarks.map((w) => [w.owner_id, Number(w.head_sequence)])),
    // WHAT RANKING CONSIDERED, not what survived hydration and the boolean filter. `returned`
    // and `withheld_candidates` are `serializeResults`'s own, computed from the list it is
    // handed; conflating the two would report a page as the whole answer.
    candidate_total: outcome.candidates.length,
    mode_used: mode,
    incomplete: outcome.incomplete,
    reasons: outcome.reasons,
  });
}
