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
   * the first to create tables rather than reshape them, and so the first to declare one;
   * phase 4's `002_improve_control.sql` declares two, because it creates the relation tables
   * `improvement_run_finding` and `release_attempt_owner`.
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
 * What each pending migration is expected to move, keyed by its filename. Empty whenever a
 * release's migrations have folded back into `001_init.sql`: the pending files are gone, so there
 * is no before->after pair left to declare, and a key naming a file that no longer exists would
 * make the rehearsal look up an expectation nothing can satisfy.
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
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  /**
   * `002_improve_control.sql` — group G, and the chain-check probe litter.
   *
   * Two of the tables it touches change their row count by an amount only the data knows: every
   * `control_run` whose initiative does not exist is probe litter and leaves with its evidence and
   * waivers, and the number of those is a fact about the day's production, not about this
   * migration. They declare `count: "any"` and skip the hash for the same reason a deleted row
   * makes a whole-table digest meaningless; the joins below are what say the removal was exactly
   * the litter and that what survived is integral. Every other table it touches keeps its count,
   * and the hash over the columns it does not own is taken on both sides.
   *
   * `eval_finding` deliberately declares no `count`: `002_catalog_evaluation.sql` already declares
   * the eleven rows it deletes, and the fold lets the LAST declaration win — so a count here would
   * override that one and then disagree with the database whenever both migrations are pending,
   * which is every rehearsal until this phase is folded back.
   *
   * `improvement_run_finding` and `release_attempt_owner` are created by this migration.
   */
  "002_improve_control.sql": {
    tables: {
      // `eval_id`, `scope`, `docs_affected`, `proposed_change` and `resulted_in_skill_version_id`
      // go, and three of the surviving columns are rewritten: `decided_by` becomes a principal id,
      // `owner_ref` is nulled where the owner is the plugin itself, and a strength's `decision` is
      // nulled. No hash, for the same reason as `control_evidence` below: the eleven legacy rows
      // are deleted before this migration runs, so a digest over the surviving rows is taken over
      // a different set of rows on each side and differs by the deletion alone. The two joins that
      // name this table are what carry its integrity.
      eval_finding: { contentHash: "skip" },
      // `finding_ids` becomes rows in `improvement_run_finding`; the run's own facts must hold.
      improvement_run: { hashColumns: ["id", "eval_run_id", "created_at"] },
      improvement_run_finding: { added: true },
      // `base_subject_version_id` is renamed, `patchset`, `touched_owners` and `proposer_identity`
      // go, and `patch`, `proposed_by` and `proposer_client` are derived from them. The columns
      // both sides carry must hold — and the renamed one is left out, because it does not exist
      // under one name on both sides.
      candidate: {
        hashColumns: [
          "id", "improvement_run_id", "hypothesis", "expected_effect", "patch_digest",
          "complexity_delta", "touched_components", "status", "created_at", "build_requested_at",
          "build_requested_by", "build_result", "build_recorded_at",
        ],
      },
      // The released subject version is renamed and the verdict moves out of `verification`, so
      // neither is hashed; the attempt's own lifecycle facts must hold.
      release_attempt: {
        hashColumns: [
          "id", "candidate_id", "status", "release_ref", "created_at", "reason", "plugin_id",
          "applying_at",
        ],
      },
      release_attempt_owner: { added: true },
      // Every run whose initiative does not exist is deleted, with its evidence — see the entry's
      // own doc. Nothing else about either table is comparable across the removal.
      control_run: { count: "any", contentHash: "skip" },
      control_evidence: { count: "any", contentHash: "skip" },
      // No column moves and no row is touched: the whole row must hash identically, which is what
      // says the sweep took only the runs it named and left every waiver where it was.
      control_waiver: {},
    },
    joins: [
      {
        // The litter is gone: no surviving run names an initiative that does not exist. This is
        // the spec's criterion read back as a count rather than as a list of names.
        name: "every control run names an initiative that exists",
        violatingCount:
          "select count(*)::int as n from zz.control_run r where not exists (select 1 from zz.initiative i where i.id = r.initiative_id)",
      },
      {
        // `entry_id` is the kernel's matching key, and it identified 217 rows across 93 groups
        // before this migration re-identified them.
        name: "every fact of a run is identified once inside it",
        violatingCount:
          "select count(*)::int as n from (select run_id, entry_id from zz.control_evidence group by 1, 2 having count(*) > 1) d",
      },
      {
        // A withdrawal resolves inside its own run and to an entry that precedes it, which is what
        // makes the kernel's order-independent withdrawn set correct.
        name: "every withdrawal names an earlier entry of its own run",
        violatingCount: `
          select count(*)::int as n
            from zz.control_evidence e
           where e.supersedes is not null
             and not exists (select 1 from zz.control_evidence o
                              where o.run_id = e.run_id and o.entry_id = e.supersedes and o.seq < e.seq)`,
      },
      {
        // An approval names the document entry current at its own seq, so a revision withdraws the
        // approval it replaced rather than every approval of that path.
        name: "every approval names the document entry current at its own seq",
        violatingCount: `
          select count(*)::int as n
            from zz.control_evidence e
           where e.kind = 'approval'
             and not exists (select 1 from zz.control_evidence d
                              where d.run_id = e.run_id and d.kind = 'document'
                                and d.entry_id = e.about and d.seq <= e.seq)`,
      },
      {
        // The plugin is reachable through the run, so a plugin-owned finding keeps no copy of it.
        name: "no plugin-owned finding carries an owner reference",
        violatingCount:
          "select count(*)::int as n from zz.eval_finding where owner_kind = 'plugin' and owner_ref is not null",
      },
      {
        // A strength is what is working, not open work: it carries no decision, and everything
        // else carries one — `deferred` included, which is what the column means while open.
        name: "a strength carries no decision and every other finding carries one",
        violatingCount: `
          select count(*)::int as n from zz.eval_finding
           where (kind = 'strength' and decision is not null)
              or (kind is distinct from 'strength' and decision is null)`,
      },
    ],
  }
};
