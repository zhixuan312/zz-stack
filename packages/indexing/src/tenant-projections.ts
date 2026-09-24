/**
 * The tenant-information derived database's write path: replaying one owner's committed
 * transaction into the common/subtype/search projections, the file-backed compatibility-id map
 * that survives a rebuild, and the per-corpus partitions `zz.search_current`/`zz.search_evidence`/
 * `zz.search_history` need before they can hold a row.
 *
 * Nothing here owns a connection. `ProjectionClient` is the smallest shape a single connection
 * already satisfies — one `query(text, params)` — so a caller hands in whichever it has and a test
 * hands in a plain object that records calls. Nothing imports `pg` for its runtime except
 * `connectIsolated` below.
 *
 * It must be one dedicated connection, never a `pg.Pool`. `applyCommit` issues its own
 * `begin`/`commit`/`rollback` and every statement between them must land on the same session. A
 * `pg.Pool` structurally satisfies `.query()`, but sends `begin` down whichever connection happens
 * to be free and the inserts down others — no transaction at all, silently. Callers acquire a
 * `pg.PoolClient` (`pool.connect()`) or use `connectIsolated` below, never `pool.query` itself.
 *
 * `applyCommit` projects the common tables (`zz.artifact`, `zz.artifact_revision`,
 * `zz.artifact_event`, `zz.artifact_edge`), the two legacy-subtype bridges when the caller supplies
 * them, and its own replay/watermark bookkeeping. It does not write to
 * `zz.search_current`/`evidence`/`history` or to `zz.artifact_passage`/`zz.artifact_identifier`,
 * and `semanticProjectionHash` below is not called from anywhere. It does not decide which team a
 * `team_slug` belongs to either: the subtype-bridge writes run only when the caller supplies
 * `docBridge`/`knowledgeBridge`, because only the caller knows that mapping.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import pg from "pg";

import type { ArtifactClass, ArtifactEvent, ContentRevision } from "@zz/contracts";

import { analyze } from "./tenant-analysis.js";
import { parseQuery, type QueryClause } from "./query-grammar.js";

// The smallest shape a caller's pool/client already has

export interface ProjectionClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** A real `ProjectionClient` over one dedicated connection to an operator-provided database.
 *  COUPLED: used only by `testing/tenant-info/rebuild.ts`'s integration cases, which run under
 *  `tsconfig.tooling.json` and so have no "pg" type declarations — which is why that file never
 *  imports "pg" itself. Every other caller of `applyCommit`/`ensureCorpus` supplies its own pool or
 *  client. One connection, not a pool: the integration cases need one session's transaction
 *  boundary, not concurrency. */
export async function connectIsolated(
  connectionString: string,
  // NOT A TOOL: `close()` below ends this one pg connection, and has nothing to do with the
  // `initiative_close` tool.
): Promise<ProjectionClient & { close(): Promise<void> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
      const result = await client.query(text, params as unknown[]);
      return { rows: result.rows as T[] };
    },
    close: () => client.end(),
  };
}

// The file-backed compatibility-id map: the durable record of "this owner+artifact already has
// id N", read before a rebuild starts and written back after. Plain JSON, one file per deployment,
// never regenerated from scratch while any existing entry could still be looked up — a reallocated
// id breaks every external reference to that row (zz.decision.doc_id, a bookmark, a link in prose).

interface CompatibilityMap {
  readonly version: 1;
  readonly entries: Readonly<Record<string, number>>;
}

const EMPTY_MAP: CompatibilityMap = { version: 1, entries: {} };

/** A fresh or absent file reads as the empty map, not an error. A file that exists but fails to
 *  parse as this map's own shape is refused outright: silently discarding it would reallocate every
 *  id in the deployment. */
export function loadCompatibilityMap(path: string): CompatibilityMap {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return EMPTY_MAP;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1
      || typeof (parsed as { entries?: unknown }).entries !== "object") {
    throw new Error(`${path} does not hold a version-1 compatibility map — refusing to treat it as empty`);
  }
  return { version: 1, entries: { ...(parsed as { entries: Record<string, number> }).entries } };
}

export function saveCompatibilityMap(path: string, map: CompatibilityMap): void {
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
}

const compatKey = (ownerId: string, artifactId: string): string => `${ownerId}\u0000${artifactId}`;

/** The stable compatibility id for (owner, artifact) — allocated once, on first sight, and read
 *  back unchanged on every later call against a map that already has it, including across a full
 *  rebuild that reloads this file from disk. A plain function of its input rather than an in-place
 *  mutator: `saveCompatibilityMap` is what decides when the updated map is durable. */
export function compatIdFor(
  map: CompatibilityMap, ownerId: string, artifactId: string,
): { readonly id: number; readonly map: CompatibilityMap } {
  const key = compatKey(ownerId, artifactId);
  const existing = map.entries[key];
  if (existing !== undefined) return { id: existing, map };
  const next = 1 + Object.values(map.entries).reduce((highest, id) => Math.max(highest, id), 0);
  return { id: next, map: { version: 1, entries: { ...map.entries, [key]: next } } };
}

// The semantic parity hash. Operational rebuild and index ids are excluded by construction: this
// function's input type has no field for a rebuild's wall-clock duration, a physical index OID or a
// retry timestamp. Two projections of the same semantic facts hash identically regardless of when,
// how many times or how slowly either was produced.

interface SemanticProjectionInput {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly artifact_class: ArtifactClass;
  readonly revision: number;
  readonly content_hash: string;
  readonly payload: unknown;
}

export function semanticProjectionHash(input: SemanticProjectionInput): string {
  return createHash("sha256").update(JSON.stringify({
    owner_id: input.owner_id, artifact_id: input.artifact_id, artifact_class: input.artifact_class,
    revision: input.revision, content_hash: input.content_hash, payload: input.payload,
  })).digest("hex");
}

// Replaying one owner's committed transaction

/** What one owner commit hands `applyCommit`: the identity and class it names, the revisions and
 *  events a real commit manifest carries (the subset the derived database needs from
 *  `services/zz-core/src/tenant-info/record.ts`'s `PreparedManifestInput`), and the two
 *  legacy-subtype bridges, each supplied only when the caller knows that mapping. */
export interface ProjectionManifest {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly artifact_class: ArtifactClass;
  readonly current_path: string;
  readonly sequence: number;
  readonly transaction_id: string;
  readonly audience?: string | null;
  readonly profile?: string | null;
  readonly revisions: readonly ContentRevision[];
  readonly events: readonly ArtifactEvent[];
  readonly docBridge?: { readonly team_slug: string; readonly initiative: string; readonly path: string };
  readonly knowledgeBridge?: {
    readonly team_slug: string; readonly path: string;
    readonly origin_profile: "native" | "legacy_import";
  };
}

interface ApplyCommitResult {
  readonly applied: boolean;
  readonly reason?: "already_applied" | "stale_sequence";
}

/** Applies one owner's committed manifest to every projection except the passage and identifier
 *  tables (see this module's header), in one transaction it owns itself — the caller passes a fresh
 *  client, not one already mid-transaction.
 *
 *  Replay keys on transaction_id: an id already recorded, or a sequence at or below the owner's
 *  watermark, is a no-op that still commits rather than an error, so an already-applied commit or
 *  one arriving behind a newer one never regresses or duplicates what is projected. */
export async function applyCommit(
  client: ProjectionClient, manifest: ProjectionManifest,
): Promise<ApplyCommitResult> {
  await client.query("begin");
  try {
    const already = await client.query(
      "select 1 from zz.artifact_projection_commit where owner_id=$1 and transaction_id=$2",
      [manifest.owner_id, manifest.transaction_id]);
    if (already.rows.length > 0) {
      await client.query("commit");
      return { applied: false, reason: "already_applied" };
    }
    const watermark = await client.query<{ head_sequence: number }>(
      "select head_sequence from zz.artifact_projection_watermark where owner_id=$1",
      [manifest.owner_id]);
    const head = watermark.rows[0]?.head_sequence ?? 0;
    if (manifest.sequence <= head) {
      await client.query("commit");
      return { applied: false, reason: "stale_sequence" };
    }

    // Null for a source, not zero. `reduce(max, 0)` over an empty revision list returns its seed,
    // and the schema refuses 0: revision numbers start at 1, and `null` is how the rest of this
    // platform says a source has none. `ArtifactRefSchema` resolves `revision: null` only to a
    // source; `transitions.ts` refuses every lifecycle operation on `head.revision === null`.
    //
    // `greatest()` below ignores nulls and returns null only when every argument is null, so a
    // source stays null across replays and a document that later gains revisions still takes the
    // higher number.
    const latestRevision = manifest.revisions.length === 0
      ? null
      : manifest.revisions.reduce((m, r) => Math.max(m, r.revision), 0);
    const latestEventSequence = manifest.events.reduce((m, e) => Math.max(m, e.sequence), 0);
    const latest = manifest.revisions.find((r) => r.revision === latestRevision);
    const createdAt = manifest.events.find((e) => e.kind === "created")?.at ?? null;

    await client.query(
      `insert into zz.artifact
         (owner_id, artifact_id, artifact_class, current_path, current_revision, content_hash,
          head_event_sequence, created_at, audience, profile)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (owner_id, artifact_id) do update set
         artifact_class = excluded.artifact_class, current_path = excluded.current_path,
         current_revision = greatest(zz.artifact.current_revision, excluded.current_revision),
         content_hash = excluded.content_hash,
         head_event_sequence = greatest(zz.artifact.head_event_sequence, excluded.head_event_sequence),
         audience = excluded.audience, profile = excluded.profile`,
      [manifest.owner_id, manifest.artifact_id, manifest.artifact_class, manifest.current_path,
       latestRevision, latest?.content_hash ?? "", latestEventSequence, createdAt,
       manifest.audience ?? null, manifest.profile ?? null]);

    // Events before revisions. `zz.artifact_edge.asserted_event_id` is an immediate (not deferred)
    // foreign key into `zz.artifact_event`, and the revisions loop below inserts "cites" edges
    // asserted by these same events — so inserting a "cites" edge before its asserting event exists
    // fails the whole transaction the moment any revision carries a `sources` entry.
    for (const event of manifest.events) {
      await client.query(
        `insert into zz.artifact_event
           (event_id, transaction_id, owner_id, artifact_id, sequence, at, actor, kind,
            revision, content_hash, cause_refs, data)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (event_id) do nothing`,
        [event.event_id, event.transaction_id, manifest.owner_id, manifest.artifact_id,
         event.sequence, event.at, event.actor, event.kind, event.revision, event.content_hash,
         JSON.stringify(event.cause_refs), JSON.stringify(event.data)]);

      // "derived_from" edges, asserted by the event that named the cause.
      for (const cause of event.cause_refs) {
        await client.query(
          `insert into zz.artifact_edge
             (source_owner_id, source_artifact_id, source_revision, kind,
              target_owner_id, target_artifact_id, target_revision, target_hash,
              asserted_event_id)
           values ($1,$2,$3,'derived_from',$4,$5,$6,$7,$8)
           on conflict (source_owner_id, source_artifact_id, kind, target_owner_id,
                        target_artifact_id, asserted_event_id) do nothing`,
          [manifest.owner_id, manifest.artifact_id, event.revision,
           cause.owner_id, cause.artifact_id, cause.revision, cause.content_hash, event.event_id]);
      }
    }

    for (const revision of manifest.revisions) {
      await client.query(
        `insert into zz.artifact_revision
           (owner_id, artifact_id, revision, content_hash, payload, cause_refs, sources,
            generated_by, generated_at, origin_profile, legacy_unresolved_sources, previous_revision)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (owner_id, artifact_id, revision) do nothing`,
        [manifest.owner_id, manifest.artifact_id, revision.revision, revision.content_hash,
         JSON.stringify(revision.payload), JSON.stringify(revision.cause_refs),
         JSON.stringify(revision.sources), revision.generated.by, revision.generated.at,
         revision.origin_profile, JSON.stringify(revision.legacy_unresolved_sources),
         revision.previous_revision]);

      // "cites" edges, asserted by whichever event produced this revision — a SourceCitation has no
      // event of its own. That event row was inserted in the loop above.
      const assertingEvent = manifest.events.find(
        (e) => e.revision === revision.revision && (e.kind === "created" || e.kind === "revised"));
      if (assertingEvent) {
        for (const source of revision.sources) {
          await client.query(
            `insert into zz.artifact_edge
               (source_owner_id, source_artifact_id, source_revision, kind,
                target_owner_id, target_artifact_id, target_revision, target_hash, citation_id,
                asserted_event_id)
             values ($1,$2,$3,'cites',$4,$5,$6,$7,$8,$9)
             on conflict (source_owner_id, source_artifact_id, kind, target_owner_id,
                          target_artifact_id, asserted_event_id) do nothing`,
            [manifest.owner_id, manifest.artifact_id, revision.revision,
             source.ref.owner_id, source.ref.artifact_id, source.ref.revision,
             source.ref.content_hash, source.id, assertingEvent.event_id]);
        }
      }
    }

    if (manifest.docBridge) {
      await client.query(
        `insert into zz.doc_artifact
           (team_slug, initiative, path, owner_id, artifact_id, current_revision, updated_at)
         values ($1,$2,$3,$4,$5,$6,now())
         on conflict (team_slug, initiative, path) do update set
           owner_id = excluded.owner_id, artifact_id = excluded.artifact_id,
           current_revision = excluded.current_revision, updated_at = now()`,
        [manifest.docBridge.team_slug, manifest.docBridge.initiative, manifest.docBridge.path,
         manifest.owner_id, manifest.artifact_id, latestRevision]);
    }
    if (manifest.knowledgeBridge) {
      await client.query(
        `insert into zz.knowledge_node_artifact
           (team_slug, path, owner_id, artifact_id, current_revision, origin_profile, updated_at)
         values ($1,$2,$3,$4,$5,$6,now())
         on conflict (team_slug, path) do update set
           owner_id = excluded.owner_id, artifact_id = excluded.artifact_id,
           current_revision = excluded.current_revision, origin_profile = excluded.origin_profile,
           updated_at = now()`,
        [manifest.knowledgeBridge.team_slug, manifest.knowledgeBridge.path,
         manifest.owner_id, manifest.artifact_id, latestRevision, manifest.knowledgeBridge.origin_profile]);
    }

    await client.query(
      "insert into zz.artifact_projection_commit (owner_id, transaction_id, sequence) values ($1,$2,$3)",
      [manifest.owner_id, manifest.transaction_id, manifest.sequence]);
    await client.query(
      `insert into zz.artifact_projection_watermark (owner_id, head_sequence, updated_at)
       values ($1,$2,now())
       on conflict (owner_id) do update set
         head_sequence = greatest(zz.artifact_projection_watermark.head_sequence, excluded.head_sequence),
         updated_at = now()`,
      [manifest.owner_id, manifest.sequence]);

    await client.query("commit");
    return { applied: true };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

// Provisioning a corpus's own partition. Which corpora exist is a runtime fact (a tenant signs up,
// a shelf publishes), so the migration creates the three partitioned parents and a `_default`
// catch-all and this function attaches one partition per corpus to all three, the first time that
// corpus is about to hold a row. Idempotent: attaching a partition that already exists is a no-op.

const CORPUS_KEY = /^[a-z][a-z0-9_]{0,62}$/;

const SEARCH_PARENTS = ["zz.search_current", "zz.search_evidence", "zz.search_history"] as const;

/** `corpusKey` becomes part of a table name and a partition-bound literal, neither of which
 *  Postgres lets a bind parameter fill — so it is validated against a closed character set first and
 *  then interpolated, the pattern `packages/tools/src/testing/sql-check.ts` reports as "not
 *  checkable" rather than silently skips. The check above is what makes "nothing here is
 *  caller-supplied free text" true rather than assumed. */
export async function ensureCorpus(client: ProjectionClient, corpusKey: string): Promise<void> {
  if (!CORPUS_KEY.test(corpusKey)) {
    throw new RangeError(`corpus key ${JSON.stringify(corpusKey)} is not a safe partition-name suffix`);
  }
  for (const parent of SEARCH_PARENTS) {
    const table = `${parent}_${corpusKey}`;
    await client.query(
      `create table if not exists ${table} partition of ${parent} for values in ('${corpusKey}')`);
    await client.query(
      `create index if not exists ${table.replace(".", "_")}_tsv on ${table} using gin (to_tsvector('english', raw_body))`);
    await client.query(
      `create index if not exists ${table.replace(".", "_")}_tags on ${table} using gin (tags)`);
    // The BM25 index, on the concrete partition — which is why these partitions exist.
    // `to_bm25query(query, index_name)` requires the named index to be on the relation being
    // scanned; otherwise it resolves an index automatically and the IDF comes from whichever index
    // the planner chose, across whatever rows it covers — a cross-tenant statistics leak no
    // row-level check can see. One corpus, one partition, one index.
    //
    // `text_config='english'` matches the stock tsvector fallback on the same partition, and is the
    // limit of what this extension can do for Chinese: text_config names a PostgreSQL text search
    // configuration, and none of the built-in ones segments CJK. Chinese and mixed content is served
    // by the GiST trigram index on zz.artifact_identifier, which segments by character.
    await client.query(
      `create index if not exists ${table.replace(".", "_")}_bm25 on ${table} using bm25 (raw_body) with (text_config='english')`);
  }
}

// The native lane set: which of exact / BM25 / fuzzy-identifier / typed-provenance a query reaches,
// over Chinese prose exactly as over Latin, through the shared analyzer.
//
// Tags are filters and tie-breaks, never a lane. `zz.search_current`/`evidence`/`history` carry a
// `tags` GIN index (`ensureCorpus` above) for narrowing and ranking a result set another lane
// produced; they are never a way to reach a row nothing else found. `lanesFor` below has no branch
// that can push `"tag"` into its result.
//
// A lane this module excludes never ran, so it has no ranking, no cost and nothing to report as
// empty: it is left out of the returned array rather than returned with a `matched: false` flag a
// caller could mistake for "ran and found nothing". Each lane that is returned carries its own
// `LaneApplicability`, so a caller writing "not applicable" text for the lanes not returned has the
// same rule objects to draw the negative from.
//
// `lanesFor` runs no query, touches no `ProjectionClient` and reads neither `zz.artifact_passage`
// nor `zz.artifact_identifier` — nothing populates those tables yet. It is the routing decision a
// retrieval call would make before it queries anything.
//
// COUPLED: every applicability rule below reads a query through `parseQuery` (`query-grammar.ts`)
// and `analyze` (`tenant-analysis.ts`, `zz-lexical-v2`), never a second parser or analyzer of its
// own. Natural-mode ranking hints and legacy conjunction semantics are that other file's concern.

/** The four lanes this module can route a query to. No `"tag"` member exists — see this
 *  section's header — so a caller cannot even type a tag lane into existence here. */
export type LaneName = "exact" | "bm25" | "fuzzy" | "provenance";

/** The rule that let one lane into a `lanesFor` result: a short machine-stable `rule` id (for
 *  a caller that branches on it) plus a `detail` sentence a person can read as-is when
 *  explaining why a lane did, or — read against a lane `lanesFor` left out — did not, run. */
export interface LaneApplicability {
  readonly rule: string;
  readonly detail: string;
}

/** DELIBERATE: `name` is `string`, not the narrower `LaneName`. A caller checking a returned lane
 *  set against a lane that must never appear — `names.includes("tag")` — has to be able to ask that
 *  about a value outside the union without TypeScript refusing the comparison as unreachable.
 *  `pushLane` below still pins every constructed `name` to `LaneName`. */
export interface LaneDescriptor {
  readonly name: string;
  readonly applicability: LaneApplicability;
}

const HAN_SCALAR = /\p{Script=Han}/u;

/** A clause reads as identifier-shaped when it carries internal structure ordinary prose does not:
 *  a delimiter (`.`, `_`, `/`, `-`, `:`), a camelCase or acronym transition, or a letter-digit
 *  boundary — the boundary set `identifierTokens` (`tenant-analysis.ts`) splits on. A bare lowercase
 *  word like `"reader"` has none and is left to the BM25 lane. Han text is never identifier-shaped:
 *  the identifier lanes key off `zz.artifact_identifier`, a Latin-identifier table, so Chinese prose
 *  is served by BM25. */
function isIdentifierShaped(raw: string): boolean {
  if (HAN_SCALAR.test(raw)) return false;
  if (!/[A-Za-z0-9]/.test(raw)) return false;
  return /[._/:-]/.test(raw) || /[a-z0-9][A-Z]/.test(raw) || /[A-Za-z][0-9]/.test(raw) || /[0-9][A-Za-z]/.test(raw);
}

/** The narrower shape `provenance` keys off: identifier-shaped and carrying a `.` or `/`, the two
 *  scalars that make an identifier read as a concrete artifact reference (an extension, a path)
 *  rather than a structured token like `httpServer2`. Typed neighbours (`zz.artifact_edge`'s
 *  `derived_from`/`cites` rows) are asserted about one specific artifact, so this lane is stricter
 *  than `exact`'s. */
function isArtifactReferenceShaped(raw: string): boolean {
  return isIdentifierShaped(raw) && /[./]/.test(raw);
}

/** Every non-excluded leaf clause a query folds to, alternation operands included — an
 *  exclusion (`-foo`) is a negative filter on a lane's results, never a positive signal that a
 *  lane should run, so it is left out here rather than treated the same as a term or phrase. */
function positiveLeaves(clauses: readonly QueryClause[]): QueryClause[] {
  const leaves: QueryClause[] = [];
  for (const clause of clauses) {
    if (clause.kind === "exclude") continue;
    if (clause.kind === "alternation") { leaves.push(...positiveLeaves(clause.alternatives ?? [])); continue; }
    leaves.push(clause);
  }
  return leaves;
}

/** The one place a `LaneDescriptor.name` is constructed — pinned to `LaneName`, so `lanesFor`
 *  cannot typo a lane name or push `"tag"`, though the field a caller reads back is wider. */
function pushLane(lanes: LaneDescriptor[], name: LaneName, applicability: LaneApplicability): void {
  lanes.push({ name, applicability });
}

/** Routes one query to the native lanes it actually reaches. Four independent rules, each reading
 *  `query` through `parseQuery`/`analyze` rather than a second parser of its own:
 *
 *   `exact`      — a positive clause is identifier-shaped: looked up by its unsplit spelling.
 *   `bm25`       — the shared `zz-lexical-v2` analyzer produces at least one base term (a Han
 *                  unigram or a Latin word) to rank; no Han-specific branch.
 *   `fuzzy`      — a positive clause is identifier-shaped and at least 3 scalars long, the floor a
 *                  GiST trigram index needs to mean anything; never reached by prose, Han or Latin.
 *   `provenance` — a positive clause is artifact-reference-shaped: specific enough to name one
 *                  artifact whose typed `zz.artifact_edge` neighbours can be resolved.
 *
 *  No `"tag"` branch exists. A lane whose rule finds nothing to match is absent from the returned
 *  array; no zero-result entry is fabricated for it. `QueryParseError` from a malformed query
 *  propagates to the caller unchanged rather than being flattened into "no lanes apply". */
export function lanesFor(query: string): LaneDescriptor[] {
  const leaves = positiveLeaves(parseQuery(query).clauses);
  const identifierLeaves = leaves.filter((c) => isIdentifierShaped(c.text));
  const hasAnalyzableTerm = leaves.some((c) => analyze(c.text).base.length > 0);

  const lanes: LaneDescriptor[] = [];
  if (identifierLeaves.length > 0) {
    pushLane(lanes, "exact", {
      rule: "identifier-shaped-clause",
      detail: "at least one clause carries an unsplit identifier spelling (a delimiter, camelCase/acronym or letter-digit boundary), looked up verbatim against zz.artifact_identifier.identifier_text",
    });
  }
  if (hasAnalyzableTerm) {
    pushLane(lanes, "bm25", {
      rule: "analyzable-base-term",
      detail: "the shared zz-lexical-v2 analyzer produced at least one Han or Latin base term to rank with pg_textsearch bm25 — true of Chinese prose exactly as of English prose",
    });
  }
  if (identifierLeaves.some((c) => Array.from(c.text).length >= 3)) {
    pushLane(lanes, "fuzzy", {
      rule: "identifier-shaped-clause-trigram-length",
      detail: "an identifier-shaped clause of at least 3 scalars exists for GiST trigram fuzzy matching over identifiers only, never over prose bodies",
    });
  }
  if (identifierLeaves.some((c) => isArtifactReferenceShaped(c.text))) {
    pushLane(lanes, "provenance", {
      rule: "artifact-reference-shaped-clause",
      detail: "an identifier-shaped clause also carries a '.' or '/', specific enough to name one artifact whose typed zz.artifact_edge neighbours (derived_from, cites) are resolvable",
    });
  }
  return lanes;
}
