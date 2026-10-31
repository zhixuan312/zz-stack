/**
 * Running the negative-control probes.
 *
 * A probe in `@zz/contracts` exists to prove a detector can actually fail: it plants a fault the
 * real inputs cannot express, runs the real code over it, and reports whether the detector
 * noticed. A probe nothing runs proves nothing, so this file runs every probe the door publishes.
 *
 * DELIBERATE: one check per probe, never one check over all of them. `check` in `../run.ts`
 * reports the first failure string a body returns, so a loop would name one broken probe and hide
 * the rest; `gateCheckNames` in `../read.ts` discovers names with `/^check\("(.+?)",/gm`, so a
 * name built in a loop is invisible to the gate's inventory and to the execution report.
 *
 * A probe returns self-verdicting rows — `fires` is a boolean the probe computed. The check
 * asserts every row fires, the row count, distinct detector names, and that `fires` agrees with
 * the prose on the same row, which is the only independent purchase here. The count is exact: a
 * probe that loses rows still passes "every row fires", and an empty one passes it vacuously.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeProbe } from "@zz/contracts";
import { firstOf, root, withoutComments } from "../read.ts";
import { check } from "../run.ts";

// The set itself, derived rather than typed

const DOOR = "packages/contracts/src/control-loop.ts";

/** The door's exported value names, with `X as Y` resolved to the name the door publishes.
 *  Type exports are dropped: `CloseProbeRow` carries "Probe" in its name and is not a probe. */
function doorValueNames(source: string): string[] {
  const out: string[] = [];
  for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const raw of block[1].split(",")) {
      const piece = raw.trim();
      if (!piece || /^type\s/.test(piece)) continue;
      out.push((piece.split(/\s+as\s+/).pop() ?? piece).trim());
    }
  }
  return out;
}

/** The names this module imports from the door. `noUnusedLocals` is on for `scripts/**`, so a
 *  name that appears here is a name some check below actually calls — the compiler binds the
 *  import list to the exercised set, and this check does not have to. */
function ownProbeImports(source: string): string[] {
  const out: string[] = [];
  for (const block of source.matchAll(/import\s+\{([^}]*)\}\s*from\s*"@zz\/contracts"/g)) {
    for (const raw of block[1].split(",")) {
      const piece = raw.trim();
      if (piece) out.push(piece);
    }
  }
  return out;
}

/**
 * The set is derived, not typed, which is what makes the checks below trustworthy: it
 * comes off the door — every exported value name ending in `Probe` — and is compared against
 * the names this module imports. Add a probe to the door and this fails until it is wired;
 * delete one and this fails until the import goes.
 *
 * COUPLED: `noUnusedLocals` on `scripts/**` is doing half the work. An import no check below
 * calls fails the typecheck, which is what binds the import list to the exercised set.
 *
 * The `Probe` suffix is the convention, and a probe named against it would be missed, so the
 * convention is asserted by failing when the door yields no probes at all.
 */
check("every negative-control probe on the contracts door is run by this file", () => {
  const door = withoutComments(readFileSync(join(root, DOOR), "utf8"));
  const onDoor = doorValueNames(door).filter((n) => /Probe$/.test(n));
  // A door this check cannot read is a failure, not a pass on an empty set: the door moving or
  // changing shape would otherwise retire this rule silently.
  if (onDoor.length === 0) {
    return `${DOOR} yielded no exported value name ending in "Probe" — the door moved, changed ` +
      "shape, or the naming convention this check derives the set from has been abandoned";
  }
  const own = ownProbeImports(withoutComments(readFileSync(fileURLToPath(import.meta.url), "utf8")));
  const imported = new Set(own);
  const bad: string[] = [];
  for (const name of onDoor) {
    if (!imported.has(name)) {
      bad.push(`${DOOR} publishes the probe ${name} and this file does not run it — import it ` +
        "and add a check, or take it off the door; a probe nothing runs proves nothing");
    }
  }
  for (const name of own) {
    if (/Probe$/.test(name) && !onDoor.includes(name)) {
      bad.push(`this file imports ${name} and the door no longer publishes it as a value`);
    }
  }
  return firstOf(bad);
});


// The probes that verdict their own rows

/** The row shape a self-verdicting probe returns, declared here so the assertions below hold any
 *  such probe to one shape. */
interface FiringRow {
  readonly detector: string;
  readonly healthy: string;
  readonly faulted: string;
  readonly fires: boolean;
}

/**
 * Every assertion a self-verdicting probe is held to. Returns the failure text, or null.
 *
 * DELIBERATE: emptiness is tested first, because an empty table satisfies "every row fires" —
 * `[].every` is true — and that vacuous pass is the shape these probes exist to expose.
 */
function firing(rows: readonly FiringRow[], expected: number): string | null {
  if (rows.length === 0) {
    return "the probe returned no rows at all. A probe with nothing to report satisfies " +
      "\"every row fires\" vacuously, which is precisely the shape it exists to catch";
  }
  if (rows.length !== expected) {
    return `the probe returned ${rows.length} rows where ${expected} were measured when this ` +
      "check was written. If rows were added or removed deliberately, update the number here; " +
      "if they were not, a detector has been lost";
  }
  const names = new Set(rows.map((r) => r.detector));
  if (names.size !== rows.length) {
    return `the ${rows.length} rows do not carry ${rows.length} distinct detector names ` +
      `(${names.size} distinct). Repeated rows inflate the count without testing anything further`;
  }
  const missed = rows.filter((r) => !r.fires);
  if (missed.length) {
    return `${missed.length} of ${rows.length} detectors did not fire: ` +
      missed.map((r) => `${r.detector} [${r.healthy}] [${r.faulted}]`).join("; ");
  }
  // The independent reading. `fires` is the probe's own conjunction; `healthy` and `faulted`
  // are the same two booleans rendered as prose by the same helper. A `fires` that no longer
  // follows from them is a verdict somebody wrote rather than one the probe measured.
  const inconsistent = rows.filter(
    (r) => !r.healthy.startsWith("silent") || !r.faulted.startsWith("fires"),
  );
  if (inconsistent.length) {
    return `the prose on ${inconsistent.length} of ${rows.length} rows contradicts the ` +
      "fires=true the same row carries: " +
      inconsistent.map((r) => `${r.detector} [${r.healthy}] [${r.faulted}]`).join("; ");
  }
  return null;
}

check("the close negative control fires on every planted fault", () =>
  firing(closeProbe(), 8));
