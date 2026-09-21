/**
 * WHAT A PIECE OF WORK CONSUMED, summed under one written-down rule.
 *
 * THE DEFECT THIS EXISTS FOR IS REAL AND WAS MEASURED, not imagined. The first runtime this
 * platform integrated reports consumption twice for the same tokens whenever a unit of work
 * delegates: the delegating turn's result carries a rollup for the whole delegated run, and
 * the delegated run's own turns each carry their own record. Adding up every record you can
 * see therefore charges the delegated work to the account twice, and the error grows with the
 * thing the platform most wants to encourage. Nothing in the records is malformed — both
 * numbers are correct about what they describe — so nothing catches it except a rule.
 *
 * THE RULE, in one sentence: a record is counted exactly when no ancestor of it is marked as
 * already including its descendants.
 *
 * That one sentence covers both shapes a runtime can report in, which is why it is the rule
 * rather than a special case:
 *
 *   · Flat records, nothing rolled up — every record's ancestry is clean, so every record is
 *     counted, once.
 *   · A rollup over children — the rollup is counted and its descendants are excluded by
 *     name, because the rollup already contains them.
 *
 * AND WHERE IT CANNOT DECIDE, IT SAYS SO. A record whose parent is not among the records
 * given, or whose ancestry runs in a circle, cannot be shown to be uncounted — and cannot be
 * shown to be counted either. Guessing in either direction produces a number that looks like
 * every other number. So such a record is excluded by name, and {@link UsageTotal.completeness}
 * drops to `floor_only`: the total is then a lower bound on what the work consumed, and a
 * caller deciding a budget against it is deciding against a floor and knows it.
 */

/** One consumption record as a runtime reported it, normalised to the two numbers every
 *  runtime has and the one relationship that decides double counting. */
export interface UsageRecord {
  readonly record_id: string;
  readonly parent_record_id: string | null;
  /** True when the RUNTIME has already folded every descendant's numbers into this record.
   *  Not a hint and not a heuristic: an adapter sets this from what the runtime documents
   *  about its own rollups, and where it does not know, it does not set it. */
  readonly includes_descendants: boolean;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Whether every record's place in the tree could be established. `floor_only` is not a
 *  warning about precision — it says the number below is a lower bound. */
export type UsageCompleteness = "every_record_resolved" | "floor_only";

/** A total, plus every record's fate, so that a reader can check the arithmetic instead of
 *  trusting it. The three lists partition the input: counted, excluded because an ancestor
 *  already contains them, excluded because their ancestry could not be established. */
export interface UsageTotal {
  /** The one rule, named in the data. A total that does not carry the rule that produced it
   *  is a number two systems can disagree about while both look right. */
  readonly rule: "no_ancestor_rollup";
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly counted: readonly string[];
  readonly excluded_as_rolled_up: readonly string[];
  readonly excluded_as_unresolvable: readonly string[];
  readonly completeness: UsageCompleteness;
}

/**
 * Apply the rule.
 *
 * Duplicated record ids are treated as unresolvable rather than deduplicated. A runtime that
 * reports the same identifier twice is reporting something the adapter does not understand,
 * and silently keeping one of them is how a real discrepancy becomes a rounding difference
 * nobody investigates.
 */
export function summariseUsage(records: readonly UsageRecord[]): UsageTotal {
  const byId = new Map<string, UsageRecord>();
  const duplicated = new Set<string>();
  for (const r of records) {
    if (byId.has(r.record_id)) duplicated.add(r.record_id);
    else byId.set(r.record_id, r);
  }

  const counted: string[] = [];
  const rolledUp: string[] = [];
  const unresolvable: string[] = [];
  let input = 0;
  let output = 0;

  for (const record of records) {
    if (duplicated.has(record.record_id)) {
      if (!unresolvable.includes(record.record_id)) unresolvable.push(record.record_id);
      continue;
    }
    // Walk to the root. `seen` is what catches a circle; the bound is the record count, so a
    // chain longer than the whole input is a circle whether or not an id repeats.
    const seen = new Set<string>([record.record_id]);
    let ancestorRollsUp = false;
    let resolved = true;
    let cursor = record.parent_record_id;
    while (cursor !== null) {
      if (seen.has(cursor)) { resolved = false; break; }
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) { resolved = false; break; }
      if (parent.includes_descendants) { ancestorRollsUp = true; break; }
      cursor = parent.parent_record_id;
    }
    if (!resolved) unresolvable.push(record.record_id);
    else if (ancestorRollsUp) rolledUp.push(record.record_id);
    else {
      counted.push(record.record_id);
      input += record.input_tokens;
      output += record.output_tokens;
    }
  }

  return {
    rule: "no_ancestor_rollup",
    input_tokens: input,
    output_tokens: output,
    counted,
    excluded_as_rolled_up: rolledUp,
    excluded_as_unresolvable: unresolvable,
    completeness: unresolvable.length === 0 ? "every_record_resolved" : "floor_only",
  };
}
