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
              (select count(distinct i.slug) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and i.slug <> '_knowledge')                   as initiatives,
              (select count(*) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and d.type <> 'source')                       as documents,
              (select count(*) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and d.type = 'source')                        as sources
         from zz.team t order by t.status, t.slug`)
      : await db.query(
      `select t.slug, t.name, t.status, to_char(t.created_at,'YYYY-MM-DD') as created,
              (select count(*) from zz.membership m where m.team_id = t.id)          as members,
              (select count(distinct i.slug) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and i.slug <> '_knowledge')                   as initiatives,
              (select count(*) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and d.type <> 'source')                       as documents,
              (select count(*) from zz.doc d
                 join zz.initiative i on i.id = d.initiative_id
                where i.team_id = t.id and d.type = 'source')                        as sources
         from zz.team t where t.slug = $1 order by t.status, t.slug`, [scope.slug]);
    // The shelf count is its own statement rather than a sixth subquery: a node's shelf is a
    // relation to `zz.team` now, so this one joins on `team_id`, and asking it apart keeps each
    // statement naming only the columns the table it reads actually carries. Two complete
    // statements for the same reason as above; `count(k.id)`, not `count(*)`, so a team with no
    // nodes is a counted zero rather than an inner join's missing row.
    const shelves = scope.kind === "platform"
      ? await db.query<{ slug: string; knowledge: string }>(
      `select t.slug, count(k.id) as knowledge
         from zz.team t
         left join zz.knowledge_node k on k.team_id = t.id
        group by t.slug
        order by t.slug`)
      : await db.query<{ slug: string; knowledge: string }>(
      `select t.slug, count(k.id) as knowledge
         from zz.team t
         left join zz.knowledge_node k on k.team_id = t.id
        where t.slug = $1
        group by t.slug
        order by t.slug`, [scope.slug]);
    const bySlug = new Map(shelves.rows.map((r) => [r.slug, Number(r.knowledge)]));
    res.json({
      teams: teams.rows.map((r) => ({
        slug: r.slug, name: r.name, status: r.status, created: r.created,
        members: +r.members, initiatives: +r.initiatives,
        documents: +r.documents, sources: +r.sources,
        knowledge: bySlug.get(r.slug as string) ?? 0,
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
