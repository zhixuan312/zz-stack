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
  /** The knowledge base: the list, with enough of each body to recognise it.
   *
   * The excerpt is here so the list is readable on its own — a title alone told
   * a reader nothing about whether the node was the one they wanted, which is
   * the complaint the console exists to answer. Full bodies come from the
   * endpoint below, one at a time. */
  app.get("/api/console/knowledge", handler("the knowledge base", async (_req, res, scope) => {
    const db = platformDb();
    // Same deletion as /initiatives, and the same reason: a null `team_slug` parameter
    // must never again mean "every team's nodes".
    //
    // TWO COMPLETE STATEMENTS, not one assembled from `scope` — see the note in
    // /api/console/initiatives above; `check:sql` can only PREPARE a literal it can read
    // whole.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select team_slug as team, path, type, status, title, tags,
              -- WHERE THE LESSON CAME FROM. evidence holds the initiative that
              -- produced the node, and it is the only linkage the store actually
              -- records between a node and the work behind it. Nothing displayed it,
              -- so every node read as a free-floating assertion.
              evidence, superseded_by,
              -- ISO like every other time this API sends. It was a bare date, which meant
              -- one field named updated carried a day and another carried an instant, so no
              -- rule about rendering a time could be stated here, let alone checked.
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(body,'')) as bytes,
              left(regexp_replace(coalesce(body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.doc
        where initiative = '_knowledge' and path like 'nodes/%'
        order by team_slug, path`)
      : await db.query(
      `select team_slug as team, path, type, status, title, tags,
              evidence, superseded_by,
              to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(body,'')) as bytes,
              left(regexp_replace(coalesce(body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.doc
        where initiative = '_knowledge' and path like 'nodes/%'
          and team_slug = $1
        order by team_slug, path`, [scope.slug]);
    res.json({ nodes: rows.map((r) => ({
      ...r, bytes: +r.bytes,
      // The NUMBER is per team — every team numbers its own nodes from 0001, so
      // two teams both have a node 1. Shown as a number and keyed by team+path,
      // because a list mixing teams under a bare "1, 1, 2, 2" looks duplicated
      // and is unusable for picking one.
      num: /nodes\/0*(\d+)/.exec(r.path as string)?.[1] ?? "",
      key: `${r.team_slug as string}/${r.path as string}`,
    })) });
  }));

  /** The knowledge base's own log — what was recorded, what replaced what, and by whom.
   *
   * READS `knowledge.add` / `knowledge.supersede`, the entries zz-core writes beside its
   * `_knowledge/log.md` (see `knowledgeEvent` there). Not `tool_call` rows: those carry no
   * actor on purpose — "no address on a measurement" — and they include `search_knowledge`
   * reads, which are not journal entries. A log needs exactly the thing a measurement drops.
   *
   * THE NODES ARE JOINED BACK IN, by (team, subject), so a row can carry the node's title
   * as it stands NOW rather than as it was typed. A log listing "node 3, superseded" with
   * no title is a list of numbers; the title is the only part a person recognises. A left
   * join, because a node deleted from the shelf still has a log entry that happened, and
   * dropping it would edit the record to match the store.
   */
  app.get("/api/console/knowledge/log", handler("the knowledge log", async (_req, res, scope) => {
    const db = platformDb();
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              e.actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as superseded_by,
              d.title as node_title, d.status as node_status
         from zz.event e
         left join zz.team t on t.id = e.team_id
         left join zz.doc d on d.team_slug = e.team_slug and d.initiative = '_knowledge'
                           and d.path like '%/' || e.subject || '-%'
        where e.kind in ('knowledge.add','knowledge.supersede')
        order by e.ts desc limit 500`)
      : await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              e.actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as superseded_by,
              d.title as node_title, d.status as node_status
         from zz.event e
         join zz.team t on t.id = e.team_id
         left join zz.doc d on d.team_slug = e.team_slug and d.initiative = '_knowledge'
                           and d.path like '%/' || e.subject || '-%'
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
    // Same not-found rather than a refusal as /teams/:slug: a team scope naming someone
    // else's team gets the response it would get for a node that never existed.
    if (scope.kind === "team" && req.params.team !== scope.slug) {
      res.status(404).json({ error: `no node ${path}` });
      return;
    }
    const { rows } = await db.query(
      `select team_slug as team, path, type, status, title, tags, body,
              evidence, superseded_by,
              to_char(updated_at,'YYYY-MM-DD') as updated
         from zz.doc where team_slug = $1 and initiative = '_knowledge' and path = $2`,
      [req.params.team, path]);
    if (!rows.length) { res.status(404).json({ error: `no node ${path}` }); return; }
    res.json(rows[0]);
  }));
}
