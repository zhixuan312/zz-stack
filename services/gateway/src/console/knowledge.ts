/**
 * The knowledge base, both shelves.
 *
 * The index, the append-only log of what was minted and superseded, and one node's content.
 * A node's shelf is part of its address: the same ordinal under a team and under the platform
 * are different nodes, and a reader that guessed would show one team another team's lesson.
 *
 * The reshape moved four relations into keys, and every one of them is derived here from the key
 * rather than read out of a column: the shelf is `team_id`, joined back to the slug this API
 * sends; the address is `node_ordinal` and `slug`, which is what the node file's name splits
 * into; the successor is `superseded_by_id`; the citations are rows in `knowledge_node_evidence`,
 * joined through `zz.initiative`. The JSON is exactly what it has always been — each field below
 * is built in JS from the derived column, which is why the SQL aliases are not those field names.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { handler } from "./shared.js";

/** One row of the list and detail queries below, as they are aliased there. */
interface NodeRow {
  shelf: string; address: string; ordinal: string; type: string; status: string;
  title: string; tags: string[] | null; citations: string[] | null; successor: string | null;
  updated: string; bytes?: string; excerpt?: string; body?: string;
  evidence_in?: unknown;
}

export function mountKnowledge(app: Express): void {
  /** The knowledge base: the list, with enough of each body to recognise it. A title alone does
   *  not tell a reader whether the node is the one they wanted. Full bodies come from the
   *  endpoint below, one at a time. */
  app.get("/api/console/knowledge", handler("the knowledge base", async (_req, res, scope) => {
    const db = platformDb();
    // Same deletion as /initiatives, and the same reason: a null shelf parameter must
    // never mean "every team's nodes".
    //
    // Two complete statements, not one assembled from `scope` — `check:sql` can only PREPARE a
    // literal it can read whole.
    //
    // Where the lesson came from: `knowledge_node_evidence` holds the initiatives the node cites,
    // the only linkage the store records between a node and the work behind it. Ordered, because
    // a relation has no order of its own and the list must not shuffle between reads.
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select t.slug as shelf,
              'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as address,
              k.node_ordinal as ordinal, k.kind as type, k.lifecycle as status, k.title, k.tags,
              (select coalesce(array_agg(i.slug order by i.slug), '{}')
                 from zz.knowledge_node_evidence ne
                 join zz.initiative i on i.id = ne.initiative_id
                where ne.node_id = k.id) as citations,
              (select s.node_ordinal
                 from zz.knowledge_node s where s.id = k.superseded_by_id) as successor,
              -- An instant, like every other time this API sends.
              to_char(k.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(k.body,'')) as bytes,
              left(regexp_replace(coalesce(k.body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        order by t.slug, k.node_ordinal`)
      : await db.query(
      `select t.slug as shelf,
              'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as address,
              k.node_ordinal as ordinal, k.kind as type, k.lifecycle as status, k.title, k.tags,
              (select coalesce(array_agg(i.slug order by i.slug), '{}')
                 from zz.knowledge_node_evidence ne
                 join zz.initiative i on i.id = ne.initiative_id
                where ne.node_id = k.id) as citations,
              (select s.node_ordinal
                 from zz.knowledge_node s where s.id = k.superseded_by_id) as successor,
              to_char(k.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated,
              length(coalesce(k.body,'')) as bytes,
              left(regexp_replace(coalesce(k.body,''), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where t.slug = $1
        order by k.node_ordinal`, [scope.slug]);
    res.json({ nodes: (rows as NodeRow[]).map((r) => ({
      team: r.shelf, path: r.address, type: r.type, status: r.status, title: r.title,
      tags: r.tags, evidence: r.citations, superseded_by: r.successor,
      updated: r.updated, bytes: Number(r.bytes), excerpt: r.excerpt,
      // The number is per team — every team numbers its own nodes from 0001, so two teams both
      // have a node 1. Shown as a number and keyed by team+path, because a list mixing teams
      // under a bare "1, 1, 2, 2" looks duplicated.
      num: String(Number(r.ordinal)),
      key: `${r.shelf}/${r.address}`,
    })) });
  }));

  /** The knowledge base's own log — what was recorded, what replaced what, and by whom.
   *
   * Reads `knowledge.add` / `knowledge.supersede`, the entries zz-core writes beside its
   * `_knowledge/log.md`, which the store writes. Not `tool_call` rows: those carry no actor
   * by design and include `knowledge_search` reads, which are not journal entries.
   *
   * The actor is an id on the row, so the address comes from `zz.principal`: the event records who
   * did it, not how they spelled themselves. Null where the door resolved no principal — an entry
   * is still evidence of an act even when nobody can be named for it.
   *
   * The nodes are joined back in by (team, ordinal): a node's shelf is the team the event names,
   * and the event's `subject` was always the node's ordinal, so the join runs on `team_id` and
   * `node_ordinal` rather than on a path the table no longer holds. A left join, because a node
   * deleted from the shelf still has a log entry that happened.
   */
  app.get("/api/console/knowledge/log", handler("the knowledge log", async (_req, res, scope) => {
    const db = platformDb();
    const { rows } = scope.kind === "platform"
      ? await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              p.email as actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as successor_recorded,
              d.title as node_title, d.lifecycle as node_status
         from zz.event e
         left join zz.team t on t.id = e.team_id
         left join zz.principal p on p.id = e.actor_id
         left join zz.knowledge_node d on d.team_id = t.id
                           and d.node_ordinal = e.subject
        where e.kind in ('knowledge.add','knowledge.supersede')
        order by e.ts desc limit 500`)
      : await db.query(
      `select to_char(e.ts at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as ts,
              p.email as actor, t.slug as team, e.kind, e.subject as node,
              e.detail->>'title' as recorded_title, e.detail->>'supersededBy' as successor_recorded,
              d.title as node_title, d.lifecycle as node_status
         from zz.event e
         join zz.team t on t.id = e.team_id
         left join zz.principal p on p.id = e.actor_id
         left join zz.knowledge_node d on d.team_id = t.id
                           and d.node_ordinal = e.subject
        where e.kind in ('knowledge.add','knowledge.supersede')
          and t.slug = $1
        order by e.ts desc limit 500`,
      [scope.slug]);
    res.json({ entries: (rows as Record<string, unknown>[]).map((r) => ({
      ts: r.ts, actor: r.actor, team: r.team, kind: r.kind, node: r.node,
      recorded_title: r.recorded_title, superseded_by: r.successor_recorded,
      node_title: r.node_title, node_status: r.node_status,
    })) });
  }));

  /** One node, whole. The console's reading pane. */
  app.get("/api/console/knowledge/:team/*", handler("the node", async (req, res, scope) => {
    const db = platformDb();
    const address = (req.params as Record<string, string>)[0];
    // Same not-found rather than a refusal as /teams/:slug: a team scope naming someone else's
    // team gets the response it would get for a node that never existed.
    if (scope.kind === "team" && req.params.team !== scope.slug) {
      res.status(404).json({ error: `no node ${address}` });
      return;
    }
    const { rows } = await db.query(
      `select t.slug as shelf,
              'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as address,
              k.kind as type, k.lifecycle as status, k.title, k.tags, k.body,
              (select coalesce(array_agg(i.slug order by i.slug), '{}')
                 from zz.knowledge_node_evidence ne
                 join zz.initiative i on i.id = ne.initiative_id
                where ne.node_id = k.id) as citations,
              (select s.node_ordinal
                 from zz.knowledge_node s where s.id = k.superseded_by_id) as successor,
              -- Which team each cited initiative lives in, read off the relation rather than
              -- resolved: the citation names the initiative, so its team is the initiative's own
              -- and nothing has to be guessed from a slug two teams could both carry.
              (select coalesce(jsonb_agg(jsonb_build_object('name', i.slug, 'team', t2.slug)
                                         order by i.slug), '[]'::jsonb)
                 from zz.knowledge_node_evidence ne
                 join zz.initiative i on i.id = ne.initiative_id
                 join zz.team t2 on t2.id = i.team_id
                where ne.node_id = k.id) as evidence_in,
              -- An instant, like the list route: the console's Time component reads a bare date as
              -- UTC midnight.
              to_char(k.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where t.slug = $1 and ('nodes/' || k.node_ordinal || '-' || k.slug || '.md') = $2`,
      [req.params.team, address]);
    if (!rows.length) { res.status(404).json({ error: `no node ${address}` }); return; }
    const r = rows[0] as NodeRow;
    res.json({
      team: r.shelf, path: r.address, type: r.type, status: r.status, title: r.title,
      tags: r.tags, body: r.body, evidence: r.citations, superseded_by: r.successor,
      evidence_in: r.evidence_in, updated: r.updated,
    });
  }));
}
