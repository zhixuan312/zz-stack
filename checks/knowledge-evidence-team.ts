#!/usr/bin/env node
/**
 * checks/knowledge-evidence-team.ts — a lesson's evidence links the initiative knowledge_add validated, on a team the
 * caller is a member of, never another team's initiative that happens to carry the same slug.
 *
 *   node checks/knowledge-evidence-team.ts   # needs Docker and a built tree (`npm run build`)
 *
 * The caller acts for the seeded team and is a member of a second; a third team they are not in holds an initiative
 * with the same slug as one of the second's, its id sorting first. knowledge_add citing that slug is validated against
 * the caller's shelves, so the evidence row must name the second team's initiative. And where the team the caller acts
 * for and their second team both hold one slug, the evidence names the acting team's.
 *
 * Exit 0: the case held. Exit 1: it did not, quoting the row. Exit 2: Docker is not available — not a pass.
 */
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-evidence-team";
const DONE = "knowledge-evidence-team: a lesson's evidence names the cited initiative on the caller's own shelves, " +
  "not another team's of the same slug, and the acting team's where two of their own carry it: ok";

const SLUG = "2026-10-01-shared-name";
const MINE = "ffffffff-0000-4000-8000-000000000001";
const THEIRS = "00000000-0000-4000-8000-000000000001";

async function run(c: Core): Promise<void> {
  const step = "evidence cited by a slug two teams carry";
  const person = (await c.sql.query<{ id: string }>("select id from zz.principal where email = $1", [c.email])).rows[0].id;
  const team = async (slug: string): Promise<string> => (await c.sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, person])).rows[0].id;
  const second = await team("evidence-second");
  const third = await team("evidence-third");
  await c.sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)", [second, person]);
  for (const [id, teamId] of [[MINE, second], [THEIRS, third]]) {
    await c.sql.query("insert into zz.initiative (id, team_id, slug, opened_by) values ($1, $2, $3, $4)", [id, teamId, SLUG, person]);
  }

  await c.ok(step, "knowledge_add", {
    title: "A lesson cited across teams", type: "knowledge", scope: "team",
    body: "What the second team's initiative taught.", evidence: [SLUG],
  });
  const { rows } = await c.sql.query<{ initiative: string }>(
    `select e.initiative_id::text as initiative
       from zz.knowledge_node_evidence e join zz.knowledge_node n on n.id = e.node_id
      where n.title = 'A lesson cited across teams'`);
  if (rows.length !== 1 || rows[0].initiative !== MINE) {
    c.fail(step, `the evidence links ${JSON.stringify(rows)}, not the second team's initiative ${MINE}`);
  }
  c.pass(`${step}: the second team's initiative, not the third team's of the same slug`);

  // Two of the caller's own shelves carry one slug: the team they act for wins, whichever row the
  // database reaches first. They switch to the second team, created after the seeded one.
  const both = "acting team and a second team sharing one slug";
  const seeded = (await c.sql.query<{ id: string }>("select id from zz.team where slug = $1", [c.team])).rows[0].id;
  await c.sql.query("update zz.principal set active_team_id = $1 where id = $2", [second, person]);
  await c.restart();
  const SHARED = "2026-10-02-both-teams";
  const OURS = "ffffffff-0000-4000-8000-000000000002";
  await c.sql.query("insert into zz.initiative (id, team_id, slug, opened_by) values ($1, $2, $3, $4), ($5, $6, $3, $4)",
                    ["00000000-0000-4000-8000-000000000002", seeded, SHARED, person, OURS, second]);
  await c.ok(both, "knowledge_add", {
    title: "A lesson cited on two own shelves", type: "knowledge", scope: "team",
    body: "What the acting team's initiative taught.", evidence: [SHARED],
  });
  const { rows: own } = await c.sql.query<{ initiative: string }>(
    `select e.initiative_id::text as initiative
       from zz.knowledge_node_evidence e join zz.knowledge_node n on n.id = e.node_id
      where n.title = 'A lesson cited on two own shelves'`);
  if (own.length !== 1 || own[0].initiative !== OURS) {
    c.fail(both, `the evidence links ${JSON.stringify(own)}, not the acting team's initiative ${OURS}`);
  }
  c.pass(`${both}: the acting team's initiative`);
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
