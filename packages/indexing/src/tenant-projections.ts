/**
 * The tenant-information derived database's write path: replaying one owner's committed
 * transaction into the common/subtype/search projections that migration 070 created, the
 * file-backed compatibility-id map that survives a rebuild, and the per-corpus partitions
 * `zz.search_current`/`zz.search_evidence`/`zz.search_history` need before they can hold a row.
 *
 * NOTHING HERE OWNS A CONNECTION. `ProjectionClient` is the smallest shape a single connection
 * already satisfies — one `query(text, params)` — so a caller hands in whichever it has and a
 * test hands in a plain object that records calls. Nothing imports `pg` for its runtime here
 * except `connectIsolated` below, which is its own exception (see its own comment).
 *
 * MUST BE ONE DEDICATED CONNECTION, NEVER A `pg.Pool` DIRECTLY. `applyCommit` issues its own
 * `begin`/`commit`/`rollback` and depends on every statement in between landing on the SAME
 * session. A `pg.Pool` structurally satisfies `.query()` too, but handing one to `applyCommit`
 * sends `begin` down whichever connection happens to be free and the inserts down others —
 * no transaction at all, silently, and a real error only shows up as data that never quite
 * lands. Callers acquire a `pg.PoolClient` (`pool.connect()`) or use `connectIsolated` below,
 * never `pool.query` itself.
 *
 * WHAT `applyCommit` DOES NOT DO. It projects the common tables (`zz.artifact`,
 * `zz.artifact_revision`, `zz.artifact_event`, `zz.artifact_edge`), the two legacy-subtype
 * bridges when the caller supplies them, and its own replay/watermark bookkeeping. It does
 * NOT write to `zz.search_current`/`evidence`/`history` or to `zz.artifact_passage`/
 * `zz.artifact_identifier` — migration 070 creates those tables, but populating them needs a
 * text analyzer (`tenant-analysis.ts`, I-14) and a corpus-key derivation rule that do not exist
 * yet, and `semanticProjectionHash` below is not yet called from anywhere. A later task wires
 * both in. It does not decide which team a `team_slug` belongs to either — the subtype-bridge
 * writes in `applyCommit` only run when the CALLER supplies `docBridge`/`knowledgeBridge`,
 * because only the caller (the adapter that still speaks zz.doc's team_slug/initiative/path
 * vocabulary) knows that mapping.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import pg from "pg";

import type { ArtifactClass, ArtifactEvent, ContentRevision } from "@zz/contracts";

// ── the smallest shape a caller's pool/client already has ──────────────────────────────────

export interface ProjectionClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** A real `ProjectionClient` over one dedicated connection to an operator-provided database —
 *  used ONLY by `testing/tenant-info/rebuild.ts`'s integration case group, which this
 *  repository's tooling tsconfig (`tsconfig.tooling.json`) has no "pg" type declarations for,
 *  so that file never imports "pg" itself. Every other caller of `applyCommit`/`ensureCorpus`
 *  supplies its own pool/client — the gateway's `db.ts` and zz-core's `platform-db.ts` each
 *  already own one and neither needs this. One connection, not a pool: the integration cases
 *  need one session's transaction boundary, not concurrency. */
export async function connectIsolated(
  connectionString: string,
  // NOT A TOOL: `close()` below just ends this one pg connection — nothing to do with the
  // `initiative_close` MCP tool.
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

// ── the file-backed compatibility-id map ────────────────────────────────────────────────────
//
// "Preserve compatibility IDs through a file-backed migration map" and "never reallocated on
// rebuild" — this task's own contract. A rebuild that re-derives zz.doc/zz.knowledge_node rows
// from canonical files must not hand a document a fresh random id every time it runs, or every
// external reference to that row (zz.decision.doc_id, a bookmark, a link in prose) breaks on
// the next rebuild. This map is the durable record of "this owner+artifact already has id N",
// read before a rebuild starts and written back after — plain JSON, one file per deployment,
// never regenerated from scratch while any existing entry could still be looked up.

interface CompatibilityMap {
  readonly version: 1;
  readonly entries: Readonly<Record<string, number>>;
}

const EMPTY_MAP: CompatibilityMap = { version: 1, entries: {} };

/** A fresh or absent file reads as the empty map, not an error — the first rebuild of a new
 *  deployment has nothing to preserve yet. A file that exists but fails to parse as this
 *  map's own shape is the one case this refuses outright: silently discarding it would
 *  reallocate every id in the deployment, which is exactly what this map exists to prevent. */
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

/** The stable compatibility id for (owner, artifact) — allocated once, on first sight, and
 *  read back unchanged on every later call against a map that already has it, including
 *  across a full rebuild that reloads this file from disk. A plain function of its input
 *  rather than an in-place mutator: the map is data, and `applyCommit`/a rebuild walk decides
 *  when the updated map is actually durable via `saveCompatibilityMap`. */
export function compatIdFor(
  map: CompatibilityMap, ownerId: string, artifactId: string,
): { readonly id: number; readonly map: CompatibilityMap } {
  const key = compatKey(ownerId, artifactId);
  const existing = map.entries[key];
  if (existing !== undefined) return { id: existing, map };
  const next = 1 + Object.values(map.entries).reduce((highest, id) => Math.max(highest, id), 0);
  return { id: next, map: { version: 1, entries: { ...map.entries, [key]: next } } };
}

// ── the semantic parity hash ────────────────────────────────────────────────────────────────
//
// "Operational rebuild/index IDs are excluded from semantic parity hashes" — this task's own
// contract. Excluded BY CONSTRUCTION: this function's input type has no field for a rebuild's
// wall-clock duration, a physical index OID or a retry timestamp, so there is no way to feed
// one in by mistake. Two projections of the same semantic facts hash identically regardless
// of when, how many times or how slowly either one was produced.

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

// ── replaying one owner's committed transaction ─────────────────────────────────────────────

/** What one owner commit hands `applyCommit`: the identity/class it names, the revisions and
 *  events a real commit manifest already carries (see `services/zz-core/src/tenant-info/
 *  record.ts`'s `PreparedManifestInput` — this is the subset the derived database needs, not
 *  a second copy of that file's own shape), and the two legacy-subtype bridges, each supplied
 *  only when the caller actually knows that mapping. */
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

/** Applies one owner's committed manifest to every projection migration 070 created except
 *  the passage/identifier tables (see this module's header), in one transaction it owns
 *  itself — the caller passes a fresh client/connection, not one already mid-transaction.
 *
 *  "replay uses transaction_id as its unique key" and "an older queue item never overwrites a
 *  newer head": a transaction_id already recorded, or a sequence at or below the owner's
 *  current watermark, is a no-op that still commits (nothing to roll back) rather than an
 *  error — replaying an already-applied commit, or one that arrives out of order behind a
 *  newer one already applied, must never regress or duplicate what is already projected. */
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

    const latestRevision = manifest.revisions.reduce((m, r) => Math.max(m, r.revision), 0);
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

    // EVENTS BEFORE REVISIONS. `zz.artifact_edge.asserted_event_id` is an immediate (not
    // deferred) foreign key into `zz.artifact_event`, and the revisions loop below inserts
    // "cites" edges asserted by one of these same events — so on a real Postgres, inserting a
    // "cites" edge before its asserting event exists fails the whole transaction the moment
    // any revision carries a `sources` entry. The in-memory fake this suite's offline cases
    // use models no foreign keys and both its fixtures carry an empty `sources`, so neither
    // caught this ordering; `atomic_apply_against_isolated_database`'s own fixture does carry
    // one, against a real foreign key.
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

      // "cites" edges, asserted by whichever event actually produced this revision — a
      // SourceCitation has no event of its own, so the assertion is the revision's own. The
      // event row this references was inserted above, in the loop before this one.
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

// ── provisioning a corpus's own partition ───────────────────────────────────────────────────
//
// "Use separate PostgreSQL list partitions ... for each private owner and published shared
// shelf" — which corpora exist is a runtime fact (a tenant signs up, a shelf publishes), so
// migration 070 creates the three partitioned parents and a `_default` catch-all; this
// function attaches ONE partition per corpus to all three, the first time that corpus is
// about to hold a row. Idempotent: attaching a partition that already exists is a no-op.

const CORPUS_KEY = /^[a-z][a-z0-9_]{0,62}$/;

const SEARCH_PARENTS = ["zz.search_current", "zz.search_evidence", "zz.search_history"] as const;

/** `corpusKey` becomes part of a table name and a partition-bound literal, neither of which
 *  Postgres lets a bind parameter fill — so it is validated against a closed character set
 *  first and then interpolated, exactly the pattern `check:sql` already recognises and
 *  reports as "not checkable" rather than silently skips (see `packages/tools/src/testing/
 *  sql-check.ts`). Nothing about `corpusKey` is caller-supplied free text by the time it
 *  reaches here; the check above is what makes that true rather than assumed. */
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
  }
}
