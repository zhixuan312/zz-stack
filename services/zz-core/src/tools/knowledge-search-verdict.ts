/**
 * Which kind of empty an empty `knowledge_search` answer is.
 *
 * SPLIT OUT OF knowledge-search.ts BY SUBJECT, the same seam that file's own header records
 * being split at once before. That file reads the shelves: predicates, lanes, fusion, the byte
 * budget. This one concludes, and concludes about the one case retrieval cannot: an answer
 * with nothing in it.
 *
 * 43 of one person's 269 real searches came back empty. The broadening retry rescued most of
 * that, and what it did not rescue still left a caller ONE answer for two different facts — a
 * search that ran cleanly and found nothing, and a search that could not conclude. Those are
 * different answers to a person, and reading the first as the second is how a team decides
 * again something it already settled.
 *
 * THE VERDICT ITSELF IS NOT WRITTEN HERE. `@zz/contracts`' `recallResultFrom` owns that
 * mapping and authors the sentence for each exit, precisely so they cannot be merged by
 * whoever happens to be reading the search response. This file produces its INPUTS from what
 * the handler observed, and nothing else: pure, no database, no clock, no second sentence.
 */
import type { RecallSearchOutcome } from "@zz/contracts";

/**
 * What the handler knows about one empty search.
 *
 * `asksHan`/`asksLatin` are the query's own scripts, tested by the CALLER against the same
 * `HAN_SCALAR_RE` its predicate builder splits clauses on — passed in rather than retested
 * here, because a second copy of that test is a second thing to keep in agreement.
 *
 * `scope` is a reading of the material the declared search actually covered — whether it held
 * any row at all, and which scripts those rows are written in — or `null` when that reading
 * could not be taken, which is never a reason to fail a search that already has its answer.
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
 * LANGUAGE QUALIFICATION IS THE ONE THAT DECIDES REAL SEARCHES, and it is a claim about the
 * handler's LANES, not about the documents. An ASCII clause goes through
 * `websearch_to_tsquery`, whose parser has no Han segmentation at all, so it cannot see a word
 * inside an unspaced Han run however the row is stored; a Han clause is matched as a literal
 * `body` substring, which reaches nothing written in Latin letters. A query framed in one
 * script, over a scope that also holds the other, is therefore not qualified for that half —
 * and an empty result there is a fact about retrieval rather than about the team.
 *
 * IT CLAIMS NO MORE THAN THAT. A mostly-English document with one quoted Han sentence counts
 * as holding Han, and its English words were reachable the whole time. "Not qualified" means
 * one lane could not reach part of what was searched; it never means the material is absent,
 * and it never asserts the answer is in the part that was missed.
 *
 * A QUERY-LESS SEARCH IS ALWAYS QUALIFIED — no query, nothing to frame in the wrong script.
 * An empty one means the filters alone selected nothing, which is a clean no-match on them.
 *
 * A SCOPE NOBODY COULD READ IS `unknown`, NEVER COMPLETE. A probe that failed says nothing
 * about how far the search got, and the kernel reads an unknown completeness and an undeclared
 * language as blocking a clean empty — which is the honest verdict when coverage could not be
 * established at all.
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
