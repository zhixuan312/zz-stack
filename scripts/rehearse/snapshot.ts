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

import { declaredTableNames, foldedTableExpectation } from "./expect.ts";

interface TableSnapshot {
  count: number;
  /** `null` when the table's expectation skips the content hash. */
  hash: string | null;
  /** `false` when `zz.<table>` is not there at all — a table the migration drops, read on the
   *  after side. A relation that cannot be read has no count and no hash, and `0` would be a
   *  claim about rows instead. */
  present: boolean;
}

export type Snapshot = Record<string, TableSnapshot>;

/** Which side of the migration is being read. The before side reads a renamed table under the
 *  name it had then; the after side reads every table under the target's own name. */
type SnapshotSide = "before" | "after";

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

/** Whether `zz.<relation>` exists at all, so a table the migration drops is read as absent
 *  rather than throwing out of the whole rehearsal. */
async function relationExists(client: pg.Client, relation: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present", [`zz.${relation}`],
  );
  return rows[0].present;
}

async function snapshotTable(
  client: pg.Client,
  relation: string,
  hashColumns: string[] | null,
  skipHash: boolean,
): Promise<TableSnapshot> {
  if (!(await relationExists(client, relation))) return { count: 0, hash: null, present: false };
  const orderBy = (await livePrimaryKey(client, relation) ?? await liveColumns(client, relation))
    .map((c) => `t."${c}"`).join(", ");
  const row = hashExpression(hashColumns);
  const count = (await client.query<{ count: number }>(`
    select count(*)::int as count from "zz"."${relation}" t
  `)).rows[0].count;
  if (skipHash) return { count, hash: null, present: true };
  const { rows } = await client.query<{ hash: string | null }>(`
    select md5(coalesce(string_agg(md5(${row}), '' order by ${orderBy}), '')) as hash
    from "zz"."${relation}" t
  `);
  return { count, hash: rows[0].hash ?? "", present: true };
}

/**
 * One snapshot per table `SCHEMA_TARGET` names — plus every table a pending migration declares,
 * since a dropped table is not in the target any more and is exactly what the before side must
 * still read. Hashed the way `pendingMigrations`' expectations ask for, and read on the side
 * `side` names: the before side uses `was` to find a renamed table's old relation, and the after
 * side reads it under the target's name.
 */
export async function captureSnapshot(
  client: pg.Client,
  pendingMigrations: readonly string[],
  side: SnapshotSide,
): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const name of declaredTableNames(pendingMigrations)) {
    const exp = foldedTableExpectation(name, pendingMigrations);
    const relation = side === "before" ? exp.was ?? name : name;
    snapshot[name] = await snapshotTable(client, relation, exp.hashColumns, exp.contentHash === "skip");
  }
  return snapshot;
}
