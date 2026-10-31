/**
 * Assertions this run could not plant against, and why — recorded rather than dropped.
 *
 * When a clause loses its subject, deleting its spec makes the artifact show a check fully
 * covered by however many rows remain, with nothing saying an assertion went unexercised. The
 * entries live here instead and are carried into the report beside the rows.
 *
 * DELIBERATE: they are not rows. A row whose `replacements` is zero reads exactly like a check
 * that survived its defect, so "this could not be planted" is expressed outside `results`.
 *
 * Dormant is not broken: every entry below names a clause that is correct and would fire the
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
   * The check file's sha256 when this entry was written, so a reader can tell whether the
   * entry still describes the file it names.
   *
   * DELIBERATE: written by hand. A digest the runner filled in at write time would match on
   * every run and prove nothing; this one is a claim about the bytes an author read.
   * `mutation-run.ts` compares it to the live file and stamps `stale` beside it, the same
   * treatment a row gets. Nothing re-derives an entry, so without this a pasted observation
   * could go on asserting what it saw with nothing comparing it to anything.
   */
  readonly observed_check_sha256: string;
}

export const UNEXERCISABLE: readonly Unexercisable[] = [
  {
    check: "scripts/gate/checks/contracts-door.ts",
    assertion: "the ratchet backward — a listed name the door no longer publishes fails, so the list cannot outlive what it describes",
    why: "the check's RESIDUE list is empty. Both backward clauses are `for (const name of " +
      "RESIDUE)`, so their bodies never execute and no defect planted in the door can reach " +
      "them — a clause the data never takes.",
    plantable_when: "a value name is tolerated on the door without an importer and is listed " +
      "in RESIDUE again; the clause fires the moment that entry outlives the name it describes.",
    observed_check_sha256: "7d9c676e47fc5bb7f9dec97d800e9389f428fe1cd550fe9e0ff769cb27fdef4e",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    assertion: "the ratchet backward — a listed name that has ACQUIRED an importer fails, so it can never return to the residue",
    why: "the same empty RESIDUE: importing a listed name is the defect, and no name is listed.",
    plantable_when: "RESIDUE holds at least one name; importing that name then fires it.",
    observed_check_sha256: "7d9c676e47fc5bb7f9dec97d800e9389f428fe1cd550fe9e0ff769cb27fdef4e",
  },
  {
    check: "scripts/gate/checks/catalog-stages.ts",
    assertion: "a missing testing/ FAILS rather than passing in silence",
    why: "the clause fires only when `testing/` does not exist, and the sole edit that " +
      "produces that state is to the check's own path string. `plant()` freezes " +
      "`scripts/gate/checks/` — a run that edited a check would be measuring itself — and a " +
      "find/replace spec cannot remove a directory. The subject and the instrument are the " +
      "same file, which is the one combination this runner refuses by construction.",
    plantable_when: "the runner can express a subject's ABSENCE as a mutation, rather than " +
      "only its contents. Until then the clause is verified by reading: it returns a failure " +
      "string, and `testing/` is tracked, so the state it guards is a broken checkout rather " +
      "than a checkout without an optional artifact.",
    observed_check_sha256: "113fd516a0793c28b91c2adc494c7756de3b973c4b32dcdf1ce0747bbf8969e8",
  },
  {
    check: "scripts/gate/checks/deploy-compose.ts",
    assertion: "a Caddyfile that cannot be read FAILS rather than passing in silence",
    why: "the same shape as the catalog-stages entry. `deploy/Caddyfile` is a legitimate " +
      "subject and other rows mutate its CONTENTS, but no spec can make it absent, and the " +
      "absence is the whole clause.",
    plantable_when: "the runner can express a subject's ABSENCE as a mutation. The stake: this " +
      "check's own comment records that a wrong Caddyfile leaves the public URL answering 502 " +
      "while every container reads as healthy.",
    observed_check_sha256: "e767ba4252c32edec100c49e5c8eac9467670bf1a0c7a1b140f7c5e44c60cd98",
  },
  {
    check: "scripts/gate/checks/console.ts",
    assertion: "an absent ../zz-stack-dashboard is NAMED, rather than reported as routes nobody calls",
    why: "the condition is `!existsSync(dash)` on a SIBLING REPOSITORY, which no edit to a " +
      "mutable subject can remove — the only lever is the check's own path string, and " +
      "`plant()` freezes `scripts/gate/checks/`. It can be exercised by hand: rsync this tree " +
      "(minus node_modules and .git) into a directory that has no zz-stack-dashboard beside " +
      "it, symlink node_modules, and run `node scripts/gate.ts` there. The check then fails " +
      "with the sentence naming the missing repository, never `serves /api/console/... and " +
      "nothing calls it` — a false accusation that would invite a reader to delete working code.",
    plantable_when: "never by this runner, and it does not need to be. A spec cannot express " +
      "the absence of a directory outside the repository; the sibling-less gate run above " +
      "exercises the real condition rather than a stand-in for it.",
    observed_check_sha256: "875d1bdc1abc0b1d388b34d806884f74b2940a64b36ab3132b4b6a216baf3e32",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    assertion: "nothing reads an envelope field except parseEnvelope",
    why: "the check fires on a REGEX LITERAL over an envelope field name, and no file reads an " +
      "envelope that way: every reader goes through `parseEnvelope` and names its fields as " +
      "properties (`env.status`), which is what the sibling check covers. A mutation would have " +
      "to introduce a private regex into a reader that has no reason to hold one, which plants " +
      "a shape the code never had rather than a defect it could have.",
    plantable_when: "a reader needs a field from a document it has not parsed — the shape this " +
      "check was written against.",
    observed_check_sha256: "f76711b083621a3d9f40661cf0dd5cfd8cee7d270f3fb5a174d223f83a0c1fe3",
  },
  {
    check: "scripts/gate/checks/documents-envelope.ts",
    assertion: "where a frontmatter block starts and ends is spelled once",
    why: "the check scans for an anchored `---` fence in a multi-line pattern, and the only " +
      "such spelling in services/ and packages/ is the definition the check exempts, " +
      "`ENVELOPE_BLOCK` in `@zz/contracts`. There is no second site to plant a second " +
      "spelling in.",
    plantable_when: "a second module spells the fence again — a parser for skills' frontmatter " +
      "outside @zz/contracts would do it, and this check would fire the day it lands.",
    observed_check_sha256: "f76711b083621a3d9f40661cf0dd5cfd8cee7d270f3fb5a174d223f83a0c1fe3",
  },
  {
    check: "scripts/gate/checks/knowledge.ts",
    assertion: "supersession stays on one shelf and knows which",
    why: "the check reads the tool's whole body for the shelf vocabulary, and that vocabulary " +
      "is spread across a resolver helper, a shelf-selection branch and a refusal MESSAGE that " +
      "names both shelves. Removing the shelf distinction in one span leaves the refusal " +
      "naming shelves (so the check still passes) or leaves `bothShelves` unused (which fails " +
      "the build rather than the check). The defect is real but no single-span mutation " +
      "expresses it while the file still compiles.",
    plantable_when: "the resolver and its refusal are one function again, or the check reads " +
      "the resolver rather than the tool body.",
    observed_check_sha256: "04ecfd7ac2d4072c247472bdf2546fb89d84c543a39d76bc9231f490c80409b0",
  },
  {
    check: "scripts/gate/checks/data-telemetry-reports.ts",
    assertion: "a live count in shipped prose carries the date it was taken",
    why: "no shipped .md under catalog/, skills/ or docs/ has a sentence naming this deployment " +
      "with a count in it, dated or not, so there is no dated count to strip the date from.",
    plantable_when: "a shipped .md under catalog/, skills/ or docs/ states a dated count of " +
      "this deployment again; aim the plant at that sentence's date.",
    observed_check_sha256: "e1991eafdbc3ff647451f48ea373c12ed4cbaa99454f5fa99b4feb71fe276721",
  },
];
