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
}

export function foldedTableExpectation(
  table: string,
  pendingMigrations: readonly string[],
): FoldedExpectation {
  let count: CountExpectation = "unchanged";
  let contentHash: "unchanged" | "skip" = "unchanged";
  let hashColumns: string[] | null = null;
  for (const migration of pendingMigrations) {
    const exp = MIGRATION_EXPECTATIONS[migration]?.tables?.[table];
    if (!exp) continue;
    if (exp.count !== undefined) count = exp.count;
    if (exp.contentHash !== undefined) contentHash = exp.contentHash;
    if (exp.hashColumns !== undefined) hashColumns = exp.hashColumns;
  }
  return { count, contentHash, hashColumns };
}

export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_identity_access.sql": {
    tables: {
      // The duplicate live bootstrap PAT is revoked in place, never deleted, and `revoked_at` is
      // the one column the migration owns — so every other column of every PAT must still hold
      // the value it held before, including on the row it revoked.
      pat: {
        hashColumns: [
          "id", "principal_id", "token_hash", "label", "team_id",
          "expires_at", "last_used_at", "created_at",
        ],
      },
      // `updated_at` is dropped; every other column of every principal — `active_team_id`
      // included, which the migration nulls only where it named no membership of that principal
      // (none today) — must still hold its value.
      principal: {
        hashColumns: [
          "id", "email", "display_name", "role", "status", "created_at", "active_team_id",
        ],
      },
      // `team_id` is added and backfilled from the principal's `active_team_id`; every other
      // column of every session must still hold its value.
      console_session: {
        hashColumns: [
          "id", "principal_id", "token_hash", "issued_at", "expires_at",
          "revoked_at", "last_seen_at", "user_agent", "ip",
        ],
      },
      // `issued_by` and `created_at` are dropped; the four columns that remain must hold.
      passkey_enrolment: {
        hashColumns: ["token_hash", "principal_id", "expires_at", "used_at"],
      },
      // `revoked_at` is added null on every row; the four original columns must hold.
      mcp_oauth_client: {
        hashColumns: ["client_id", "redirect_uris", "name", "created_at"],
      },
      // Ephemeral by contract — a challenge lives five minutes, a code ten — so every row is
      // deleted rather than aged into the new shape: nothing before survives to be compared with.
      passkey_challenge: { count: "any", contentHash: "skip" },
      mcp_oauth_authz: { count: "any", contentHash: "skip" },
    },
    joins: [
      {
        // A migration that revoked too much cannot pass: every PAT it revoked must have a newer
        // live PAT of the same principal and label that it left alone.
        name: "every PAT this migration revoked has a newer live PAT of the same principal and label",
        violatingCount: `
          select count(*)::int as n from zz.pat p
          where p.revoked_at >= (select applied_at from zz.schema_migration where name = '002_identity_access.sql')
            and not exists (
              select 1 from zz.pat q
              where q.principal_id = p.principal_id and q.label = p.label
                and q.revoked_at is null and q.created_at > p.created_at
            )`,
      },
      {
        // AC-2.1: a console session's team is that principal's own choice, so it must be a
        // membership of theirs — the backfill resolves the principal's `active_team_id` through
        // `membership` rather than trusting it.
        name: "every console session team is a membership of its principal",
        violatingCount: `
          select count(*)::int as n from zz.console_session s
          where s.team_id is not null
            and not exists (
              select 1 from zz.membership m
              where m.team_id = s.team_id and m.principal_id = s.principal_id
            )`,
      },
    ],
  },
};
