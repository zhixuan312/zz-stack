/**
 * One `TableTarget` rendered as the TypeScript literal an area file under `schema-target/`
 * holds for it — the same field order and quoting everywhere, so an entry pasted from
 * `scripts/schema-target-extract.ts` reads exactly like the entries beside it.
 */
import type { ForeignKeyTarget, TableTarget } from "./types.ts";

function quote(s: string): string {
  return JSON.stringify(s);
}

function propKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quote(k);
}

/** A JSON-shaped value (string, number, boolean, null, array or plain object) rendered as a TS
 *  literal. Object keys are written in the iteration order the caller gave them — this is what
 *  `orderedTable` below uses to fix the field order the contract lists. */
function serializeValue(v: unknown, indent: string): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return quote(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => `${inner}${serializeValue(x, inner)},`).join("\n")}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const items = entries.map(([k, val]) => `${inner}${propKey(k)}: ${serializeValue(val, inner)},`).join("\n");
  return `{\n${items}\n${indent}}`;
}

/** The contract's own field order — fixed here once, rather than left to `Object.keys` on
 *  whatever `catalog.ts` happened to build. */
function orderedTable(t: TableTarget): Record<string, unknown> {
  const fk = (f: ForeignKeyTarget) => ({
    columns: f.columns, refTable: f.refTable, refColumns: f.refColumns,
    onDelete: f.onDelete, deferrable: f.deferrable,
  });
  return {
    columns: t.columns,
    primaryKey: t.primaryKey,
    uniques: t.uniques,
    foreignKeys: t.foreignKeys.map(fk),
    checks: t.checks,
    indexes: t.indexes,
    comment: t.comment,
    columnComments: t.columnComments,
  };
}

/** `name: { … },` at the two-space indent of an area file's `Record<string, TableTarget>`. */
export function renderTable(name: string, t: TableTarget): string {
  return `  ${propKey(name)}: ${serializeValue(orderedTable(t), "  ")},`;
}
