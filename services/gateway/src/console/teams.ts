/**
 * Teams: the list a caller may see, and one team's own page.
 *
 * A team is the platform's unit of scope, so what these two return is already narrowed by
 * the scope `handler` resolved — a person sees the teams they are in, and a superadmin sees
 * the platform. Neither route decides that for itself.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler } from "./shared.js";

export function mountTeams(app: Express): void {
  /** Every team, with the counts that say whether anything is happening in it. */
  app.get("/api/console/teams", handler("teams", async (_req, res, scope) => {
    const db = platformDb();
    // A ROSTER OF EVERY TEAM is per-team data by definition: each row is one department's
    // name, headcount, installed flows and granted blocks, none of which is another
    // department's business. Until now anyone who could sign in through the identity provider saw every
    // row regardless of which team they were in — the same "console shows everything" gap
    // AC-1 closes elsewhere. A team scope narrows the outer query to the caller's own row;
    // only a platform scope sees the fleet, which is what every caller got before this.
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope`: `check:sql` PREPAREs every
    // query in this file against a live schema before release, and a predicate built from
    // `scope.kind` at request time is invisible to it — see sql-check.ts's header for the
    // 0.4.0 release it exists to catch. Both branches are spelled out in full below.
    const teamsQuery = scope.kind === "platform"
      ? db.query(
      `select t.id, t.slug, t.name, t.status, to_char(t.created_at,'YYYY-MM-DD') as created,
              (select count(*) from zz.membership m where m.team_id = t.id)          as members,
              (select count(distinct d.initiative) from zz.doc d
                 where d.team_slug = t.slug and d.initiative <> '_knowledge')        as initiatives,
              (select count(*) from zz.doc d where d.team_slug = t.slug)             as documents,

              (select coalesce(array_agg(f.flow || ' ' || f.version), '{}')
                 from zz.flow_install f where f.team_id = t.id)                      as flows,
              (select coalesce(array_agg(g.block order by g.block), '{}')
                 from zz.tool_grant g where g.team_id = t.id)                        as blocks
         from zz.team t order by t.status, t.slug`)
      : db.query(
      `select t.id, t.slug, t.name, t.status, to_char(t.created_at,'YYYY-MM-DD') as created,
              (select count(*) from zz.membership m where m.team_id = t.id)          as members,
              (select count(distinct d.initiative) from zz.doc d
                 where d.team_slug = t.slug and d.initiative <> '_knowledge')        as initiatives,
              (select count(*) from zz.doc d where d.team_slug = t.slug)             as documents,

              (select coalesce(array_agg(f.flow || ' ' || f.version), '{}')
                 from zz.flow_install f where f.team_id = t.id)                      as flows,
              (select coalesce(array_agg(g.block order by g.block), '{}')
                 from zz.tool_grant g where g.team_id = t.id)                        as blocks
         from zz.team t where t.slug = $1 order by t.status, t.slug`, [scope.slug]);
    // Two more queries beyond the team roster, for the reason above: the per-team
    // document counts key on zz.doc.team_slug, and the event counts key on
    // zz.event.team_id — the real foreign key, which is null for anything a person did
    // outside a team. Merged here rather than in SQL so neither column can be read as
    // the other. Both stay unfiltered by scope: they are keyed by team id and looked up
    // per row below, so a team scope's single-row result simply never consults the rows
    // for teams it cannot see.
    const [teams, events, work] = await Promise.all([
      teamsQuery,
      db.query(`select team_id, count(*) as n from zz.event
                 where team_id is not null group by team_id`),
      // EVENTS THAT NAME ONE OF THE TEAM'S OWN INITIATIVES — which is a different
      // question from "events attributed to the team", and the difference is the
      // whole point of reporting both.
      //
      // A team can hold 197 documents and have produced NONE of them through the
      // platform: load the files in and there is nothing to record, so its event
      // count is admin actions only. Reported as one number beside a busy team's,
      // that reads as "this team does less work", which is not what it measures —
      // one team's work was instrumented and the other's was not. Two teams on this
      // deployment are in exactly that state, and the first person to read the
      // column drew exactly that wrong conclusion from it.
      db.query(`select t.id as team_id, count(*) as n
                  from zz.event e
                  join zz.team t on t.id = e.team_id
                 where coalesce(e.initiative,'') <> ''
                   and exists (select 1 from zz.doc d
                                where d.team_slug = t.slug and d.initiative = e.initiative)
                 group by t.id`),
    ]);
    const byTeam = new Map(events.rows.map((r) => [r.team_id as string, +r.n]));
    const workByTeam = new Map(work.rows.map((r) => [r.team_id as string, +r.n]));
    res.json({ teams: teams.rows.map((r) => {
      const documents = +r.documents;
      const workEvents = workByTeam.get(r.id as string) ?? 0;
      return {
        slug: r.slug, name: r.name, status: r.status, created: r.created,
        members: +r.members, initiatives: +r.initiatives, documents,
        events: byTeam.get(r.id as string) ?? 0,
        workEvents,
        // A team that HOLDS documents but produced none of them through the
        // platform. Null for a team with no documents at all — there is nothing
        // to have instrumented, so "not instrumented" would be a false alarm.
        instrumented: documents === 0 ? null : workEvents > 0,
        flows: r.flows, blocks: r.blocks,
      };
    }) });
  }));

  /** One team: its people, what it has installed, and who has connected what.
   *
   * The block connections are the answer to "is this team actually able to
   * work" — a grant is the team's permission, a token is a person having used
   * it, and the two are routinely mistaken for each other. Scopes are shown;
   * the tokens themselves never leave the database. */
  app.get("/api/console/teams/:slug", handler("the team", async (req, res, scope) => {
    const db = platformDb();
    const slug = req.params.slug;
    // A team-scoped caller naming a slug that is not their own gets the SAME "no team"
    // response a caller naming a slug that does not exist gets — never a 403, which would
    // confirm the other team is real. Only a platform scope may look up an arbitrary team.
    if (scope.kind === "team" && slug !== scope.slug) {
      res.status(404).json({ error: `no team ${slug}` });
      return;
    }
    const team = await db.query(
      `select id, slug, name, status, to_char(created_at,'YYYY-MM-DD') as created
         from zz.team where slug = $1`, [slug]);
    if (!team.rows.length) { res.status(404).json({ error: `no team ${slug}` }); return; }
    const id = team.rows[0].id as string;
    const [members, flows, grants, tokens] = await Promise.all([
      db.query(`select p.email, p.display_name as name, m.role,
                       to_char(m.created_at,'YYYY-MM-DD') as joined
                  from zz.membership m join zz.principal p on p.id = m.principal_id
                 where m.team_id = $1 order by m.role, p.email`, [id]),
      db.query(`select flow, version, agent_name as agent,
                       to_char(created_at,'YYYY-MM-DD') as installed
                  from zz.flow_install where team_id = $1 order by flow`, [id]),
      db.query(`select block, to_char(created_at,'YYYY-MM-DD') as granted
                  from zz.tool_grant where team_id = $1 order by block`, [id]),
      db.query(`select p.email, b.block, b.scope,
                       to_char(b.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as expires
                  from zz.block_token b
                  join zz.principal p on p.id = b.principal_id
                  join zz.membership m on m.principal_id = p.id and m.team_id = $1
                 order by p.email, b.block`, [id]),
    ]);
    res.json({
      team: { slug: team.rows[0].slug, name: team.rows[0].name,
              status: team.rows[0].status, created: team.rows[0].created },
      members: members.rows, flows: flows.rows, grants: grants.rows, connections: tokens.rows,
    });
  }));
}
