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
import { carryStore, verifyStore } from "../store-migration.ts";
import { formatReport } from "../store-migration/report.ts";
import type { Queryable } from "../store-migration/model.ts";

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
 *
 * COUPLED: `002_remove_artifact_layer.sql` folded back here once release 0.86.2 was verified in
 * production, and what it declared went with it — the thirteen tables and three partitions it
 * dropped, the reshape of `knowledge_node` under its own `id`, the new `knowledge_node_evidence`,
 * and the three joins that said every node's address split into a numeric ordinal and a non-empty
 * slug, every lifecycle agreed with the successor it resolved to, and every citation named a node
 * and an initiative that exist. Those joins ran against the 2026-09-27 backup and every one
 * returned zero violating rows, which is what made the fold safe to take.
 *
 * The map is no longer empty: the phase-6 store migration is pending, and it declares the two
 * tables it creates, the one it reshapes and the three joins that say what it did to the data — the
 * answer being "nothing", which is the claim `doc`'s entry has to make precisely. Beside it the
 * phase's second migration carries the legacy evaluation pins, and it is the first entry since
 * Phase 0 to declare a `withArtifacts` step: the carry that writes `doc_revision` from every team's
 * store reads the file store rather than the database, so `scripts/rehearse.ts` unpacks `--artifacts`
 * and the step runs there.
 *
 * COUPLED: the phase's third entry is `005_initiative_record.sql`'s, for the one table the release
 * CREATES rather than reshapes. It was missing through waves 1-8 and the phase-end rehearsal is what
 * found it: every other pending migration adds columns or drops them, which the default expectation
 * already covers, and a created table is the one shape only a declaration can satisfy.
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_database_store.sql": {
    tables: {
      // Both are created here and hold no row when this file is done: the carry that fills them from
      // the teams' stores is a later migration's, and `added` is the only expectation that says so —
      // a count would be a claim about rows this file may not write.
      doc_revision: { added: true },
      doc_link: { added: true },
      // `doc` is NOT declared added, dropped or moved: every row it has survives untouched, and what
      // changes is its shape. `current_revision` and `approved_revision` are the migration's own
      // columns — they are null on every existing row — so they are the two a digest leaves out.
      //
      // DELIBERATE, and the one weakness in this file: `doc`'s content is NOT hashed, because this
      // migration changes the key the digest is ORDERED by. `scripts/rehearse/snapshot.ts:95` orders
      // each side by the LIVE primary key — on the before side `(team_slug, initiative, path)`, on
      // the after side `(id)` — so the same rows concatenate in a different order and the two MD5s
      // differ for that reason alone. `contentHash: "unchanged"` cannot pass here on a correct
      // migration, and the two digests were measured to be the ordering's doing and nothing else:
      // over the 2026-09-27 backup's 1,472 rows, `doc`'s 24 pre-existing columns hash to
      // `aa097b3e651e65e06558cdbe5f39bf05` on BOTH sides when ordered by `(team_slug, initiative,
      // path)`, and to `0d3faec954e940e200d902374fc5d635` on BOTH sides when ordered by `id` — no
      // column of any row differs, only the order the two sides read them in.
      //
      // The one-line change that would let this be declared rather than described is in
      // `snapshot.ts:95`: order by the declared `hashColumns` when a migration declares them (they
      // exist on both sides by definition, and a list carrying the row's own id is a total order),
      // falling back to the live key otherwise. Measured: with both sides ordered by the 24 declared
      // columns the digest is `aa097b3e651e…` on each, so the declaration below becomes
      // `hashColumns: [<the 24>]` with `contentHash` unchanged. It is named here rather than applied
      // because `snapshot.ts` belongs to no phase-6 task.
      doc: { contentHash: "skip" },
    },
    joins: [
      // The tightened key points where the store's own slug pair points. This file tightens
      // `doc.initiative_id` to `not null` and changes its delete action; the column's VALUE is the
      // carry's business, and this is the join that says the two addresses agree rather than that the
      // constraint is satisfied — a foreign key cannot be violated, and a row keyed to the wrong
      // initiative of the same team violates nothing.
      // REMOVED, and why: this asserted that the `initiative_id` the migration RESOLVED from
      // `doc`'s `(team_slug, initiative)` named the initiative those columns meant to. Its subject
      // is gone — `007_drop_legacy_store.sql` drops both — so the resolution it checked has already
      // happened and cannot be re-read from the row. What remains is the foreign key, which
      // enforces that the id names a real initiative; it cannot say the RIGHT one, and no join can
      // any more. Recorded rather than deleted silently, because a join that stopped being run is
      // indistinguishable from one that passes.
      // The two revision keys name a revision that exists. Vacuously true here — this file writes no
      // row, so both columns are null on all of them — and it is declared anyway, because it is the
      // claim the carry that fills them has to keep and the rehearsal is where a later migration
      // meets it. A current revision with no row is a document whose content has no authority.
      {
        name: "every doc.current_revision names a revision of that document",
        violatingCount: `select count(*)::int as n from zz.doc d
          where d.current_revision is not null
            and not exists (select 1 from zz.doc_revision r
                             where r.doc_id = d.id and r.revision = d.current_revision)`,
      },
      {
        name: "every doc.approved_revision names a revision of that document",
        violatingCount: `select count(*)::int as n from zz.doc d
          where d.approved_revision is not null
            and not exists (select 1 from zz.doc_revision r
                             where r.doc_id = d.id and r.revision = d.approved_revision)`,
      },
    ],
  },
  "003_store_data.sql": {
    tables: {
      // `eval_protocol_version` gains one column and no row moves: it is the pin the carry resolves
      // from a frozen approval record, and this file adds the column, the composite key and the
      // tightened CHECK it lands in. `hashColumns` is therefore every column the table has on BOTH
      // sides — the fifteen below — and not the whole row: a digest carrying `approved_doc_revision`
      // would differ for that column's presence alone rather than proving the rest of the row
      // survived, which is what this file is being rehearsed for.
      //
      // `eval_assessment` is deliberately NOT declared. This file adds a CHECK and a composite key
      // to it and no column at all, and neither is part of a row's content, so its whole-row digest
      // is expected unchanged — the default, and the stronger claim of the two.
      eval_protocol_version: {
        hashColumns: [
          "id", "version", "purpose", "qualification_policy", "scoring_policy",
          "improvement_policy", "content_digest", "created_at", "plugin_id", "protocol_key",
          "observable_surfaces", "approved_doc_id", "affirmed_by", "affirmed_at", "recorded_by",
        ],
      },
    },
    // The store's own half, and the only hook a pending migration has for it. The carry reads every
    // team's working tree, its `_versions/` snapshots and its git history and writes `doc_revision`,
    // `doc_link` and the two legacy pins; then it proves what it wrote, file for row, by content
    // hash. The report it prints is the plan's `run:` evidence — documents read, revisions retained,
    // revisions marked `missing_legacy`, both pin counts, refusals — and what it returns is one line
    // per disagreement, so a carry that lost a byte fails the rehearsal rather than passing quietly.
    withArtifacts: async (artifactsDir, client) => {
      const db: Queryable = client;
      const report = await carryStore(db, artifactsDir);
      for (const line of formatReport(report)) console.log(`  ${line}`);
      return (await verifyStore(db, artifactsDir)).map((p) => `003_store_data.sql: ${p}`);
    },
  },
  "005_initiative_record.sql": {
    tables: {
      // `initiative_record` is CREATED here, and that is measured rather than assumed: the before
      // snapshot reads `zz.initiative_record` as absent — no earlier migration names the table and
      // the folded `001_init.sql` carries none — so the one shape the rehearsal can be handed is
      // absent-before/present-after, which is what `added` is for. Without this entry the run
      // reports "no expectation declares the table dropped or created" and the phase's own gate
      // cannot go green.
      //
      // The after side holds zero rows, and that is the data's business rather than this file's:
      // phase 6 fills the table through the live path (`writeStageRecord` in
      // `services/zz-core/src/initiative-record.ts`), not through a carry, so the count declares
      // nothing. What the `_records.json` files it replaces hold is verified where it is — the
      // carry's `records` count, against the rows each id already has.
      initiative_record: { added: true },
    },
  },
};
