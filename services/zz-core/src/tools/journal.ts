/**
 * The shared journal, as the document tools address it.
 *
 * A knowledge node is not a `doc` row: it lives in `zz.knowledge_node`, under a team, and the
 * document store is not its writer. It is addressed as a path — `_knowledge/nodes/<ordinal>-<slug>.md`
 * — and this module is the one place that address is parsed and resolved, for the read that
 * serves a node and the listing that shows a shelf's nodes.
 *
 * DELIBERATE: an ordinal is allocated PER SHELF, so `_knowledge/nodes/0034-…md` names one node on
 * the caller's own shelf and possibly another on the platform's. The shelf is the row's `team_id`
 * and nothing else: `scope: "platform"` picks the platform shelf, anything else the caller's own.
 * Resolution is by the ordinal the path carries, never by the slug.
 */
import type pg from "pg";

import { KNOWLEDGE_TEAM } from "../paths.js";

/** The ordinal a node path carries, or null when the path is not a node address. */
export function journalOrdinal(rel: string): string | null {
  return /^_knowledge\/nodes\/(\d+)-(.+)\.md$/.exec(rel.replace(/^\/+/, ""))?.[1] ?? null;
}

/** One node's title and body, or the refusal that says which shelf was read and — when the node
 *  is on the other one — how to ask for it. The ordinal means a node on each shelf, so a caller
 *  holding only a search's answer cannot tell which one it asked for. */
export async function readJournalNode(p: pg.Pool, args: {
  rel: string; ordinal: string; team: string | null; scope: string | undefined;
}): Promise<string> {
  const { rel, ordinal, team, scope } = args;
  const shelf = scope === "platform" ? KNOWLEDGE_TEAM : team;
  const node = shelf
    ? (await p.query<{ title: string | null; body: string | null }>(
        `select k.title, k.body from zz.knowledge_node k
           join zz.team t on t.id = k.team_id
          where t.slug = $1 and k.node_ordinal = $2`,
        [shelf, ordinal])).rows[0]
    : undefined;
  if (node) return `${node.title ?? ""}\n\n${node.body ?? ""}`;
  if (!scope && team) {
    const other = (await p.query<{ slug: string }>(
      `select t.slug from zz.knowledge_node k
         join zz.team t on t.id = k.team_id
        where t.slug = $1 and k.node_ordinal = $2`, [KNOWLEDGE_TEAM, ordinal])).rows[0];
    if (other) {
      return `ERROR: ${rel} does not exist on your team's shelf — ` +
        `there is a node ${ordinal} on the ${other.slug} shelf; read it with scope: "platform"`;
    }
  }
  return scope === "platform"
    ? `ERROR: ${rel} does not exist on the platform shelf`
    : `ERROR: ${rel} does not exist on your team's shelf`;
}

/** The node addresses on the caller's own shelf, in ordinal order — the listing `document_list`
 *  answers a journal prefix with. A node is a row, so `documentPaths` cannot see it, and without
 *  this the store listed a shelf's nodes while the listing answered `[]` for them. */
export async function listJournalNodes(p: pg.Pool, team: string, base: string): Promise<string[]> {
  const { rows } = await p.query<{ node_ordinal: string; slug: string }>(
    `select k.node_ordinal, k.slug from zz.knowledge_node k
       join zz.team t on t.id = k.team_id
      where t.slug = $1 order by k.node_ordinal`, [team]);
  return rows.map((n) => `_knowledge/nodes/${n.node_ordinal}-${n.slug}.md`)
    .filter((rel) => !base || rel.startsWith(`${base}/`));
}
