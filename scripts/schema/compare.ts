/**
 * Compares a live catalog with `SCHEMA_TARGET`, one line per difference in either direction.
 * Read-only on the client it is given.
 */
import type pg from "pg";

import { SCHEMA_TARGET } from "../../schema-target.ts";
import { readCatalog } from "./catalog.ts";
import type { TableTarget } from "./types.ts";

function fmt(v: unknown): string {
  return JSON.stringify(v);
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function diffLine(table: string, what: string, targetVal: unknown, catalogVal: unknown): string {
  return `${table}: ${what} — target ${fmt(targetVal)}, catalog ${fmt(catalogVal)}`;
}

/** Every column present in only one side, plus every column present in both whose full tuple
 *  (type, nullable, default) differs — the shape the technical AC's proof-of-negative exercises. */
function diffColumns(table: string, t: TableTarget, c: TableTarget): string[] {
  const diffs: string[] = [];
  const tCols = new Map(t.columns.map((col) => [col[0], col] as const));
  const cCols = new Map(c.columns.map((col) => [col[0], col] as const));
  for (const [name, col] of tCols) {
    const other = cCols.get(name);
    if (!other) diffs.push(diffLine(table, `column ${name}`, col, "missing"));
    else if (differs(col, other)) diffs.push(diffLine(table, `column ${name}`, col, other));
  }
  for (const [name, col] of cCols) {
    if (!tCols.has(name)) diffs.push(diffLine(table, `column ${name}`, "missing", col));
  }
  return diffs;
}

/** The remaining collections of `TableTarget`, plus the two comment fields — each compared as
 *  a whole, since a difference inside any of them still names the table and the collection. */
function diffTable(table: string, t: TableTarget, c: TableTarget): string[] {
  const diffs = diffColumns(table, t, c);
  if (differs(t.primaryKey, c.primaryKey)) diffs.push(diffLine(table, "primary key", t.primaryKey, c.primaryKey));
  if (differs(t.uniques, c.uniques)) diffs.push(diffLine(table, "unique constraints", t.uniques, c.uniques));
  if (differs(t.foreignKeys, c.foreignKeys)) diffs.push(diffLine(table, "foreign keys", t.foreignKeys, c.foreignKeys));
  if (differs(t.checks, c.checks)) diffs.push(diffLine(table, "check constraints", t.checks, c.checks));
  if (differs(t.indexes, c.indexes)) diffs.push(diffLine(table, "indexes", t.indexes, c.indexes));
  // Comment metadata is compared exactly as the target declares it — the target carries a
  // comment only from the phase that adds it, so an un-annotated phase compares null to null
  // and a later phase's declared comments are enforced the same way columns are.
  if (differs(t.comment, c.comment)) diffs.push(diffLine(table, "comment", t.comment, c.comment));
  if (differs(t.columnComments, c.columnComments)) {
    diffs.push(diffLine(table, "column comments", t.columnComments, c.columnComments));
  }
  return diffs;
}

/** Pure: two `TableTarget` catalogs in, every difference out, in neither direction favoured —
 *  a table only the target has and a table only the migrated catalog has are both reported. */
function diffCatalogs(
  target: Record<string, TableTarget>,
  catalog: Record<string, TableTarget>,
): string[] {
  const diffs: string[] = [];
  const targetNames = Object.keys(target).sort();
  const catalogNames = new Set(Object.keys(catalog));
  for (const name of targetNames) {
    if (!catalogNames.has(name)) diffs.push(diffLine(name, "table", "present", "missing"));
  }
  const targetNamesSet = new Set(targetNames);
  for (const name of [...catalogNames].sort()) {
    if (!targetNamesSet.has(name)) diffs.push(diffLine(name, "table", "missing", "present"));
  }
  for (const name of targetNames) {
    const c = catalog[name];
    if (c) diffs.push(...diffTable(name, target[name], c));
  }
  return diffs;
}

/**
 * Reads `client`'s live catalog and compares it with `SCHEMA_TARGET`, read-only throughout.
 *
 * Shared by `checks/schema-inventory.ts` (a throwaway database the real runner built) and
 * `scripts/rehearse.ts` (a restored production copy in its own container).
 *
 * DELIBERATE: the search path is pinned for the read. `format_type`, `pg_get_indexdef`,
 * `pg_get_expr` and `pg_get_constraintdef` all render a schema-qualified name ONLY for an object
 * the current search path does not reach, so the same schema reads as `zz.citext` on a connection
 * that does not search `zz` and as `citext` on one that does — and the target is spelled the first
 * way. Comparing a deployment that reaches `zz` against the target as written would report five
 * differences that are one connection setting, which is the kind of noise that teaches a reader to
 * ignore the check. The throwaway picks an empty path for the same reason (`scripts/schema/
 * throwaway.ts`); pinning it here is what makes the two comparable, and it is restored afterwards
 * because the client belongs to the caller.
 */
export async function compareWithTarget(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ path: string }>("show search_path");
  const before = rows[0]?.path ?? null;
  await client.query("select set_config('search_path', '', false)");
  try {
    const catalog = await readCatalog(client);
    return diffCatalogs(SCHEMA_TARGET.tables, catalog);
  } finally {
    if (before !== null) await client.query("select set_config('search_path', $1, false)", [before]);
  }
}
