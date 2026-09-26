/**
 * The frozen baseline catalog: 67 design tables, extracted by
 * `scripts/schema-target-extract.ts` from a fresh `services/gateway/migrations/001_init.sql`
 * run. `schema_migration` and the three `search_*_default` partitions are excluded — see
 * `scripts/schema/catalog.ts`.
 *
 * Do not edit by hand; regenerate with the extractor and let `--check` confirm the tree
 * still matches it.
 */
import type { SchemaTarget } from "./scripts/schema/types.ts";
import { TABLES_1 } from "./schema-target/part-1.ts";
import { TABLES_2 } from "./schema-target/part-2.ts";
import { TABLES_3 } from "./schema-target/part-3.ts";
import { TABLES_4 } from "./schema-target/part-4.ts";
import { TABLES_5 } from "./schema-target/part-5.ts";
import { TABLES_6 } from "./schema-target/part-6.ts";
import { TABLES_7 } from "./schema-target/part-7.ts";
import { TABLES_8 } from "./schema-target/part-8.ts";
import { TABLES_9 } from "./schema-target/part-9.ts";
import { TABLES_10 } from "./schema-target/part-10.ts";
import { TABLES_11 } from "./schema-target/part-11.ts";

export const SCHEMA_TARGET: SchemaTarget = {
  phase: 0,
  tables: { ...TABLES_1, ...TABLES_2, ...TABLES_3, ...TABLES_4, ...TABLES_5, ...TABLES_6, ...TABLES_7, ...TABLES_8, ...TABLES_9, ...TABLES_10, ...TABLES_11 },
};
