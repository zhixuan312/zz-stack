/**
 * The plant: name a tool nobody registers and a skill nobody ships, prove the gate says so;
 * restore, prove it stops. And prove ordinary English never fires it.
 *
 * DELIBERATE: this reads check names, not the exit status. Appending any line to a shipped
 * SKILL.md turns the gate red several times over — "a skill that changed says so in its version",
 * the plugin lock and the rendered marketplace all fire on the edit, whatever it says — so an
 * exit-status plant records its own controls as failures against a check that is behaving
 * perfectly.
 *
 * The question asked here is "did this check fail, by name", which is falsifiable in both
 * directions and independent of whatever else the tree is in the middle of.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** node:child_process throws an object carrying stdout/stderr, never an Error. Narrow at the
 *  boundary rather than assume the shape. */
function execOutput(err: unknown): string {
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const stdout = typeof rec.stdout === "string" ? rec.stdout : "";
    const stderr = typeof rec.stderr === "string" ? rec.stderr : "";
    return `${stdout}${stderr}`;
  }
  return String(err);
}

const TOOLS = "no shipped prose names a tool no door registers";
const SKILLS = "no shipped prose names a skill no plugin ships";

/** A shipped skill, and a gate module whose comments are the other half of the input set. */
const SK = "skills/zz-platform/SKILL.md";
const MOD = "scripts/gate/checks/hygiene.ts";

const read = (p: string) => {
  const text = readFileSync(p, "utf8");
  if (!text.trim()) { console.error(`${p} is empty — refusing to plant into it`); process.exit(1); }
  return text;
};
const skOriginal = read(SK);
const modOriginal = read(MOD);
const restore = () => { writeFileSync(SK, skOriginal); writeFileSync(MOD, modOriginal); };

/** The gate's failing checks, by name, with the sentence each gave. */
function failing() {
  let out: string;
  try {
    out = execFileSync("node", ["scripts/gate.ts", "--quiet"], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    out = execOutput(err);
  }
  const lines = out.split("\n");
  const found = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    const m = /^\s*✗ (.+)$/.exec(line);
    if (m) found.set(m[1], (lines[i + 1] ?? "").trim());
  }
  return found;
}

const fail: string[] = [];

// Both checks must be green to start with, or nothing below separates the defect being planted
// from one that was already there. The rest of the gate may be red for its own reasons and that
// is deliberately not this plant's business.
let now = failing();
for (const name of [TOOLS, SKILLS]) {
  if (now.has(name)) fail.push(`"${name}" is already failing before anything was planted — this plant cannot measure it`);
}
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }

const plant = (file: string, original: string, line: string) => writeFileSync(file, `${original}\n${line}\n`);
const expect = (name: string, what: string) => {
  now = failing();
  if (!now.has(name)) fail.push(`${what} did not fail "${name}"`);
  else console.log(`  ${what} -> ✗ ${name}\n      ${now.get(name)}`);
  restore();
};
const expectNot = (names: string[], what: string) => {
  now = failing();
  for (const name of names) {
    if (now.has(name)) fail.push(`${what} fired "${name}"; it is too broad: ${now.get(name)}`);
  }
  restore();
};

// The fixtures use `write_document`/`document_write`, chosen for the property each case needs:
// `document_write` is registered today, and `write_document` is its pre-rename spelling, which is
// what `claimsPreRename` exists to catch. A fixture naming a deleted tool tests nothing, and its
// failure accuses the check instead of the example.
//
// 1. The historical case, and the one nothing else in this gate can see. `write_document` is
//    verb-first: "a skill never names a platform tool that does not exist" derives our namespace
//    from the noun a name starts with, finds no tool registered under `write`, and reads the whole
//    name as another server's.
plant(SK, skOriginal, "Call `write_document` to store a document for the team.");
expect(TOOLS, "prose naming a verb-first tool no door registers");

// 2. And the current spelling, which this check reads the same way the skill checks do — the
//    difference being the input set, not the rule.
plant(SK, skOriginal, "Call `plugin_invented` to do the thing.");
expect(TOOLS, "prose naming a noun-first tool no door registers");

// 3. A comment in this gate's own source. Nothing else reads these at all.
plant(MOD, modOriginal, "// A team key used to be stored with delete_team_credential.");
expect(TOOLS, "a gate check's comment naming a tool no door registers");

// 4. A skill nobody ships, backticked and without `skill_read`. The `skill_read("…")` form is
//    already caught by "a skill_read a skill spells out names a skill that exists", so planting
//    that would be satisfiable without this feature. A bare backticked citation from a platform
//    skill is reached by neither that check nor the flow-prefix one, which sweeps only a flow's own
//    skill tree.
plant(SK, skOriginal, "Load `zz-nonexistent` before doing anything else.");
expect(SKILLS, "prose naming a skill no plugin ships");

// 5. Control — ordinary English, using the words that are also tool names.
plant(SK, skOriginal, "A person may approve the document, or close the initiative.");
expectNot([TOOLS, SKILLS], "ordinary English prose");

// 6. Control — a tool that does exist and a skill that is shipped, both in call shape. Without
//    this the plant proves only that something fires, not that it fires on the right thing.
plant(SK, skOriginal, "Call `document_write` to store a document, then load `zz-handover`.");
expectNot([TOOLS, SKILLS], "a real tool and a real skill, both named in call shape");

// 7. Control — a verb-first name whose noun is not one this platform registers under belongs to
//    another server and must be left alone.
plant(SK, skOriginal, "Another server publishes `read_api_spec` and `get_platform_overview`.");
expectNot([TOOLS], "another server's own tools, named in call shape");

// 8. The dead names are gone from the tree — a real removal, not a rename. CHANGELOG.md is outside
//    these roots: it records what past releases said, and a release that shipped a tool said so
//    correctly at the time. This file is outside them too, for the same reason a plant naming the
//    defect it plants is not itself the defect.
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? (["node_modules", "dist"].includes(f) ? [] : walk(p)) : [p];
});
for (const dir of ["services", "scripts", "catalog", "skills", "packages", "marketplace"]) {
  if (!existsSync(dir)) continue;
  for (const p of walk(dir)) {
    if (!/\.(ts|mjs|js|md)$/.test(p)) continue;
    if (/set_team_credential|delete_team_credential/.test(readFileSync(p, "utf8"))) {
      fail.push(`${p} still names a tool registered nowhere`);
    }
  }
}

// 9. And it stops when the planting does — a check that stays red after restore is measuring the
//    tree it was run in rather than the defect.
now = failing();
for (const name of [TOOLS, SKILLS]) {
  if (now.has(name)) fail.push(`"${name}" is still failing after restore: ${now.get(name)}`);
}

if (fail.length) { console.error([...new Set(fail)].join("\n")); process.exit(1); }
console.log("prose-names plant: ok");
