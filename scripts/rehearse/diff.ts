/**
 * Turning a before/after `Snapshot` pair, read against `expect.ts`'s declared expectations for
 * whichever migrations actually ran, into the report lines `scripts/rehearse.ts` prints and the
 * list of disagreements that make it exit non-zero. Pure — no I/O, so it is the one piece of the
 * rehearsal a unit test could drive without Docker.
 *
 * A dropped table is declared, not hashed: it is present before and gone after, and the only
 * fact left to compare is the one `expect.ts` wrote down. A renamed table is one line rather than
 * a removal and an addition, because the before snapshot files the old relation under the name
 * the target uses — the count and the hashed columns of both sides land together, which is what
 * makes "every row survived the rename" readable at all.
 */
import type { Snapshot } from "./snapshot.ts";
import { foldedTableExpectation, type CountExpectation, type FoldedExpectation } from "./expect.ts";

function describeCount(exp: CountExpectation): string {
  if (exp === "unchanged") return "unchanged";
  if (exp === "any") return "any";
  return `Δ${exp.delta >= 0 ? "+" : ""}${exp.delta}`;
}

interface TableReportLine {
  table: string;
  /** The name the before side read it under, when a pending migration renamed it. */
  was: string | null;
  dropped: boolean;
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
    const exp: FoldedExpectation = foldedTableExpectation(table, pendingMigrations);
    const where = `${table}${exp.was ? ` (was ${exp.was})` : ""}`;
    if (!b || !a) {
      diffs.push(`${table}: missing from the ${!b ? "before" : "after"} snapshot`);
      continue;
    }
    // A declared drop is the one shape where absence is the expectation: present before, gone
    // after, nothing to hash. Either half alone is a disagreement — a table still there after
    // the migration that drops it, or one the before side never had.
    if (exp.dropped || !b.present || !a.present) {
      const ok = exp.dropped && b.present && !a.present;
      if (exp.dropped && !b.present) diffs.push(`${table}: declared dropped, but absent from the before snapshot too`);
      else if (exp.dropped && a.present) diffs.push(`${table}: declared dropped, but still present after (${a.count} row(s))`);
      else if (!exp.dropped) diffs.push(`${where}: present ${b.present ? "before" : "not before"}, ${a.present ? "after" : "not after"} — no expectation declares the table dropped`);
      lines.push({
        table, was: exp.was, dropped: exp.dropped,
        before: b.present ? b.count : 0, after: a.present ? a.count : 0,
        expectedCount: "dropped", countOk: ok, hashChecked: false, hashOk: ok,
      });
      continue;
    }
    const delta = a.count - b.count;
    const countOk = exp.count === "any" ? true
      : exp.count === "unchanged" ? delta === 0
      : delta === exp.count.delta;
    if (!countOk) {
      diffs.push(`${where}: row count ${b.count} -> ${a.count} (Δ${delta}), expected ${describeCount(exp.count)}`);
    }
    // A snapshot's `hash` is null exactly when its expectation skips it, so a null under an
    // expectation that requires one is a disagreement between the two — reported, never read as
    // a pass. Both snapshots are captured with the same pending set, so this cannot be a miss.
    const hashChecked = exp.contentHash === "unchanged";
    const hashOk = !hashChecked || (b.hash !== null && a.hash !== null && a.hash === b.hash);
    if (hashChecked && !hashOk) {
      diffs.push(b.hash === null || a.hash === null
        ? `${where}: content hash required by the expectation but not captured`
        : `${where}: content hash changed (before ${b.hash.slice(0, 12)}…, after ${a.hash.slice(0, 12)}…)`);
    }
    lines.push({
      table, was: exp.was, dropped: false, before: b.count, after: a.count,
      expectedCount: describeCount(exp.count), countOk, hashChecked, hashOk,
    });
  }
  return { lines, diffs };
}

export function formatTableReport(lines: readonly TableReportLine[]): string[] {
  return lines.map((l) => {
    const name = `${l.table}${l.was ? ` (was ${l.was})` : ""}`;
    const count = l.countOk ? `${l.before} -> ${l.after} (${l.expectedCount}, ok)`
      : `${l.before} -> ${l.after} (expected ${l.expectedCount}, DISAGREES)`;
    // A dropped table has no after side to hash, so it reads "declared" rather than "not checked"
    // — the expectation is the whole of the evidence there is.
    const hash = l.dropped ? "declared" : !l.hashChecked ? "not checked" : l.hashOk ? "unchanged" : "CHANGED";
    return `  ${name}: count ${count}, hash ${hash}`;
  });
}
