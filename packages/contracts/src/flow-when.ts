/**
 * Conditional documents in the flow contract (FR-52, FR-58, spec v8; Task I-26).
 *
 * A document in a flow manifest may declare `when: { <fact>: value | value[] }` — equality or
 * set-membership over the durable branch facts an initiative has settled so far. `documentApplies`
 * is the one function every reader of a conditional document calls: `initiative_status`
 * (services/zz-core/src/tools/initiative-status.ts), the write guards' gate and close checks
 * (services/zz-core/src/guards.ts), and `initiative_close`'s abandon-truthfulness check
 * (services/zz-core/src/tools/initiative-close.ts). Facts are read from `<initiative>/_facts.json`
 * — written by the eval service (Task I-27), never here — the same "absence is not failure" shape
 * `_assessments/` already uses (services/zz-core/src/semantic.ts).
 *
 * A document with no `when` is unaffected: `documentApplies` answers `"applies"` for it
 * unconditionally, which is what keeps sdlc and zz-access — neither of which declares `when` —
 * behaving exactly as before this task.
 */
import { z } from "zod";

/** The durable branch facts a document's `when` may name (FR-58). Every writer of a `when`
 *  clause and every reader of `_facts.json` draws from this one list; a fact name not here is
 *  refused at the manifest boundary — `FlowDocWhen` below is a closed object, not a free-form
 *  record, so an unrecognised key is a zod issue naming it, the same refusal
 *  `packages/catalog`'s `manifestAt` already gives every other unknown manifest field. */
export const WHEN_FACT_NAMES = ["protocol_action", "improvement_mode", "release_mode"] as const;
export type WhenFactName = (typeof WHEN_FACT_NAMES)[number];

/** One `when` value: a fact equals this string, or is a member of this list — spec v8's
 *  "equality / set-membership composition" (FR-58). */
const FactPredicate = z.union([z.string().min(1), z.array(z.string().min(1))]);

/** `FlowDoc.when`.
 *
 * DELIBERATE: named fields, not `z.record(z.enum(WHEN_FACT_NAMES), FactPredicate)`. A record's
 * key restriction is real to the validator but invisible to `jsonSchema()` in index.ts — its
 * `ZodRecord` case publishes only the value type, so the published `/schemas/manifest.json`
 * would promise less than the validator refuses. A plain strict object publishes exactly as
 * strict as it validates, through the `ZodObject` case that already exists, with no change to
 * the emitter. */
export const FlowDocWhen = z.object({
  protocol_action: FactPredicate.optional(),
  improvement_mode: FactPredicate.optional(),
  release_mode: FactPredicate.optional(),
}).strict();
export type FlowDocWhen = z.infer<typeof FlowDocWhen>;

/** `documentApplies`'s answer. `"undetermined"` means the branch has not been decided yet, not
 *  that anything failed — see the module doc above. */
export type Applicability = "applies" | "not_applicable" | "undetermined";

/**
 * Whether a document applies under the facts an initiative has settled so far — evaluated by
 * code from durable state (FR-58), never by a model's confidence.
 *
 * Every named fact must equal its declared value, or be a member of its declared list, for the
 * document to apply. A single definite mismatch makes the whole predicate false regardless of
 * what else is unknown — the predicate is an AND across its named facts, and Kleene's
 * three-valued AND makes `false ∧ unknown = false`, never `unknown`: a document ruled out by one
 * settled fact is ruled out, whatever else has not been decided yet. Only when nothing mismatches
 * and at least one named fact is still missing does the answer become `"undetermined"`.
 *
 * A document with no `when` — or an empty one — always applies. `facts` is read from
 * `_facts.json`; an absent or blank value for a named fact counts as "not recorded yet", the same
 * as the fact being missing from the file entirely.
 */
export function documentApplies(
  doc: { when?: Record<string, string | string[]> },
  facts: Record<string, string>,
): Applicability {
  const when = doc.when;
  if (!when || Object.keys(when).length === 0) return "applies";
  let missing = false;
  for (const [fact, want] of Object.entries(when)) {
    const have = facts[fact];
    if (have === undefined || have === "") { missing = true; continue; }
    const matches = Array.isArray(want) ? want.includes(have) : want === have;
    if (!matches) return "not_applicable";
  }
  return missing ? "undetermined" : "applies";
}
