#!/usr/bin/env node
/**
 * Every planted defect still lands.
 *
 * A mutation spec's `find` is a literal string searched in its `subject`, and `plant.ts` writes
 * the file back only when it replaced something — a spec whose subject text has moved applies
 * NOTHING and does not throw. The runner prints that as `0 replacement(s)` beside rows that
 * landed and never fails on it, so a check can look covered by a plant that never ran. Six such
 * specs were found by hand in the schema review (bug 32f6761), every one of them pre-existing.
 *
 * This makes the hazard unrepresentable: a `find` that no longer occurs in its subject, or a
 * subject that no longer exists, fails here — before any gate run wastes its time planting a
 * defect that is not there. It reads the real SPECS module rather than a copy of it, so a spec
 * added tomorrow is covered the day it is added.
 *
 * A spec whose subject text is expected to move without the defect moving — a digest that
 * changes on every release — is aimed somewhere stable, or recorded in `unexercisable.ts` with
 * its reason. There is no exemption list here: an exemption is how this bug comes back.
 */
import { existsSync, readFileSync } from "node:fs";

import { SPECS } from "../scripts/mutation/specs.ts";
import { UNEXERCISABLE } from "../scripts/mutation/unexercisable.ts";

const fail: string[] = [];
let landed = 0;

// An assertion is either planted or declared unplantable, never both. `unexercisable.ts` says
// "no honest mutation reaches this", and a row that reaches one anyway makes that claim false in
// the direction that hides coverage: the reader stops looking, and the report shows a clause
// covered by nothing.
const declared = new Set(UNEXERCISABLE.map((u) => `${u.check}\u0000${u.assertion}`));
for (const spec of SPECS) {
  const key = `${spec.check}\u0000${spec.assertion ?? ""}`;
  if (declared.has(key)) {
    fail.push(`${spec.check}: "${spec.assertion}" is planted AND declared unexercisable — ` +
      "drop whichever is no longer true");
  }
}

for (const spec of SPECS) {
  const { subject, find } = spec;
  if (!existsSync(subject)) {
    fail.push(`${subject} does not exist — the plant for "${spec.check}" has no subject`);
    continue;
  }
  const text = readFileSync(subject, "utf8");
  if (!text.includes(find)) {
    fail.push(`${subject} no longer contains the plant's text (check "${spec.check}"):\n` +
      `      find: ${JSON.stringify(find.slice(0, 120))}${find.length > 120 ? "…" : ""}\n` +
      "      The plant applies nothing, so that check is covered by a defect that never ran.");
    continue;
  }
  landed++;
}

if (fail.length) {
  console.error(`mutation-specs-match-subjects: ${fail.length} plant(s) would not land` +
    ` (${landed} of ${SPECS.length} do)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`ok mutation-specs-match-subjects — ${landed} plant(s) land in their subject`);
