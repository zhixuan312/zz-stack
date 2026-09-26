/**
 * Turning a before/after `Snapshot` pair, read against `expect.ts`'s declared expectations for
 * whichever migrations actually ran, into the report lines `scripts/rehearse.ts` prints and the
 * list of disagreements that make it exit non-zero. Pure — no I/O, so it is the one piece of the
 * rehearsal a unit test could drive without Docker.
 */
import type { Snapshot } from "./snapshot.ts";
import { MIGRATION_EXPECTATIONS, type CountExpectation, type TableExpectation } from "./expect.ts";

function describeCount(exp: CountExpectation): string {
  if (exp === "unchanged") return "unchanged";
  if (exp === "any") return "any";
  return `Δ${exp.delta >= 0 ? "+" : ""}${exp.delta}`;
}

/** The last migration to name a table wins over an earlier one naming the same table — the
 *  same "later entry overrides" rule a single map would give for free, kept explicit because
 *  this is folding several maps rather than reading one. */
function tableExpectation(table: string, pendingMigrations: readonly string[]): Required<TableExpectation> {
  let count: CountExpectation = "unchanged";
  let contentHash: "unchanged" | "skip" = "unchanged";
  for (const migration of pendingMigrations) {
    const exp = MIGRATION_EXPECTATIONS[migration]?.tables?.[table];
    if (!exp) continue;
    if (exp.count !== undefined) count = exp.count;
    if (exp.contentHash !== undefined) contentHash = exp.contentHash;
  }
  return { count, contentHash };
}

interface TableReportLine {
  table: string;
  before: number;
  after: number;
  expectedCount: string;
  countOk: boolean;
  hashChecked: boolean;
  hashOk: boolean;
}

/** One line per table in either snapshot, sorted by name — the before/after table the technical
 *  AC asks for, plus (separately) which of those lines disagree. */
export function diffSnapshots(
  before: Snapshot,
  after: Snapshot,
  pendingMigrations: readonly string[],
): { lines: TableReportLine[]; diffs: string[] } {
  const lines: TableReportLine[] = [];
  const diffs: string[] = [];
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  for (const table of tables) {
    const b = before[table];
    const a = after[table];
    if (!b || !a) {
      diffs.push(`${table}: missing from the ${!b ? "before" : "after"} snapshot`);
      continue;
    }
    const exp = tableExpectation(table, pendingMigrations);
    const delta = a.count - b.count;
    const countOk = exp.count === "any" ? true
      : exp.count === "unchanged" ? delta === 0
      : delta === exp.count.delta;
    if (!countOk) {
      diffs.push(`${table}: row count ${b.count} -> ${a.count} (Δ${delta}), expected ${describeCount(exp.count)}`);
    }
    const hashChecked = exp.contentHash === "unchanged";
    const hashOk = !hashChecked || a.hash === b.hash;
    if (hashChecked && !hashOk) {
      diffs.push(`${table}: content hash changed (before ${b.hash.slice(0, 12)}…, after ${a.hash.slice(0, 12)}…)`);
    }
    lines.push({
      table, before: b.count, after: a.count, expectedCount: describeCount(exp.count),
      countOk, hashChecked, hashOk,
    });
  }
  return { lines, diffs };
}

export function formatTableReport(lines: readonly TableReportLine[]): string[] {
  return lines.map((l) => {
    const count = l.countOk ? `${l.before} -> ${l.after} (${l.expectedCount}, ok)`
      : `${l.before} -> ${l.after} (expected ${l.expectedCount}, DISAGREES)`;
    const hash = !l.hashChecked ? "not checked" : l.hashOk ? "unchanged" : "CHANGED";
    return `  ${l.table}: count ${count}, hash ${hash}`;
  });
}
