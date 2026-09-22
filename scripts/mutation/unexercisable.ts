/**
 * Assertions this run could not plant against, and why — recorded rather than dropped.
 *
 * A SPEC THAT QUIETLY DISAPPEARS IS THE WORST OUTCOME AVAILABLE. When a clause loses its
 * subject the tempting move is to delete its spec, and the artifact then shows a check fully
 * covered by however many rows remain. Nothing says an assertion went unexercised. That is
 * the same silence this whole run exists to break, so the entries live here and are carried
 * into the report beside the rows.
 *
 * THEY ARE NOT ROWS, AND THAT IS FORCED RATHER THAN CHOSEN. `mutation-coverage.ts` refuses
 * any row whose `replacements` is zero — correctly, because a mutation that did not land is
 * indistinguishable from a check that survived it. So an honest "this could not be planted"
 * cannot be expressed as a row without turning the gate red on a finding. It is expressed
 * here instead: outside `results`, where the frozen check does not read, and in front of any
 * reader who opens the artifact.
 *
 * DORMANT IS NOT BROKEN. Every entry below names a clause that is correct and would fire the
 * day its subject exists again. What is missing is the data, not the rule.
 */

interface Unexercisable {
  /** The registered check whose assertion this is. */
  readonly check: string;
  /** The assertion, in the words the row would have carried. */
  readonly assertion: string;
  /** Why no honest mutation can reach it today. */
  readonly why: string;
  /** What would have to become true for it to be plantable again. */
  readonly plantable_when: string;
}

export const UNEXERCISABLE: readonly Unexercisable[] = [
  {
    check: "scripts/gate/checks/contracts-door.ts",
    assertion: "the ratchet backward — a listed name the door no longer publishes fails, so the list cannot outlive what it describes",
    why: "the check's RESIDUE list is empty. Both backward clauses are `for (const name of " +
      "RESIDUE)`, so their bodies never execute and no defect planted in the door can reach " +
      "them. This is the first shape on this run's own list — a clause the data never takes " +
      "— arriving in a check planted the same night the list was emptied.",
    plantable_when: "a value name is tolerated on the door without an importer and is listed " +
      "in RESIDUE again; the clause fires the moment that entry outlives the name it describes.",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    assertion: "the ratchet backward — a listed name that has ACQUIRED an importer fails, so it can never return to the residue",
    why: "the same empty RESIDUE. This one was plantable earlier tonight and is recorded " +
      "because it stopped being so: the row that established it imported a listed name and " +
      "watched the clause fire, and the sweep that emptied the list took its subject away.",
    plantable_when: "RESIDUE holds at least one name; importing that name then fires it.",
  },
];
