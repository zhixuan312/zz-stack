/**
 * The contracts door carries no value name nobody imports — bounded, not asserted.
 *
 * This is not evidence that the control-loop kernel is adopted, used, or reached by anything a
 * person runs. It says one thing: the count of unimported door names cannot grow, and a name that
 * leaves the list cannot come back into it.
 *
 * COUPLED: `hygiene.ts` registers a different rule. That one reads export declarations — `export
 * function`, `export const`, `export type` — and asks whether the name appears in any other file.
 * `control-loop.ts` declares nothing; every line on it is `export { … } from "./module.js"`, which
 * that pattern does not match, and a door line is not a comment so it survives comment-stripping —
 * the re-export is itself the mention that keeps the defining module's declaration alive. Both
 * rules are wanted: "is this declaration named anywhere else in the tree" is about dead code inside
 * a package, and "is this name on the package door imported through the package" is about a public
 * surface with no public.
 *
 * Value names only. A type re-exported here reaches a consumer by inference — TypeScript emits it
 * into the `.d.ts` through a return position and the consumer never names it in an import — so "no
 * named import" is not evidence of dormancy for a type. A value has no such route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { firstOf, root, sourceFiles, withoutComments } from "../read.ts";
import { check, note } from "../run.ts";

const DOOR = "packages/contracts/src/control-loop.ts";

/**
 * The names on the door with no importer — written out in full rather than counted, so a reader
 * meets what is being tolerated.
 *
 * This list may only shrink, and the check below enforces that in both directions: a name here that
 * has acquired an importer fails until the line is deleted, and a name here that is no longer on the
 * door fails the same way. A name is not re-admitted by being re-added — once deleted, it is judged
 * as new, and new means it needs an importer.
 *
 * Derived by reading every `export { … } from` block on the door for names not written `type X`,
 * then every `import { … } from "@zz/contracts"` in `services`, `packages`, `scripts`, `checks` and
 * `testing` outside the contracts package itself.
 */
const RESIDUE: readonly string[] = [
  // Empty, and that is the point: every value name this door publishes has an importer. The list is
  // kept rather than deleted because the rule it bounds is still enforced — add a name with no
  // importer and the check fails rather than quietly growing an entry here.

];

/** The names in one brace list, with `X as Y` resolved to the half that matters: a door publishes
 *  the right-hand name, an import names the left-hand one. `[^}]*` rather than a lazy
 *  any-character run — a lazy run crosses the closing brace and swallows every list after the first
 *  in the same file. */
function namesIn(braces: string, side: "published" | "imported"): string[] {
  const out: string[] = [];
  for (const raw of braces.split(",")) {
    const piece = raw.trim();
    if (!piece) continue;
    // `type X` on the door is a name this check does not judge, for the reason in the header. In an
    // import the marker says only how the name travels, and the file is still an importer of it —
    // so there it is stripped and the name kept.
    if (side === "published" && /^type\s/.test(piece)) continue;
    const halves = piece.replace(/^type\s+/, "").split(/\s+as\s+/).map((h) => h.trim());
    const name = side === "published" ? halves[halves.length - 1] : halves[0];
    // Anything that is not a plain identifier after that is not a name this door can publish or an
    // importer can bind, and reporting it would be reporting the parser rather than the door.
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
  }
  return out;
}

check("a name on the contracts door has an importer", () => {
  const door = withoutComments(readFileSync(join(root, DOOR), "utf8"));

  // A wildcard is the one way past this, so it is refused where it would be written. The door names
  // every symbol it publishes precisely so a name that stops existing breaks the build; `export *`
  // would publish a module's whole surface without naming any of it, and every name it added would
  // be invisible here.
  if (/^\s*export\s+\*/m.test(door)) {
    return `${DOOR} re-exports with a wildcard — this door names every symbol it publishes, ` +
           "and a wildcard puts names on it that no reader and no check can enumerate";
  }

  const values: string[] = [];
  for (const block of door.matchAll(/export\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const name of namesIn(block[1], "published")) values.push(name);
  }
  // A door this check cannot read is a failure, not a pass on an empty set: the file moving or its
  // block shape changing would otherwise retire the rule silently.
  if (values.length === 0) {
    return `${DOOR} yielded no re-exported value names — the door moved or changed shape, ` +
           "and this check cannot bound a surface it cannot enumerate";
  }

  const imported = new Set<string>();
  // The gate and the probes count as importers, the same correction the export rule in `hygiene.ts`
  // carries: a symbol a check imports by name to exercise is used. Deliberately excluded is the
  // contracts package itself — a package naming its own symbol through its own door is the module
  // system working, not a consumer.
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
