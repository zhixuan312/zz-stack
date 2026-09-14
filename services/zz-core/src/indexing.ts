/**
 * Making a document findable: the row the knowledge index keeps for it, and the walks that
 * rebuild that index for a team or for every team.
 *
 * A document the store holds and the index does not know about is a document `knowledge_search`
 * cannot return, which reads to the person asking as though the work was never done. So every
 * tool that writes a file indexes it in the same call, and the reindex walks exist for the two
 * cases that cannot be covered that way: a store restored from a backup, and a schema change
 * that alters what a row means.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { documentBody, parseEnvelope } from "@zz/contracts";

import { decisionRows, indexable, isoDate, renderEnvelope, tableRow } from "./document-rules.js";
import { ARTIFACTS_DIR, db } from "./platform-db.js";

/** The knowledge base's own log, in the platform's event table.
 *
 * `journalLog` beside this writes `_knowledge/log.md` — a real append-only journal, and the
 * right thing for anyone reading a team's store on disk. It is invisible to the console,
 * which reads Postgres and has no way to open a team's files, so "what has this team
 * learned lately, and who wrote it down" had no answer any screen could show.
 *
 * NOT A `tool_call` ROW. Those already exist for these tools and cannot serve: a tool_call
 * deliberately carries NO ACTOR — "no address on a measurement", see tool-telemetry.ts —
 * because it measures a skill, not a person. A journal entry is the opposite kind of record:
 * who recorded what, when. It also cannot be filtered out of tool_call rows honestly, since
 * those include `knowledge_search` reads, which are not log entries at all.
 *
 * team_id AND team_slug, both. The slug alone is what zz.event carried for a week while
 * every console view that joins through `team_id` read empty — see 042_event_team_backfill.
 * The id is resolved in the INSERT so it cannot drift from the slug beside it.
 *
 * THE ACTOR IS FOLDED IN THE STATEMENT. `who.email` arrives canonical from `parseCaller`,
 * but this column is grouped on by tool-report, evolve-report and watch-results, and one
 * person spelled two ways breaks all three — so every writer of it folds, whatever the
 * value's provenance. Cheap insurance on a column with that property.
 *
 * FIRE AND FORGET, catching everything: a journal entry that failed to write must never be
 * the reason a node the person already minted reports failure. */
export function knowledgeEvent(e: {
  actor: string; action: "add" | "supersede"; node: string;
  team: string | null; detail: Record<string, unknown>;
}): void {
  const p = db();
  if (!p) return;
  void p.query(
    `insert into zz.event (actor, team_slug, team_id, kind, subject, detail)
     values (lower($1), $2, (select id from zz.team where slug = $2), $3, $4, $5)`,
    [e.actor, e.team, `knowledge.${e.action}`, e.node, JSON.stringify(e.detail)],
  ).catch(() => undefined);
}
/** Append a row to the journal's human-readable log. It is markdown, so it
 * must be a table: consecutive plain lines render as one run-on paragraph. */
export function journalLog(root: string, action: string, id: string, detail: string): void {
  const log = join(root, "_knowledge", "log.md");
  if (!existsSync(log)) {
    mkdirSync(join(root, "_knowledge"), { recursive: true });
    writeFileSync(log, "| when | action | node | detail |\n|---|---|---|---|\n");
  }
  appendFileSync(log, tableRow(new Date().toISOString(), action, id, detail));
}
/** One row of the knowledge base as retrieval reads it. */
export interface KbRow {
  initiative: string; path: string; flow: string; type: string; status: string;
  outcome: string | null; approved_by: string | null; approved_at: string | null;
  updated_at: string; title: string; tags: string[] | null; evidence: string[] | null;
  superseded_by: string | null; rank: number; snippet: string;
  /** WHICH SHELF the row is on. A knowledge search deliberately spans the caller's team AND
   * the platform's journal, and dropping this made the two indistinguishable in the answer —
   * so a path that came back could not be read back. */
  team_slug: string;
}
/** A source document, which two tools write.
 *
 * source_add attaches material a person brought; document_revise captures the words that
 * caused a version. Same `type: source`, same fields, same readers — and two hand-built
 * envelopes, of which ONE escaped its title. document_revise's interpolated `source_title`
 * raw, so a title carrying a newline did not corrupt the source's envelope, it added fields
 * to it: `supports` decides which approved documents initiative_status flags for refinement,
 * and `type` is what knowledge_search filters on, so a source could be indexed as a spec.
 *
 * Through renderEnvelope, so every value is folded to one line whatever a caller sends and
 * whatever field is added here next. `supports` stays comma-joined because that is how the
 * readers split it, and both callers validate their entries before they arrive. */
export function sourceDocument(
  opts: { title: string; by: string; day: string; supports: string; content: string },
): string {
  return renderEnvelope(
    { type: "source", title: opts.title, contributed_by: opts.by, date: opts.day,
      added_at: new Date().toISOString(), supports: opts.supports },
    ["type", "title", "contributed_by", "date", "added_at", "supports"],
  ) + `\n${opts.content}\n`;
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
    const values = [teamSlug, parts[0], parts.slice(1).join("/"),
      env.flow ?? "", env.type ?? parts[parts.length - 1].replace(/\.md$/, ""),
      env.status ?? "", env.outcome ?? null, env.approved_by ?? null,
      isoDate(env.approved_at),
      // WHO CLOSED IT. The platform validates and stamps this already — a close is the most
      // consequential act on the platform — and stored it nowhere, so "who closed this" could
      // only be answered by opening the document.
      env.closed_by ?? null,
      body, title, list(env.tags), list(env.evidence),
      superseded && superseded !== "null" ? superseded : null];
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
    // THE BLOCK'S NAME, NORMALISED — because `server:` is free text an author wrote, and they
    // wrote it seventeen different ways for three blocks: `casebox`, `ops_casebox`, `mcp_casebox`, `mcp-casebox`,
    // `mcp__plugin_ops_casebox`, `mcp__plugin_ops_casebox__*`, and `RuleMill"`, `"bookit`, plus `+` and `MCP`
    // which are not blocks at all.
    //
    // That is not cosmetic. `blocks` is GIN-indexed so that "what have we predicted about casebox"
    // is one query, and `knowledge_reconcile` joins it against the block name the gateway records — which
    // is always the bare `casebox`. With six spellings in the column the join matched the sixth of
    // rows that happened to agree, and reported the rest as predictions about nothing.
    //
    // A client prefix is not part of a block's identity: `mcp__plugin_ops_casebox__list_records` is the
    // casebox block seen through one client's naming, and a record that keeps the client's spelling
    // is a record that changes when somebody swaps clients.
    const blocks = [...new Set((env.server ?? "")
      .split(/[\s/,]+/)
      .map((raw) => raw.trim().toLowerCase().replace(/^["'`]+|["'`*]+$/g, ""))
      // Peel the layers a client wraps a server name in, longest first so `mcp__plugin_ops_`
      // goes before `mcp_`.
      .map((t) => t.replace(/^mcp__plugin_[a-z0-9]+_/, "")
                   .replace(/^mcp__/, "").replace(/^mcp[_-]/, "")
                   .replace(/^plugin[_-]/, "").replace(/^ops[_-]/, "")
                   .replace(/__.*$/, "").replace(/[^a-z0-9-]/g, ""))
      // What is left has to look like a name. `+` reduces to nothing; `mcp` and `plugin` are
      // wrappers rather than blocks and are named explicitly.
      //
      // The length bound is TWO, not three. A block id may be two characters — one on this
      // deployment was — and `> 2` silently deleted it while leaving the longer names looking
      // correct, so the column reported predictions about nothing for the most-used block.
      // Found by running the rule over every spelling the store actually holds instead of over
      // the ones I had in mind.
      //
      // No id in the registry is that short TODAY, which is exactly why this comment says a
      // block id MAY be: a bound justified by a fact that later stops being true is a bound the
      // next reader deletes. The rule is about what an id is allowed to be, not about what the
      // current ones happen to be.
      .filter((t) => t.length >= 2 && t !== "mcp" && t !== "plugin"))];
    const hash = createHash("sha256")
      // env.blocks is hashed as well as written. Without it a re-selection that changed only
      // the chosen blocks — same prose, same everything else — would hash identically and be
      // skipped, leaving the row saying what the previous selection chose.
      .update(JSON.stringify([values, role, blocks, claims, env.blocks ?? ""])).digest("hex").slice(0, 32);
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
      `insert into zz.doc (team_slug, initiative, path, flow, type, status, outcome, approved_by, approved_at, closed_by, updated_at, body, title, tags, evidence, superseded_by, content_hash, supports, blocks, body_tsv)
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
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($17::timestamptz, now()), $11,$12,$13::text[],$14::text[],$15,$16, $18, $19::text[],
               -- title A, tags B, body C. The positions moved when closed_by was inserted at
               -- $10: these pointed at $11/$12/$10, which after the shift is body/title/closed_by
               -- — a search index built from the wrong three columns, and one that would have
               -- looked like it worked because every one of them is text.
               setweight(to_tsvector('english', $12::text), 'A') ||
               setweight(to_tsvector('english', array_to_string($13::text[], ' ')), 'B') ||
               setweight(to_tsvector('english', $11::text), 'C'))
       on conflict (team_slug, initiative, path) do update set
         flow=excluded.flow, type=excluded.type, status=excluded.status, outcome=excluded.outcome,
         approved_by=excluded.approved_by, approved_at=excluded.approved_at,
         closed_by=excluded.closed_by, updated_at=excluded.updated_at,
         body=excluded.body, title=excluded.title, tags=excluded.tags,
         evidence=excluded.evidence, superseded_by=excluded.superseded_by,
         content_hash=excluded.content_hash, supports=excluded.supports,
         blocks=excluded.blocks, body_tsv=excluded.body_tsv
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
       // $19 — THE CHOSEN BLOCKS, on the row rather than only in the file. The gateway
       // resolves a stage's `blocks: "selected"` through this column: it cannot read the
       // team's file store, and `body` here has had its envelope stripped, so the field was
       // written and then invisible to the one component that exists to read it.
       //
       // Appended rather than added to `values`, because every placeholder in the values
       // clause after $15 is positional against THAT array — slipping one in the middle
       // silently re-points content_hash, updated_at and supports at each other's data.
       list(env.blocks)],
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
    // WHAT EACH BLOCK SAID IT WAS, at the moment the claim was made — read from the calls the
    // platform has already recorded rather than asked for again. Empty when a block has never
    // been called, which is itself worth seeing: a prediction about a block nobody has reached.
    const blockVers: Record<string, string> = {};
    if (blocks.length) {
      const { rows: bv } = await p.query<{ block: string; block_version: string }>(
        `select distinct on (block) block, block_version from zz.event
          where block = any($1::text[]) and block_version is not null
          order by block, ts desc`, [blocks]);
      for (const r of bv) blockVers[r.block] = r.block_version;
    }
    for (const c of claims) {
      await p.query(
        `insert into zz.decision (team_slug, initiative, path, role, key, verdict, qualifier, detail, checker, blocks, block_versions, updated_at, doc_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11, now(), $12)`,
        [teamSlug, initiative, docPath, role, c.key, c.verdict,
         c.qualifier, c.detail, c.checker, blocks,
         // AGAINST WHICH VERSION OF EACH BLOCK. "casebox handles this natively" was true against a
         // particular casebox; when the block moves the claim may be silently stale. Without it,
         // reconcile compares a prediction made against one version with calls made against
         // another and reports a discrepancy that is nobody's defect.
         JSON.stringify(blockVers), docId]);
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
    return { scanned: 0, indexed: 0, removed: r.rowCount ?? 0 };
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
  return { scanned, indexed, removed: gone.length };
}
/** Rebuild every team at boot.
 *
 * Deliberately not awaited by startup: the service answers requests while this runs, and a
 * partially-rebuilt index is strictly better than a service that will not start. Anything
 * it misses is repaired by the next write or an explicit knowledge_reindex call. */
export async function reindexAllTeams(): Promise<void> {
  const teamsDir = join(ARTIFACTS_DIR, "teams");
  const p = db();
  if (!p || !existsSync(teamsDir)) return;
  // THE DIRECTORIES ARE NOT THE WHOLE LIST. Walking teams/ alone can only ever visit a team
  // that still has a store, so the one team that needs cleaning — the one whose store is gone
  // — is the one never visited. The union with what the index believes is what closes it.
  const dirs = readdirSync(teamsDir, { withFileTypes: true })
    .filter((t) => t.isDirectory()).map((t) => t.name);
  const indexed = (await p.query<{ team_slug: string }>(
    "select distinct team_slug from zz.doc")).rows.map((r) => r.team_slug);
  for (const name of [...new Set([...dirs, ...indexed])].sort()) {
    try {
      const r = await reindexTeam(name);
      console.log(`knowledge index: ${name} — ${r.scanned} scanned, ${r.indexed} re-indexed, ${r.removed} removed`);
    } catch (err) { console.error(`reindex ${name} failed:`, err); }
  }
}
