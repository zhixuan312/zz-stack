/**
 * The knowledge index's door: the analyzer, the query grammar, the snippet reader, the decision
 * reader and the generation-aware rederivation pass, re-exported so a consumer imports
 * `@zz/indexing` rather than a path inside it.
 *
 * The store walk that used to live here went with the store. Phase 6 made the database the
 * record: a document's bytes are `zz.doc_revision` rows and its identity is a `zz.doc` row, so
 * there is no file to walk and nothing to derive a row FROM but the row itself. What is left of
 * a rebuild is `reindexTeam`/`reindexAllTeams` below — the two derived columns (`body_tsv`,
 * `analyzer_version`) recomputed from each row's own `title`/`tags`/`body`, which is what
 * `knowledge_reindex` means once the rows are the source of truth.
 *
 * The pool is injected and the store root is not: zz-core hands over its lazily built pool once,
 * through `configureIndexing`, and the call inside stays `db()`.
 */
import { createHash } from "node:crypto";

import type pg from "pg";

import { bodyTsvParams, bodyTsvSql, buildRowVector, inputLimitRefusal } from "./tenant-analysis.js";

// The package's door: a consumer imports `@zz/indexing`, not a path inside it. That is why
// the pure rules are re-exported here rather than reached by a deep import.
export { decisionRows, type DecisionRow } from "./rules.js";
// `zz-lexical-v2`, the versioned analyzer. `buildRowVector` is also imported below, not only
// re-exported, because the reindex pass calls it to rebuild a row's `body_tsv`.
export {
  ANALYZER_NAME, CURRENT_ANALYZER_VERSION, MAX_INPUT_BYTES, InputTooLargeError,
  assertWithinInputLimit, inputLimitRefusal, PASSAGE_MAX_SCALARS, PASSAGE_OVERLAP_SCALARS,
  passagesOf, identifierTokens, analyze, derivationFingerprint,
  buildRowVector,
  // The two text-search configuration names, and the `body_tsv` construction built from them.
  // COUPLED: the read path, `services/zz-core/src/tools/knowledge-search.ts`, must parse its
  // queries with the same configuration this package stores a Latin term through, or a stemmed
  // query stops matching an unstemmed stored word.
  TEXT_SEARCH_CONFIG, bodyTsvSql, bodyTsvParams, termsByWeight,
  type Passage, type DerivationVersions, type AnalysisField, type AnalysisTerm, type AnalysisResult,
  type RowVector, type RowVectorTerm, type RowVectorWeight,
} from "./tenant-analysis.js";
// The generation-aware rederivation pass over existing `zz.doc`/`zz.knowledge_node` rows.
// `rederivation.js` imports only `tenant-analysis.js`, never this file, so re-exporting it here
// creates no import cycle — and `rebuildRowVector` lives there, beside its only caller.
export { planRebuild, queryGeneration, rederiveCorpus, rederiveAll, rebuildRowVector, type RebuildRowInput, type RebuildPlan, type GenerationQuery, type GenerationStatusResult, type CorpusRebuildRecord, type RederivationClient } from "./rederivation.js";
// The query-grammar lexer: quotes, exclusions and explicit `OR`, read on the raw text before
// `identifierTokens`/`analyze` above ever see it.
export {
  parseQuery, QueryParseError,
  type QueryClauseKind, type QueryClause, type QueryAst,
} from "./query-grammar.js";
// A citation for a hit: original-byte snippet extraction, widened to a character boundary and
// never an analyzer term.
export { snippetFor, type Snippet } from "./snippet.js";

/** How this process reaches the platform database, as the service that owns the pool
 *  answers it. Null means the deployment has no database and reindexes nothing.
 *
 *  DELIBERATE: the unconfigured default throws rather than returning null. Returning null
 *  would make an indexer nobody wired indistinguishable from a deployment with TEAM_DB_URL
 *  unset. */
let db: () => pg.Pool | null = () => {
  throw new Error(
    "@zz/indexing was never configured — the service that owns the connection pool must call " +
    "configureIndexing(db) at import time. Indexing without it would silently write nothing.");
};

/** Hand this package the accessor for the platform database. Called once, by zz-core's
 *  `platform-db.ts`, which owns the pool. */
export function configureIndexing(accessor: () => pg.Pool | null): void {
  db = accessor;
}

/** The `zz.team.id` a slug names, or null when no team carries it.
 *
 *  A knowledge node's shelf is a relation to `team`, so the slug the tool names has to be
 *  resolved once and the id carried from there — a node written against a slug would sit on a
 *  shelf no reader can reach it from. */
export async function teamIdOf(p: pg.Pool, teamSlug: string): Promise<string | null> {
  const row = (await p.query<{ id: string }>(
    "select id::text as id from zz.team where slug=$1", [teamSlug])).rows[0];
  return row?.id ?? null;
}

/** The node a recorded successor ordinal names on one shelf, or null when it is not written yet.
 *  The ordinal is the spelling both the node and its successor carry. */
async function nodeIdForOrdinal(p: pg.Pool, teamId: string, ordinal: string): Promise<string | null> {
  const row = (await p.query<{ id: string }>(
    `select id::text as id from zz.knowledge_node
      where team_id=$1::uuid and node_ordinal=$2`, [teamId, ordinal])).rows[0];
  return row?.id ?? null;
}

/** A journal node, written as a row: `zz.knowledge_node` and its evidence relation.
 *
 * The journal's nodes were files under `_knowledge/nodes/`; the store is retired and the row is
 * the node. Both halves are written in one call — a node whose row and whose evidence disagree
 * is one `knowledge_search` answers with half a node — and the derived columns come from the
 * same `buildRowVector` every other writer of a `body_tsv` calls.
 *
 * `cited` names initiatives by slug and is resolved to ids here: a slug is team-scoped and an
 * identity is not, and the evidence relation is the id. A cited slug that names no initiative
 * on any shelf inserts nothing — the same reading the migration takes of a citation it cannot
 * resolve, and `knowledge_add` refuses one at the door. */
export async function indexNode(node: {
  team: string;
  ordinal: string;
  slug: string;
  kind: string;
  title: string;
  body: string;
  tags: readonly string[];
  /** A successor named by ORDINAL, as a supersession records it. Resolved to the row's id here;
   *  a node indexed before its successor exists resolves to nothing and stays `adopted`. */
  successorOrdinal?: string | null;
  cited?: readonly string[];
}): Promise<{ id: string } | { taken: true } | { refusal: string }> {
  const p = db();
  if (!p) return { refusal: "ERROR: no platform database — there is nowhere to write this node." };
  const teamId = await teamIdOf(p, node.team);
  if (!teamId) {
    return { refusal:
      `ERROR: knowledge node on the shelf "${node.team}", and no team carries that slug — its ` +
      "team_id has no row to name, so the node is refused rather than written onto a shelf " +
      "nobody reads" };
  }
  const cited = [...(node.cited ?? [])];
  const successorOrdinal = (node.successorOrdinal ?? "").trim();
  const successorId = successorOrdinal && successorOrdinal !== "null"
    ? await nodeIdForOrdinal(p, teamId, successorOrdinal)
    : null;
  // The table's own check keeps `superseded` and a named successor together, and a node that
  // names no successor is `adopted` — the lifecycle a node nothing has replaced carries.
  const lifecycle = successorId ? "superseded" : "adopted";
  const tags = [...node.tags];
  // The whole body: a node past the limit is refused by `buildRowVector`, never stored shortened.
  const body = node.body;
  const hash = createHash("sha256")
    .update(JSON.stringify([node.kind, lifecycle, successorOrdinal, node.title, body, tags, cited]))
    .digest("hex").slice(0, 32);
  let vector: ReturnType<typeof buildRowVector>;
  try {
    vector = buildRowVector({ title: node.title, tags, body });
  } catch (err) {
    const refusal = inputLimitRefusal(`knowledge node "${node.title}"`, err);
    if (refusal) return { refusal };
    throw err;
  }
  /* One transaction, because a node and its evidence are one fact. Written separately, a failure
   * between them left a node whose evidence was half-rewritten, and the caller's retry — which is
   * what `taken` exists for — minted a second node beside it. The allocator's rule is untouched:
   * a taken ordinal still returns having written nothing. */
  const client = await p.connect();
  try {
    await client.query("begin");
    const id = (await client.query<{ id: string }>(
      `insert into zz.knowledge_node
         (team_id, node_ordinal, slug, kind, lifecycle, superseded_by_id,
          title, body, tags, content_hash, updated_at, analyzer_version, body_tsv)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, now(), $11,
               ${bodyTsvSql(12)})
       -- DELIBERATE: do nothing, never do update. The ordinal IS the node's identity, so a
       -- conflict means somebody else minted this number between the caller's read and this
       -- write — the caller recomputes and tries the next one. An upsert here would overwrite
       -- their node with this one's, which is the one thing an id allocator must not do.
       on conflict (team_id, node_ordinal) do nothing
       returning id::text as id`,
      [teamId, node.ordinal, node.slug, node.kind, lifecycle, successorId, node.title, body, tags,
       hash, vector.analyzer, ...bodyTsvParams(vector)])).rows[0];
    if (!id) { await client.query("rollback"); return { taken: true }; }
    // Rewritten wholesale rather than diffed — a node's evidence is a handful of rows and the
    // caller states the whole set.
    await client.query("delete from zz.knowledge_node_evidence where node_id=$1::uuid", [id.id]);
    for (const citedSlug of cited) {
      await client.query(
        `insert into zz.knowledge_node_evidence (node_id, initiative_id)
         select $1::uuid, i.id
           from zz.initiative i
           join zz.team t on t.id = i.team_id
          where i.slug = $2
          order by (t.id = $3::uuid) desc, i.id
          limit 1
         on conflict do nothing`,
        [id.id, citedSlug, teamId]);
    }
    await client.query("commit");
    return id;
  } catch (err) {
    // Nothing half-written reaches the store: the caller either gets a node with its whole
    // evidence or gets the error, which is the rule this function states and did not keep.
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** A node superseded by another on the same shelf: the successor's key on the old node, and the
 *  lifecycle that key requires. One statement, because the table's own check keeps the two
 *  together and a node `superseded` with no successor is one no reader can follow. */
export async function supersedeNode(nodeId: string, successorId: string): Promise<void> {
  const p = db();
  if (!p) return;
  await p.query(
    `update zz.knowledge_node set superseded_by_id = $2::uuid, lifecycle = 'superseded'
      where id = $1::uuid`, [nodeId, successorId]);
}

/** What one team's rebuild did, with the team named. */
export interface TeamReindex {
  team: string;
  /** Rows this rebuild looked at, across both corpora. */
  scanned: number;
  /** Rows whose derived columns it rewrote. */
  indexed: number;
  /** Set when that one team threw. The walk continues. */
  error?: string;
}

/** The two tables a rebuild re-derives, and the key each one is walked in. The `where` is what
 *  scopes a corpus to one team: `zz.doc` reaches its team through the initiative it is filed
 *  under, `zz.knowledge_node` carries `team_id` itself. */
const CORPORA = [
  {
    table: "zz.doc",
    scope: "initiative_id in (select id from zz.initiative where team_id = $1::uuid)",
    update: "update zz.doc set analyzer_version = $2, body_tsv = " + bodyTsvSql(3) + " where id = $1::uuid",
  },
  {
    table: "zz.knowledge_node",
    scope: "team_id = $1::uuid",
    update: "update zz.knowledge_node set analyzer_version = $2, body_tsv = " + bodyTsvSql(3) + " where id = $1::uuid",
  },
] as const;

/** Re-derive one team's `body_tsv` and `analyzer_version` from the rows themselves.
 *
 * The rows are the source of truth now, so a rebuild is not a re-read of anything: it is the
 * analyzer's own pass over what a row already holds. Two columns move and nothing else does —
 * a rebuild must never restamp content, a revision or an approval.
 *
 * `force` re-derives every row even where `analyzer_version` already names the current
 * analyzer. That is what a generation bump needs: what a row's vector SHOULD be changed while
 * its content stayed byte-identical, so a skip keyed to the content hash would leave exactly
 * the rows the rebuild exists for. */
export async function reindexTeam(
  teamSlug: string, force = false,
): Promise<TeamReindex> {
  const p = db();
  if (!p) return { team: teamSlug, scanned: 0, indexed: 0 };
  const teamId = await teamIdOf(p, teamSlug);
  if (!teamId) return { team: teamSlug, scanned: 0, indexed: 0 };
  let scanned = 0, indexed = 0;
  for (const corpus of CORPORA) {
    const rows = await p.query<{ id: string; title: string | null; tags: string[] | null;
                                 body: string | null; analyzer_version: string | null }>(
      `select id::text as id, title, tags, body, analyzer_version
         from ${corpus.table}
        where ${corpus.scope}`, [teamId]);
    for (const row of rows.rows) {
      scanned++;
      const vector = buildRowVector({ title: row.title ?? "", tags: row.tags ?? [], body: row.body ?? "" });
      if (!force && row.analyzer_version === vector.analyzer) continue;
      await p.query(corpus.update, [row.id, vector.analyzer, ...bodyTsvParams(vector)]);
      indexed++;
    }
  }
  return { team: teamSlug, scanned, indexed };
}

/** Rebuild every team: `knowledge_reindex` with no `team`.
 *
 * DELIBERATE: not awaited by zz-core's startup. The service answers requests while this runs,
 * and anything it misses is repaired by the next write or an explicit knowledge_reindex call.
 *
 * The team list is `zz.team` — every team on the deployment, whether or not it holds a row
 * yet, because "which teams exist" is a fact about the roster and not about the index. */
export async function reindexAllTeams(force = false): Promise<TeamReindex[]> {
  const p = db();
  if (!p) return [];
  const teams = (await p.query<{ slug: string }>("select slug from zz.team order by slug")).rows;
  const out: TeamReindex[] = [];
  for (const { slug } of teams) {
    // One team's failure is one team's: an uncaught throw would end the boot rebuild and
    // leave every team after it unindexed. The row carries the reason so a caller reporting
    // this can say which team.
    try {
      const r = await reindexTeam(slug, force);
      console.log(`knowledge index: ${slug} — ${r.scanned} scanned, ${r.indexed} re-derived`);
      out.push(r);
    } catch (err) {
      console.error(`reindex ${slug} failed:`, err);
      out.push({ team: slug, scanned: 0, indexed: 0, error: (err as Error).message });
    }
  }
  return out;
}
