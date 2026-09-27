/**
 * The knowledge index: the row a document gets in `zz.doc`, and the walks that rebuild it for
 * one team or for every team.
 *
 * A package rather than a module inside zz-core, because @zz/contracts, the scripts and the
 * checks import it too.
 *
 * Every tool that writes a file indexes it in the same call; a document the store holds and
 * the index does not know about is one `knowledge_search` cannot return. The reindex walks
 * cover the two cases that misses: a store restored from a backup, and a schema change that
 * alters what a row means.
 *
 * The pool is injected and the store root is not: zz-core hands over its lazily built pool once,
 * through `configureIndexing`, and the call inside stays `db()`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type pg from "pg";

import { documentBody, parseEnvelope } from "@zz/contracts";

// The package's door: a consumer imports `@zz/indexing`, not a path inside it. That is why
// the pure rules are re-exported here rather than reached by a deep import.
export { decisionRows, indexable, isoDate, type DecisionRow } from "./rules.js";
// `zz-lexical-v2`, the versioned analyzer. `buildRowVector` is also imported below, not only
// re-exported, because `indexDoc` calls it directly to build the `body_tsv` vector for both
// `zz.doc` and `zz.knowledge_node`. `passagesOf`/`identifierTokens` are not called from
// `indexDoc`/`reindexTeam`: both write at a fixed 200,000-character cutoff, and the two
// exist for callers that need passages or identifier spellings of their own.
export {
  ANALYZER_NAME, CURRENT_ANALYZER_VERSION, MAX_INPUT_BYTES, InputTooLargeError,
  assertWithinInputLimit, PASSAGE_MAX_SCALARS, PASSAGE_OVERLAP_SCALARS,
  passagesOf, identifierTokens, analyze, derivationFingerprint,
  OPACITY_SEEDS, OPACITY_CASES, analyzerDigestFor,
  // The write path below and the rederivation pass (`rebuildRowVector`, re-exported further
  // down) call this same function.
  buildRowVector,
  // The two text-search configuration names, and the `body_tsv` construction built from them.
  // COUPLED: the read path, `services/zz-core/src/tools/knowledge-search.ts`, must parse its
  // queries with the same configuration this file stores a Latin term through, or a stemmed
  // query stops matching an unstemmed stored word.
  TEXT_SEARCH_CONFIG, bodyTsvSql, bodyTsvParams, termsByWeight,
  type Passage, type DerivationVersions, type AnalysisField, type AnalysisTerm, type AnalysisResult,
  type RowVector, type RowVectorTerm, type RowVectorWeight,
} from "./tenant-analysis.js";
import { bodyTsvParams, bodyTsvSql, buildRowVector } from "./tenant-analysis.js";
// The generation-aware rederivation pass over existing `zz.doc`/`zz.knowledge_node` rows.
// `rederivation.js` imports only `tenant-analysis.js`, never this file, so re-exporting it here
// creates no import cycle — and `rebuildRowVector` lives there, beside this pass's only caller.
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

import { indexable, isoDate } from "./rules.js";

/** Where every team's store is mounted. */
export const ARTIFACTS_DIR = "/artifacts";

/** How this process reaches the platform database, as the service that owns the pool
 *  answers it. Null means the deployment has no database and indexes nothing.
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

/** The `zz.team.id` a shelf slug names, or null when no team carries it.
 *
 *  A knowledge node's shelf is a relation to `team` now, so the slug a directory is named by has
 *  to be resolved once and the id carried from there — a node written against a slug would sit
 *  on a shelf no reader can reach it from. */
async function teamIdOf(p: pg.Pool, teamSlug: string): Promise<string | null> {
  const row = (await p.query<{ id: string }>(
    "select id::text as id from zz.team where slug=$1", [teamSlug])).rows[0];
  return row?.id ?? null;
}

/** The same, refusing by name: a node whose directory names no team has no shelf to sit on, and
 *  the column would refuse a null anyway — with a message that never says which slug. */
async function teamIdFor(p: pg.Pool, teamSlug: string): Promise<string> {
  const id = await teamIdOf(p, teamSlug);
  if (!id) {
    throw new Error(
      `knowledge node on the shelf "${teamSlug}", and no team carries that slug — its team_id ` +
      "has no row to name, so the node is refused rather than written onto a shelf nobody reads");
  }
  return id;
}

/** The node a recorded successor ordinal names on one shelf, or null when it is not indexed yet.
 *  The ordinal is the file's own spelling, which is what `node_ordinal` stores. */
async function nodeIdForOrdinal(p: pg.Pool, teamId: string, ordinal: string): Promise<string | null> {
  const row = (await p.query<{ id: string }>(
    `select id::text as id from zz.knowledge_node
      where team_id=$1::uuid and node_ordinal=$2`, [teamId, ordinal])).rows[0];
  return row?.id ?? null;
}

/** The rebuild's second pass over one shelf's supersessions: every node whose file records a
 *  successor ordinal is re-keyed to the row that ordinal names.
 *
 *  A node can be indexed before its successor exists — the walk is alphabetical and `0008` sorts
 *  before `0099` — so the first pass leaves its `superseded_by_id` null and its row `adopted`.
 *  The ordinal is recorded in the file and not in the table, which is why this reads the shelf
 *  again rather than the rows: the row that would say it is the one being repaired.
 *
 *  `lifecycle` moves with the key, because the table's own check keeps `superseded` and a named
 *  successor together; a node that names its own ordinal is left alone, as nothing supersedes
 *  itself. */
async function resolveSupersessions(p: pg.Pool, teamId: string | null, root: string): Promise<number> {
  if (!teamId) return 0;
  const ndir = join(root, "_knowledge", "nodes");
  if (!existsSync(ndir)) return 0;
  let repaired = 0;
  for (const abs of walk(ndir)) {
    const rel = abs.slice(root.length + 1);
    if (!indexable(rel)) continue;
    const named = /^_knowledge\/nodes\/([0-9]+)-(.+)\.md$/.exec(rel);
    if (!named) continue;
    const recorded = (parseEnvelope(readFileSync(abs, "utf8")).supersededBy ?? "")
      .replace(/^["']|["']$/g, "").trim();
    if (!recorded || recorded === "null" || recorded === named[1]) continue;
    const r = await p.query(
      `update zz.knowledge_node k
          set superseded_by_id = s.id,
              lifecycle = 'superseded'
         from zz.knowledge_node s
        where k.team_id = $1::uuid and k.node_ordinal = $2
          and s.team_id = $1::uuid and s.node_ordinal = $3`,
      [teamId, named[1], recorded]);
    repaired += r.rowCount ?? 0;
  }
  return repaired;
}

/** Write one file's row into zz.doc — envelope fields plus full text, derived and
 * rebuildable. Returns true when the index actually changed.
 *
 * `skipIfHash` makes a rebuild cheap: a reindex over an unchanged corpus does one SELECT
 * per file and no writes. On the normal write path it is off — the caller just wrote the
 * file and the row must reflect it. */
export async function indexDoc(root: string, relPath: string, content: string, skipIfHash = false): Promise<boolean> {
  try {
    const p = db();
    if (!p) return false;
    const teamSlug = root.startsWith(join(ARTIFACTS_DIR, "teams") + "/")
      ? root.slice(join(ARTIFACTS_DIR, "teams").length + 1)
      : "";
    if (!teamSlug) return false;
    if (!indexable(relPath)) return false;
    const parts = relPath.replace(/^\/+/, "").split("/");
    const env = parseEnvelope(content);
    // The body is stored, not just vectorised: ts_headline needs the source text to cut an
    // excerpt and ts_rank needs it to score.
    const body = documentBody(content).slice(0, 200_000);
    const title = (env.title ?? "").replace(/^["']|["']$/g, "").trim()
      || parts[parts.length - 1].replace(/\.md$/, "");
    const list = (v?: string): string[] => (v ?? "").replace(/^\[|\]$/g, "")
      .split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    // A frozen approval snapshot is a superseded copy of the live document, derived from the
    // path rather than frontmatter: the snapshot is a byte copy of what was approved, so it
    // can never say this about itself. `include_superseded: false` reads exactly this field.
    //
    // A knowledge node is not a document and goes to its own table. A node is adopted until
    // something better replaces it; nobody approves one, so `zz.doc.status` would have to
    // carry both a gate verdict and a lifecycle. Recognised by both halves, which agree on
    // every row in the store: the initiative is `_knowledge` and the address is under `nodes/`.
    // Returning early is what keeps the two subjects from sharing a row.
    if (parts[0] === "_knowledge" && parts[1] === "nodes") {
      // The shelf is a team row now, not a slug: a node's `team_id` is a key, and a directory
      // whose slug names no team has no shelf for the row to sit on. Refused by name — the
      // column would refuse a null anyway, with a message that never says which slug.
      const teamId = await teamIdFor(p, teamSlug);
      // The file's name is the address, and it carries both halves: `nodes/0028-a-lesson.md`
      // is ordinal `0028` and slug `a-lesson`, which is what the spec's
      // `unique (team_id, node_ordinal)` is for. A name that is not that shape has no honest
      // pair to write, so it is refused rather than split by a guess.
      const address = parts.slice(1).join("/");
      const named = /^nodes\/([0-9]+)-(.+)\.md$/.exec(address);
      if (!named) {
        throw new Error(
          `knowledge node ${relPath} is not <nodes>/<ordinal>-<slug>.md — the ordinal and the ` +
          "slug are its address now, and a name that carries neither has no honest pair");
      }
      const [, nodeOrdinal, slug] = named;
      const kind = env.type ?? "knowledge";
      const cited = list(env.evidence);
      // The successor is recorded in the file as an ordinal, which is what a reader is sent to;
      // the row holds the key, resolved here. A node indexed before its successor exists
      // resolves to nothing — `reindexTeam`'s second pass re-keys it afterwards — and
      // `lifecycle` follows the resolution rather than the file, because the table's own check
      // keeps `superseded` and a named successor together and the file cannot name one.
      const successorOrdinal = (env.supersededBy ?? "").replace(/^["']|["']$/g, "").trim();
      const successorId = successorOrdinal && successorOrdinal !== "null"
        ? await nodeIdForOrdinal(p, teamId, successorOrdinal)
        : null;
      const lifecycle = env.status === "superseded" && successorId ? "superseded" : "adopted";
      const nodeHash = createHash("sha256")
        .update(JSON.stringify([kind, lifecycle, successorOrdinal, title, body,
                                list(env.tags), cited])).digest("hex").slice(0, 32);
      if (skipIfHash) {
        const cur = await p.query<{ content_hash: string }>(
          "select content_hash from zz.knowledge_node where team_id=$1::uuid and node_ordinal=$2",
          [teamId, nodeOrdinal]);
        if (cur.rows[0]?.content_hash === nodeHash) return false;
      }
      // Analysed by `zz-lexical-v2`, not parsed as prose in SQL. `buildRowVector` is the
      // analyzer's own segmentation, done once and shared with the rederivation pass;
      // `bodyTsvSql`/`bodyTsvParams` group its flat term list into six space-joined strings,
      // one per weight per configuration, so the Han half is stored by `simple` exactly as
      // the analyzer emitted it and the Latin half by the same configuration the read path
      // queries with. A failure in `buildRowVector`/`analyze` propagates out of this `try` to
      // the `catch` at the foot of this function: the write fails outright, with no prose
      // fallback.
      const nodeVector = buildRowVector({ title, tags: list(env.tags), body });
      const node = (await p.query<{ id: string }>(
        `insert into zz.knowledge_node
           (team_id, node_ordinal, slug, kind, lifecycle, superseded_by_id,
            title, body, tags, content_hash, updated_at, analyzer_version, body_tsv)
         -- The node's own recorded date, not the moment the index ran: a rebuild must not restamp
         -- the journal. The date field is what knowledge_add writes into the node frontmatter;
         -- now() is the fallback for a node that carries none, because a null would lose the
         -- ordering entirely.
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,
                 coalesce($11::timestamptz, now()), $20,
                 ${bodyTsvSql(12)})
         on conflict (team_id, node_ordinal) do update set
           slug=excluded.slug, kind=excluded.kind, lifecycle=excluded.lifecycle,
           superseded_by_id=excluded.superseded_by_id, title=excluded.title, body=excluded.body,
           tags=excluded.tags, content_hash=excluded.content_hash,
           updated_at=excluded.updated_at, analyzer_version=excluded.analyzer_version,
           body_tsv=excluded.body_tsv
         returning id::text as id`,
        [teamId, nodeOrdinal, slug, kind, lifecycle, successorId,
         title, body, list(env.tags), nodeHash,
         /^\d{4}-\d{2}-\d{2}$/.test((env.date ?? "").trim()) ? env.date.trim() : null,
         // $12-$19 — the eight `bodyTsvSql` binds: the two configuration names, then the
         // six space-joined term strings (A/B/C x latin/han). $20 is the analyzer.
         ...bodyTsvParams(nodeVector), nodeVector.analyzer])).rows[0];
      // The citations are rows now, not a slug array: a slug is team-scoped, so the store's 58
      // citations that point at another shelf could not be told apart from a same-named
      // initiative on the node's own. Rewritten wholesale rather than diffed — the file is the
      // source of truth for what a node cites, and the set is a handful of rows.
      //
      // A cited slug that names no initiative on any shelf inserts nothing, which is the
      // reading the migration takes of a citation it cannot resolve; `knowledge_add` refuses
      // one at the door, so this is the repair path for a store that changed underneath it.
      // The citing node's own team wins a tie, the way the migration resolves the ambiguity.
      await p.query("delete from zz.knowledge_node_evidence where node_id=$1::uuid", [node.id]);
      for (const citedSlug of cited) {
        await p.query(
          `insert into zz.knowledge_node_evidence (node_id, initiative_id)
           select $1::uuid, i.id
             from zz.initiative i
             join zz.team t on t.id = i.team_id
            where i.slug = $2
            order by (t.id = $3::uuid) desc, i.id
            limit 1
           on conflict do nothing`,
          [node.id, citedSlug, teamId]);
      }
      return true;
    }

    const snapshotOf = /^_versions\/(.+)\.v\d+\.md$/.exec(parts.slice(1).join("/"))?.[1];
    const superseded = snapshotOf
      ? `${snapshotOf}.md`
      : (env.supersededBy ?? "").replace(/^["']|["']$/g, "").trim();
    // DELIBERATE: the derived row is what gets hashed, not the file. A row is skipped exactly
    // when re-deriving it would produce what is already stored, whether the file moved, the
    // logic in this function moved, or neither; hashing the file misses the second.
    //
    // A snapshot inherits the type of what it snapshots. The fallback is the filename with
    // `.md` off, and a frozen approval copy is `<name>.v<N>.md`, which would otherwise index
    // `_versions/notes.v1.md` as type `notes.v1` — a type nothing else has and no filter
    // names. `snapshotOf` already holds the document it is a copy of, and the version is
    // carried by the path.
    const fallbackType = (snapshotOf ?? parts[parts.length - 1].replace(/\.md$/, ""))
      .replace(/\.md$/, "");
    const values = [teamSlug, parts[0], parts.slice(1).join("/"),
      env.flow ?? "", env.type ?? fallbackType,
      env.status ?? "", env.outcome ?? null, env.approved_by ?? null,
      isoDate(env.approved_at),
      // Who closed it. The platform validates and stamps this on the envelope; without the
      // column, "who closed this" can only be answered by opening the document.
      env.closed_by ?? null,
      body, title, list(env.tags),
      // What caused this version. No write path sets an `evidence:` frontmatter field, but
      // `document_revise` refuses a version that names no cause and writes what it was told
      // into the envelope's `sources`, so `sources` is the fallback. `evidence` wins where it
      // is set: a document that names its evidence explicitly makes a stronger claim than one
      // whose sources happen to be listed.
      list(env.evidence || env.sources),
      superseded && superseded !== "null" ? superseded : null];
    // The same `buildRowVector` the `zz.knowledge_node` branch above and the rederivation
    // pass call — one mapping from title/tags/body to a weighted term list, never two that
    // could disagree. `body`/`title`/`list(env.tags)` are the values already in `values`.
    const docVector = buildRowVector({ title, tags: list(env.tags), body });
    // The row is what gets hashed: a skip is correct exactly when re-deriving this row would
    // produce what is already stored. The claims a document makes are not part of the row —
    // they are recomputed from its body by whoever reads them — so nothing derived from them
    // belongs in the hash.
    const hash = createHash("sha256")
      .update(JSON.stringify(values)).digest("hex").slice(0, 32);
    if (skipIfHash) {
      const cur = await p.query<{ content_hash: string }>(
        "select content_hash from zz.doc where team_slug=$1 and initiative=$2 and path=$3",
        [teamSlug, parts[0], parts.slice(1).join("/")]);
      if (cur.rows[0]?.content_hash === hash) return false;
    }
    await p.query(
      `insert into zz.doc (team_slug, initiative, initiative_id, path, flow, type, status, outcome, approved_by, approved_at, closed_by, updated_at, body, title, tags, evidence, superseded_by, content_hash, supports, analyzer_version, body_tsv)
       -- When the document changed, not when the indexer last ran: a reindex touches every file
       -- it re-derives and must not restamp the corpus. The envelope's updated_at is stamped by
       -- the platform on every write, so it is authoritative; now() is the fallback for a
       -- document whose envelope has no date at all.
       --
       -- initiative_id is resolved here, inline, from the same $1/$2 this statement already
       -- binds team_slug/initiative from — the same reason services/gateway/src/events.ts
       -- resolves team_id inline: the id has to come from the same statement that writes the
       -- row, not a second round trip that can disagree with it. Null when the initiative row
       -- does not exist (a store predating 002_initiative_anchor.sql, or a caller writing
       -- outside a database-backed initiative_open) — the same as today, until reindexed.
       values ($1,$2, (select i.id from zz.initiative i join zz.team t on t.id = i.team_id
                        where t.slug = $1 and i.slug = $2),
               $3,$4,$5,$6,$7,$8,$9,$10, coalesce($17::timestamptz, now()), $11,$12,$13::text[],$14::text[],$15,$16, $18, $27,
               -- title A, tags B, body C: the analyzer's own terms for each field ($19-$26, from
               -- buildRowVector/bodyTsvParams above), not the raw columns re-parsed by a prose
               -- text-search configuration, which would take an unspaced Han run as one opaque word.
               -- Two configurations, and bodyTsvSql is the only place either is named: Latin words go
               -- through the one the read path's websearch_to_tsquery uses, so stemming happens once and
               -- both sides agree; Han unigrams and zh-bigrams go through simple, which does no stemming
               -- and no dictionary lookup, so they are stored exactly as the analyzer emitted them.
               ${bodyTsvSql(19)})
       on conflict (team_slug, initiative, path) do update set
         initiative_id=excluded.initiative_id,
         flow=excluded.flow, type=excluded.type, status=excluded.status, outcome=excluded.outcome,
         approved_by=excluded.approved_by, approved_at=excluded.approved_at,
         closed_by=excluded.closed_by, updated_at=excluded.updated_at,
         body=excluded.body, title=excluded.title, tags=excluded.tags,
         evidence=excluded.evidence, superseded_by=excluded.superseded_by,
         content_hash=excluded.content_hash, supports=excluded.supports,
         analyzer_version=excluded.analyzer_version, body_tsv=excluded.body_tsv`,
      // $17 — the file's own mtime, with the envelope's date as the fallback and now()
      // behind that. Parsed here rather than in SQL so an unparseable value degrades to
      // index time instead of failing the whole document's row. A rebuild must not move
      // the time, and re-reading a file does not change its mtime; the envelope date is a
      // day, so it reports midnight. `date` as well as `updated_at`, because a knowledge
      // node carries `date` — that is what knowledge_add writes.
      [...values, hash,
       (() => {
         try { return statSync(join(root, relPath)).mtime.toISOString(); } catch { /* fall through */ }
         const day = [env.updated_at, env.date]
           .find((v) => /^\d{4}-\d{2}-\d{2}/.test(v ?? ""))?.slice(0, 10);
         return day ?? null;
       })(),
       // $18 — which document this source was attached to; the chain from "what we
       // learned" to "what we changed" is joined on it.
       env.supports ?? null,
       // $19-$26 — the eight `bodyTsvSql` binds for title/tags/body (two configuration
       // names, then six space-joined term strings), and $27 the analyzer that produced
       // them (`docVector`/`bodyTsvParams` above).
       ...bodyTsvParams(docVector), docVector.analyzer],
    );
    return true;
  } catch (err) {
    console.error("doc index failed:", err);
    return false;
  }
}

/** Every file a team has in its store — not every file on disk under it.
 *
 * Dot-directories are skipped, `.git` being the one that exists: the store is a git
 * repository, and its objects, hooks and refs sort before the documents. `_versions/` and
 * `_knowledge/` start with an underscore, not a dot: they are content and are walked.
 *
 */
export function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile()) yield p;
  }
}
/** Rebuild one team's derived index from its files.
 *
 * The files are the source of truth; this table is a cache reconstructible from them at any
 * time. Three things happen, in this order:
 *
 *   1. every .md under the team root is hashed and re-indexed if the hash moved
 *   2. rows whose file no longer exists are deleted — a ghost row answers confidently with
 *      something that is gone
 *   3. counts come back so a caller can see what changed
 *
 * An unchanged corpus costs one SELECT per file and zero writes. */
export async function reindexTeam(teamSlug: string, force = false): Promise<{ scanned: number; indexed: number; removed: number }> {
  const root = join(ARTIFACTS_DIR, "teams", teamSlug);
  const p = db();
  if (!p) return { scanned: 0, indexed: 0, removed: 0 };
  // Two reasons a root is absent, and they are handled differently:
  //
  //   the teams/ directory is gone  — the volume is not mounted. Touch nothing: every team
  //                                   would look deleted and one boot would empty the index.
  //   this team's directory is gone — the team's store was removed. Its rows go with it.
  if (!existsSync(join(ARTIFACTS_DIR, "teams"))) return { scanned: 0, indexed: 0, removed: 0 };
  if (!existsSync(root)) {
    const r = await p.query("delete from zz.doc where team_slug=$1", [teamSlug]);
    // And the knowledge shelf: a team's nodes live in their own table, so cleaning zz.doc
    // alone leaves a retired team's journal answering knowledge_search. The shelf is a team
    // row now, so the cleanup keys on its id rather than on the slug the directory was named by.
    const teamId = await teamIdOf(p, teamSlug);
    const n = teamId
      ? await p.query("delete from zz.knowledge_node where team_id=$1::uuid", [teamId])
      : { rowCount: 0 };
    return { scanned: 0, indexed: 0, removed: (r.rowCount ?? 0) + (n.rowCount ?? 0) };
  }
  // Resolved once for the whole walk: the node reaping and the supersession pass behind it both
  // key on `team_id`, and the nodes themselves resolve it again per file because the write path
  // has only the directory to read it from.
  const teamId = await teamIdOf(p, teamSlug);
  const found = new Set<string>();
  let scanned = 0, indexed = 0;
  for (const abs of walk(root)) {
    const rel = abs.slice(root.length + 1);
    if (!indexable(rel)) continue;             // same predicate the write path applies
    const parts = rel.split("/");
    scanned++;
    found.add(`${parts[0]}\u0000${parts.slice(1).join("/")}`);
    if (await indexDoc(root, rel, readFileSync(abs, "utf8"), !force)) indexed++;
  }
  const rows = await p.query<{ initiative: string; path: string }>(
    "select initiative, path from zz.doc where team_slug=$1", [teamSlug]);
  const gone = rows.rows.filter((r) => !found.has(`${r.initiative}\u0000${r.path}`));
  // The knowledge shelf is reaped too, from its own table. The walk above adds a node to
  // `found` like any other file, keyed the way the walk keys it: a node's `initiative`
  // segment is the literal `_knowledge` directory and the rest of the name is its address,
  // which the table now splits into the ordinal and the slug. Rebuilt here from the two
  // columns, because that pair is what the row carries.
  const nodeRows = await p.query<{ node_ordinal: string; slug: string }>(
    "select node_ordinal, slug from zz.knowledge_node where team_id=$1::uuid", [teamId]);
  const nodesGone = nodeRows.rows
    .filter((r) => !found.has(`_knowledge\u0000nodes/${r.node_ordinal}-${r.slug}.md`));
  for (const g of nodesGone) {
    await p.query("delete from zz.knowledge_node where team_id=$1::uuid and node_ordinal=$2",
      [teamId, g.node_ordinal]);
  }
  // Before the removals are reported, so a node repaired here is not also counted as reaped.
  await resolveSupersessions(p, teamId, root);
  for (const g of gone) {
    await p.query("delete from zz.doc where team_slug=$1 and initiative=$2 and path=$3",
      [teamSlug, g.initiative, g.path]);
  }
  return { scanned, indexed, removed: gone.length + nodesGone.length };
}
/** What one team's rebuild did, with the team named. */
export interface TeamReindex {
  team: string; scanned: number; indexed: number; removed: number;
  /** Set when that one team threw. The walk continues. */
  error?: string;
}
/** Rebuild every team: zz-core's boot rebuild, and `knowledge_reindex` with no `team`.
 *
 * DELIBERATE: not awaited by zz-core's startup. The service answers requests while this
 * runs, and anything it misses is repaired by the next write or an explicit
 * knowledge_reindex call.
 *
 * Returns one row per team; the boot log and `knowledge_reindex`'s answer are both built
 * from what it returns.
 *
 * The union of the directories and the indexed slugs is what the caller must not rebuild for
 * itself: walking teams/ alone can only ever visit a team that still has a store, so the one
 * team that needs cleaning — the one whose store is gone — is the one never visited. */
export async function reindexAllTeams(force = false): Promise<TeamReindex[]> {
  const teamsDir = join(ARTIFACTS_DIR, "teams");
  const p = db();
  if (!p || !existsSync(teamsDir)) return [];
  // The directories are not the whole list: walking teams/ alone can only visit a team that
  // still has a store. The union with what the index believes closes it.
  const dirs = readdirSync(teamsDir, { withFileTypes: true })
    .filter((t) => t.isDirectory()).map((t) => t.name);
  // Both tables: a team can hold knowledge nodes and no documents at all, so asking zz.doc
  // alone leaves exactly that team unvisited. The node half is its own literal because the
  // table no longer carries a shelf slug: it resolves one through `zz.team`, and a statement
  // that names `zz.knowledge_node` names no column this reshape retired.
  const nodeShelves =
    "select t.slug from zz.knowledge_node k join zz.team t on t.id = k.team_id";
  const indexed = (await p.query<{ team_slug: string }>(
    `select team_slug from zz.doc
     union
     ${nodeShelves}`)).rows.map((r) => r.team_slug);
  const out: TeamReindex[] = [];
  for (const name of [...new Set([...dirs, ...indexed])].sort()) {
    // One team's failure is one team's: an uncaught throw would end the boot rebuild and
    // leave every team after it unindexed. The row carries the reason so a caller reporting
    // this can say which team.
    try {
      const r = await reindexTeam(name, force);
      console.log(`knowledge index: ${name} — ${r.scanned} scanned, ${r.indexed} re-indexed, ${r.removed} removed`);
      out.push({ team: name, ...r });
    } catch (err) {
      console.error(`reindex ${name} failed:`, err);
      out.push({ team: name, scanned: 0, indexed: 0, removed: 0, error: (err as Error).message });
    }
  }
  return out;
}
