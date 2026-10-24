/**
 * The reader for a `SCHEMA.md` comment's `key=value` fields, shared by every check that has to ask
 * one of them a question.
 *
 * `checks/comment-completeness.ts` carried this: the six classes, the six keys in the order the
 * template writes them, and a scan that finds where each key's value ends. It was the only copy
 * until `checks/table-retention.ts` needed to read `retention=` and nothing else, and a second copy
 * for one key would be a second answer to "where does this value stop" — the failure being a check
 * that reads half a sentence and reports a rule as unmet.
 *
 * What stays with the caller is what it does with the fields: which keys its document's class
 * allows, and what a value has to say. This module only says where they are.
 *
 * Moved verbatim from `checks/comment-completeness.ts`.
 */

/** The six classes `SCHEMA.md` fixes. A comment naming a seventh is not one this standard can
 *  read, and it is exactly what a comparison cannot catch: it proves the two agree, never that
 *  either is one of the six. */
export const CLASSES = ["current_state", "immutable_history", "state_machine", "relation", "ephemeral", "projection"];

/** The keys `SCHEMA.md`'s template fixes, in the order it writes them. A comment is
 *  `class=…; authority=…; question=<one sentence>` and then the tails its class takes. */
const KEYS = ["class", "authority", "question", "transitions", "rebuilt_from", "retention"] as const;

/** The `key=value` each key carries, or undefined when the comment does not carry it.
 *
 *  NOT a split on `;` — and that is the whole reason this is a function rather than a one-line
 *  regex. `question` is `<one sentence>`, and a sentence may contain a semicolon: `zz.event.detail`
 *  asks about "section headings, cause paths, normalisations and diagnostics; on a document.refused
 *  row ...; and on a document.shown or document.shown_part row ...", which a split on `; ` cuts in
 *  half so that the question reads as ending mid-clause, and the `question` rule would be red
 *  against a target that is correct.
 *
 *  So a field starts at the string's own start or after `; `, and a value runs to wherever the
 *  NEXT known key starts, less the `; ` that separates them. A `; ` inside a sentence is inside
 *  the value, which is what the template means by `<one sentence>`. */
export function fields(comment: string): Record<string, string> {
  const hits: { key: string; at: number; valueAt: number }[] = [];
  for (const key of KEYS) {
    for (const m of comment.matchAll(new RegExp(`(?:^|; )${key}=`, "g"))) {
      hits.push({ key, at: m.index, valueAt: m.index + m[0].length });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out: Record<string, string> = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : comment.length;
    out[hits[i].key] = comment.slice(hits[i].valueAt, end).replace(/; $/, "");
  }
  return out;
}
