/**
 * The knowledge base, both shelves.
 *
 * The index, the append-only log of what was minted and superseded, and one node's content.
 * A node's shelf is part of its address: the same path under a team and under the platform
 * are different nodes, and a reader that guessed would show one team another team's lesson.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler } from "./shared.js";

export function mountKnowledge(app: Express): void {
  /** The knowledge base: the list, with enough of each body to recognise it. A title alone does
   *  not tell a reader whether the node is the one they wanted. Full bodies come from the
   *  endpoint below, one at a time. */
  app.get("/api/console/knowledge", handler("the knowledge base", async (_req, res, scope) => {
    const db = platformDb();
    // Same deletion as /initiatives, and the same reason: a null `team_slug` parameter must
    // never mean "every team's nodes".
    //
    // Two complete statements, not one assembled from `scope` — `check:sql` can only PREPARE a
    // literal it can read whole.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select team_slug as team, path, kind as type, lifecycle as status, title, tags,
              -- Where the lesson came from: evidence holds the initiative that produced the node, the
              -- only linkage the store records between a node and the work behind it.
              evidence, superseded_by,
              -- An instant, like every other time this API sends.
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(body,'')) as bytes,
              left(regexp_replace(coalesce(body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node
        order by team_slug, path`)
      : await db.query(
      `select team_slug as team, path, kind as type, lifecycle as status, title, tags,
              evidence, superseded_by,
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(body,'')) as bytes,
              left(regexp_replace(coalesce(body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node
        where team_slug = $1
        order by team_slug, path`, [scope.slug]);
    res.json({ nodes: rows.map((r) => ({
      ...r, bytes: +r.bytes,
      // The number is per team — every team numbers its own nodes from 0001, so two teams both
      // have a node 1. Shown as a number and keyed by team+path, because a list mixing teams
      // under a bare "1, 1, 2, 2" looks duplicated.
      num: /nodes\/0*(\d+)/.exec(r.path as string)?.[1] ?? "",
      key: `${r.team_slug as string}/${r.path as string}`,
    })) });
  }));

  /** The knowledge base's own log — what was recorded, what replaced what, and by whom.
   *
   * Reads `knowledge.add` / `knowledge.supersede`, the entries zz-core writes beside its
   * `_knowledge/log.md`, which the store writes. Not `tool_call` rows: those carry no actor
   * by design and include `knowledge_search` reads, which are not journal entries.
   *
   * The nodes are joined back in by (team, subject), so a row carries the node's title as it
   * stands now rather than as it was typed. A left join, because a node deleted from the shelf
   * still has a log entry that happened.
   */
  app.get("/api/console/knowledge/log", handler("the knowledge log", async (_req, res, scope) => {
    const db = platformDb();
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              e.actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as superseded_by,
              d.title as node_title, d.lifecycle as node_status
         from zz.event e
         left join zz.team t on t.id = e.team_id
         left join zz.knowledge_node d on d.team_slug = e.team_slug
                           and d.path like '%' || e.subject || '-%'
        where e.kind in ('knowledge.add','knowledge.supersede')
        order by e.ts desc limit 500`)
      : await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              e.actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as superseded_by,
              d.title as node_title, d.lifecycle as node_status
         from zz.event e
         join zz.team t on t.id = e.team_id
         left join zz.knowledge_node d on d.team_slug = e.team_slug
                           and d.path like '%' || e.subject || '-%'
        where e.kind in ('knowledge.add','knowledge.supersede')
          and t.slug = $1
        order by e.ts desc limit 500`,
      [scope.slug]);
    res.json({ entries: rows });
  }));

  /** One node, whole. The console's reading pane. */
  app.get("/api/console/knowledge/:team/*", handler("the node", async (req, res, scope) => {
    const db = platformDb();
    const path = (req.params as Record<string, string>)[0];
    // Same not-found rather than a refusal as /teams/:slug: a team scope naming someone else's
    // team gets the response it would get for a node that never existed.
    if (scope.kind === "team" && req.params.team !== scope.slug) {
      res.status(404).json({ error: `no node ${path}` });
      return;
    }
    const { rows } = await db.query(
      `select team_slug as team, path, kind as type, lifecycle as status, title, tags, body,
              evidence, superseded_by,
              -- Which team each piece of evidence lives in, resolved rather than assumed:
              -- knowledge_add accepts evidence naming an initiative in any team the author belongs
              -- to. Null when no team on this deployment has an initiative by that name, and the
              -- console then renders the name as text. The node's own team wins a tie, because that
              -- is the likeliest author.
              (select coalesce(jsonb_agg(jsonb_build_object(
                        \'name\', ev.name,
                        \'team\', (select t2.slug from zz.initiative i2
                                    join zz.team t2 on t2.id = i2.team_id
                                   where i2.slug = ev.name
                                   order by (t2.slug = n.team_slug) desc, t2.slug
                                   limit 1))), \'[]\'::jsonb)
                 from unnest(coalesce(evidence, array[]::text[])) as ev(name)) as evidence_in,
              -- An instant, like the list route: the console's Time component reads a bare date as
              -- UTC midnight.
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated
         from zz.knowledge_node n where n.team_slug = $1 and n.path = $2`,
      [req.params.team, path]);
    if (!rows.length) { res.status(404).json({ error: `no node ${path}` }); return; }
    res.json(rows[0]);
  }));
}
