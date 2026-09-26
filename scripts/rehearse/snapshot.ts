/**
 * Before/after facts about the design tables `SCHEMA_TARGET` names: a row count and an `md5`
 * over each table's rows, ordered by the live database's own primary key and hashed over the
 * columns `expect.ts` says the pending migrations leave alone — the same tables
 * `compareWithTarget` checks the shape of, checked here for content instead.
 *
 * The hash is over a fixed set of columns rather than the whole row so a table a migration
 * reshapes is still proven unchanged in every column that migration does not own: the digest is
 * built from the declared columns alone, which normalizes the pre- and post-migration shapes of
 * the same row to one value. The columns left out are the migration's own — one it adds, one it
 * writes — and a digest that carried them would differ for that reason alone.
 */
import type pg from "pg";

import { SCHEMA_TARGET } from "../../schema-target.ts";
import { foldedTableExpectation } from "./expect.ts";

interface TableSnapshot {
  count: number;
  /** `null` when the table's expectation skips the content hash. */
  hash: string | null;
}

export type Snapshot = Record<string, TableSnapshot>;

/**
 * The live database's own primary key for `table`, in key order — read from `pg_index`, not from
 * `SCHEMA_TARGET`, because a migration may change a table's key (`mcp_oauth_authz`: `id` becomes
 * `code_hash`) and the two snapshots of one rehearsal must order the rows they compare the same
 * way. `null` when the table has no primary key.
 */
async function livePrimaryKey(client: pg.Client, table: string): Promise<string[] | null> {
  const { rows } = await client.query<{ attname: string }>(`
    select a.attname
    from pg_index i
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = $1::regclass and i.indisprimary
    order by k.ord
  `, [`zz.${table}`]);
  return rows.length > 0 ? rows.map((r) => r.attname) : null;
}

/** Every live column of `table`, in ordinal order — the fallback ordering for a table with no
 *  primary key (none exist in `SCHEMA_TARGET` today), which is still a total order over rows
 *  that are themselves distinct. */
async function liveColumns(client: pg.Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ attname: string }>(`
    select a.attname
    from pg_attribute a
    where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  `, [`zz.${table}`]);
  return rows.map((r) => r.attname);
}

/** A single-quoted SQL string literal. The names here are column identifiers this repo declares,
 *  but a literal is still escaped rather than trusted. */
function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The row expression the digest is taken over: the whole row when nothing declared a column
 *  list, and otherwise exactly the declared columns — built from the list rather than filtered
 *  out of the row, because the columns that must stay out of the digest are the ones whose value
 *  differs across the migration, not the ones that happen to be absent from one side. */
function hashExpression(hashColumns: string[] | null): string {
  if (hashColumns === null) return "to_jsonb(t)::text";
  return `jsonb_build_object(${hashColumns.map((c) => `${sqlLiteral(c)}, t."${c}"`).join(", ")})::text`;
}

async function snapshotTable(
  client: pg.Client,
  table: string,
  hashColumns: string[] | null,
  skipHash: boolean,
): Promise<TableSnapshot> {
  const orderBy = (await livePrimaryKey(client, table) ?? await liveColumns(client, table))
    .map((c) => `t."${c}"`).join(", ");
  const row = hashExpression(hashColumns);
  const count = (await client.query<{ count: number }>(`
    select count(*)::int as count from "zz"."${table}" t
  `)).rows[0].count;
  if (skipHash) return { count, hash: null };
  const { rows } = await client.query<{ hash: string | null }>(`
    select md5(coalesce(string_agg(md5(${row}), '' order by ${orderBy}), '')) as hash
    from "zz"."${table}" t
  `);
  return { count, hash: rows[0].hash ?? "" };
}

/** One snapshot per design table `SCHEMA_TARGET` names, read off `client` as it stands right now,
 *  hashed the way `pendingMigrations`' expectations ask for. */
export async function captureSnapshot(client: pg.Client, pendingMigrations: readonly string[]): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const name of Object.keys(SCHEMA_TARGET.tables)) {
    const exp = foldedTableExpectation(name, pendingMigrations);
    snapshot[name] = await snapshotTable(client, name, exp.hashColumns, exp.contentHash === "skip");
  }
  return snapshot;
}
