/**
 * The knowledge index: the row a document gets in `zz.doc`, the claims derived from it, and
 * the walks that rebuild both for one team or for every team.
 *
 * A PACKAGE AND NOT A MODULE INSIDE zz-core, since Task I-38. `knowledge_reindex` belongs on
 * `/manage` — rebuilding a team's index is an administrative act on a team, not a step in
 * anybody's flow — and the gateway serves that door. It had no indexer and no way to reach
 * zz-core's, so the tool could not move: a service cannot import another service. Copying the
 * two functions across would have left this platform with two indexers that agree until the
 * day one of them is edited, which is the failure this whole surface redesign exists to
 * remove. So the indexer is a package, and zz-core and the gateway import the same one.
 *
 * A document the store holds and the index does not know about is a document `knowledge_search`
 * cannot return, which reads to the person asking as though the work was never done. So every
 * tool that writes a file indexes it in the same call, and the reindex walks exist for the two
 * cases that cannot be covered that way: a store restored from a backup, and a schema change
 * that alters what a row means.
 *
 * WHY THE POOL IS INJECTED AND THE STORE ROOT IS NOT. The two services reach their database
 * differently and both shapes are correct: zz-core builds its pool LAZILY, so "is there one"
 * is a race and every read has to go through `db()`; the gateway builds its EAGERLY at boot
 * and asks `platformDbReady()`. This package cannot pick one without making the other wrong,
 * so each service hands over its own accessor once — `configureIndexing` — and the shape of
 * the call inside stays `db()`, which is the same accessor discipline both services are held
 * to. `ARTIFACTS_DIR` is the opposite case: it is ONE path on the deployment, both containers
 * mount it at it, and a second spelling of it in the gateway would be the drift this package
 * was created to end. So it is defined here, once, and both services import it from here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type pg from "pg";

import { documentBody, parseEnvelope } from "@zz/contracts";

// The package's DOOR, and the reason the pure rules are re-exported through it rather than
// reached by a deep import: `@zz/contracts` states the same rule about identity.ts and
// alias.ts one line from its own top. A consumer imports `@zz/indexing`, not a path inside it.
export { decisionRows, indexable, isoDate, type DecisionRow } from "./rules.js";
// `zz-lexical-v2`, the versioned analyzer for the derived tables migration 070 created, and,
// since Task I-38, for `indexDoc`'s own `body_tsv` below too — `buildRowVector` is imported
// for local use just below, not only re-exported, because `indexDoc` calls it directly to
// build the vector for both `zz.doc` and `zz.knowledge_node` instead of the english
// text-search configuration this file used to build it with. `passagesOf`/`identifierTokens`
// are NOT called from `indexDoc`/`reindexTeam` — those still write their two tables at the
// fixed 200,000-character cutoff this analyzer has no part of, and passages are a projection
// input for the derived tables migration 070 created, wired in by whichever task populates
// `zz.artifact_passage`/`zz.artifact_identifier`. Re-exported here so a caller outside this
// file imports one door, `@zz/indexing`, rather than a deep path into it — the same reason
// `rules.js` is re-exported above.
export {
  ANALYZER_NAME, CURRENT_ANALYZER_VERSION, MAX_INPUT_BYTES, InputTooLargeError,
  assertWithinInputLimit, PASSAGE_MAX_SCALARS, PASSAGE_OVERLAP_SCALARS,
  passagesOf, identifierTokens, analyze, derivationFingerprint,
  OPACITY_SEEDS, OPACITY_CASES, analyzerDigestFor,
  // `buildRowVector` moved here from this file by Task I-13, so the write path below and the
  // rederivation pass (`rebuildRowVector`, re-exported further down) import the same function
  // rather than each keeping its own copy — see `tenant-analysis.ts`'s own comment on it.
  buildRowVector,
  // The two text-search configuration names, and the `body_tsv` construction built from them.
  // Re-exported because the READ path (`services/zz-core/src/tools/knowledge-search.ts`) has to
  // parse its queries with the same configuration this file stores a Latin term through; when
  // the two were written out separately in the two files they drifted, and a stemmed query
  // stopped matching an unstemmed stored word.
  TEXT_SEARCH_CONFIG, bodyTsvSql, bodyTsvParams, termsByWeight,
  type Passage, type DerivationVersions, type AnalysisField, type AnalysisTerm, type AnalysisResult,
  type RowVector, type RowVectorTerm, type RowVectorWeight,
} from "./tenant-analysis.js";
import { bodyTsvParams, bodyTsvSql, buildRowVector } from "./tenant-analysis.js";
// The generation-aware rederivation pass over EXISTING `zz.doc`/`zz.knowledge_node` rows —
// Task I-13 — re-exported through this same door. `rebuildRowVector` lives in
// `tenant-rebuild.js` (its own file's header explains why); `planRebuild`/`queryGeneration`
// live in `rederivation.js`, which never imports this file back — only `tenant-rebuild.js`
// and `tenant-analysis.js`, so re-exporting both here creates no import cycle.
export { planRebuild, queryGeneration, rederiveCorpus, rederiveAll, type RebuildPlan, type GenerationQuery, type GenerationStatusResult, type CorpusRebuildRecord, type RederivationClient } from "./rederivation.js";
export { rebuildRowVector, type RebuildRowInput } from "./tenant-rebuild.js";
// The query-grammar lexer: quotes, exclusions and explicit `OR`, read on the raw text BEFORE
// `identifierTokens`/`analyze` above ever see it — re-exported through this door for the same
// reason everything else on this page is, rather than a deep import into `query-grammar.js`.
export {
  parseQuery, QueryParseError,
  type QueryClauseKind, type QueryClause, type QueryAst,
} from "./query-grammar.js";
// A citation for a hit: original-byte snippet extraction, widened to a character boundary and
// never an analyzer term — re-exported through this door for the same reason everything else
// on this page is, rather than a deep import into `snippet.js`.
export { snippetFor, type Snippet } from "./snippet.js";
// Which native lanes (exact, BM25, fuzzy-identifier, typed-provenance) a query actually
// reaches — pure routing over `parseQuery`/`analyze` above, no database involved, so it is
// re-exported through this door exactly like the rest of this page rather than through
// `tenant-projections.js`'s own deep import path, which the DB-bound pieces of that file
// (`applyCommit`, `ensureCorpus`, `connectIsolated`) still use. No `"tag"` lane exists here.
export {
  lanesFor,
  type LaneName, type LaneApplicability, type LaneDescriptor,
} from "./tenant-projections.js";
// The scope-restriction plan built on top of `lanesFor` above — I-12 — re-exported through
// this same door for the reason everything else on this page is, rather than a deep import
// into `search-plan.js`. Pure and synchronous exactly like `lanesFor`: see that file's own
// header for why it plans a native retrieval call rather than running one.
export { planSearch } from "./search-plan.js";
// The retrieval-consumption contract and its serializer — I-14 — re-exported through this
// same door for the reason everything else on this page is. See `retrieval-serializer.ts`'s
// own header for why `serializeReceipt` touches no database either, exactly like `lanesFor`
// and `planSearch` above.
export {
  serializeReceipt,
  type RetrievalScope, type RetrievalItem, type RetrievalReceipt,
  type Ref, type LegacyRef, type ExecutionRef, type RawResponseCapture,
  type RawRetrievalRow, type SerializeReceiptInput,
} from "./retrieval-serializer.js";

import { decisionRows, indexable, isoDate } from "./rules.js";

/** Where every team's store is mounted. zz-core mounts it read-write and the gateway
 *  read-only; a rebuild only READS files and writes rows, so read-only is enough. */
export const ARTIFACTS_DIR = "/artifacts";

/** How this process reaches the platform database, as the service that owns the pool
 *  answers it. Null is an ordinary answer — a deployment with no database indexes nothing
 *  and says so — and the unconfigured state is NOT that answer, which is why it throws.
 *
 *  A silent `return false` here would be indistinguishable from "this deployment has no
 *  database", so an indexer nobody wired would look exactly like a laptop with TEAM_DB_URL
 *  unset: every write claiming to be indexed, nothing in `zz.doc`, and no line anywhere
 *  saying why. That failure has already been paid for once in this file's history, when
 *  `pool` was read directly and a write arriving before the first connection went to disk
 *  and never reached the index. */
let db: () => pg.Pool | null = () => {
  throw new Error(
    "@zz/indexing was never configured — the service that owns the connection pool must call " +
    "configureIndexing(db) at import time. Indexing without it would silently write nothing.");
};

/** Hand this package the accessor for the platform database. Called once per process, by the
 *  module that owns the pool: `platform-db.ts` in zz-core, `db.ts` in the gateway. */
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
    // db(), not `pool`. This asked whether anybody had connected yet, so a write arriving
    // before the first database-backed request went to disk and never reached the index —
    // and knowledge_search answers "nothing is known" for a document that is right there.
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
    // excerpt and ts_rank needs it to score. Without it the store can say an answer exists
    // but never what it is.
    const body = documentBody(content).slice(0, 200_000);
    const title = (env.title ?? "").replace(/^["']|["']$/g, "").trim()
      || parts[parts.length - 1].replace(/\.md$/, "");
    const list = (v?: string): string[] => (v ?? "").replace(/^\[|\]$/g, "")
      .split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    // A frozen approval snapshot IS a superseded copy of the live document, and until this
    // line nothing in the index said so. `_versions/spec.v1.md` carried `status: approved`
    // from its own frontmatter and an empty superseded_by, so it came back from
    // knowledge_search indistinguishable from the current spec — three rows for one
    // document on this store, all reading as approved, and `include_superseded: false`
    // filtered none of them because that filter reads exactly this field. 28 of 164 indexed
    // rows are snapshots.
    //
    // Derived from the path, not from frontmatter: the snapshot is a byte copy of what was
    // approved, so it can never say this about itself.
    // A KNOWLEDGE NODE IS NOT A DOCUMENT, and it goes to its own table.
    //
    // A node is adopted until something better replaces it; nobody approves one. Sharing
    // `zz.doc.status` with a gate verdict meant every query about gates had to remember to
    // exclude 853 rows and every query about knowledge to include only them — a predicate
    // every caller must remember is one some caller will forget.
    //
    // Recognised by BOTH halves, which agree on every row in the store: the initiative is
    // `_knowledge` and the path is under `nodes/`. Returning early is what keeps the two
    // subjects from ever sharing a row again.
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
      // Task I-38: analysed by `zz-lexical-v2`, not parsed as prose in SQL. `buildRowVector`
      // is the analyzer's own segmentation, done once and shared with Task I-13's
      // rederivation; `bodyTsvSql`/`bodyTsvParams` group its flat term list into six
      // space-joined strings — one per weight per configuration — so the Han half is stored
      // by `simple` exactly as the analyzer emitted it (Task I-8's fixture) and the Latin
      // half by the same configuration the read path queries with, which is what keeps a
      // stemmed query matching a stored word. A failure in `buildRowVector`/`analyze`
      // propagates out of this `try` to the `catch` at the foot of this function: the write
      // fails outright, and no statement here re-parses prose to fall back on.
      const nodeVector = buildRowVector({ title, tags: list(env.tags), body });
      await p.query(
        `insert into zz.knowledge_node
           (team_slug, path, kind, lifecycle, superseded_by,
            title, body, tags, evidence, content_hash, updated_at, analyzer_version, body_tsv)
         -- THE NODE'S OWN RECORDED DATE, not the moment the index ran. This was now(), so
         -- every row said "recorded" whenever it was last re-derived: a force rebuild
         -- restamps the entire journal to one afternoon, and the console Recorded column
         -- which reads this then reports 859 nodes as all having been written that day.
         -- Measured on this deployment: every node across all three shelves carries
         -- updated_at 2026-09-16, which is exactly one such rebuild. The date field is what
         -- knowledge_add writes into the node frontmatter; now() remains the fallback for a
         -- node that carries none, because a null here would lose the ordering entirely.
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
    // The DERIVED ROW is what gets hashed, not the file.
    //
    // Hashing the file made the rebuild blind to the only other thing that can change a
    // row: this function. Marking every _versions/ snapshot as superseded changed what the
    // index should say about 28 rows without touching a byte on disk, so the next reindex
    // read 28 unchanged hashes, skipped all 28, and reported "0 re-indexed" while the
    // index went on saying the old thing. I had already claimed in a commit message that a
    // reboot would fix it; the database said otherwise.
    //
    // Hashing what we are about to WRITE makes skipping correct by construction: a row is
    // skipped exactly when re-deriving it would produce what is already stored, whether the
    // file moved, the logic moved, or neither.
    // A SNAPSHOT INHERITS THE TYPE OF WHAT IT SNAPSHOTS. The fallback is the filename with
    // `.md` off, and a frozen approval copy is `<name>.v<N>.md` — so `_versions/notes.v1.md`
    // was indexed as type `notes.v1`, a type nothing else has and no filter names. `snapshotOf`
    // already holds the document it is a copy of; the version belongs in the path, which
    // carries it, and not in a second field that reads as a kind.
    const fallbackType = (snapshotOf ?? parts[parts.length - 1].replace(/\.md$/, ""))
      .replace(/\.md$/, "");
    const values = [teamSlug, parts[0], parts.slice(1).join("/"),
      env.flow ?? "", env.type ?? fallbackType,
      env.status ?? "", env.outcome ?? null, env.approved_by ?? null,
      isoDate(env.approved_at),
      // WHO CLOSED IT. The platform validates and stamps this already — a close is the most
      // consequential act on the platform — and stored it nowhere, so "who closed this" could
      // only be answered by opening the document.
      env.closed_by ?? null,
      body, title, list(env.tags),
      // WHAT CAUSED THIS VERSION, ON THE DOCUMENT AND NOT ONLY BESIDE IT.
      //
      // `evidence` read an `evidence:` frontmatter field that no write path has ever set, so
      // the column was declared on every row and populated on NONE -- 0 of 365 on this
      // deployment, measured -- while `knowledge_add`, which refuses a node that cites nothing,
      // carried it on 867 of 867. A column nothing fills is worse than an absent one: every
      // query over it answers "no document has evidence", which is false.
      //
      // The cause is recorded. `document_revise` REFUSES a version that names none and writes
      // what it was told into the envelope's `sources` -- so the fact existed the whole time
      // and landed in a field the index did not read. Falling back to it is what makes the
      // column true, rather than adding a second place for callers to say the same thing.
      //
      // `evidence` still wins where it is set, because a document that names its evidence
      // explicitly is making a stronger claim than one whose sources happen to be listed.
      list(env.evidence || env.sources),
      superseded && superseded !== "null" ? superseded : null];
    // Task I-38: the same `buildRowVector` `indexDoc`'s `zz.knowledge_node` branch above
    // calls, and the one Task I-13's rederivation pass calls too — one analyzer-driven
    // mapping from title/tags/body to a weighted term list, never two that could disagree.
    // `body`/`title`/`list(env.tags)` are the same values already sitting in `values` above.
    const docVector = buildRowVector({ title, tags: list(env.tags), body });
    // The decision rows are part of what this function WRITES, so they belong in the hash.
    //
    // Without them the skip is blind to exactly one thing again: a change to decisionRows.
    // Adding this derivation to a store of unchanged documents produced "64 files scanned,
    // 0 re-indexed" and not one selection row — the same shape of miss that hashing the file
    // instead of the row produced last time, one derivation later. A row is skipped
    // correctly only when re-deriving EVERYTHING would produce what is already stored.
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
    // `returning id`, because the decision rows written below carry a foreign key to
    // this document and nothing was ever putting a value in it. zz.decision.doc_id
    // existed, was indexed, and was null on 836 of 941 rows — every join from an
    // acceptance criterion back to the spec that stated it had to go through three
    // text columns instead. Worse, a backfill could not hold: this function DELETES
    // and re-inserts a document's claims on every reindex, so each rebuild put the
    // column back to null. The id is right here; it only had to be carried.
    const inserted = await p.query<{ id: string }>(
      `insert into zz.doc (team_slug, initiative, path, flow, type, status, outcome, approved_by, approved_at, closed_by, updated_at, body, title, tags, evidence, superseded_by, content_hash, supports, analyzer_version, body_tsv)
       -- WHEN THE DOCUMENT CHANGED, not when the indexer last ran.
       --
       -- This was now(). A reindex touches every file it re-derives, so one rebuild
       -- restamped all 496 documents on this deployment to the same afternoon and the
       -- whole corpus claimed to have been written at once — the store held six
       -- distinct dates, the index held one. Every "what changed this week", every
       -- ordering by recency and every trend over the document set was reading the
       -- rebuild rather than the work.
       --
       -- The envelope already carries the answer and the platform stamps it itself
       -- (see the updated_at line written on every write), so it is authoritative
       -- rather than a model's claim. now() survives only as the fallback for a
       -- document whose envelope has no date at all.
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($17::timestamptz, now()), $11,$12,$13::text[],$14::text[],$15,$16, $18, $27,
               -- title A, tags B, body C — unchanged since the positions moved when closed_by
               -- was inserted at $10 (see below). Task I-38: the analyzer's own terms for each
               -- field ($19-$26, from buildRowVector/bodyTsvParams above), not the raw columns
               -- re-parsed by a prose text-search configuration — that tokenizes on whitespace
               -- and punctuation, so an unspaced Han run went in as one opaque word.
               -- TWO configurations, not one, and bodyTsvSql is the only place either is
               -- named: Latin words go through the same one the read path's
               -- websearch_to_tsquery uses, so stemming happens once and both sides agree;
               -- Han unigrams and zh-bigrams go through simple, which does no stemming and no
               -- dictionary lookup, so they are stored exactly as the analyzer emitted them.
               -- Storing the whole vector through simple -- this task's first form -- left
               -- every English word whose stem differs from its surface form unfindable.
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
      // $17 — the envelope's own date, or null so the insert falls back to now().
      // Parsed here rather than in SQL so an unparseable value degrades to "index
      // time" instead of failing the whole document's row.
      // `date` as well as `updated_at`: BOTH are envelope fields, and a knowledge
      // node carries `date` because that is what knowledge_add writes. Reading only
      // one meant every node on production fell through to now() and the whole
      // journal claimed to have been written the afternoon it was last reindexed.
      // THE FILE'S OWN MTIME, with the envelope's date as the fallback.
      //
      // This was the envelope date cast to ::date, which is a day and therefore midnight —
      // so every one of 565 documents on this deployment reported `00:00`, and the console
      // showed a whole corpus written at the stroke of the day. The envelope was the right
      // instinct for the wrong half of the problem: it is there because now() restamped every
      // document to the moment of the last reindex, and what it protects is that a REBUILD
      // must not move the time.
      //
      // The mtime protects that too — re-reading a file does not change it — and it is a real
      // timestamp rather than a day. The envelope date stays as the fallback for a document
      // whose file cannot be stat'd, and now() behind that for one with no date at all.
      [...values, hash,
       (() => {
         try { return statSync(join(root, relPath)).mtime.toISOString(); } catch { /* fall through */ }
         const day = [env.updated_at, env.date]
           .find((v) => /^\d{4}-\d{2}-\d{2}/.test(v ?? ""))?.slice(0, 10);
         return day ?? null;
       })(),
       // $18 — which document this source was attached to. Every source carries it
       // and nothing indexed it, so the chain from "what we learned" to "what we
       // changed" could be read by opening files and by no query at all.
       env.supports ?? null,
       // $19-$26 — the eight `bodyTsvSql` binds for title/tags/body (two configuration
       // names, then six space-joined term strings), and $27 the analyzer that produced
       // them (`docVector`/`bodyTsvParams` above).
       ...bodyTsvParams(docVector), docVector.analyzer],
    );
    const docId = inserted.rows[0]?.id ?? null;
      // The claims this document makes, replaced wholesale rather than merged: a revision
      // that drops a criterion must drop its row too, and an upsert alone would leave the
      // old one standing as a prediction nobody makes any more.
      // The DELETE runs for every document, the insert only for ones that make claims.
      //
      // Guarding both together left a _versions/ snapshot's rows in place forever: once
      // snapshots stopped producing claims, the block stopped running for them at all, so
      // nothing removed the fifty rows the earlier pass had written. A replace has to be
      // able to replace with nothing.
      //
      // Snapshots make no claims of their own: a frozen copy's claims ARE the live
      // document's, so indexing both counts every prediction twice — and "what have we
      // predicted about casebox" is exactly the question this table exists to answer.
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

/** Every file a TEAM has in its store — not every file on disk under it.
 *
 * Dot-directories are skipped, `.git` being the one that exists. The store became a git
 * repository this release, and a walker that does not know reports the repository's own
 * machinery as the team's work: measured on a store holding three documents, document_list
 * returned 32 entries of which 29 were git objects, hooks and refs — and they sort FIRST, so
 * the first thing an agent reading a store saw was `.git/COMMIT_EDITMSG`. On a store with a
 * quarter of history behind it that is thousands of entries burying the documents.
 *
 * ONE walker, because there were two. The reindexer had its own with the dot-directory rule
 * and the lister had this one without it — the same question answered twice, and the copy
 * that had not been told is the one that broke. `_versions/` and `_knowledge/` start with an
 * underscore, not a dot: they are content and are walked.
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
 * The files are the source of truth; this table is a cache that must be reconstructible
 * from them at any time. Three things happen, in this order:
 *
 *   1. every .md under the team root is hashed and re-indexed if the hash moved
 *   2. rows whose file no longer exists are deleted — a ghost row is the worst failure
 *      this store has, because it answers confidently with something that is gone
 *   3. counts come back so a caller can see what changed
 *
 * Cheap by construction: an unchanged corpus costs one SELECT per file and zero writes. */
export async function reindexTeam(teamSlug: string, force = false): Promise<{ scanned: number; indexed: number; removed: number }> {
  const root = join(ARTIFACTS_DIR, "teams", teamSlug);
  const p = db();
  if (!p) return { scanned: 0, indexed: 0, removed: 0 };
  // TWO REASONS A ROOT IS ABSENT, and one early return used to cover both.
  //
  //   the teams/ directory is gone  — the volume is not mounted. Touch nothing: every team
  //                                   would look deleted and one boot would empty the index.
  //   THIS team's directory is gone — the team's store was removed. Its rows must go with it.
  //
  // Conflating them left a retired team's rows in zz.doc for good, answering confidently with
  // documents that are not there — "a ghost row is the worst failure this store has", says the
  // comment forty lines down, which was describing the case this function could not reach.
  // Six rows survived archiving zz-team and had to be deleted by hand.
  if (!existsSync(join(ARTIFACTS_DIR, "teams"))) return { scanned: 0, indexed: 0, removed: 0 };
  if (!existsSync(root)) {
    const r = await p.query("delete from zz.doc where team_slug=$1", [teamSlug]);
    await p.query("delete from zz.decision where team_slug=$1", [teamSlug]);
    // AND THE KNOWLEDGE SHELF. A team's nodes are its own subject in their own table since
    // migration 059, and this only ever cleaned zz.doc — so a retired team's journal
    // survived the archive and went on answering knowledge_search, which is the ghost-row
    // failure the paragraph above calls the worst this store has.
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
  // THE KNOWLEDGE SHELF IS REAPED TOO, and it is a SECOND table since migration 059.
  //
  // The walk above indexes a node into zz.knowledge_node and adds it to `found` like any
  // other file, but this reap only ever asked zz.doc what it believed — so a node deleted or
  // renamed on disk kept its row for good, unreachable by the rebuild that exists to repair
  // exactly that. "A search returned a document whose file is gone" is the stated reason
  // knowledge_reindex exists, and for a knowledge node it could not answer it.
  //
  // Keyed the same way the walk keys it: a node's `initiative` segment is the literal
  // `_knowledge` directory and its path is the rest.
  const nodeRows = await p.query<{ path: string }>(
    "select path from zz.knowledge_node where team_slug=$1", [teamSlug]);
  const nodesGone = nodeRows.rows.filter((r) => !found.has(`_knowledge\u0000${r.path}`));
  for (const g of nodesGone) {
    await p.query("delete from zz.knowledge_node where team_slug=$1 and path=$2",
      [teamSlug, g.path]);
  }
  for (const g of gone) {
    // BOTH tables. A document's row lives in zz.doc and its claims live in zz.decision, keyed
    // the same way, and only one of them was being cleaned. indexDoc deletes the claims of a
    // document it is about to re-index — which never runs for a document that no longer
    // exists, so a deleted or renamed selection left its predictions behind permanently, to
    // be joined against a path nothing would ever produce again.
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
  /** Set when that ONE team threw. The walk continues; see the loop below. */
  error?: string;
}
/** Rebuild every team: zz-core's boot rebuild, and `knowledge_reindex` with no `team`.
 *
 * Deliberately not awaited by zz-core's startup: the service answers requests while this
 * runs, and a partially-rebuilt index is strictly better than a service that will not start.
 * Anything it misses is repaired by the next write or an explicit knowledge_reindex call.
 *
 * IT RETURNS THE ROWS, since Task I-38, and the boot log is built from what it returns. It
 * used to log and return nothing, which was enough for the one caller it had. `/manage`'s
 * `knowledge_reindex` with `team` omitted is the second, and it has to TELL the person what
 * happened on each team — a tool whose whole output is "see the server log" is a tool that
 * answers a question the caller cannot read.
 *
 * The union of the directories and the indexed slugs is what the caller must not rebuild for
 * itself: walking teams/ alone can only ever visit a team that still has a store, so the one
 * team that needs cleaning — the one whose store is gone — is the one never visited. */
export async function reindexAllTeams(force = false): Promise<TeamReindex[]> {
  const teamsDir = join(ARTIFACTS_DIR, "teams");
  const p = db();
  if (!p || !existsSync(teamsDir)) return [];
  // THE DIRECTORIES ARE NOT THE WHOLE LIST. Walking teams/ alone can only ever visit a team
  // that still has a store, so the one team that needs cleaning — the one whose store is gone
  // — is the one never visited. The union with what the index believes is what closes it.
  const dirs = readdirSync(teamsDir, { withFileTypes: true })
    .filter((t) => t.isDirectory()).map((t) => t.name);
  // BOTH TABLES. A team whose store is gone is the one this union exists to reach, and since
  // migration 059 a team can hold knowledge nodes and no documents at all — asking zz.doc
  // alone left exactly that team unvisited, which is the shape of the gap the union closes.
  const indexed = (await p.query<{ team_slug: string }>(
    `select team_slug from zz.doc
     union
     select team_slug from zz.knowledge_node`)).rows.map((r) => r.team_slug);
  const out: TeamReindex[] = [];
  for (const name of [...new Set([...dirs, ...indexed])].sort()) {
    // ONE TEAM'S FAILURE IS ONE TEAM'S. A throw here used to end the boot rebuild at whichever
    // team happened to sort first among the broken ones, leaving every team after it
    // unindexed with nothing in the log to say the walk had stopped early rather than found
    // nothing to do. The row carries the reason so a caller reporting this can say which team.
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
