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
  /**
   * The check file's sha256 WHEN THIS ENTRY WAS WRITTEN, so a reader can tell whether the
   * entry still describes the file it names.
   *
   * WRITTEN BY HAND, AND THAT IS THE POINT. A digest the runner filled in at write time would
   * match on every run and prove nothing; this one is a claim about the bytes an author
   * actually read. `mutation-run.ts` compares it to the live file and stamps `stale` beside
   * it, the same treatment a row gets — which is what a teammate pointed out these entries
   * were missing while the rows had it. A row about a check that moved announces itself; an
   * entry that pasted an OBSERVED OUTPUT, as the console one does, could go on asserting what
   * it saw with nothing comparing it to anything. A record of a real run is stronger evidence
   * and weaker provenance than a planted mutation, because nothing re-derives it.
   */
  readonly observed_check_sha256: string;
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
    observed_check_sha256: "a096e75c799b545a8fc936396865e10930c5c49aab43a197d446cbc154c50a44",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    assertion: "the ratchet backward — a listed name that has ACQUIRED an importer fails, so it can never return to the residue",
    why: "the same empty RESIDUE. This one was plantable earlier tonight and is recorded " +
      "because it stopped being so: the row that established it imported a listed name and " +
      "watched the clause fire, and the sweep that emptied the list took its subject away.",
    plantable_when: "RESIDUE holds at least one name; importing that name then fires it.",
    observed_check_sha256: "a096e75c799b545a8fc936396865e10930c5c49aab43a197d446cbc154c50a44",
  },
  {
    check: "scripts/gate/checks/build.ts",
    assertion: "a missing testing/ FAILS rather than passing in silence",
    why: "the clause fires only when `testing/` cannot be read, and the sole edit that " +
      "produces that state is to the check's own path string. `plant()` freezes " +
      "`scripts/gate/checks/` — a run that edited a check would be measuring itself — and a " +
      "find/replace spec cannot remove a directory. The subject and the instrument are the " +
      "same file, which is the one combination this runner refuses by construction.",
    plantable_when: "the runner can express a subject's ABSENCE as a mutation, rather than " +
      "only its contents. Until then the clause is verified by reading: it was `return null` " +
      "and it is now a returned failure string, and `testing/` is tracked, so the state it " +
      "guards is a broken checkout rather than a checkout without an optional artifact.",
    observed_check_sha256: "1934e0d4f0c336c2570a5b54850bec27bb34c06d593f21760831c5afaeb5e107",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    assertion: "a missing testing/ FAILS rather than passing in silence",
    why: "identical to the entry above, in the sibling check that carried the same escape.",
    plantable_when: "as above.",
    observed_check_sha256: "fd37d484ad83beccf81350711b64003e3277a81ae0e8f348bdad605114d176f9",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    assertion: "a Caddyfile that cannot be read FAILS rather than passing in silence",
    why: "the same shape. `deploy/Caddyfile` is a legitimate subject and other rows mutate " +
      "its CONTENTS, but no spec can make it absent, and the absence is the whole clause.",
    plantable_when: "as above. Note the stake: this check's own comment records that a wrong " +
      "Caddyfile left production answering 502 while every container read as healthy, and " +
      "before this initiative a Caddyfile that was simply gone passed the check in silence.",
    observed_check_sha256: "80353f208c5c50946321fe902ec7fae974ceff73c369f472d446d465d06ac381",
  },
  {
    check: "scripts/gate/checks/console.ts",
    assertion: "an absent ../zz-stack-dashboard is NAMED, rather than reported as routes nobody calls",
    why: "the condition is `!existsSync(dash)` on a SIBLING REPOSITORY, which no edit to a " +
      "mutable subject can remove — the only lever is the check's own path string, and " +
      "`plant()` freezes `scripts/gate/checks/`. But unlike the three entries above, this one " +
      "HAS BEEN EXERCISED. REPRODUCE IT: rsync this tree (minus node_modules and .git) into " +
      "a directory that has no zz-stack-dashboard beside it, symlink node_modules, and run " +
      "`node scripts/gate.ts` there. The run is disposable and its output is not kept in the " +
      "tree, which is why the method is written here rather than a transcript — a number in " +
      "a comment is the thing that goes stale, and the route count moves whenever a route " +
      "is added. On 2026-09-22 it reported 50 routes it could not show a caller for. Before " +
      "this change the same run reported each of them as `serves /api/console/... and nothing " +
      "calls it` — a false accusation that invites a reader to delete working code, which is " +
      "why it fails with a different sentence rather than passing or shortening its list.",
    plantable_when: "never by this runner, and it does not need to be. A spec cannot express " +
      "the absence of a directory outside the repository. The evidence for this clause is the " +
      "sibling-less gate run recorded above, which is stronger than a planted mutation because " +
      "it exercises the real condition rather than a stand-in for it.",
    observed_check_sha256: "e45f3536ccf9e899d0e54f7c3b8970f97dc2c9f198bc668e8c5e14514f28f804",
  },
  {
    check: "scripts/gate/checks/suites.ts",
    assertion: "the checks a stricter tooling project superseded are gone, not merely duplicated, " +
      "and the incident they existed to prevent is still on record",
    why: "the delegated script `checks/bespoke-checks-gone.ts` reads exactly two things, and " +
      "both are frozen: `scripts/gate/checks/build.ts` at its line 6, for the two deleted " +
      "registrations and the 0.26.1 incident narrative, and every sibling under " +
      "`scripts/gate/checks/` at lines 13-14, to prove those checks were not merely moved " +
      "elsewhere. `plant()` refuses that whole directory, because a run that edited a check " +
      "would be measuring itself. Verified by reading the script rather than by accepting the " +
      "claim: those are its only two reads.",
    plantable_when: "the 0.26.1 incident narrative, or the registrations this check forbids, " +
      "live anywhere outside `scripts/gate/checks/`. Nothing else moves it — the only other " +
      "lever is the judge itself, which is the thing being judged.",
    observed_check_sha256: "d5075f301a52bb0cbadeb1963342a3c1f88b1ce8fe04aa4ae0c95e5cc8761dea",
  },
];
