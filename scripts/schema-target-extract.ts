#!/usr/bin/env node
/**
 * schema-target-extract — how PostgreSQL renders a table this checkout's migrations build.
 *
 *   node scripts/schema-target-extract.ts <table> [<table>…]
 *
 * Migrates a throwaway PostgreSQL 17 (`scripts/schema/throwaway.ts`) with every file in
 * `services/gateway/migrations/`, reads its catalog (`scripts/schema/catalog.ts`) and prints each
 * named table as the entry an area file under `schema-target/` holds for it. It writes nothing.
 *
 * The target is declared by hand from the spec and the migration is written to match it; this
 * exists so the hand-written entry spells a type, a check or an index exactly as PostgreSQL does
 * (`format_type`, `pg_get_constraintdef`, `pg_get_indexdef`), not to produce the target. Pasting
 * its output over an entry would make the inventory check compare the catalog with itself.
 *
 * Exit 0: every named table was printed. Exit 1: a table the migrated catalog does not have, or
 * no table named. Docker not running or a failing migration propagates from `withThrowawayDb`.
 */
import { readCatalog } from "./schema/catalog.ts";
import { renderTable } from "./schema/serialize.ts";
import { withThrowawayDb } from "./schema/throwaway.ts";

async function main(): Promise<number> {
  const names = process.argv.slice(2);
  if (!names.length) {
    console.error("usage: node scripts/schema-target-extract.ts <table> [<table>…]");
    return 1;
  }
  const catalog = await withThrowawayDb(readCatalog);
  const unknown = names.filter((n) => !catalog[n]);
  if (unknown.length) {
    console.error(`schema-target-extract: the migrated catalog has no table ${unknown.join(", ")}`);
    return 1;
  }
  for (const name of names) console.log(renderTable(name, catalog[name]));
  return 0;
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
