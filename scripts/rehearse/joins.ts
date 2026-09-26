/**
 * Running the key joins `expect.ts` declares for whichever migrations actually ran, against the
 * migrated database. Each one is a query the migration's author already wrote down as "the count
 * of rows that break this join" — this only runs it and checks it came back zero.
 */
import type pg from "pg";

import { MIGRATION_EXPECTATIONS } from "./expect.ts";

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
  for (const migration of pendingMigrations) {
    for (const join of MIGRATION_EXPECTATIONS[migration]?.joins ?? []) {
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
