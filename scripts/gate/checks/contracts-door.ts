/**
 * The contracts door carries no name nobody imports — bounded, not asserted.
 *
 * WHAT THIS IS NOT, first, because the number it prints invites the opposite reading. It is
 * not evidence that the control-loop kernel is adopted, used, or reached by anything a person
 * runs. Sixty-eight of the door's value names have no importer at all on the day this was
 * derived, and this check passes on every one of them by name. It says one thing only: the
 * count of them cannot grow, and a name that leaves the list cannot come back into it. A
 * reader who wants to know whether the kernel is load-bearing has to ask a different question
 * of a different artifact; this one answers how large the residue is allowed to be.
 *
 * WHY A SECOND CHECK, when `hygiene.ts` already registers one about exports nobody imports.
 * That check reads EXPORT DECLARATIONS — `export function`, `export const`, `export type` —
 * and asks whether the name appears in any other file in the tree. `control-loop.ts` declares
 * nothing; it is a door, and every line on it is `export { … } from "./module.js"`, which that
 * check's pattern does not match at all. So the door's own names were never judged. Worse, a
 * door line is not a comment and survives the comment-stripping, so the re-export IS the
 * mention that keeps the defining module's declaration alive: the kernel satisfied the
 * existing rule by putting its names on a door and importing them nowhere.
 *
 * The two rules therefore ask different questions and both are wanted. "Is this declaration
 * named anywhere else in the tree" is about dead code inside a package. "Is this name on the
 * package door imported through the package" is about a public surface with no public. A
 * symbol can satisfy the first because a sibling module in its own package names it — forty-
 * six of the sixty-eight do — and still fail the second.
 *
 * VALUE NAMES ONLY, and the door's own header says why. A type re-exported here reaches a
 * consumer by inference: TypeScript emits it into the `.d.ts` through a return position and
 * the consumer gets the full shape without ever naming it in an import. "No named import"
 * is therefore not evidence of dormancy for a type, and enforcing it over the door's two
 * hundred and forty type names would report correct code as dead. A value has no such route
 * — nothing calls a function it has not named.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check, note } from "../run.ts";

const DOOR = "packages/contracts/src/control-loop.ts";

/**
 * The names on the door with no importer as of 752f099, 2026-09-22 — written out in full
 * rather than counted, so a reader meets what is being tolerated instead of a number standing
 * in for it.
 *
 * THIS LIST MAY ONLY SHRINK, and the check below enforces that in both directions. A name
 * here that has acquired an importer fails until the line is deleted, and a name here that is
 * no longer on the door fails the same way — either would otherwise let the list outlive what
 * it describes, which is how a ratchet becomes a rug. A name is not re-admitted by being
 * re-added: once deleted, it is judged as new, and new means it needs an importer.
 *
 * Derived by reading every `export { … } from` block on the door for names not written
 * `type X`, then every `import { … } from "@zz/contracts"` in `services`, `packages`,
 * `scripts`, `checks` and `testing` outside the contracts package itself. Of the door's one
 * hundred and fourteen value names, forty-two are imported only by gate checks and four reach
 * a service — `createHost`, `moduleDigest`, `INTERNAL_GRANT_ISSUANCE` and `deriveOutcome`.
 * Those two groups are not listed here: they have an importer, which is all this check asks.
 */
const RESIDUE: readonly string[] = [
  "procedureSignature", "reusesGatedDocumentPipeline", "matchKindFromVia",
  "authorizesSemanticAdvance", "interpretBatch", "canonicalTarget", "claimAgainstGrant",
  "createGrantStore", "dependencySnapshotRef", "effectDigest", "issueControlGrant",
  "profileDigest", "grantFixtureWorld", "resetGrantFixture", "bindingHistory",
  "rebindDetectorProbe", "recordCalibration", "recordInvocation", "revokeProfile",
  "declareProfile", "qualificationKey", "revalidate", "snapshotCoverageProbe",
  "boundaryDetectorProbe", "reconcileDetectorProbe", "ASSET_ROLES", "CANCEL_STATES",
  "OBSERVED_COMPLETENESS", "PORT_PROTOCOL", "RECEIPT_ASSURANCE", "RUNTIME_CAPABILITIES",
  "RUNTIME_OPERATIONS", "STOP_EVIDENCE", "admitToRuntime", "cancelStrength", "declarationDigest",
  "summariseUsage", "accountFor", "adjudicate", "eligibilityOf", "sliceAdequacy", "sliceKey",
  "SAMPLE_ADEQUACY_RULE_REF", "assembleProtocol", "conclude", "outcomesOf",
  "reuseHeldOutForTuning", "AGREEMENT_METRIC", "evalProtocolProbe", "episodeKey",
  "createController", "stageControlProbe", "UNDETERMINED_CHECK_STATE", "asCheckState",
  "disputeFinding", "recordAudit", "resolveFinding", "UNAVAILABLE", "auditIdentityProbe",
  "ACTION_CONTRACTS", "GAP_KINDS", "authorityMintAudit", "citationAudit", "coverageAudit",
  "deadlockAudit", "gapRoutingProbe", "closeProbe", "recallTrialProbe",
];

/** The names in one brace list, with `X as Y` resolved to the half that matters: a door
 *  publishes the right-hand name, an import names the left-hand one. `[^}]*` rather than a
 *  lazy any-character run — a lazy run crosses the closing brace and swallows every list after
 *  the first in the same file, which is the bug that produced a wrong first census of this door. */
function namesIn(braces: string, side: "published" | "imported"): string[] {
  const out: string[] = [];
  for (const raw of braces.split(",")) {
    const piece = raw.trim();
    if (!piece) continue;
    // `type X` on the door is a name this check does not judge, for the reason in the header.
    // In an import the marker says only how the name travels, and the file is still an
    // importer of it — so there it is stripped and the name kept.
    if (side === "published" && /^type\s/.test(piece)) continue;
    const halves = piece.replace(/^type\s+/, "").split(/\s+as\s+/).map((h) => h.trim());
    const name = side === "published" ? halves[halves.length - 1] : halves[0];
    // Anything that is not a plain identifier after that is not a name this door can publish
    // or an importer can bind, and reporting it would be reporting the parser rather than the
    // door. Nothing on the door or in any import reaching it is of that shape today.
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
  }
  return out;
}

check("a name on the contracts door has an importer", () => {
  const door = withoutComments(readFileSync(join(root, DOOR), "utf8"));

  // A WILDCARD IS THE ONE WAY PAST THIS, so it is refused where it would be written. The
  // door's header promises one commented block of explicit names per module precisely so a
  // name that stops existing breaks the build; `export *` would publish a module's whole
  // surface without naming any of it, and every name it added would be invisible here.
  if (/^\s*export\s+\*/m.test(door)) {
    return `${DOOR} re-exports with a wildcard — this door names every symbol it publishes, ` +
           "and a wildcard puts names on it that no reader and no check can enumerate";
  }

  const values: string[] = [];
  for (const block of door.matchAll(/export\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const name of namesIn(block[1], "published")) values.push(name);
  }
  // A DOOR THIS CHECK CANNOT READ IS A FAILURE, not a pass on an empty set. The file moving or
  // its block shape changing would otherwise retire the rule silently, which is the quietest
  // way a check about a surface stops watching that surface.
  if (values.length === 0) {
    return `${DOOR} yielded no re-exported value names — the door moved or changed shape, ` +
           "and this check cannot bound a surface it cannot enumerate";
  }

  const imported = new Set<string>();
  // THE GATE AND THE PROBES COUNT AS IMPORTERS, the same correction the export rule in
  // `hygiene.ts` already carries: a symbol a check imports by name to exercise is used, and
  // calling it dormant would push that test back into reading the code instead of running it.
  // What is deliberately excluded is the contracts package itself — a package naming its own
  // symbol through its own door is the module system working, not a consumer.
  for (const rel of sourceFiles(["services", "packages", "scripts", "checks", "testing"], [".ts"])) {
    if (rel.startsWith("packages/contracts/")) continue;
    const src = withoutComments(readFileSync(join(root, rel), "utf8"));
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@zz\/contracts(?:\/[^"]*)?"/g)) {
      for (const name of namesIn(m[1], "imported")) imported.add(name);
    }
  }

  const listed = new Set(RESIDUE);
  const onDoor = new Set(values);
  const bad: string[] = [];
  for (const name of values) {
    if (imported.has(name) || listed.has(name)) continue;
    bad.push(`${DOOR} publishes ${name} and nothing imports it from "@zz/contracts" — give it ` +
             "a caller, or take it off the door");
  }
  for (const name of RESIDUE) {
    if (!onDoor.has(name)) {
      bad.push(`RESIDUE lists ${name} and the door no longer publishes it — delete the entry, ` +
               "so re-adding the name is judged as new rather than restored");
    } else if (imported.has(name)) {
      bad.push(`RESIDUE lists ${name} and something now imports it — delete the entry, so the ` +
               "name can never return to the residue without an importer");
    }
  }
  if (bad.length) return firstOf(bad);
  note(`      ${RESIDUE.length} of ${values.length} value names on the contracts door have no ` +
       "importer — bounded and listed by name, which is not the same as adopted");
  return null;
});
