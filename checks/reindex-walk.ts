#!/usr/bin/env node
/**
 * checks/reindex-walk.ts — a team's rebuild re-derives every stale row of that team, past a page boundary, and no
 * other team's; a row that cannot be re-derived is named and the walk goes on past it.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds 450 documents and two
 * knowledge nodes for one team with a stale `analyzer_version` — one document's body past the stored-body limit — and
 * three stale documents for a second team, then runs the built `reindexTeam` against it.
 *
 *   node checks/reindex-walk.ts   # needs Docker and a built tree (`npm run build`)
 *
 * Exit 0: every case held. Exit 1: a case failed, quoting what was found. Exit 2: Docker is not available — not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { root } from "../scripts/deployment.ts";
import { failing, withThrowawayDbCheck, type Fail } from "../scripts/schema/throwaway.ts";

type Indexing = typeof import("../packages/indexing/dist/index.js");
const { ANALYZER_NAME, MAX_INPUT_BYTES, configureIndexing, reindexTeam }: Indexing =
  await import(pathToFileURL(join(root, "packages/indexing/dist/index.js")).href);

const NAME = "reindex-walk";
const DONE = "reindex-walk: a team's rebuild re-derives all of that team's stale rows across pages and no other " +
  "team's, naming the one row it could not: ok";
const fail: Fail = failing(NAME);
const STALE = "zz-lexical-v1";

process.exitCode = await withThrowawayDbCheck(NAME, DONE, async (c, url) => {
  const one = async (sql: string, values: unknown[] = []) => (await c.query<{ id: string }>(sql, values)).rows[0].id;
  const person = await one("insert into zz.principal (email) values ('reindex@zz.test') returning id");
  const seed = async (slug: string, docs: number): Promise<string> => {
    const team = await one("insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person]);
    const initiative = await one("insert into zz.initiative (team_id, slug) values ($1, $2) returning id",
                                 [team, `2026-10-31-${slug}`]);
    await c.query(`insert into zz.doc (path, updated_at, initiative_id, analyzer_version)
                   select $4 || '/d' || g || '.md', now(), $1, $2 from generate_series(1, $3::int) g`,
                  [initiative, STALE, docs, slug]);
    await c.query(`insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash)
                   select id, 1, 1, 'retained', path, 'the body of ' || path, '{}', md5(path)
                     from zz.doc where initiative_id = $1`, [initiative]);
    await c.query("update zz.doc set current_revision = 1, current_version = 1 where initiative_id = $1", [initiative]);
    return team;
  };
  const team = await seed("reindex-a", 450);
  await seed("reindex-b", 3);
  // One body the analyzer refuses, in the middle of the walk.
  await c.query(`update zz.doc_revision r set body = repeat('x', $1::int)
                   from zz.doc d where d.id = r.doc_id and d.path = 'reindex-a/d225.md'`, [MAX_INPUT_BYTES + 1]);
  await c.query(`insert into zz.knowledge_node (team_id, node_ordinal, slug, kind, title, body, analyzer_version)
                 values ($1, 'K1', 'k1', 'knowledge', 'One', 'a lesson', $2), ($1, 'K2', 'k2', 'knowledge', 'Two', 'b', $2)`,
                [team, STALE]);

  const pool = new pg.Pool({ connectionString: url });
  configureIndexing(() => pool);
  try {
    const step = "reindexTeam over 450 documents and 2 nodes, one document unreadable";
    const r = await reindexTeam("reindex-a");
    if (r.scanned !== 452 || r.indexed !== 451 || !/1 row\(s\) could not be re-derived/.test(r.error ?? "")) {
      fail(step, `answered ${JSON.stringify(r)}`);
    }
    const count = async (slug: string, analyzer: string) => Number((await c.query<{ n: string }>(
      `select count(*)::text as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
         join zz.team t on t.id = i.team_id where t.slug = $1 and d.analyzer_version = $2`, [slug, analyzer])).rows[0].n);
    const current = await count("reindex-a", ANALYZER_NAME);
    if (current !== 449) fail(step, `${current} of the team's 449 readable documents carry ${ANALYZER_NAME}`);
    const nodes = Number((await c.query<{ n: string }>(
      "select count(*)::text as n from zz.knowledge_node where analyzer_version = $1 and body_tsv is not null",
      [ANALYZER_NAME])).rows[0].n);
    if (nodes !== 2) fail(step, `${nodes} of the team's 2 nodes were re-derived`);
    const other = await count("reindex-b", STALE);
    if (other !== 3) fail(step, `the other team's documents were touched: ${3 - other} of 3 moved`);
    console.log(`  ${step}: 449 documents and 2 nodes re-derived, the unreadable one named, the other team untouched`);
  } finally {
    await pool.end();
  }
});
