/**
 * The schema this checkout declares, as delivered through the current phase of the approved
 * spec (`2026-09-21-schema-first-principles-review`). `checks/schema-inventory.ts` fails the gate
 * when a database migrated from `services/gateway/migrations/` differs from it in any table,
 * column, key, foreign key, check, index or comment. `SCHEMA.md` states the rules it follows.
 *
 * Edited by hand, one area file per subject under `schema-target/`: a change is declared here
 * first and the migration is written to match it — never regenerated from a migrated catalog,
 * because a target derived from what it checks proves nothing. To see how PostgreSQL renders a
 * type, check or index, `node scripts/schema-target-extract.ts <table>…` prints the entries of a
 * database built from this checkout's migrations. `schema_migration` and the `search_*_default`
 * partitions are not design tables and are not listed.
 */
import type { SchemaTarget } from "./scripts/schema/types.ts";
import { IDENTITY } from "./schema-target/identity.ts";
import { SIGN_IN } from "./schema-target/sign-in.ts";
import { DELIVERY } from "./schema-target/delivery.ts";
import { KNOWLEDGE } from "./schema-target/knowledge.ts";
import { TELEMETRY } from "./schema-target/telemetry.ts";
import { CATALOG } from "./schema-target/catalog.ts";
import { EVAL_LEGACY } from "./schema-target/eval-legacy.ts";
import { EVAL_PROTOCOL } from "./schema-target/eval-protocol.ts";
import { EVAL_OBSERVE } from "./schema-target/eval-observe.ts";
import { EVAL_RUN } from "./schema-target/eval-run.ts";
import { IMPROVE } from "./schema-target/improve.ts";
import { CONTROL } from "./schema-target/control.ts";
import { ARTIFACT } from "./schema-target/artifact.ts";
import { SEARCH } from "./schema-target/search.ts";

export const SCHEMA_TARGET: SchemaTarget = {
  phase: 0,
  tables: { ...IDENTITY, ...SIGN_IN, ...DELIVERY, ...KNOWLEDGE, ...TELEMETRY, ...CATALOG, ...EVAL_LEGACY, ...EVAL_PROTOCOL, ...EVAL_OBSERVE, ...EVAL_RUN, ...IMPROVE, ...CONTROL, ...ARTIFACT, ...SEARCH },
};
