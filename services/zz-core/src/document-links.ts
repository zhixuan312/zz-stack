/**
 * The rows a write files beside its document, inside `saveDocument`'s transaction: its `cites` and
 * `supports` links, a change's causes, and the request record a keyed change commits with. Each
 * takes the transaction's client; none opens a transaction of its own or commits.
 *
 * DELIBERATE: every insert here is ONE statement, whatever the count — the rows go in as arrays
 * through `unnest` — so a change citing two hundred sources runs the statements a change citing
 * one does (`checks/document-store.ts` counts them). Each was one insert per row, which made a
 * change's round trips grow with its causes.
 */
import type pg from "pg";

/** One cause a change records: a `cites` link from the resulting row, with its origin. */
export interface Cause { path: string; revision: number; linked_by: "agent" | "platform" }

/** A keyed change: the caller's key, what its request digests to, and the receipt to replay. */
export interface RequestRecord {
  principalEmail: string; canonicalPath: string; requestId: string; digest: string;
  receipt: Record<string, unknown>;
}

/** A write's own links, as `saveDocument` is handed them. */
interface Links {
  /** The revisions this one cites: `doc_link` rows of kind `cites`. */
  cites?: { path: string; revision: number }[];
  /** The documents this revision bears on: `doc_link` rows of kind `supports`. */
  supports?: string[];
}

export const REQUEST_ID_CONFLICT = "ERROR: REQUEST_ID_CONFLICT — this request_id was used for a different request";

/** The documents a set of store paths name, newest row per path, in one statement. It was a
 *  `documentAt` per entry — 2.1 ms each, sequential (checks/document-body-whole.ts). */
async function idsOf(c: Pick<pg.Pool, "query">, team: string, rels: string[]): Promise<Map<string, string>> {
  if (!rels.length) return new Map();
  const { rows } = await c.query<{ rel: string; id: string }>(`
    select distinct on (i.slug || '/' || d.path) i.slug || '/' || d.path as rel, d.id::text as id
      from zz.doc d
      join zz.initiative i on i.id = d.initiative_id
      join zz.team t on t.id = i.team_id
     where t.slug = $1 and (i.slug || '/' || d.path) = any($2::text[])
     order by i.slug || '/' || d.path, d.updated_at desc`, [team, rels]);
  return new Map(rows.map((r) => [r.rel, r.id] as const));
}

/** The write's own `cites` and `supports`, from the revision it filed. A link whose target names no
 *  document is not filed. */
export async function insertLinks(
  c: Pick<pg.Pool, "query">, team: string, id: string, revision: number, w: Links,
): Promise<void> {
  const links = [
    ...(w.cites ?? []).map((l) => ({ rel: l.path, toRevision: l.revision as number | null, kind: "cites" })),
    ...(w.supports ?? []).map((rel) => ({ rel, toRevision: null, kind: "supports" })),
  ];
  const ids = await idsOf(c, team, links.map((l) => l.rel));
  const filed = links.filter((l) => ids.has(l.rel));
  if (!filed.length) return;
  // DELIBERATE: `on conflict do nothing` — `doc_link_unique` is NULLS NOT DISTINCT, so citing
  // twice is one row, within this statement as across two.
  await c.query(
    `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind)
     select $1::uuid, $2, l.to_doc_id, l.to_revision, l.kind
       from unnest($3::uuid[], $4::int[], $5::text[]) as l (to_doc_id, to_revision, kind)
     on conflict do nothing`,
    [id, revision, filed.map((l) => ids.get(l.rel)), filed.map((l) => l.toRevision), filed.map((l) => l.kind)]);
}

/** A change's causes, as `cites` links with their origin. A cause the writer named wins over the
 *  same cause the platform linked: `platform` is upgraded to `agent`, never the other way, and a
 *  citation recorded before origins were (`linked_by` null, read as `agent`) is left as it is.
 *  Returns the first path that names no document, which refuses the whole change. */
export async function insertCauses(
  c: Pick<pg.Pool, "query">, team: string, id: string, revision: number, causes: Cause[],
): Promise<string | null> {
  const ids = await idsOf(c, team, causes.map((k) => k.path));
  const missing = causes.find((k) => !ids.has(k.path));
  if (missing) return missing.path;
  // One row per link, `agent` kept over `platform`: an `on conflict do update` may not touch a row
  // twice in one statement, and a cause listed twice is one link whose origin the writer's naming
  // decides — which is what inserting them one after another used to leave.
  const links = new Map<string, Cause & { to: string }>();
  for (const k of causes) {
    const to = ids.get(k.path)!;
    const key = `${to}:${k.revision}`;
    const had = links.get(key);
    if (!had || (had.linked_by === "platform" && k.linked_by === "agent")) links.set(key, { ...k, to });
  }
  const rows = [...links.values()];
  if (!rows.length) return null;
  await c.query(
    `insert into zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind, linked_by)
     select $1::uuid, $2, l.to_doc_id, l.to_revision, 'cites', l.linked_by
       from unnest($3::uuid[], $4::int[], $5::text[]) as l (to_doc_id, to_revision, linked_by)
     on conflict (from_doc_id, from_revision, to_doc_id, to_revision, kind)
     do update set linked_by = 'agent'
      where zz.doc_link.linked_by = 'platform' and excluded.linked_by = 'agent'`,
    [id, revision, rows.map((k) => k.to), rows.map((k) => k.revision), rows.map((k) => k.linked_by)]);
  return null;
}

/** A committed request under this key: the receipt to replay, or the conflict. Null when none. */
export async function storedRequest(
  c: Pick<pg.Pool, "query">, team: string, principal: string, r: RequestRecord,
): Promise<{ replayed: Record<string, unknown> } | { refusal: string } | null> {
  const { rows } = await c.query<{ request_digest: string; receipt: Record<string, unknown> }>(
    `select q.request_digest, q.receipt from zz.doc_request q join zz.team t on t.id = q.team_id
      where t.slug = $1 and q.principal_id = $2::uuid and q.canonical_path = $3 and q.request_id = $4`,
    [team, principal, r.canonicalPath, r.requestId]);
  if (!rows[0]) return null;
  return rows[0].request_digest === r.digest ? { replayed: rows[0].receipt } : { refusal: REQUEST_ID_CONFLICT };
}

/** The request row, last of the change's own rows in the transaction. False when the key was
 *  already taken. */
export async function recordRequest(
  c: Pick<pg.Pool, "query">, team: string, principal: string, docId: string, r: RequestRecord,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `insert into zz.doc_request (team_id, principal_id, canonical_path, request_id, doc_id,
                                 request_digest, receipt)
     select t.id, $2::uuid, $3, $4, $5::uuid, $6, $7::jsonb from zz.team t where t.slug = $1
     on conflict do nothing`,
    [team, principal, r.canonicalPath, r.requestId, docId || null, r.digest, JSON.stringify(r.receipt)]);
  return (rowCount ?? 0) > 0;
}
