/**
 * Words: how a body is counted, the pace an estimate assumes, and the estimate itself. The gateway's
 * writing ledger counts every flow document and lesson body with `countWords`, and every page, export
 * and tool that states an estimate makes it with `writingEstimate`, so one constant sets the pace for
 * all of them.
 *
 * DELIBERATE: this module imports `documentBody` from the package's door, which re-exports this module.
 * The cycle is safe because `documentBody` is a function declaration read only when a body is counted,
 * and the envelope has one reader, kept beside its pattern in index.ts.
 */
import { documentBody } from "./index.js";

/** Words one person writes in an hour: a declared product assumption, not a measured rate. Every
 *  writing estimate is made at this pace and states it. */
export const WORDS_PER_HOUR = 500;

/** What an estimate's words were counted over, and what they were not. Each count is of documents or
 *  of revisions, as its name says:
 *
 *    documents, revisions  the flow documents and revisions the figure was read over, every kind
 *    importMade            documents every recorded write of which was a maintenance client's, left out
 *    unrecorded            documents with no recorded write, left out
 *    mixed                 documents written both ways, counted as work and named
 *    datedByLastWrite      revisions last rewritten by an approval or a close with no content act
 *                          recorded before it, dated by that rewrite
 *    undated               revisions that carry no time, counted in the stock and in no period
 *    missingLegacy         revisions whose words are unknown because they or their predecessor
 *                          retained no bytes, counted nowhere */
export type WritingCoverage = {
  documents: number; revisions: number; importMade: number; unrecorded: number; mixed: number;
  datedByLastWrite: number; undated: number; missingLegacy: number;
};

/** An estimate of hours at a stated pace, never a measurement: the basis, the words, the pace and the
 *  coverage travel with it. `words` null is a basis nobody could read, and its hours are null too. */
export type WritingEstimate = {
  basis: "retained_stock" | "period_net_additions";
  words: number | null; assumedWordsPerHour: number; hours: number | null;
  coverage: WritingCoverage;
};

/** The words of a text: its maximal runs of non-whitespace once normalised to NFC, the envelope left
 *  out. Markdown marks and URLs are words like any other run, and a run of characters from a script
 *  written without spaces is one word. */
export function countWords(text: string): number {
  return documentBody(text).normalize("NFC").match(/\S+/g)?.length ?? 0;
}

/** The time to write `words` at `WORDS_PER_HOUR`, on the basis named, with the coverage beside it. A
 *  missing word count stays missing: its hours are null, never zero. */
export function writingEstimate(words: number | null, basis: WritingEstimate["basis"], coverage: WritingCoverage): WritingEstimate {
  return { basis, words, assumedWordsPerHour: WORDS_PER_HOUR, hours: words === null ? null : words / WORDS_PER_HOUR, coverage };
}
