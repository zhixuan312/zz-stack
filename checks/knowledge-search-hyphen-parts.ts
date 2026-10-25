#!/usr/bin/env node
/**
 * checks/knowledge-search-hyphen-parts.ts — a person finds their own document by the number-like
 * part of a hyphenated word, and every search that worked before still works, through a real
 * zz-core on a throwaway database.
 *
 *   node checks/knowledge-search-hyphen-parts.ts   # needs Docker and a built tree (`npm run build`)
 *
 * PostgreSQL's default parser, which builds the Latin half of `body_tsv` from the row's own text,
 * reads `ticket-1234` as `ticket` plus the signed integer `-1234`, and a digit-e-digit run such as
 * `run-3e5a91` as one hyphenated part where the same word alone is a float plus a word. The query
 * `1234` or `3e5a91` then asks for lexemes the row never stored. What it establishes:
 *
 *   - `1234`, `9110` and `3e5a91` find the document holding `ticket-1234`, `rfc-9110` and
 *     `run-3e5a91`, `5678` finds the lesson holding `ticket-5678`, and `-1234` excludes the document;
 *   - what found it before still does: an exact word, a quoted phrase and not its reversal, a Han
 *     substring, a version (`0.96.0`), a compound as a whole and by each of its parts, and the whole
 *     hyphenated word; a word in one document's title still ranks it above one holding it in its body;
 *   - a row with no number-like hyphenated word stores exactly the vector it stored before, and a
 *     row with one in its body ranks as before for every query naming none of its parts whose
 *     terms all sit in the Latin text of one field, or all in its Han text. The parts are appended
 *     to their field's Latin text, which moves every later half's positions along (the Han text
 *     of the same field included): a cover spanning that text and a later one grows, and ranks
 *     lower. Only the body case is seeded here;
 *   - rows still carrying the previous generation's vector are re-derived when zz-core boots, the
 *     way a release reaches production's rows, and are found afterwards. It prints how long the
 *     boot pass took over the rows seeded here, about as many lessons as the largest shelf holds.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { ANALYZER_NAME, bodyTsvSql, buildRowVector, TEXT_SEARCH_CONFIG, termsByWeight } from "@zz/indexing";

import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-search-hyphen-parts";
const DONE = "knowledge-search-hyphen-parts: a number-like part of a hyphenated word finds its row, every " +
  "search that worked before still does, and a boot re-derives rows of the previous generation: ok";

/** The generation whose rows carried no parts. Written here rather than derived: it is what
 *  production holds before the release this check is for. */
const PREVIOUS = "zz-lexical-v3";
/** About as many lessons as the largest team shelf holds. */
const BULK = 900;
const REDERIVE_TIMEOUT_MS = 120_000;

type Result = { path?: string; title?: string };

/** The rows `knowledge_search` answers for `query`, in rank order. */
async function search(c: Core, query: string): Promise<Result[]> {
  const reply = await c.ok(`search ${query}`, "knowledge_search", { query, limit: 50 });
  try {
    return (JSON.parse(reply) as { results: Result[] }).results;
  } catch {
    return c.fail(`search ${query}`, `reply was not JSON: ${reply}`);
  }
}

/** The vector a row held under `PREVIOUS`: the Latin half its own text alone, the Han half the
 *  analyzer's terms. Built from `bodyTsvSql` so only the Latin text differs from today's writer. */
function previousParams(row: { title: string; tags: string[]; body: string }): string[] {
  const v = buildRowVector(row);
  return [TEXT_SEARCH_CONFIG.latin, TEXT_SEARCH_CONFIG.han,
          v.raw.A, termsByWeight(v, "A", "han"), v.raw.B, termsByWeight(v, "B", "han"),
          v.raw.C, termsByWeight(v, "C", "han")];
}

type Row = { id: string; title: string; tags: string[]; body: string };
const TABLES = ["zz.doc", "zz.knowledge_node"] as const;

async function run(c: Core): Promise<void> {
  const initiative = await c.open("hyphen-parts");
  await c.ok("an agent writes the release notes", "document_write", {
    path: `${initiative}/notes.md`, title: "Release notes",
    content: "# Release notes\n\nThe quokka ledger reconciles nightly. Fixed in ticket-1234 under rfc-9110, " +
      "traced by run-3e5a91, shipped in zz-0.96.0 with the sdlc-deck chassis.\n\n这个迁移会破坏旧的模式。\n",
  });
  await c.ok("an agent writes a document titled Deck", "document_write", {
    path: `${initiative}/deck.md`, title: "Deck", content: "# Deck\n\nThe slides for the review.\n",
  });
  await c.ok("an agent writes a document mentioning a deck", "document_write", {
    path: `${initiative}/review.md`, title: "Review",
    content: "# Review\n\nThe review walked through the deck once, slowly.\n",
  });
  await c.ok("an agent records a lesson", "knowledge_add", {
    title: "Cache ceiling", type: "decision", scope: "team", evidence: [initiative],
    body: "The wombat cache ceiling was raised in ticket-5678.",
  });

  const finds = async (step: string, query: string, path: RegExp, want = true): Promise<Result[]> => {
    const rows = await search(c, query);
    if (rows.some((r) => path.test(String(r.path))) !== want) {
      c.fail(step, `${JSON.stringify(query)} ${want ? "did not find" : "found"} ${path}: ${JSON.stringify(rows.map((r) => r.path))}`);
    }
    return rows;
  };
  const NOTES = /^notes\.md$/;
  const LESSON = /^nodes\/\d+-[a-z0-9-]+\.md$/;

  const partsFind = async (when: string): Promise<void> => {
    for (const q of ["1234", "9110", "3e5a91"]) {
      await finds(`${when}: ${q} finds the document holding it after a hyphen`, q, NOTES);
    }
    await finds(`${when}: 5678 finds the lesson holding ticket-5678`, "5678", LESSON);
    await finds(`${when}: -1234 excludes the document holding ticket-1234`, "quokka -1234", NOTES, false);
  };
  await partsFind("as written");
  c.pass("1234, 9110 and 3e5a91 find the document holding ticket-1234, rfc-9110 and run-3e5a91, 5678 the lesson, and -1234 excludes it");

  for (const q of ["quokka", '"ledger reconciles"', "迁移", "0.96.0", "zz-0.96.0", "sdlc-deck", "sdlc", "deck",
                   "ticket-1234", "rfc-9110"]) {
    await finds(`${q} still finds the document`, q, NOTES);
  }
  await finds("a reversed phrase does not match", '"reconciles ledger"', NOTES, false);
  const deck = await search(c, "deck");
  const titled = deck.findIndex((r) => r.path === "deck.md");
  const mentioned = deck.findIndex((r) => r.path === "review.md");
  if (titled < 0 || mentioned < 0 || titled > mentioned) {
    c.fail("a title match ranks first", `deck answered ${JSON.stringify(deck.map((r) => r.path))}`);
  }
  c.pass("an exact word, a phrase and not its reversal, a Han substring, a version, a compound whole and by part, " +
         "and the whole hyphenated word still find it; a title match still ranks above a body match");

  // A row whose text has no number-like hyphenated word is stored exactly as before: same vector,
  // so the same rank for every query.
  const same = await c.sql.query<{ path: string; same: boolean }>(
    `select d.path, d.body_tsv = (${bodyTsvSql(1)}) as same from zz.doc d where d.path = $9`,
    [...previousParams(await rowOf(c, "zz.doc", "deck.md")), "deck.md"]);
  if (!same.rows[0]?.same) c.fail("an ordinary row is unchanged", `deck.md's vector differs from its text's own: ${JSON.stringify(same.rows)}`);
  // A row whose body gains parts ranks as before for a query naming none of them whose terms sit in
  // one half of one field: `ts_rank_cd` without a normalization reads only the covers of the query's
  // own terms, and the parts come after the body's own Latin text. A cover spanning two halves is
  // not asked here.
  const ranked = await c.sql.query<{ q: string; now: number; before: number }>(
    `select q, ts_rank_cd(d.body_tsv, websearch_to_tsquery($1::regconfig, q)) as now,
            ts_rank_cd(${bodyTsvSql(1)}, websearch_to_tsquery($1::regconfig, q)) as before
       from zz.doc d, unnest($10::text[]) as q where d.path = $9`,
    [...previousParams(await rowOf(c, "zz.doc", "notes.md")), "notes.md", ["quokka", '"ledger reconciles"', "sdlc-deck", "deck", "迁移"]]);
  const moved = ranked.rows.filter((r) => r.now !== r.before);
  if (ranked.rows.length !== 5 || moved.length) c.fail("a row with parts ranks as before", JSON.stringify(ranked.rows));
  c.pass("a row with no number-like hyphenated word stores the vector it stored before, and one with parts in its body ranks " +
         "as before for every query here naming none, each answered within one half of one field");

  // The release: every row back to what the previous generation stored, plus a shelf's worth of
  // lessons, then a boot.
  await c.sql.query(
    `insert into zz.knowledge_node (kind, title, body, tags, team_id, node_ordinal, slug, analyzer_version)
     select 'knowledge', 'Lesson ' || i,
            'Lesson ' || i || ' was learned in ticket-' || (10000 + i) || ' under rfc-' || (20000 + i) ||
            ' and sdlc-deck, shipped in zz-0.' || i || '.0. ' || repeat('The plan held and the review agreed. ', 40),
            array['lesson'], (select id from zz.team where slug = $1), lpad((1000 + i)::text, 4, '0'),
            'lesson-' || i, $2
       from generate_series(1, $3::int) as i`, [c.team, PREVIOUS, BULK]);
  for (const table of TABLES) {
    const { rows } = await c.sql.query<Row>(bodySelect(table));
    for (const row of rows) {
      await c.sql.query(`update ${table} set analyzer_version = $10, body_tsv = ${bodyTsvSql(2)} where id = $1::uuid`,
                        [row.id, ...previousParams(row), PREVIOUS]);
    }
  }
  await finds("the previous generation's rows reproduce the defect", "1234", NOTES, false);
  const stale = await generations(c);
  const started = Date.now();
  await c.restart();
  for (;;) {
    const left = (await generations(c)).filter((g) => g.analyzer_version !== ANALYZER_NAME);
    if (!left.length) break;
    if (Date.now() - started > REDERIVE_TIMEOUT_MS) c.fail("boot re-derives", `still stale: ${JSON.stringify(left)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const took = Date.now() - started;
  await partsFind("after a boot");
  await finds("the boot re-derived the bulk lessons", "10450", LESSON);
  c.pass(`a boot re-derived ${stale.map((g) => `${g.n} ${g.corpus} row(s)`).join(" and ")} from ${PREVIOUS} to ` +
         `${ANALYZER_NAME} in ${took} ms, restart included, and they are found by their parts`);
}

/** A corpus's rows with the text its vector is built from. `zz.doc` stopped keeping a copy of the
 *  bytes its current revision holds, so that half reads the revision; the update below still
 *  targets `zz.doc`, which is where the vector and the generation live and still belong. */
function bodySelect(table: string): string {
  return table === "zz.doc"
    ? `select d.id::text as id, d.title, d.tags, r.body from zz.doc d
         left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision`
    : `select id::text as id, title, tags, body from ${table}`;
}

async function rowOf(c: Core, table: string, path: string): Promise<Row> {
  const where = table === "zz.doc" ? "d.path = $1" : "path = $1";
  const { rows } = await c.sql.query<Row>(`${bodySelect(table)} where ${where}`, [path]);
  return rows[0] ?? c.fail("read a row", `${table} holds no ${path}`);
}

async function generations(c: Core): Promise<{ corpus: string; analyzer_version: string | null; n: number }[]> {
  const { rows } = await c.sql.query<{ corpus: string; analyzer_version: string | null; n: number }>(
    `select 'zz.doc' as corpus, analyzer_version, count(*)::int as n from zz.doc group by 2
     union all
     select 'zz.knowledge_node', analyzer_version, count(*)::int from zz.knowledge_node group by 2`);
  return rows;
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
