/**
 * The knowledge index: the row a document gets in `zz.doc`, the claims derived from it, and
 * the walks that rebuild both for one team or for every team.
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
// `indexDoc`/`reindexTeam`: those write their two tables at a fixed 200,000-character cutoff,
// and passages feed `zz.artifact_passage`/`zz.artifact_identifier`.
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
// `rederivation.js` imports only `tenant-rebuild.js` and `tenant-analysis.js`, never this
// file, so re-exporting both here creates no import cycle.
export { planRebuild, queryGeneration, rederiveCorpus, rederiveAll, type RebuildPlan, type GenerationQuery, type GenerationStatusResult, type CorpusRebuildRecord, type RederivationClient } from "./rederivation.js";
export { rebuildRowVector, type RebuildRowInput } from "./tenant-rebuild.js";
// The query-grammar lexer: quotes, exclusions and explicit `OR`, read on the raw text before
// `identifierTokens`/`analyze` above ever see it.
export {
  parseQuery, QueryParseError,
  type QueryClauseKind, type QueryClause, type QueryAst,
} from "./query-grammar.js";
// A citation for a hit: original-byte snippet extraction, widened to a character boundary and
// never an analyzer term.
export { snippetFor, type Snippet } from "./snippet.js";
// Which native lanes (exact, BM25, fuzzy-identifier, typed-provenance) a query actually
// reaches — pure routing over `parseQuery`/`analyze` above, no database involved. The
// DB-bound pieces of `tenant-projections.js` (`applyCommit`, `ensureCorpus`,
// `connectIsolated`) are reached by deep import instead. No `"tag"` lane exists here.
export {
  lanesFor,
  type LaneName, type LaneApplicability, type LaneDescriptor,
} from "./tenant-projections.js";
// The scope-restriction plan built on top of `lanesFor` above. Pure and synchronous exactly
// like `lanesFor`: it plans a native retrieval call rather than running one.
export { planSearch } from "./search-plan.js";

import { decisionRows, indexable, isoDate } from "./rules.js";

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
    // every row in the store: the initiative is `_knowledge` and the path is under `nodes/`.
    // Returning early is what keeps the two subjects from sharing a row.
    if (parts[0] === "_knowledge" && parts[1] === "nodes") {
      const kind = env.type ?? "knowledge";
      const lifecycle = env.status === "superseded" ? "superseded" : "adopted";
      const supersededBy = (env.supersededBy ?? "").replace(/^["']|["']$/g, "").trim();
      const nodeHash = createHash("sha256")
        .update(JSON.stringify([kind, lifecycle, supersededBy, title, body,
                                list(env.tags), list(env.evidence)])).digest("hex").slice(0, 32);
      if (skipIfHash) {
        const cur = await p.query<{ content_hash: string }>(
          "select content_hash from zz.knowledge_node where team_slug=$1 and path=$2",
          [teamSlug, parts.slice(1).join("/")]);
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
      await p.query(
        `insert into zz.knowledge_node
           (team_slug, path, kind, lifecycle, superseded_by,
            title, body, tags, evidence, content_hash, updated_at, analyzer_version, body_tsv)
         -- The node's own recorded date, not the moment the index ran: a rebuild must not restamp
         -- the journal. The date field is what knowledge_add writes into the node frontmatter;
         -- now() is the fallback for a node that carries none, because a null would lose the
         -- ordering entirely.
         values ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,
                 coalesce($11::timestamptz, now()), $20,
                 ${bodyTsvSql(12)})
         on conflict (team_slug, path) do update set
           kind=excluded.kind, lifecycle=excluded.lifecycle,
           superseded_by=excluded.superseded_by, title=excluded.title, body=excluded.body,
           tags=excluded.tags, evidence=excluded.evidence, content_hash=excluded.content_hash,
           updated_at=excluded.updated_at, analyzer_version=excluded.analyzer_version,
           body_tsv=excluded.body_tsv`,
        [teamSlug, parts.slice(1).join("/"), kind, lifecycle,
         supersededBy && supersededBy !== "null" ? supersededBy : null,
         title, body, list(env.tags), list(env.evidence), nodeHash,
         /^\d{4}-\d{2}-\d{2}$/.test((env.date ?? "").trim()) ? env.date.trim() : null,
         // $12-$19 — the eight `bodyTsvSql` binds: the two configuration names, then the
         // six space-joined term strings (A/B/C x latin/han). $20 is the analyzer.
         ...bodyTsvParams(nodeVector), nodeVector.analyzer]);
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
    // The decision rows are part of what this function writes, so they belong in the hash:
    // without them the skip is blind to a change in `decisionRows`. A row is skipped
    // correctly only when re-deriving everything would produce what is already stored.
    const role = (env.type ?? "").trim();
    const claims = /^(selection|agreement|plan)$/.test(role) && !snapshotOf
      ? decisionRows(body) : [];
    const hash = createHash("sha256")
      .update(JSON.stringify([values, role, claims])).digest("hex").slice(0, 32);
    if (skipIfHash) {
      const cur = await p.query<{ content_hash: string }>(
        "select content_hash from zz.doc where team_slug=$1 and initiative=$2 and path=$3",
        [teamSlug, parts[0], parts.slice(1).join("/")]);
      if (cur.rows[0]?.content_hash === hash) return false;
    }
    // `returning id`, because the decision rows written below carry `zz.decision.doc_id`, the
    // foreign key an acceptance criterion joins back to its spec on. A backfill cannot hold
    // it: this function deletes and re-inserts a document's claims on every reindex.
    const inserted = await p.query<{ id: string }>(
      `insert into zz.doc (team_slug, initiative, path, flow, type, status, outcome, approved_by, approved_at, closed_by, updated_at, body, title, tags, evidence, superseded_by, content_hash, supports, analyzer_version, body_tsv)
       -- When the document changed, not when the indexer last ran: a reindex touches every file
       -- it re-derives and must not restamp the corpus. The envelope's updated_at is stamped by
       -- the platform on every write, so it is authoritative; now() is the fallback for a
       -- document whose envelope has no date at all.
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($17::timestamptz, now()), $11,$12,$13::text[],$14::text[],$15,$16, $18, $27,
               -- title A, tags B, body C: the analyzer's own terms for each field ($19-$26, from
               -- buildRowVector/bodyTsvParams above), not the raw columns re-parsed by a prose
               -- text-search configuration, which would take an unspaced Han run as one opaque word.
               -- Two configurations, and bodyTsvSql is the only place either is named: Latin words go
               -- through the one the read path's websearch_to_tsquery uses, so stemming happens once and
               -- both sides agree; Han unigrams and zh-bigrams go through simple, which does no stemming
               -- and no dictionary lookup, so they are stored exactly as the analyzer emitted them.
               ${bodyTsvSql(19)})
       on conflict (team_slug, initiative, path) do update set
         flow=excluded.flow, type=excluded.type, status=excluded.status, outcome=excluded.outcome,
         approved_by=excluded.approved_by, approved_at=excluded.approved_at,
         closed_by=excluded.closed_by, updated_at=excluded.updated_at,
         body=excluded.body, title=excluded.title, tags=excluded.tags,
         evidence=excluded.evidence, superseded_by=excluded.superseded_by,
         content_hash=excluded.content_hash, supports=excluded.supports,
         analyzer_version=excluded.analyzer_version, body_tsv=excluded.body_tsv
       returning id`,
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
    const docId = inserted.rows[0]?.id ?? null;
      // The claims this document makes, replaced wholesale rather than merged: a revision
      // that drops a criterion must drop its row too.
      //
      // DELIBERATE: the delete runs for every document and the insert only for ones that
      // make claims. Guarding both together leaves the rows of a document that has stopped
      // producing claims — a `_versions/` snapshot — in place forever.
      //
      // Snapshots make no claims of their own: a frozen copy's claims are the live
      // document's, so indexing both would count every prediction twice.
    const initiative = parts[0];
    const docPath = parts.slice(1).join("/");
    await p.query(
      "delete from zz.decision where team_slug=$1 and initiative=$2 and path=$3",
      [teamSlug, initiative, docPath]);
    for (const c of claims) {
      await p.query(
        `insert into zz.decision (team_slug, initiative, path, role, key, verdict, qualifier, detail, checker, updated_at, doc_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
        [teamSlug, initiative, docPath, role, c.key, c.verdict,
         c.qualifier, c.detail, c.checker, docId]);
    }
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
    await p.query("delete from zz.decision where team_slug=$1", [teamSlug]);
    // And the knowledge shelf: a team's nodes live in their own table, so cleaning zz.doc
    // alone leaves a retired team's journal answering knowledge_search.
    const n = await p.query("delete from zz.knowledge_node where team_slug=$1", [teamSlug]);
    return { scanned: 0, indexed: 0, removed: (r.rowCount ?? 0) + (n.rowCount ?? 0) };
  }
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
  // segment is the literal `_knowledge` directory and its path is the rest.
  const nodeRows = await p.query<{ path: string }>(
    "select path from zz.knowledge_node where team_slug=$1", [teamSlug]);
  const nodesGone = nodeRows.rows.filter((r) => !found.has(`_knowledge\u0000${r.path}`));
  for (const g of nodesGone) {
    await p.query("delete from zz.knowledge_node where team_slug=$1 and path=$2",
      [teamSlug, g.path]);
  }
  for (const g of gone) {
    // Both tables: a document's row lives in zz.doc and its claims live in zz.decision, keyed
    // the same way. indexDoc deletes the claims of a document it is about to re-index, which
    // never runs for a document that no longer exists.
    await p.query("delete from zz.doc where team_slug=$1 and initiative=$2 and path=$3",
      [teamSlug, g.initiative, g.path]);
    await p.query("delete from zz.decision where team_slug=$1 and initiative=$2 and path=$3",
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
  // alone leaves exactly that team unvisited.
  const indexed = (await p.query<{ team_slug: string }>(
    `select team_slug from zz.doc
     union
     select team_slug from zz.knowledge_node`)).rows.map((r) => r.team_slug);
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
