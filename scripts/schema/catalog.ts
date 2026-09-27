/**
 * Reading a live `zz` schema into the `TableTarget` shape — the one catalog reader shared by
 * the extractor, the schema gate check and the rehearsal.
 *
 * Every table's PostgreSQL system catalogs are read straight off `pg_catalog`: no ORM, no
 * `information_schema` (which hides constraint deferrability, delete actions and the exact
 * `format_type`/`pg_get_*` rendering the target is compared byte for byte against). The
 * caller's client must already have run `set search_path = ''` — `withThrowawayDb` does this —
 * so every `pg_get_constraintdef`/`pg_get_indexdef` below renders `zz.*` fully qualified
 * regardless of whatever search_path a different session would have carried.
 *
 * DELIBERATE: `schema_migration` and the three `search_*_default` partitions are excluded here,
 * not by the caller — `readCatalog` is the one place that knows what counts as a design table,
 * and every caller gets the same 67.
 */
import type pg from "pg";

import type { ForeignKeyTarget, TableTarget } from "./types.ts";

const DELETE_ACTION: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

interface TableRow { oid: string; relname: string }
interface ColumnRow { name: string; type: string; nullable: boolean; default_expr: string | null }
interface KeyRow { conname: string; cols: string[] }
interface ForeignKeyRow {
  conname: string; ref_table: string; columns: string[]; ref_columns: string[];
  on_delete_columns: string[] | null; confdeltype: string; condeferrable: boolean;
}
interface DefRow { def: string }
interface CommentRow { attname: string; comment: string | null }

async function readTables(client: pg.Client): Promise<TableRow[]> {
  const { rows } = await client.query<TableRow>(`
    select c.oid::text as oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'zz'
      and c.relkind in ('r', 'p')
      and not c.relispartition
      and c.relname <> 'schema_migration'
    order by c.relname
  `);
  return rows;
}

async function readColumns(client: pg.Client, oid: string): Promise<TableTarget["columns"]> {
  const { rows } = await client.query<ColumnRow>(`
    select a.attname as name,
           format_type(a.atttypid, a.atttypmod) as type,
           not a.attnotnull as nullable,
           pg_get_expr(ad.adbin, ad.adrelid) as default_expr
    from pg_attribute a
    left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
    where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  `, [oid]);
  return rows.map((r) => [r.name, r.type, r.nullable, r.default_expr]);
}

async function readPrimaryKey(client: pg.Client, oid: string): Promise<string[] | null> {
  const { rows } = await client.query<{ attname: string }>(`
    select a.attname
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = $1 and c.contype = 'p'
    order by k.ord
  `, [oid]);
  return rows.length ? rows.map((r) => r.attname) : null;
}

// DELIBERATE: `attname::text` inside every `array_agg` below. `pg_attribute.attname` is
// PostgreSQL's `name` type, and `array_agg(name)` aggregates to `name[]` — an array type node-postgres
// has no default parser for, so it comes back as the driver's raw wire text (`"{a,b}"`) instead
// of a JS array. Casting to `text` first aggregates to `text[]`, which node-postgres does parse.
async function readUniques(client: pg.Client, oid: string): Promise<string[][]> {
  const { rows } = await client.query<KeyRow>(`
    select c.conname, array_agg(a.attname::text order by k.ord) as cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = $1 and c.contype = 'u'
    group by c.oid, c.conname
    order by c.conname
  `, [oid]);
  return rows.map((r) => r.cols);
}

// DELIBERATE: `on_delete_columns` is aggregated with a FILTER rather than read from
// `confdelsetcols` directly: `confdelsetcols` holds the referencing table's `attnum`s, and the
// target names columns. The lateral `unnest(c.conkey)` above already walks those attnums in key
// order, so filtering it to the set `confdelsetcols` names yields them in the order `columns` is
// in. `filter` returns null when the set is empty — an `on delete set null` that names nothing,
// or any other delete action — which is the key being absent.
async function readForeignKeys(client: pg.Client, oid: string): Promise<ForeignKeyTarget[]> {
  const { rows } = await client.query<ForeignKeyRow>(`
    select c.conname,
           rc.relname as ref_table,
           array_agg(la.attname::text order by k.ord) as columns,
           array_agg(ra.attname::text order by k.ord) as ref_columns,
           array_agg(la.attname::text order by k.ord)
             filter (where k.attnum = any (c.confdelsetcols)) as on_delete_columns,
           c.confdeltype,
           c.condeferrable
    from pg_constraint c
    join pg_class rc on rc.oid = c.confrelid
    cross join lateral unnest(c.conkey, c.confkey) with ordinality as k(attnum, refattnum, ord)
    join pg_attribute la on la.attrelid = c.conrelid and la.attnum = k.attnum
    join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.refattnum
    where c.conrelid = $1 and c.contype = 'f'
    group by c.oid, c.conname, rc.relname, c.confdeltype, c.condeferrable
    order by c.conname
  `, [oid]);
  return rows.map((r): ForeignKeyTarget => ({
    columns: r.columns,
    refTable: r.ref_table,
    refColumns: r.ref_columns,
    onDelete: DELETE_ACTION[r.confdeltype] ?? r.confdeltype,
    ...(r.on_delete_columns ? { onDeleteColumns: r.on_delete_columns } : {}),
    deferrable: r.condeferrable,
  }));
}

async function readChecks(client: pg.Client, oid: string): Promise<string[]> {
  const { rows } = await client.query<DefRow>(`
    select pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = $1 and c.contype = 'c'
    order by c.conname
  `, [oid]);
  return rows.map((r) => r.def);
}

async function readIndexes(client: pg.Client, oid: string): Promise<string[]> {
  // `and c.conrelid = i.indrelid` is load-bearing, and its absence was latent from Phase 0 until
  // Phase 3's migration added the first foreign key that references a NON-primary unique index on
  // another table. `conindid` is the index a constraint is built on — but for a FOREIGN KEY it is
  // the index on the table being REFERENCED, so `eval_protocol_version_approved_doc_id_fkey` and
  // `eval_assessment_doc_id_fkey` (both added by `002_catalog_evaluation.sql`, both referencing
  // `zz.doc(id)`) each had `conindid = doc_id_unique`'s index. Unscoped, the predicate then read
  // `doc_id_unique` — a plain unique index, not a constraint — as constraint-backed and dropped it
  // from `indexes`, so `checks/schema-inventory.ts` reported a target index the migrated catalog
  // plainly had. The database was right in every arrangement; the reader was wrong.
  const { rows } = await client.query<DefRow & { relname: string }>(`
    select pg_get_indexdef(i.indexrelid) as def, ic.relname
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = $1
      and not exists (select 1 from pg_constraint c
                       where c.conindid = i.indexrelid and c.conrelid = i.indrelid)
    order by ic.relname
  `, [oid]);
  return rows.map((r) => r.def);
}

async function readComments(client: pg.Client, oid: string): Promise<{ table: string | null; columns: Record<string, string> }> {
  const table = (await client.query<{ comment: string | null }>(
    "select obj_description($1::oid, 'pg_class') as comment", [oid],
  )).rows[0]?.comment ?? null;
  const { rows } = await client.query<CommentRow>(`
    select a.attname, col_description($1::oid, a.attnum) as comment
    from pg_attribute a
    where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  `, [oid]);
  const columns: Record<string, string> = {};
  for (const r of rows) if (r.comment !== null) columns[r.attname] = r.comment;
  return { table, columns };
}

/** The 67 design tables of whatever `zz` schema `client` is connected to, keyed by name. */
export async function readCatalog(client: pg.Client): Promise<Record<string, TableTarget>> {
  const tables = await readTables(client);
  const result: Record<string, TableTarget> = {};
  // Sequential, not `Promise.all`: a single `pg.Client` serves one query at a time, and
  // firing several at once against it only works by accident (and warns as much).
  for (const t of tables) {
    const columns = await readColumns(client, t.oid);
    const primaryKey = await readPrimaryKey(client, t.oid);
    const uniques = await readUniques(client, t.oid);
    const foreignKeys = await readForeignKeys(client, t.oid);
    const checks = await readChecks(client, t.oid);
    const indexes = await readIndexes(client, t.oid);
    const comments = await readComments(client, t.oid);
    result[t.relname] = {
      columns, primaryKey, uniques, foreignKeys, checks, indexes,
      comment: comments.table,
      columnComments: comments.columns,
    };
  }
  return result;
}
