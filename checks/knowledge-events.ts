#!/usr/bin/env node
/**
 * checks/knowledge-events.ts — a lesson's event names the lesson, and a supersede names its shelf
 * (AC-2.11), through a real zz-core on a throwaway database.
 *
 *   node checks/knowledge-events.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds the shared
 * shelf's team, and has an agent record lessons on both shelves and supersede one on each. What it
 * establishes:
 *
 *   - `knowledge_add` with `scope: team` and with `scope: platform` each write one `knowledge.add`
 *     event whose `detail.ids.node` is the id of the node it made, on the shelf it was made on — so
 *     a lesson is found from its event by id, without its ordinal;
 *   - `knowledge_supersede` writes exactly one event, under the team of the shelf the superseded node is on:
 *     the caller's team for a team node, the shared shelf's for a platform node;
 *   - both tools answer exactly as before, so the release's chain check, which reads
 *     `journal node NNNN created`, still reads them.
 *
 * DELIBERATE: the shared shelf's slug, the answers' wording and the event kinds are written here,
 * not imported from the code under test.
 *
 * The only database this touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import type pg from "pg";

import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-events";
const DONE = "knowledge-events: a lesson's knowledge.add event names the node it made on either shelf, a supersede is " +
  "recorded under the shelf's team, and both tools answer as the chain check reads them: ok";

/** The shared shelf's team. */
const PLATFORM_SHELF = "zz-platform";

/** Rows matching `sql`, waited on until there are `n` of them: zz-core writes an event after the
 *  answer it describes, so it is polled for, briefly. */
async function rowsOnce<T extends pg.QueryResultRow>(c: Core, sql: string, params: unknown[], n: number): Promise<T[]> {
  const until = Date.now() + 5000;
  for (;;) {
    const { rows } = await c.sql.query<T>(sql, params);
    if (rows.length >= n || Date.now() > until) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** `knowledge_add`, its answer held to the exact sentence the chain check reads: the ordinal. */
async function add(c: Core, step: string, shelf: string, args: Record<string, unknown>): Promise<string> {
  const reply = await c.ok(step, "knowledge_add", args);
  const m = /^journal node (\d{4,}) created on (\S+)'s shelf$/.exec(reply);
  if (!m || m[2] !== shelf) c.fail(step, `answered "${reply}", not "journal node NNNN created on ${shelf}'s shelf"`);
  // The chain check's own reading (packages/tools/src/testing/chain-shelf.ts).
  if (/journal node (\d+) created/.exec(reply)?.[1] !== m[1]) c.fail(step, `the chain check cannot read "${reply}"`);
  return m[1];
}

/** The id of the node on `shelf` with `ordinal`. */
async function nodeId(c: Core, step: string, shelf: string, ordinal: string): Promise<string> {
  const { rows } = await c.sql.query<{ id: string }>(
    `select k.id::text as id from zz.knowledge_node k join zz.team t on t.id = k.team_id
      where t.slug = $1 and k.node_ordinal = $2`, [shelf, ordinal]);
  if (rows.length !== 1) c.fail(step, `${rows.length} nodes on ${shelf} carry ordinal ${ordinal}, not one`);
  return rows[0].id;
}

async function addCases(c: Core, initiative: string): Promise<Record<string, string[]>> {
  const made: Record<string, string[]> = { [c.team]: [], [PLATFORM_SHELF]: [] };
  const lessons = [
    { shelf: c.team, scope: "team", title: "Cache expiry", tags: [] as string[] },
    { shelf: PLATFORM_SHELF, scope: "platform", title: "Guardrail wording", tags: ["platform:guardrail"] },
  ];
  for (const l of lessons) {
    const step = `knowledge_add with scope: ${l.scope}`;
    const ordinal = await add(c, step, l.shelf, {
      title: l.title, type: "decision", scope: l.scope, evidence: [initiative], tags: l.tags,
      body: `The ${l.scope} lesson the event must name, recorded by the knowledge-events check.`,
    });
    const id = await nodeId(c, step, l.shelf, ordinal);
    const rows = await rowsOnce<{ node: string | null; team: string | null; subject: string }>(c,
      `select e.detail->'ids'->>'node' as node, t.slug as team, e.subject from zz.event e
         left join zz.team t on t.id = e.team_id
        where e.kind = 'knowledge.add' and e.detail->'ids'->>'node' = $1`, [id], 1);
    if (rows.length !== 1 || rows[0].team !== l.shelf || rows[0].subject !== ordinal) {
      const all = (await c.sql.query(
        "select subject, detail, team_id from zz.event where kind = 'knowledge.add' order by id")).rows;
      c.fail(step, `node ${id} (${l.shelf} ${ordinal}) is named by ${rows.length} knowledge.add events ` +
        `${JSON.stringify(rows)}, not one on ${l.shelf} about ${ordinal}; every knowledge.add: ${JSON.stringify(all)}`);
    }
    made[l.shelf].push(ordinal);
    c.pass(`knowledge_add with scope: ${l.scope} writes one knowledge.add on ${l.shelf} whose detail.ids.node is the node it made`);
  }
  return made;
}

async function supersedeCases(c: Core, initiative: string, made: Record<string, string[]>): Promise<void> {
  const shelves = [
    { shelf: c.team, which: "team", tags: [] as string[] },
    { shelf: PLATFORM_SHELF, which: "platform", tags: ["platform:guardrail"] },
  ];
  for (const s of shelves) {
    const step = `knowledge_supersede on the ${s.which} shelf`;
    const newer = await add(c, step, s.shelf, {
      title: `Newer ${s.which} lesson`, type: "decision", scope: s.which, evidence: [initiative], tags: s.tags,
      body: `What replaces the earlier ${s.which} lesson.`,
    });
    const older = made[s.shelf][0];
    // Both shelves hold the same ordinals, so a row is this supersede's only when written after it began.
    const before = (await c.sql.query<{ id: string }>("select coalesce(max(id), 0)::text as id from zz.event")).rows[0].id;
    // Ordinals are per shelf and both shelves hold 0001, so the shelf is named.
    const reply = await c.ok(step, "knowledge_supersede", { old_id: older, new_id: newer, shelf: s.which });
    if (reply !== `node ${older} superseded by ${newer}`) {
      c.fail(step, `answered "${reply}", not "node ${older} superseded by ${newer}"`);
    }
    const rows = await rowsOnce<{ team: string | null; actor: string | null }>(c,
      `select t.slug as team, p.email as actor from zz.event e
         left join zz.team t on t.id = e.team_id
         left join zz.principal p on p.id = e.actor_id
        where e.kind = 'knowledge.supersede' and e.subject = $1 and e.id > $2::bigint`, [older, before], 2);
    // Asked for two and given the full wait, so a second row (the actor-less journal copy this act
    // once wrote with no team) is caught rather than missed by returning on the first.
    if (rows.length !== 1 || rows[0].team !== s.shelf || rows[0].actor !== c.email) {
      c.fail(step, `the supersede of ${older} by ${newer} reads ${JSON.stringify(rows)}, not one row on ${s.shelf} by ${c.email}`);
    }
    c.pass(`knowledge_supersede of a ${s.which} node is recorded under ${s.shelf}, the team of the shelf it is on`);
  }
}

async function run(c: Core): Promise<void> {
  await c.sql.query(
    "insert into zz.team (slug, name, created_by) select $2, 'Platform', id from zz.principal where email = $1",
    [c.email, PLATFORM_SHELF]);
  const initiative = await c.open("knowledge-events");
  const made = await addCases(c, initiative);
  await supersedeCases(c, initiative, made);
  c.pass("both tools answer in the sentences the release's chain check reads");
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
