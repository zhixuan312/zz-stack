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
      const { rows } = await client.query<{ n: string }>(join.violatingCount);
      const violating = Number(rows[0]?.n ?? 0);
      lines.push({ migration, name: join.name, violating });
      if (violating !== 0) diffs.push(`join "${join.name}" (from ${migration}): ${violating} violating row(s)`);
    }
  }
  return { lines, diffs };
}
