/**
 * Before/after facts about the design tables `SCHEMA_TARGET` names: a row count and an `md5`
 * over each table's primary-key-ordered rows — the same tables `compareWithTarget` checks the
 * shape of, checked here for content instead.
 *
 * `t::text` on the whole row renders every column of it, in the table's own column order, so the
 * hash moves if any column's value moves, not only the ones a query happens to select.
 */
import type pg from "pg";

import { SCHEMA_TARGET } from "../../schema-target.ts";
import type { TableTarget } from "../schema/types.ts";

interface TableSnapshot {
  count: number;
  hash: string;
}

export type Snapshot = Record<string, TableSnapshot>;

/** The primary key orders a table's rows deterministically when it has one; a table with none
 *  (none exist in `SCHEMA_TARGET` today) falls back to every column, which is still a total
 *  order over rows that are themselves distinct. */
function orderColumns(target: TableTarget): string[] {
  return target.primaryKey && target.primaryKey.length > 0
    ? target.primaryKey
    : target.columns.map(([name]) => name);
}

async function snapshotTable(client: pg.Client, table: string, target: TableTarget): Promise<TableSnapshot> {
  const orderBy = orderColumns(target).map((c) => `"${c}"`).join(", ");
  const { rows } = await client.query<{ count: string; hash: string | null }>(`
    select count(*)::text as count,
           md5(coalesce(string_agg(md5(t::text), '' order by ${orderBy}), '')) as hash
    from "zz"."${table}" t
  `);
  return { count: Number(rows[0].count), hash: rows[0].hash ?? "" };
}

/** One snapshot per design table `SCHEMA_TARGET` names, read off `client` as it stands right now. */
export async function captureSnapshot(client: pg.Client): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for (const [name, target] of Object.entries(SCHEMA_TARGET.tables)) {
    snapshot[name] = await snapshotTable(client, name, target);
  }
  return snapshot;
}
