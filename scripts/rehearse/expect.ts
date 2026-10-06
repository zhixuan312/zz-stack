/**
 * What each pending migration is expected to change — data, not code, so `scripts/rehearse.ts`
 * reads the intent someone wrote down instead of re-deriving it from the diff itself.
 *
 * Keyed by migration file name, exactly as `zz.schema_migration` and
 * `services/gateway/migrations/` name it. A table a pending migration does not mention here — and
 * every table when no migration is pending at all — defaults to: row count unchanged, and the
 * `md5` over its primary-key-ordered rows unchanged. A migration that changes a table's shape or
 * its data declares that table explicitly; everything else stays proven unchanged rather than
 * silently unchecked.
 */

import { SCHEMA_TARGET } from "../../schema-target.ts";

/**
 * `"unchanged"` (the default): row count must be identical before and after.
 * `{ delta: n }`: row count must have moved by exactly `n` (negative allowed, e.g. a migration
 * that deletes rows).
 * `"any"`: row count is not checked at all — the migration is expected to change it
 * unpredictably (e.g. a backfill driven by production data).
 */
export type CountExpectation = "unchanged" | "any" | { delta: number };

interface TableExpectation {
  /** Default: `"unchanged"`. */
  count?: CountExpectation;
  /** Default: `"unchanged"`. `"skip"` when the table is reshaped wholesale and no fixed column
   *  list survives to hash — every row deleted, or a backfill whose result only the data knows. */
  contentHash?: "unchanged" | "skip";
  /**
   * The columns the content hash is taken over, when the migration reshapes the table: only
   * columns that exist before and after, so the one query reads the same values on both sides.
   * Default: the whole row — a table the migration does not reshape hashes unchanged in every
   * column, and a table it reshapes without declaring this hashes differently, which is exactly
   * the disagreement the rehearsal exists to surface.
   */
  hashColumns?: string[];
  /**
   * The table's name before the migration, when the migration renames it. The before snapshot
   * reads this relation and files it under the target's name, so the rename is one line in the
   * report rather than a table removed and another added.
   */
  was?: string;
  /**
   * The migration drops this table. It is present before and absent after, and that is declared
   * rather than hashed: the content is gone on the after side, so there is nothing to compare it
   * with. Count and `contentHash` are ignored when this is set.
   */
  dropped?: boolean;
  /**
   * The migration creates this table: it is absent before and present after, so there is no
   * before side to compare a count or a hash with, and the count it holds is a property of the
   * data the migration wrote rather than of anything that survived it.
   *
   * DELIBERATE: `scripts/rehearse/diff.ts` honours this field — a table declared created that was
   * present before the migration, or absent after it, is reported as a disagreement. Phase 3 was
   * the first to create tables rather than reshape them, and so the first to declare one; no
   * pending migration declares one today.
   */
  added?: boolean;
}

export interface JoinExpectation {
  /** Named for the report line; never interpolated into SQL. */
  name: string;
  /** A query against the migrated database returning exactly one row with one integer column
   *  named `n`: the count of rows that violate the join. The expectation holds when it is 0. */
  violatingCount: string;
}

interface MigrationExpectation {
  tables?: Record<string, TableExpectation>;
  joins?: JoinExpectation[];
}

/**
 * The expectations of every pending migration, folded together — the last migration to name a
 * table wins over an earlier one naming the same table, the same "later entry overrides" rule a
 * single map would give for free, kept explicit because this is folding several maps rather than
 * reading one. `hashColumns` is `null` when nothing declared a column list: the whole row.
 */
export interface FoldedExpectation {
  count: CountExpectation;
  contentHash: "unchanged" | "skip";
  hashColumns: string[] | null;
  /** `null` unless a pending migration declares the table renamed. */
  was: string | null;
  dropped: boolean;
  /** `true` when a pending migration creates the table. See `TableExpectation.added`. */
  added: boolean;
}

export function foldedTableExpectation(
  table: string,
  pendingMigrations: readonly string[],
): FoldedExpectation {
  let count: CountExpectation = "unchanged";
  let contentHash: "unchanged" | "skip" = "unchanged";
  let hashColumns: string[] | null = null;
  let was: string | null = null;
  let dropped = false;
  let added = false;
  for (const migration of pendingMigrations) {
    const exp = MIGRATION_EXPECTATIONS[migration]?.tables?.[table];
    if (!exp) continue;
    if (exp.count !== undefined) count = exp.count;
    if (exp.contentHash !== undefined) contentHash = exp.contentHash;
    if (exp.hashColumns !== undefined) hashColumns = exp.hashColumns;
    if (exp.was !== undefined) was = exp.was;
    if (exp.dropped !== undefined) dropped = exp.dropped;
    if (exp.added !== undefined) added = exp.added;
  }
  return { count, contentHash, hashColumns, was, dropped, added };
}

/**
 * Every table name any pending migration declares, in the order the target names its own and
 * then the ones only a migration names — a dropped table is not in the target any more, and a
 * migration that removes it is exactly the thing this must still read on the before side.
 */
export function declaredTableNames(pendingMigrations: readonly string[]): string[] {
  const names = new Set(Object.keys(SCHEMA_TARGET.tables));
  for (const migration of pendingMigrations) {
    for (const table of Object.keys(MIGRATION_EXPECTATIONS[migration]?.tables ?? {})) names.add(table);
  }
  return [...names];
}

/**
 * What each pending migration is expected to move, keyed by its filename. A release's migrations
 * fold back into `001_init.sql` once they are verified in production, and their entries here go
 * with them: the pending files are gone, so there is no before->after pair left to declare, and a
 * key naming a file that no longer exists would make the rehearsal look up an expectation nothing
 * can satisfy. What is declared here is the migrations `services/gateway/migrations/` holds today.
 *
 * Every hash lists only columns that exist on both sides of a migration, and omits every column
 * the migration owns — the ones it adds, renames, fills from another source or deletes rows by —
 * because a digest carrying them would differ for that reason alone rather than proving the rest
 * of the row survived. `scripts/rehearse.ts:142` looks a migration up here BY FILENAME.
 *
 * COUPLED: `002_catalog_evaluation.sql` folded back here once release 0.84.0 was verified in
 * production, and what it declared went with it — the tables it reshaped, the seven joins that
 * said its deletions and its bindings were exactly the rows it named, and the artifact step that
 * proved the legacy family was archived before it was dropped. Those steps ran against the
 * 0.83.2 backup and are in git history with the migration.
 *
 * COUPLED: `002_improve_control.sql` folded back here once release 0.85.0 was verified in
 * production, and what it declared went with it — the tables it reshaped, the two relations it
 * turned into tables, and the six joins that said its probe litter left and everything else
 * stayed integral. Those steps ran against the 2026-09-27 backup and are in git history with the
 * migration.
 *
 * COUPLED: `002_remove_artifact_layer.sql` folded back here once release 0.86.2 was verified in
 * production, and what it declared went with it — the thirteen tables and three partitions it
 * dropped, the reshape of `knowledge_node` under its own `id`, the new `knowledge_node_evidence`,
 * and the three joins that said every node's address split into a numeric ordinal and a non-empty
 * slug, every lifecycle agreed with the successor it resolved to, and every citation named a node
 * and an initiative that exist. Those joins ran against the 2026-09-27 backup and every one
 * returned zero violating rows, which is what made the fold safe to take.
 *
 * COUPLED: the store phase's three entries went the same way once their files folded into
 * `001_init.sql` — `002_database_store.sql` (the two tables the row store is built from),
 * `003_store_data.sql` (the one it reshapes, the three joins that said the carry had changed
 * nothing it did not name, and the artifact step that ran the carry itself) and
 * `005_initiative_record.sql` (the one table that release CREATES rather than reshapes, a shape
 * only a declaration can satisfy). The carry those entries drove is gone with them: it read a
 * team's file store, that volume is retired, and a migration that needs an artifact step again
 * declares one here rather than leaving a path nothing can reach.
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  // The document-versions release. It reshapes three tables by adding columns and deletes no row,
  // so each keeps its count and hashes unchanged over the columns it had before — the added ones
  // (`version`, `current_version`, `content_generation`, `linked_by`) are this file's own and are
  // left out of the digest. The two tables it creates are declared added. On `zz.event` it adds an
  // index and restates the table's comment, which move no row, so `event` is deliberately not named
  // here: its default — count and every column hashed unchanged — is exactly what the file claims.
  // This entry leaves with the file when it folds into `001_init.sql`.
  "002_document_versions.sql": {
    tables: {
      doc: {
        hashColumns: ["path", "type", "status", "updated_at", "body_tsv", "body", "title", "tags",
                      "content_hash", "created_at", "id", "initiative_id", "analyzer_version",
                      "current_revision", "approved_revision"],
      },
      doc_revision: {
        hashColumns: ["doc_id", "revision", "content_state", "title", "body", "tags", "content_hash",
                      "written_by", "written_at", "revision_note", "approved_by", "approved_at",
                      "fields", "presented_at"],
      },
      doc_link: {
        hashColumns: ["from_doc_id", "from_revision", "to_doc_id", "to_revision", "kind"],
      },
      doc_request: { added: true },
      cause_link_epoch: { added: true },
    },
    joins: [
      // The backfill copies a value every row already has under a new name: until this file every
      // revision was a public version, so the two numbers are equal on every existing row.
      {
        name: "every existing doc_revision's version is its revision",
        violatingCount: `select count(*)::int as n from zz.doc_revision r
          where r.version is distinct from r.revision`,
      },
      {
        name: "every doc's current_version is its current_revision",
        violatingCount: `select count(*)::int as n from zz.doc d
          where d.current_version is distinct from d.current_revision`,
      },
      // A link filed before this file has no origin recorded; one with an origin is a cause, and no
      // cause existed before the release that records them.
      {
        name: "no existing doc_link carries an origin",
        violatingCount: `select count(*)::int as n from zz.doc_link l where l.linked_by is not null`,
      },
      // The epoch is the instant this file ran, written once by it.
      {
        name: "cause_link_epoch holds exactly one row",
        violatingCount: `select abs(count(*) - 1)::int as n from zz.cause_link_epoch`,
      },
    ],
  },
};
