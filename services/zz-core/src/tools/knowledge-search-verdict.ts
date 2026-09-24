/**
 * Which kind of empty an empty `knowledge_search` answer is.
 * COUPLED: knowledge-search.ts reads the shelves — predicates, lanes, fusion, the byte budget
 * — and hands this file what it observed. This file concludes.
 *
 * A caller otherwise gets one answer for two different facts: a search that ran cleanly and
 * found nothing, and a search that could not conclude.
 *
 * The verdict itself is not written here. `@zz/contracts`' `recallResultFrom` owns the mapping
 * and authors the sentence for each exit. This file produces its inputs and nothing else:
 * pure, no database, no clock, no second sentence.
 */
import type { RecallSearchOutcome } from "@zz/contracts";

/**
 * What the handler knows about one empty search.
 *
 * `asksHan`/`asksLatin` are the query's own scripts, tested by the caller against the same
 * `HAN_SCALAR_RE` its predicate builder splits clauses on, and passed in rather than retested
 * here.
 *
 * `scope` is a reading of the material the declared search covered — whether it held any row
 * at all, and which scripts those rows are written in — or `null` when that reading could not
 * be taken, which never fails a search that already has its answer.
 */
export interface RecallSignals {
  readonly query?: string;
  readonly asksHan: boolean;
  readonly asksLatin: boolean;
  /** The predicate builder's parse complaint: the declared query is not the executed one. */
  readonly unsafe?: string;
  readonly shelves: readonly string[];
  readonly filters: Readonly<Record<string, unknown>>;
  readonly scope: { readonly rows: boolean; readonly han: boolean; readonly latin: boolean } | null;
}

/**
 * The signals as the kernel's `RecallSearchOutcome`.
 *
 * Language qualification is a claim about the handler's lanes, not about the documents. An
 * ASCII clause goes through `websearch_to_tsquery`, whose parser has no Han segmentation, so
 * it cannot see a word inside an unspaced Han run however the row is stored; a Han clause is
 * matched as a literal `body` substring, which reaches nothing written in Latin letters. A
 * query framed in one script over a scope that also holds the other is not qualified for that
 * half.
 *
 * It claims no more: a mostly-English document with one quoted Han sentence counts as holding
 * Han, and its English words were reachable throughout. "Not qualified" means one lane could
 * not reach part of what was searched; it never asserts the answer is in the part missed.
 *
 * A query-less search is always qualified — nothing to frame in the wrong script — so an empty
 * one means the filters alone selected nothing.
 *
 * A scope nobody could read is `unknown`, never complete. The kernel reads an unknown
 * completeness and an undeclared language as blocking a clean empty.
 */
export function recallOutcomeFrom(s: RecallSignals): RecallSearchOutcome {
  const question = s.query && s.query.length > 0 ? s.query : null;
  const asked: string[] = [];
  if (s.unsafe) {
    asked.push("What would the query as written have matched? It could not be read under this "
      + `platform's query grammar (${s.unsafe}) and was matched as one literal clause instead.`);
  }
  if (s.scope !== null && !s.scope.rows) {
    asked.push("Do the declared filters name anything that exists? They selected no row at all, "
      + "so the query was never compared against any material.");
  }
  const qualified = s.scope === null ? null
    : question === null ? true
      : !((s.scope.han && !s.asksHan) || (s.scope.latin && !s.asksLatin));
  return {
    items: [],
    question,
    scopes: s.shelves,
    unresolved_questions: asked,
    receipt: {
      status: "ok",
      query: question,
      completeness: s.scope === null ? "unknown" : s.unsafe ? "partial" : "complete_for_declared_search",
      language_qualified: qualified,
      // Nothing is ever trimmed out of an empty result: the ranked set and the returned set are
      // both empty, so neither the byte budget nor the row limit can have withheld a candidate.
      withheld: 0,
      scopes_searched: s.shelves,
      filters: s.filters,
    },
  };
}
