/**
 * May a step be entered, given the evidence recorded for it.
 *
 * Evidence is required at a standard, and the standard is part of the requirement. A requirement
 * says how firmly its evidence must stand, a holding says how firmly it does stand, and the
 * comparison is ordered — see {@link EvidenceStandard}. Which standard applies to which kind is the
 * caller's fact about its own world, arriving as data.
 *
 * A requirement may be discharged rather than met, on a named ground. {@link EntryWaiver} carries
 * that ground, for one named kind, and it is carried back out on {@link EntryAdmission.waived}, so
 * an admission granted on a waiver is never mistaken for one granted on evidence.
 */

/** How firmly a piece of evidence stands, or has to. `recorded` is "it exists and somebody can read
 *  it"; `ratified` is "somebody with standing has signed it off". The two are ordered, and the order
 *  is the whole rule: ratification satisfies a demand for a record, and nothing but ratification
 *  satisfies a demand for ratification. */
export type EvidenceStandard = "recorded" | "ratified";

/** The ordering, written once. A string comparison would put `ratified` below `recorded`
 *  alphabetically and be wrong in exactly the direction that admits an unratified step. */
const STANDING: Readonly<Record<EvidenceStandard, number>> = Object.freeze({ recorded: 1, ratified: 2 });

/** One kind of evidence at one standard. The same shape stands on both sides of the entry question
 *  — a contract's requirement is the standard demanded, a caller's holding is the standard reached —
 *  because they are the two halves of one comparison. */
export interface EvidenceStanding {
  readonly kind: string;
  readonly standard: EvidenceStandard;
}

/** A requirement discharged rather than met, and the ground it was discharged on.
 *
 *  It names one kind: a blanket waiver would discharge requirements its ground says nothing about.
 *  `ground` is not optional — it is the sentence a reader is owed when they ask why a step was
 *  entered without what its contract asked for. */
export interface EntryWaiver {
  readonly kind: string;
  readonly ground: string;
}

/** A requirement the caller did not meet, with what was demanded and what was actually held. `held`
 *  is null when nothing of that kind was offered at all, which is a different situation from
 *  evidence that exists and has not been ratified: a caller answers them differently — go and
 *  produce it, against go and get it signed. */
export interface UnmetRequirement {
  readonly kind: string;
  readonly required: EvidenceStandard;
  readonly held: EvidenceStandard | null;
}

/** Whether the entry requirements are satisfied, and on what. The admitted half carries the
 *  waivers it was granted on — empty when every requirement was met by evidence, which is how
 *  the two are told apart. */
export type EntryAdmission =
  | { readonly admitted: true; readonly waived: readonly EntryWaiver[] }
  | { readonly admitted: false; readonly unmet: readonly UnmetRequirement[] };

/**
 * May a step be entered, given what has been recorded. It reads no state, names no step and
 * holds nothing.
 *
 * A waiver is read only where the requirement was not met: a waiver over evidence that was there
 * anyway would be recorded as the reason a step was entered when it was not the reason.
 */
export function admitEntry(
  required: readonly EvidenceStanding[],
  held: readonly EvidenceStanding[],
  waivers: readonly EntryWaiver[],
): EntryAdmission {
  // The strongest holding of each kind, not the last one offered. A caller listing the same kind
  // twice is describing one thing it knows two facts about.
  const strongest = new Map<string, EvidenceStandard>();
  for (const h of held) {
    const prior = strongest.get(h.kind);
    if (prior === undefined || STANDING[h.standard] > STANDING[prior]) strongest.set(h.kind, h.standard);
  }
  const grounds = new Map<string, EntryWaiver>();
  for (const w of waivers) if (!grounds.has(w.kind)) grounds.set(w.kind, w);

  const unmet: UnmetRequirement[] = [];
  const waived: EntryWaiver[] = [];
  for (const r of required) {
    const at = strongest.get(r.kind) ?? null;
    if (at !== null && STANDING[at] >= STANDING[r.standard]) continue;
    const ground = grounds.get(r.kind);
    if (ground) { waived.push(ground); continue; }
    unmet.push(Object.freeze({ kind: r.kind, required: r.standard, held: at }));
  }
  return unmet.length > 0
    ? Object.freeze({ admitted: false as const, unmet: Object.freeze(unmet) })
    : Object.freeze({ admitted: true as const, waived: Object.freeze(waived) });
}
