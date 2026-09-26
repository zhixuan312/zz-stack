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
 *
 * `002_initiative_anchor.sql` reshapes `zz.initiative` in place (a rename, a dropped default,
 * new columns): its row count stays the default `"unchanged"`, but its content changes for
 * every row, so its hash is declared `"skip"` rather than proven equal to a hash taken under
 * the old columns. Every other table gets the full default — unchanged count and hash — against
 * the restored production dump.
 *
 * Its `withArtifacts` step (Task I-8) is the migration's other half: the new columns start
 * null on every row, and `packages/tools/src/migrate/initiative-files.ts` is what carries the
 * file store's own lifecycle record — a folder's closing document and its `_open.json` — onto
 * them. Run twice, because the whole backfill is written to be idempotent and a rehearsal is
 * the one place that gets proven rather than assumed.
 */
import type pg from "pg";

import { backfill, pgClientDb } from "../../packages/tools/dist/migrate/initiative-files.js";

/**
 * `"unchanged"` (the default): row count must be identical before and after.
 * `{ delta: n }`: row count must have moved by exactly `n` (negative allowed, e.g. a migration
 * that deletes rows).
 * `"any"`: row count is not checked at all — the migration is expected to change it
 * unpredictably (e.g. a backfill driven by production data).
 */
export type CountExpectation = "unchanged" | "any" | { delta: number };

export interface TableExpectation {
  /** Default: `"unchanged"`. */
  count?: CountExpectation;
  /** Default: `"unchanged"`. `"skip"` only makes sense alongside a `count` other than
   *  `"unchanged"` — a table whose rows moved has no single content hash to hold constant. */
  contentHash?: "unchanged" | "skip";
}

interface JoinExpectation {
  /** Named for the report line; never interpolated into SQL. */
  name: string;
  /** A query against the migrated database returning exactly one row with one integer column:
   *  the count of rows that violate the join. The expectation holds when it comes back 0. */
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

export const MIGRATION_EXPECTATIONS: Record<string, MigrationExpectation> = {
  "002_initiative_anchor.sql": {
    tables: {
      initiative: { contentHash: "skip" },
    },
    // The declared join: every initiative with an outcome is a closing envelope with an
    // outcome, and the reverse. `backfill` reports exactly what it could not resolve — an
    // unmatched folder, an email naming no principal, a CHECK the database itself refused —
    // and `accounted` has to add back up to what the store carries, or something was silently
    // dropped rather than reported.
    withArtifacts: async (artifactsDir, client) => {
      const diffs: string[] = [];
      const db = pgClientDb(client);

      const first = await backfill(db, artifactsDir);
      const outcomes = Object.entries(first.closedNowByOutcome).sort().map(([o, n]) => `${o} ${n}`).join(", ");
      console.log(`  initiative-files: closed ${first.closedNow} (${outcomes || "none"}), already closed ` +
        `${first.alreadyClosed}, opened fields filled ${first.openFieldsFilled}, blocked ${first.blocked}`);
      for (const u of [...first.unmatchedFolders, ...first.unmatchedEmails]) console.log(`    unmatched: ${u}`);
      if (first.blocked > 0) {
        diffs.push(`initiative-files: ${first.blocked} closing attempt(s) could not be applied`,
          ...first.violations, ...first.unmatchedEmails.filter((l) => l.includes("closed_by")));
      }
      const accounted = first.closedNow + first.alreadyClosed + first.blocked;
      if (accounted !== first.closeAttempts) {
        diffs.push(`initiative-files: join violated — ${first.closeAttempts} closing outcome(s) ` +
          `found in the store, only ${accounted} accounted for`);
      }

      // Every column this step ever writes is guarded by `is null` (opened_at by `least`,
      // which cannot move a value already at or before the folder's own), so a second pass
      // over the same store must close nothing further and fill nothing further.
      const second = await backfill(db, artifactsDir);
      console.log(`  initiative-files, second run: closed ${second.closedNow}, opened fields filled ${second.openFieldsFilled}`);
      if (second.closedNow !== 0 || second.openFieldsFilled !== 0) {
        diffs.push(`initiative-files: a second run over the same store closed ${second.closedNow} ` +
          `more initiative(s) and filled opened_* on ${second.openFieldsFilled} more — not idempotent`);
      }
      return diffs;
    },
  },
};
