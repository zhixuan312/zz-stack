/**
 * The plant: break each rule, prove that check goes red by name; restore, prove it stops.
 *
 * DELIBERATE: it reads check names, not the exit status. Adding a skill directory or touching
 * a manifest turns the gate red several times over on the edit itself — the version of a
 * changed skill, what plugins.lock.json says the catalog ships, whether the committed
 * marketplace matches — so an exit-status plant records its own controls as failures.
 *
 * DELIBERATE: the gate is run without --quiet. A passing check prints a line too, which is
 * the only way to tell "this check passed" from "the gate died before reaching it".
 *
 * COUPLED: case 2 asserts checks/manifests-conform.ts stays green on the baseline's tree,
 * which sits beside the catalog rather than inside it. That is the measurement saying this
 * rule generalises the older one rather than repeating it.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { run } from "../testing/gate-plant.ts";

const MF = "catalog/zz/zz-plugin-eval/flow.json";
const KEEP = "/tmp/zz-plugin-eval-flow.json.keep";

const DECLARES = "a plugin declares every skill it ships, and ships every skill it declares";
const PURPOSE = "a plugin manifest says what the plugin is for";
const CONFORM = "every plugin declares what it is, what it ships, and what each stage leaves behind";

// DELIBERATE: exact paths, created and removed by this file and nothing else. A directory
// removed by pattern can take a source tree with it.
const STRAY_EVAL = "catalog/zz/zz-plugin-eval/skills/zz-plugin-stray";
const STRAY_CORE = "skills/zz-stray-core";
// The gate rebuilds marketplace/ as it runs, so a planted skill can be copied there. These are
// the only two places that can happen, and they are swept by name.
const DEBRIS = ["marketplace/zz-plugin-eval/skills/zz-plugin-stray",
                "marketplace/zz-core/skills/zz-stray-core"];

const original = readFileSync(MF, "utf8");
if (!original.trim()) { console.error(`${MF} is empty — refusing to plant into it`); process.exit(1); }
cpSync(MF, KEEP);
if (!statSync(KEEP).size) { console.error(`${KEEP} is empty — refusing to plant`); process.exit(1); }

const restore = () => cpSync(KEEP, MF);
const sweep = () => { for (const p of [STRAY_EVAL, STRAY_CORE, ...DEBRIS]) rmSync(p, { recursive: true, force: true }); };

const plantSkill = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/SKILL.md`,
    `---\nname: ${name}\ndescription: A skill planted by a break-test. It is removed again immediately.\n---\n\n# ${name}\n\nNothing here.\n`);
};

/** One gate run, as two maps: every check that ran, and the sentence each failing one gave. */
const fail: string[] = [];

/** Assert, for one mutation: the named checks ran, the ones that should fire did, the ones
 *  that should not did not. Everything else the gate says is deliberately not its business. */
function measure(what: string, { fires = [], quiet = [] }: { fires?: string[]; quiet?: string[] }) {
  const { ran, failed } = run();
  for (const name of [...fires, ...quiet]) {
    if (!ran.has(name)) { fail.push(`${what}: "${name}" never ran — the gate did not reach it, so nothing here was measured`); return; }
  }
  for (const name of fires) {
    if (!failed.has(name)) fail.push(`${what}: "${name}" stayed green and should have fired`);
    else console.log(`  ${what}\n      -> ✗ ${name}\n         ${failed.get(name)}`);
  }
  for (const name of quiet) {
    if (failed.has(name)) fail.push(`${what}: "${name}" fired and should not have: ${failed.get(name)}`);
  }
}

// Nothing below separates a planted defect from one already on the tree unless all three
// names start green. The rest of the gate may be red for its own reasons.
//
// DELIBERATE: outside the try. process.exit skips a finally, and nothing is planted yet.
{
  const { ran, failed } = run();
  for (const name of [DECLARES, PURPOSE, CONFORM]) {
    if (!ran.has(name)) fail.push(`"${name}" did not run at all — this plant cannot measure it`);
    else if (failed.has(name)) fail.push(`"${name}" is already failing before anything was planted: ${failed.get(name)}`);
  }
  if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
}

try {
  // 1. A shipped skill the manifest declares nowhere.
  plantSkill(STRAY_EVAL, "zz-plugin-stray");
  measure("a shipped skill zz-plugin-eval declares nowhere", { fires: [DECLARES], quiet: [PURPOSE] });
  sweep();

  // 2. The same defect in the baseline's tree at skills/, beside the catalog. The older rule
  //    reads catalog/zz/zz-core/skills, finds no directory and reports an empty set, so it
  //    must stay green here while this one fires.
  plantSkill(STRAY_CORE, "zz-stray-core");
  measure("a shipped skill zz-core declares nowhere", { fires: [DECLARES], quiet: [PURPOSE, CONFORM] });
  sweep();

  // 3. A declared skill that is not shipped, through `libraries` — the one declaring field
  //    no other rule in this repository reads.
  {
    const m = JSON.parse(original);
    m.libraries = [...(m.libraries ?? []), "zz-plugin-absent"];
    writeFileSync(MF, JSON.stringify(m, null, 2));
    measure("a library zz-plugin-eval declares and does not ship", { fires: [DECLARES], quiet: [PURPOSE] });
    restore();
  }

  // 4. A manifest with no purpose.
  {
    const m = JSON.parse(original);
    delete m.purpose;
    writeFileSync(MF, JSON.stringify(m, null, 2));
    measure("a manifest with no purpose", { fires: [PURPOSE], quiet: [DECLARES] });
    restore();
  }

  // 5. Control: a harmless edit must fire neither. A rule that reddens on any manifest
  //    change is as useless as one that never reddens.
  {
    const m = JSON.parse(original);
    m.description = `${m.description} It measures and never changes.`;
    writeFileSync(MF, JSON.stringify(m, null, 2));
    measure("CONTROL: a harmless description edit", { quiet: [DECLARES, PURPOSE] });
    restore();
  }

  // 6. And it stops when the planting does. A check still red after restore is measuring the
  //    tree it was run in rather than the defect.
  sweep();
  measure("after restore", { quiet: [DECLARES, PURPOSE, CONFORM] });
} finally {
  restore();
  sweep();
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("plugin-declaration plant: ok");
