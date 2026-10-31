/** `outcome` is a closed set: the ledger is read by counting, and a free-text column cannot
 * answer "how many were accepted this quarter".
 *
 * `delivered` finished; `accepted` is a person saying it is what they wanted; `abandoned`
 * stopped. Each names who gave the verdict.
 *
 * DELIBERATE: there is no `superseded`. A closed record is not edited afterwards. Succession
 * belongs to knowledge, where `knowledge_supersede` already does it.
 *
 * DELIBERATE: a leaf module. `close.ts` derives an outcome from this list and cannot import
 * `index.ts`, which re-exports it through `control-loop.ts`; the envelope schema in `index.ts`
 * reads the same list from here.
 */
export const OUTCOMES = ["delivered", "accepted", "abandoned"] as const;
