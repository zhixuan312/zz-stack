/**
 * A count, not a document: how many words a body holds, by the hash of its own bytes.
 *
 * The console's words-written figure is `countWords` over the body of every revision a team's flow
 * documents have had — a pure function of bytes the platform never changes, recomputed from scratch
 * by every process that started until this table existed. `services/gateway/src/console/word-counts.ts`
 * fills it as it reads: nothing writes it on the write path, and `counted_by` names the generation of
 * `countWords` that produced a row, so a release that changes what a word is re-counts rather than
 * answering old numbers.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const WORDS: Record<string, TableTarget> = {
  doc_words: {
    columns: [
      [
        "content_hash",
        "text",
        false,
        null,
      ],
      [
        "words",
        "integer",
        false,
        null,
      ],
      [
        "counted_by",
        "integer",
        false,
        null,
      ],
      [
        "counted_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "content_hash",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: "class=current_state; authority=this; question=how many words does a body hold, keyed by the hash of its own bytes, a count derived by countWords and reusable by every revision and every read whose bytes hash to the same value?",
    columnComments: {
      content_hash: "class=immutable_history; authority=this; question=which body's bytes this count is of, the same hash zz.doc.content_hash and zz.doc_revision.content_hash carry?",
      words: "class=current_state; authority=this; question=how many words the platform counts in that body, recomputed rather than adjusted whenever the count is of a different generation?",
      counted_by: "class=current_state; authority=this; question=which generation of countWords produced the number beside it, so a release that changes what a word is re-counts rather than answering old numbers?",
      counted_at: "class=current_state; authority=this; question=when was this body last counted, the moment the row was written or overwritten?",
    },
  },
};
