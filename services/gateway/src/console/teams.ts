/**
 * Teams: the list a caller may see, and one team's own page.
 *
 * What these two return is already narrowed by the scope `handler` resolved — a person sees the
 * teams they are in, a superadmin sees the platform. Neither route decides that for itself.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler } from "./shared.js";

export function mountTeams(app: Express): void {
  /** Every team: who is in it and what it holds. */
  app.get("/api/console/teams", handler("teams", async (_req, res, scope) => {
    const db = platformDb();
    // A roster of every team is per-team data, so a team scope narrows the query to the caller's
    // own row and only a platform scope sees the fleet. Documents and sources are counted apart:
    // both live in zz.doc, and one number for the two counts registered sources as documents.
    //
    // DELIBERATE: two complete statements, not one assembled from `scope`. `check:sql` PREPAREs
    // every query in this file against a live schema before release, and a predicate built from
    // `scope.kind` at request time is invisible to it.
    const teams = scope.kind === "platform"
      ? await db.query(
      `select t.slug, t.name, t.status, to_char(t.created_at,'YYYY-MM-DD') as created,
              (select count(*) from zz.membership m where m.team_id = t.id)          as members,
              (select count(distinct d.initiative) from zz.doc d
                 where d.team_slug = t.slug and d.initiative <> '_knowledge')        as initiatives,
              (select count(*) from zz.doc d
                 where d.team_slug = t.slug and d.type <> 'source')                  as documents,
              (select count(*) from zz.doc d
                 where d.team_slug = t.slug and d.type = 'source')                   as sources,
              (select count(*) from zz.knowledge_node k where k.team_slug = t.slug)  as knowledge
         from zz.team t order by t.status, t.slug`)
      : await db.query(
      `select t.slug, t.name, t.status, to_char(t.created_at,'YYYY-MM-DD') as created,
              (select count(*) from zz.membership m where m.team_id = t.id)          as members,
              (select count(distinct d.initiative) from zz.doc d
                 where d.team_slug = t.slug and d.initiative <> '_knowledge')        as initiatives,
              (select count(*) from zz.doc d
                 where d.team_slug = t.slug and d.type <> 'source')                  as documents,
              (select count(*) from zz.doc d
                 where d.team_slug = t.slug and d.type = 'source')                   as sources,
              (select count(*) from zz.knowledge_node k where k.team_slug = t.slug)  as knowledge
         from zz.team t where t.slug = $1 order by t.status, t.slug`, [scope.slug]);
    res.json({
      teams: teams.rows.map((r) => ({
        slug: r.slug, name: r.name, status: r.status, created: r.created,
        members: +r.members, initiatives: +r.initiatives,
        documents: +r.documents, sources: +r.sources, knowledge: +r.knowledge,
      })),
    });
  }));

  /** One team: its people. */
  app.get("/api/console/teams/:slug", handler("the team", async (req, res, scope) => {
    const db = platformDb();
    const slug = req.params.slug;
    // A team-scoped caller naming a slug that is not their own gets the same "no team" response
    // a caller naming a slug that does not exist gets — never a 403, which would confirm the
    // other team is real. Only a platform scope may look up an arbitrary team.
    if (scope.kind === "team" && slug !== scope.slug) {
      res.status(404).json({ error: `no team ${slug}` });
      return;
    }
    const team = await db.query(
      `select id, slug, name, status, to_char(created_at,'YYYY-MM-DD') as created
         from zz.team where slug = $1`, [slug]);
    if (!team.rows.length) { res.status(404).json({ error: `no team ${slug}` }); return; }
    const members = await db.query(
      `select p.email, p.display_name as name, m.role,
              to_char(m.created_at,'YYYY-MM-DD') as joined
         from zz.membership m join zz.principal p on p.id = m.principal_id
        where m.team_id = $1 order by m.role, p.email`, [team.rows[0].id as string]);
    res.json({
      team: { slug: team.rows[0].slug, name: team.rows[0].name,
              status: team.rows[0].status, created: team.rows[0].created },
      members: members.rows,
    });
  }));
}
