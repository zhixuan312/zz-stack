#!/usr/bin/env node
/**
 * checks/doc-body-drop.ts — `zz.doc` keeps no second copy of a document's bytes, the trigram index
 * that answers a substring search lives on the table that holds them, and search reads the current
 * revision and no other.
 *
 *   node checks/doc-body-drop.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The column was the authority's shadow: `zz.doc_revision` holds a document's bytes, and `zz.doc`
 * held a copy that could disagree with it. What kept the copy alive was the fallback every reader
 * wrote — `coalesce(r.body, d.body)` — which answers from the revision when there is one and from
 * the copy when there is not, so a reader naming the wrong table looks right for as long as the
 * column exists. This is the check that the removal is complete and that nothing it touched stopped
 * answering. Six arms, and every one of them fails on a different way of being wrong.
 *
 *   (1) THE COLUMN IS GONE from a database migrated by the real runner, and the migration that
 *   dropped it declares `-- rollback: refused` with the reason: the previous image reads and writes
 *   the column, so a rollback across it would find no column to write.
 *
 *   (2) EVERY DOCUMENT RESOLVES. Every document carrying a `current_revision` resolves to a
 *   revision row with a non-null body, and none resolves to nothing. A document with no current
 *   revision answers its own state rather than raising, which is the case a read that assumed the
 *   copy would hide.
 *
 *   (3) THE BYTES ARE THE BYTES. For each discriminating document below, the current revision holds
 *   exactly the text the edit was handed, byte for byte, and the document holds exactly two
 *   revisions — so the arm is reading the second one, not the first. DELIBERATE: the plan asked for
 *   the pre-drop column to be captured on the same throwaway before the migration ran, and that is
 *   not reachable — `withThrowawayDb` migrates a container to the end before anything can read it,
 *   so there is no instant at which the old column and its values exist to capture. The bytes the
 *   write path was GIVEN are stronger evidence than the copy it used to keep: they are the input
 *   the revision must reproduce, and a fallback that silently answered from somewhere else could
 *   not have passed this.
 *
 *   (4) ONLY THE CURRENT REVISION IS SEARCHED, in an English, a Chinese and a mixed query: a word
 *   the document's first revision held and its current one dropped must not match, and a word both
 *   hold must. This is the arm that catches a trigram index moved onto a table whose older rows are
 *   the ones it finds.
 *
 *   (5) THE STATEMENTS THE CHANGE TOUCHED STILL ANSWER — the protocol door's body read, the
 *   console's claims read and its document read, each executed over the seeded platform. A
 *   statement is not compiled and a grep is not proof. The writer's in-place rewrite branch is run
 *   too: it is the statement the create and append paths never reach.
 *
 *   (6) THE INDEX IS CHOSEN, not merely present: `EXPLAIN` of the SHIPPED search statement — its
 *   union and its predicate read out of `knowledge-search.ts` at run time, so the plan explained
 *   cannot drift from the one that ships — names `doc_revision_body_trgm`.
 *
 * RECORDED, not asserted: at the deployment's own TOAST-heavy shape the trigram index is not chosen
 * — and the one on `zz.doc` was not chosen there either; the task measured 862 ms before the move
 * and 935 ms after on the same plan, a sequential scan of a TOAST-dominated heap, which is machine
 * noise rather than a regression. Where the planner can price the heap it is decisive: the task
 * measured 59.5 ms without it and 0.23 ms with it, and arm 6's seed is that shape. So what the move
 * buys is availability at the right table plus that win where it applies, never a production
 * speed-up that was measured. Saying otherwise would be the defect this phase exists to prevent.
 *
 * Exit 0: every arm held — one line per case, then the final line.
 * Exit 1: an arm failed, quoting what it read. Exit 2: Docker is not available.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type CoreModule = typeof import("../scripts/schema/throwaway-core.ts");
const { withThrowawayCore }: CoreModule =
  await import(pathToFileURL(join(process.cwd(), "scripts/schema/throwaway-core.ts")).href) as CoreModule;
type Core = Awaited<Parameters<Parameters<CoreModule["withThrowawayCore"]>[2]>[0]>;

const NAME = "doc-body-drop";
const DONE = "doc-body-drop: zz.doc keeps no copy of a document's bytes, the trigram index answers " +
  "from the revision table, and search reads the current revision only: ok";

/** The document arm's columns, in the order the shipped statement selects them. */
const COLS = "initiative, path, flow, type, status, outcome, approved_by, approved_at, " +
  "updated_at, title, tags, evidence, superseded_by, team_slug, subject, initiative_id, cited_ids, " +
  "id, cited_in";

/** A heap the planner can price: many rows, modest bodies, so the trigram index is chosen and the
 *  arm is about the move rather than about a detoast it cannot see. */
const HEAP_ROWS = 20_000;
const HEAP_CHARS = 600;
const HAN = "原有的架构";

interface Row { path?: string; title?: string; subject?: string }

const paths = (rows: Row[]): string[] => rows.map((r) => String(r.path));

async function search(c: Core, query: string): Promise<Row[]> {
  const reply = await c.ok(`search ${query}`, "knowledge_search", { query, limit: 50 });
  try {
    return (JSON.parse(reply) as { results: Row[] }).results;
  } catch {
    return c.fail(`search ${query}`, `reply was not JSON: ${reply.slice(0, 200)}`);
  }
}

/** One document whose first revision holds what its current one drops: write, approve (which seals
 *  revision 1), then edit with a cause — which files revision 2. */
async function seedDoc(
  c: Core, slug: string, path: string, title: string, v1: string,
  find: string, replace: string, cause: string,
): Promise<string> {
  const initiative = await c.open(slug);
  const full = `${initiative}/${path}`;
  await c.ok(`${slug}: write v1`, "document_write", { path: full, title, content: v1 });
  await c.sign(full);
  await c.ok(`${slug}: edit to v2`, "document_edit", {
    path: full, edits: [{ find, replace }], source_content: cause,
  });
  return initiative;
}

async function run(c: Core): Promise<void> {
  // ── (1) the column is gone, and the migration says a rollback is refused.
  const column = (await c.sql.query(
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'zz' and table_name = 'doc' and column_name = 'body'`,
  )).rows[0].n as number;
  if (column !== 0) {
    c.fail("the column is gone", `zz.doc still carries a body column on a migrated database`);
  }
  const drop = readFileSync(join(process.cwd(), "services/gateway/migrations/015_doc_body_drop.sql"), "utf8");
  const refusal = drop.split("\n").find((l) => /^--\s*rollback:\s*refused\s*—/.test(l));
  if (!refusal || !/zz\.doc\.body/.test(refusal)) {
    c.fail("the column is gone",
      "015_doc_body_drop.sql carries no `-- rollback: refused — …` line naming zz.doc.body, so a " +
      "rollback across the drop would be attempted against an image that writes the column");
  }
  const leftover = (await c.sql.query(
    `select count(*)::int as n from pg_indexes where schemaname = 'zz' and indexname = 'doc_body_trgm'`,
  )).rows[0].n as number;
  if (leftover !== 0) c.fail("the column is gone", "doc_body_trgm is still on the migrated catalog");
  // The replacement has to be there, and asserting only the ABSENCE above would pass on a catalog
  // that dropped the old index and never built the new one — which is the state search cannot
  // survive, and the state arm 6 would then explain as "not chosen".
  const moved = (await c.sql.query(
    `select indexdef from pg_indexes where schemaname = 'zz' and indexname = 'doc_revision_body_trgm'`,
  )).rows[0]?.indexdef as string | undefined;
  if (!moved || !/USING gin \(body zz\.gin_trgm_ops\)/i.test(moved)) {
    c.fail("the column is gone",
      `doc_revision_body_trgm is not a gin index on zz.doc_revision(body) — the catalog says ${moved ?? "it does not exist"}`);
  }
  c.pass("zz.doc carries no body column and no doc_body_trgm, and the migration that dropped them declares its rollback refused");

  // ── The three discriminating documents, plus one for the statements to read.
  const ENG = "eng.md";
  const HANP = "han.md";
  const MIX = "mixed.md";
  const engInit = await seedDoc(c, "drop-eng", ENG, "English",
    "# English\n\nThe quixotic plan holds a keystone.\n", "The quixotic plan", "The plan",
    "The stakeholder asked for the plan without the adjective.");
  await seedDoc(c, "drop-han", HANP, "中文",
    "# 中文\n\n这个迁移会破坏原有的架构。\n", "这个迁移", "这个改动", "改用「改动」这个词。");
  await seedDoc(c, "drop-mix", MIX, "Mixed",
    "# Mixed\n\nA deployment 部署 is planned.\n", "A deployment 部署", "A release 上线",
    "The stakeholder called it a release.");
  await c.ok("write protocol.md", "document_write", {
    path: `${engInit}/protocol.md`, title: "Protocol",
    content: "# Protocol\n\nThe digest this version quotes is 0123456789abcdef.\n",
  });

  // ── (2) every document resolves.
  const unresolved = (await c.sql.query(`
    select count(*)::int as n from zz.doc d
     where d.current_revision is not null
       and not exists (select 1 from zz.doc_revision r
                        where r.doc_id = d.id and r.revision = d.current_revision and r.body is not null)`)
  ).rows[0].n as number;
  const docs = (await c.sql.query("select count(*)::int as n from zz.doc")).rows[0].n as number;
  if (unresolved !== 0) c.fail("every document resolves", `${unresolved} of ${docs} resolve to nothing`);
  c.pass(`every one of ${docs} documents with a current_revision resolves to a revision row with a non-null body (0 unresolved)`);

  // ── (3) the bytes are the bytes the edit was handed.
  for (const [path, want] of [[ENG, "# English\n\nThe plan holds a keystone.\n"],
    [HANP, "# 中文\n\n这个改动会破坏原有的架构。\n"],
    [MIX, "# Mixed\n\nA release 上线 is planned.\n"]] as const) {
    const got = (await c.sql.query(
      `select r.body from zz.doc d join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        where d.path = $1`, [path])).rows[0]?.body;
    if (got !== want) c.fail("the bytes are the bytes", `${path} holds ${JSON.stringify(got)}`);
    const revs = (await c.sql.query(
      `select count(*)::int as n from zz.doc_revision r join zz.doc d on d.id = r.doc_id where d.path = $1`,
      [path])).rows[0].n as number;
    if (revs !== 2) c.fail("the bytes are the bytes", `${path} holds ${revs} revisions, not two`);
  }
  c.pass(`${ENG}, ${HANP} and ${MIX} each hold two revisions and the current one is exactly what the edit sent`);

  // ── (4) only the current revision is searched.
  const cases: [string, string, string, boolean][] = [
    ["English, removed in v2", "quixotic", ENG, false],
    ["English, kept in v2", "keystone", ENG, true],
    ["Chinese, removed in v2", "迁移", HANP, false],
    ["Chinese, kept in v2", HAN, HANP, true],
    ["mixed, removed in v2", "deployment 部署", MIX, false],
    ["mixed, kept in v2", "release 上线", MIX, true],
  ];
  for (const [label, q, path, want] of cases) {
    const found = paths(await search(c, q));
    const got = found.includes(path);
    console.log(`  ${label}: ${JSON.stringify(q)} -> [${found.join(", ")}] ; ${path} ${got ? "matched" : "absent"}`);
    if (got !== want) c.fail(label, `${JSON.stringify(q)} ${got ? "matched" : "missed"} ${path}`);
  }
  c.pass("search reads the current revision only: the dropped word misses in an English, a Chinese and a mixed query, and the kept word hits");

  // ── (5) the statements the change touched still answer.
  await c.sql.query(
    `insert into zz.doc (initiative_id, path, type, status, updated_at, title, tags, content_hash)
     select i.id, 'orphan.md', '', 'draft', now(), 'Orphan', '{}'::text[], ''
       from zz.initiative i join zz.team t on t.id = i.team_id where t.slug = $1 and i.slug = $2`,
    [c.team, engInit],
  );
  const orphan = (await c.sql.query(
    `select d.path, d.type, coalesce(r.body, '') as body
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = 'orphan.md'`, [c.team, engInit])).rows[0];
  if (!orphan || orphan.body !== "") {
    c.fail("a revision-less document answers", `expected '' bytes: ${JSON.stringify(orphan)}`);
  }
  c.pass("a document with no current_revision answers its own state rather than failing");

  const protocol = (await c.sql.query(`
      select d.id::text as id, d.current_revision, d.status, a.email as approved_by, r.body as body
        from zz.doc d
        join zz.initiative i on i.id = d.initiative_id
        join zz.team t on t.id = i.team_id
        left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
        left join zz.principal a on a.id = r.approved_by
       where i.slug = $1 and d.path = 'protocol.md' and ($2::text is null or t.slug = $2)
       order by d.updated_at desc limit 1`, [engInit, c.team])).rows[0];
  if (!protocol || typeof protocol.body !== "string" || !protocol.body.includes("0123456789abcdef")) {
    c.fail("the protocol door's body read answers", JSON.stringify(protocol));
  }
  c.pass("the protocol door's body read answered a row with its bytes");

  const claims = (await c.sql.query(
    `select d.path, d.type, r.body as body
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 order by d.path`, [c.team, engInit])).rows as Row[];
  if (claims.length < 3 || !claims.some((r) => r.path === ENG)) {
    c.fail("the console's claims read answers", JSON.stringify(paths(claims)));
  }
  c.pass(`the console's claims read answered ${claims.length} rows, ${ENG} among them`);

  const docRead = (await c.sql.query(
    `select d.id, coalesce(r.content_generation, d.content_generation) as content_generation,
            d.type, d.status, d.title, d.tags, r.body as body,
            length(coalesce(r.body, '')) as bytes
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
       left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where t.slug = $1 and i.slug = $2 and d.path = $3`, [c.team, engInit, ENG])).rows[0];
  if (!docRead || docRead.body !== "# English\n\nThe plan holds a keystone.\n") {
    c.fail("the console's document read answers", JSON.stringify(docRead));
  }
  c.pass(`the console's document read answered ${ENG} whole, ${docRead.bytes} bytes`);

  await c.ok("write a draft", "document_write", {
    path: `${engInit}/draft.md`, title: "Draft", content: "# Draft\n\nalpha line\n" });
  await c.ok("rewrite the draft in place (unsigned, so no second revision)", "document_edit", {
    path: `${engInit}/draft.md`, edits: [{ find: "alpha line", replace: "omega line" }] });
  const draft = (await c.sql.query(
    `select r.body, (select count(*)::int from zz.doc_revision x where x.doc_id = d.id) as revisions
       from zz.doc d join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where d.path = 'draft.md'`)).rows[0];
  if (!draft || draft.body !== "# Draft\n\nomega line\n" || draft.revisions !== 1) {
    c.fail("the writer's in-place rewrite answers", JSON.stringify(draft));
  }
  c.pass(`the writer's in-place rewrite answered ${JSON.stringify(draft.body)}, still one revision ` +
    "(the branch the create and append paths never reach)");

  // ── (6) the index is chosen. A heap the planner can price, then the SHIPPED statement.
  const bulk = (await c.sql.query("select id, slug from zz.initiative where slug = $1 and team_id = (select id from zz.team where slug = $2)",
    [engInit, c.team])).rows[0];
  await c.sql.query("begin");
  await c.sql.query(
    `insert into zz.doc (id, initiative_id, path, type, status, updated_at, title, tags,
                         content_hash, current_revision, current_version)
     select gen_random_uuid(), $1::uuid, 'bulk/' || g || '.md', 'source', '', now(), 'Bulk ' || g,
            '{}'::text[], '', 1, 1
       from generate_series(1, $2) g`, [bulk.id, HEAP_ROWS]);
  await c.sql.query(
    `insert into zz.doc_revision (doc_id, revision, content_state, title, body, tags, content_hash,
                                  version, content_generation)
     select d.id, 1, 'retained', d.title, repeat(md5(random()::text), $1), '{}'::text[], '', 1, 0
       from zz.doc d where d.path like 'bulk/%'`, [Math.floor(HEAP_CHARS / 32)]);
  await c.sql.query("commit");
  // The pending list, not the statistics: a GIN index has `fastupdate` on, so every row inserted
  // since its last clean sits in a pending list a scan has to read linearly — and the planner prices
  // that and declines the index. A bulk load followed by nothing is not the state production is in
  // (its rows arrive over months and autovacuum cleans behind them), and leaving it in place would
  // measure the seed's own shape rather than the index. A vacuum is what cleans it.
  await c.sql.query("vacuum (analyze) zz.doc");
  await c.sql.query("vacuum (analyze) zz.doc_revision");
  const size = (await c.sql.query(
    `select count(*)::int as n, pg_size_pretty(sum(length(body))) as bytes from zz.doc_revision`,
  )).rows[0];
  console.log(`  the seed the plan is read on: ${size.n} revision rows carrying ${size.bytes} of body text`);

  // The union and the predicate read out of the source at run time, so neither can drift from what
  // ships — a copy written here would explain a statement nobody issues.
  const source = readFileSync(join(process.cwd(), "services/zz-core/src/tools/knowledge-search.ts"), "utf8");
  const grab = (name: string): string => {
    const marker = `const ${name} = \``;
    const i = source.indexOf(marker);
    const j = i < 0 ? -1 : source.indexOf("`;", i + marker.length);
    if (i < 0 || j < 0) c.fail("the shipped statement is readable", `no \`const ${name}\` in knowledge-search.ts`);
    return source.slice(i + marker.length, j);
  };
  const NODE = grab("NODE_ARM");
  const SOURCE = grab("SOURCE").replace("${NODE_ARM}", NODE);
  type Predicate = typeof import("../services/zz-core/dist/tools/search-predicate.js");
  const { buildSearchPredicate }: Predicate =
    await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/tools/search-predicate.js")).href) as Predicate;
  const pred = buildSearchPredicate({ query: HAN, team: c.team, includeSuperseded: true });
  const scoring = pred.rankExpr
    ? `ts_rank_cd(body_tsv, ${pred.rankExpr}) as rank`
    : `ts_rank_cd(body_tsv, to_tsquery('simple', $${pred.args.length + 1})) as rank`;
  const args = pred.rankExpr ? [...pred.args] : [...pred.args, pred.hanTerms.join(" & ")];
  const shipped = `select ${COLS}, ${scoring}
                     from ${SOURCE} where ${pred.sql}
                    order by rank desc, updated_at desc, subject, id
                    limit 200`;
  const explained = (await c.sql.query(`explain (analyze, buffers, format text) ${shipped}`, args)).rows
    .map((r: Record<string, string>) => String(r["QUERY PLAN"]));
  if (!explained.some((l: string) => l.includes("doc_revision_body_trgm"))) {
    for (const l of explained) console.log(`  ${l}`);
    c.fail("the trigram index is chosen",
      "no plan line names doc_revision_body_trgm — the index is present and nothing reaches it, " +
      "which is a write cost with nothing bought");
  }
  for (const l of explained.filter((l: string) => /doc_revision_body_trgm|Bitmap Index Scan|Execution Time/.test(l))) {
    console.log(`  ${l.trim()}`);
  }
  const row = (await c.sql.query(shipped, args)).rows as { subject?: string; path?: string }[];
  if (row.length === 0) {
    c.fail("the trigram index is chosen",
      "the shipped statement returned no row, so the plan explained is of a statement that finds nothing");
  }
  c.pass(`the shipped search statement names doc_revision_body_trgm and answers ${row.length} row(s) — chosen, not merely present`);
}

const code = await withThrowawayCore(NAME, DONE, run);
process.exitCode = code;
