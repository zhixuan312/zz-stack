/**
 * Running the key joins, against the migrated database: the ones `expect.ts` declares for whichever
 * migrations actually ran, then the ones `invariants.ts` declares for every rehearsal.
 *
 * Each is a query written down as "the count of rows that break this rule" — this only runs it and
 * checks it came back zero. The always-run set is listed under the `ALWAYS` label, because a rule
 * that is not tied to a migration is not a fact about one and should not read as though it were.
 */
import type pg from "pg";

import { MIGRATION_EXPECTATIONS } from "./expect.ts";
import { ALWAYS_JOINS } from "./invariants.ts";

/** The label the always-run invariants are reported under — not a migration file name, and not
 *  mistakable for one. */
export const ALWAYS_LABEL = "ALWAYS";

interface JoinReportLine {
  migration: string;
  name: string;
  violating: number;
}

export async function checkJoins(
  client: pg.Client,
  pendingMigrations: readonly string[],
): Promise<{ lines: JoinReportLine[]; diffs: string[] }> {
  const lines: JoinReportLine[] = [];
  const diffs: string[] = [];
  const groups: (readonly [string, readonly { name: string; violatingCount: string }[]])[] = [
    ...pendingMigrations.map((m) => [m, MIGRATION_EXPECTATIONS[m]?.joins ?? []] as const),
    [ALWAYS_LABEL, ALWAYS_JOINS] as const,
  ];
  for (const [migration, joins] of groups) {
    for (const join of joins) {
      const { rows } = await client.query<{ n: unknown }>(join.violatingCount);
      // A join expectation is a count, and a query that came back as anything else — no rows,
      // several, or a first column that is not a number — proves nothing about the join. Reading
      // it as 0 would call that a pass, so it is a disagreement instead.
      if (rows.length !== 1 || typeof rows[0].n !== "number" || !Number.isInteger(rows[0].n)) {
        const seen = rows.length === 0 ? "no rows" : `${rows.length} row(s)`;
        const first = rows.length === 1 ? ` whose first column is ${JSON.stringify(rows[0].n)}` : "";
        diffs.push(`join "${join.name}" (from ${migration}): expected one row with one integer column "n", got ${seen}${first}`);
        continue;
      }
      const violating = rows[0].n;
      lines.push({ migration, name: join.name, violating });
      if (violating !== 0) diffs.push(`join "${join.name}" (from ${migration}): ${violating} violating row(s)`);
    }
  }
  return { lines, diffs };
}
