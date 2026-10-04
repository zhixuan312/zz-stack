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

/** One row as the list and a node's neighbours both return it. One mapper, because a reader must
 *  not be able to tell a node found by the list from the same node found as a neighbour. */
function listNode(r: NodeRow) {
  return {
    team: r.shelf, path: r.address, type: r.type, status: r.status, title: r.title,
    tags: r.tags, evidence: r.citations, superseded_by: r.successor,
    updated: r.updated, bytes: Number(r.bytes), excerpt: r.excerpt,
    // The number is per team — every team numbers its own nodes from 0001, so two teams both
    // have a node 1. Shown as a number and keyed by team+path, because a list mixing teams
    // under a bare "1, 1, 2, 2" looks duplicated.
    num: String(Number(r.ordinal)),
    key: `${r.shelf}/${r.address}`,
  };
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
              -- DELIBERATE: the whitespace collapse runs over a bounded prefix, not the whole
              -- body. Collapsing can only ever shorten, and an excerpt is a preview rather than
              -- a fixed-width field, so a prefix that collapses below 220 characters shows a
              -- shorter preview and nothing else — it takes a node that is mostly blank lines to
              -- do even that. Run over the whole body it detoasted all 23 MB of the shelf:
              -- 402 ms to produce 965 × 220 characters, against 159 ms bounded.
              left(regexp_replace(left(coalesce(k.body,''), 400), '\\s+', ' ', 'g'), 220) as excerpt
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
              -- DELIBERATE: the whitespace collapse runs over a bounded prefix, not the whole
              -- body. Collapsing can only ever shorten, and an excerpt is a preview rather than
              -- a fixed-width field, so a prefix that collapses below 220 characters shows a
              -- shorter preview and nothing else — it takes a node that is mostly blank lines to
              -- do even that. Run over the whole body it detoasted all 23 MB of the shelf:
              -- 402 ms to produce 965 × 220 characters, against 159 ms bounded.
              left(regexp_replace(left(coalesce(k.body,''), 400), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where t.slug = $1
        order by k.node_ordinal`, [scope.slug]);
    res.json({ nodes: (rows as NodeRow[]).map(listNode) });
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
    /* The node, and the two facts the page beside it draws from the shelf rather than from this
     * node: which other nodes share one of its tags — the only link the store records between two
     * nodes — and whether the shelf it is on spans more than one team.
     *
     * DELIBERATE: answered here rather than by the reading pane fetching the whole list. It did,
     * and a shelf is hundreds of nodes with a title, tags, an excerpt and a byte count each: the
     * page downloaded all of them to show at most a handful of neighbours.
     *
     * The neighbours are read against the SCOPE, not against the team the node belongs to, so a
     * platform-scoped reader sees the neighbours the list showed them and a team-scoped one does
     * not see nodes belonging to another team. The parameters name this node, so it is excluded
     * from its own neighbours and its tags are read in the same statement — no second round trip
     * to learn them.
     * COUPLED: listNode below, so a neighbour is the same shape as a row of the list.
     *
     * DELIBERATE: no backtick anywhere in this comment. This file is read as TEXT by the scanners
     * that check its SQL, and a backtick in prose opens a template literal they then read as code.
     * initiatives.ts carries the same note about the console's own scanner, where exactly this
     * broke the check the comment was describing. */
    const [node, neighbours, shelves] = await Promise.all([
    db.query(
      `select t.slug as shelf,
              'nodes/' || k.node_ordinal || '-' || k.slug || '.md' as address,
              k.node_ordinal as ordinal,
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
      [req.params.team, address]),
    // Two complete statements, not one assembled from `scope` — `check:sql` can only PREPARE a
    // literal it can read whole. The team branch keeps the neighbours on the caller's own shelf.
    scope.kind === "platform"
      ? db.query(
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
              left(regexp_replace(left(coalesce(k.body,''), 400), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where k.tags && (select n2.tags from zz.knowledge_node n2
                           join zz.team t2 on t2.id = n2.team_id
                          where t2.slug = $1
                            and ('nodes/' || n2.node_ordinal || '-' || n2.slug || '.md') = $2)
          and not (t.slug = $1
                   and ('nodes/' || k.node_ordinal || '-' || k.slug || '.md') = $2)
        order by t.slug, k.node_ordinal`, [req.params.team, address])
      : db.query(
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
              left(regexp_replace(left(coalesce(k.body,''), 400), '\\s+', ' ', 'g'), 220) as excerpt
         from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where t.slug = $3
          and k.tags && (select n2.tags from zz.knowledge_node n2
                           join zz.team t2 on t2.id = n2.team_id
                          where t2.slug = $1
                            and ('nodes/' || n2.node_ordinal || '-' || n2.slug || '.md') = $2)
          and not (t.slug = $1
                   and ('nodes/' || k.node_ordinal || '-' || k.slug || '.md') = $2)
        order by k.node_ordinal`, [req.params.team, address, scope.slug]),
    scope.kind === "platform"
      ? db.query<{ multi_team: boolean }>(
      `select count(distinct t.slug) > 1 as multi_team
         from zz.knowledge_node k join zz.team t on t.id = k.team_id`)
      : db.query<{ multi_team: boolean }>(
      `select count(distinct t.slug) > 1 as multi_team
         from zz.knowledge_node k join zz.team t on t.id = k.team_id
        where t.slug = $1`, [scope.slug]),
    ]);
    const rows = node.rows;
    if (!rows.length) { res.status(404).json({ error: `no node ${address}` }); return; }
    const r = rows[0] as NodeRow;
    res.json({
      team: r.shelf, path: r.address, type: r.type, status: r.status, title: r.title,
      tags: r.tags, body: r.body, evidence: r.citations, superseded_by: r.successor,
      evidence_in: r.evidence_in, updated: r.updated,
      // The number as the list shows it — per team, without its leading zeros — so the crumb above
      // the reader names the node the way the list they came from did.
      num: String(Number(r.ordinal)),
      related: (neighbours.rows as NodeRow[]).map(listNode),
      multi_team: shelves.rows[0]?.multi_team ?? false,
    });
  }));
}
