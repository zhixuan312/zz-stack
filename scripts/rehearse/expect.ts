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
  for (const migration of pendingMigrations) {
    const exp = MIGRATION_EXPECTATIONS[migration]?.tables?.[table];
    if (!exp) continue;
    if (exp.count !== undefined) count = exp.count;
    if (exp.contentHash !== undefined) contentHash = exp.contentHash;
    if (exp.hashColumns !== undefined) hashColumns = exp.hashColumns;
    if (exp.was !== undefined) was = exp.was;
    if (exp.dropped !== undefined) dropped = exp.dropped;
  }
  return { count, contentHash, hashColumns, was, dropped };
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
 * What `002_delivery_telemetry.sql` is expected to move. Every hash lists only columns that exist
 * on both sides of the migration, and omits every column the migration owns — the ones it adds,
 * renames, or fills from another source — because a digest carrying them would differ for that
 * reason alone rather than proving the rest of the row survived.
 */
export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_delivery_telemetry.sql": {
    tables: {
      // The rename and the reshape, so its count is compared as one table rather than as a
      // removal and an addition, and the count is asserted equal: "every run kept" is the claim
      // this declaration exists to produce, and a count that may differ by any amount makes it
      // decorative. The one legitimate exception is `delete from zz.skill_run where team_id is
      // null` (`002_delivery_telemetry.sql:68`) — a run that resolves no team cannot satisfy
      // `team_id not null`. That delete matches 0 rows on the 0.82.0 backup, so the count is
      // unchanged there (743 -> 743), and if a count line ever fails, the migration's own `raise
      // notice` names the delete and how many rows it took. No hash: `team_id` is derived and
      // `ended_at` is filled, so the rows the migration keeps are not the rows it was given.
      skill_run: { count: "unchanged", contentHash: "skip", was: "run" },
      // Everything the migration leaves alone. It adds four columns, drops six, fills `run_id`,
      // `session`, `actor_id`, `initiative_id` and `skill_version_id` from the rows that remain —
      // none of which is in this list — and re-fills `duration_ms` and `response_bytes` from the
      // detail bag for rows written before 2026-09-14 that carried the figure in the bag only
      // (`002_delivery_telemetry.sql:150-154`; 2,684 `ms` rows and 2,728 `bytes` rows on the 0.82.0
      // backup). Those two are the migration's own columns here, so they are out of the digest: a
      // digest carrying them would differ for that reason alone. `request_bytes` stays: the
      // migration never writes it.
      event: {
        hashColumns: [
          "ts", "kind", "subject", "detail", "ok", "refusal", "refusal_owner", "request_bytes",
          "batched", "plugin", "plugin_version", "tool_key",
        ],
      },
      // `note` becomes `error`, and its value moves with it — neither is hashable on both sides.
      model_call: {
        hashColumns: [
          "id", "ts", "purpose", "model", "input_tokens", "output_tokens", "cache_read_tokens",
          "duration_ms", "ok", "attempts",
        ],
      },
      // `team_id`, `initiative_id` and `model_call_id` are new, and `asked_by` changes from an
      // email to a principal id — the four columns the migration owns.
      assessment: {
        hashColumns: [
          "id", "family", "instruction_version", "question_digest", "reading", "probability",
          "resolved_model", "identity_assurance", "reason", "about", "asked_at",
          "evaluator_version_id", "distribution", "answer_kind",
        ],
      },
      // A fact whose slugs resolve to no initiative cannot satisfy `initiative_id not null` and
      // is dropped, and `id` is gone, so only the count is meaningful — and only as "any".
      initiative_fact: { count: "any", contentHash: "skip" },
      // Everything but the identity columns the migration resolves: `reported_by` and
      // `resolved_by` become principal references, and `team_id`, `initiative_id` and
      // `duplicate_of` are new. `reported_at` is the report's own timestamp, unchanged.
      bug: {
        hashColumns: [
          "title", "detail", "surface", "platform_version", "impact", "status", "resolution",
          "resolved_at", "reported_at",
        ],
      },
      // Dropped whole. Declared, not hashed: there is no after side to compare them with.
      decision: { dropped: true },
      discussion_message: { dropped: true },
    },
    joins: [
      {
        name: "an attributed event's run belongs to the event's team",
        violatingCount:
          "select count(*)::int as n from zz.event e join zz.skill_run r on r.id = e.run_id where e.team_id is distinct from r.team_id",
      },
      {
        name: "a bug's team and initiative agree",
        violatingCount:
          "select count(*)::int as n from zz.bug b join zz.initiative i on i.id = b.initiative_id where b.team_id is distinct from i.team_id",
      },
      {
        name: "every fact's initiative exists",
        violatingCount:
          "select count(*)::int as n from zz.initiative_fact f left join zz.initiative i on i.id = f.initiative_id where i.id is null",
      },
    ],
  },
  // The run the timer invented, deleted. `skill_run` is named here so this migration's count wins
  // over `"002_delivery_telemetry.sql"`'s `"unchanged"` — the fold takes the last migration to name
  // a table — and the two together move it by exactly one row: the run whose evidence names no
  // skill version, which is the same row as the one whose stamped version postdates it. Everything
  // else in the backup is untouched, and the join below is what says the deletion was complete
  // rather than merely that it ran.
  "003_a_run_the_timer_invented.sql": {
    tables: {
      skill_run: { count: { delta: -1 }, contentHash: "skip", was: "run" },
    },
    joins: [
      {
        name: "every run's evidence names a skill version released no later than the run",
        violatingCount:
          "select count(*)::int as n from zz.skill_run r where not exists (select 1 from zz.event e where e.run_id = r.id and e.skill_version_id is not null) or exists (select 1 from zz.skill_version v where v.id = r.skill_version_id and v.released_at > r.started_at)",
      },
    ],
  },
};
