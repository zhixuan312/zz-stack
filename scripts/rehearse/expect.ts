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
import type pg from "pg";

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

interface JoinExpectation {
  /** Named for the report line; never interpolated into SQL. */
  name: string;
  /** A query against the migrated database returning exactly one row with one integer column
   *  named `n`: the count of rows that violate the join. The expectation holds when it is 0. */
  violatingCount: string;
}

interface MigrationExpectation {
  tables?: Record<string, TableExpectation>;
  joins?: JoinExpectation[];
  /**
   * A phase step that needs the unpacked artifact store rather than the database — given the
   * directory `scripts/rehearse.ts` unpacked `--artifacts` into, and the migrated client, and
   * returning its own diff lines (empty means it held). Declared per migration, so a future
   * migration that touches the file store names what it needs without `scripts/rehearse.ts`
   * knowing anything about artifacts itself. None declared today.
   */
  withArtifacts?: (artifactsDir: string, client: pg.Client) => Promise<string[]>;
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
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_remove_artifact_layer.sql": {
    tables: {
      // The thirteen projections of a `.zz/commits` record no live store carries, plus the three
      // `search_*_default` partitions their parents take with them. Declared `dropped` rather than
      // hashed: a table the migration removes is present before and absent after, and content that
      // is gone on one side has nothing to compare against. The migration refuses to start if any
      // of them holds a row, so the presence half of this expectation is the proof there was no
      // data disposition to make.
      artifact: { dropped: true },
      artifact_revision: { dropped: true },
      artifact_event: { dropped: true },
      artifact_edge: { dropped: true },
      artifact_passage: { dropped: true },
      artifact_identifier: { dropped: true },
      artifact_projection_commit: { dropped: true },
      artifact_projection_watermark: { dropped: true },
      doc_artifact: { dropped: true },
      knowledge_node_artifact: { dropped: true },
      search_current: { dropped: true },
      search_evidence: { dropped: true },
      search_history: { dropped: true },

      // Reshaped, not rebuilt: every row survives under its own `id` and keeps its kind, lifecycle,
      // title, body, lexemes, tags, hash and both timestamps. The four columns the migration owns —
      // `team_id`, `node_ordinal`, `slug` and `superseded_by_id` — are left out of the digest, along
      // with the four it drops, so the hash says "the rest of the row is untouched" rather than
      // differing for the reason the migration exists. The count stays `unchanged` and is what says
      // the rows were carried.
      knowledge_node: {
        hashColumns: ["id", "kind", "lifecycle", "title", "body", "body_tsv", "tags",
                      "content_hash", "created_at", "updated_at", "analyzer_version"],
      },

      // Created by this migration, so there is no before side to compare a count or a hash with,
      // and the count it holds is a property of the arrays it was expanded from.
      knowledge_node_evidence: { added: true },
    },
    joins: [
      {
        // The address became two columns, and a split that produced an empty ordinal or an empty
        // slug would be a node nobody can address again. The migration refuses a path it cannot
        // split, so this asserts the refuse did not become a truncate.
        name: "every node's file address split into a numeric ordinal and a non-empty slug",
        violatingCount:
          "select count(*)::int as n from zz.knowledge_node where node_ordinal !~ '^[0-9]+$' or slug = ''",
      },
      {
        // The lifecycle check is on the RESOLVED key, which is the spec's wording: a node that says
        // it was superseded must name the row that superseded it. The migration's second pass is the
        // only writer of that key, so a row where the two disagree is a successor that did not
        // resolve or one that resolved to the wrong shelf.
        name: "a node's lifecycle agrees with the successor it resolved to",
        violatingCount:
          "select count(*)::int as n from zz.knowledge_node "
          + "where (lifecycle = 'superseded') <> (superseded_by_id is not null)",
      },
      {
        // The citations moved out of a slug array into rows. A slug is team-scoped and an id is not,
        // so this is the join that says the preference rule picked a real initiative every time
        // rather than writing a citation that names nothing.
        name: "every citation names a node and an initiative that exist",
        violatingCount:
          "select count(*)::int as n from zz.knowledge_node_evidence e "
          + "where not exists (select 1 from zz.knowledge_node k where k.id = e.node_id) "
          + "or not exists (select 1 from zz.initiative i where i.id = e.initiative_id)",
      },
    ],
  },
};
