/**
 * The plant: break the stage/document contract four ways, prove that check goes red by name,
 * and prove the three shapes that are legitimate stay green. Restore, prove it stops.
 *
 * DELIBERATE: it reads check names, not the exit status. Touching any catalog manifest turns
 * the gate red several times over on the edit itself — the plugins lock, the rendered
 * marketplace, the package digest — so an exit-status plant would record its own controls as
 * failures against a rule behaving perfectly. "Did this check fail, by name" is falsifiable in
 * both directions.
 *
 * DELIBERATE: the gate runs without --quiet. A passing check prints a line too, which is the
 * only way to tell "this check passed" from "the gate died before reaching it".
 *
 * The mutations are in zz-plugin-eval, a flow whose current eight stages use two of the three
 * kinds of `produces` (record and a document name); case 5 below plants the third ("nothing")
 * rather than assuming a stage that already answers it. SDLC_DOCS staying quiet through them
 * asserts that what remains in that file is about sdlc alone and does not fire on another
 * flow's manifest.
 *
 * Case 4 is the one this file is about: a one-way check — resolve `produces` forward, confirm
 * the document exists — passes a manifest where a document points at a stage that produces
 * something else. Only reciprocity fails there, and `catalog-stages.ts`'s "a document's
 * declared stage is a stage its flow has" stays quiet, because the stage it names is real.
 */
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";

interface Stage { name: string; produces?: string; [key: string]: unknown }
interface Doc { name: string; stage?: string; [key: string]: unknown }
interface Manifest { stages?: Stage[]; documents?: Doc[]; [key: string]: unknown }

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

const EVAL = "catalog/zz/zz-plugin-eval/flow.json";
const SDLC = "catalog/sdlc/sdlc-flow/flow.json";
const ACCESS = "catalog/zz/zz-access/flow.json";

// Exact paths, one file each, outside the repository: a directory copy into a stale path can
// overwrite a source tree.
const KEEP = {
  [EVAL]: "/tmp/zz-plugin-eval-flow.stage-produces.keep",
  [SDLC]: "/tmp/sdlc-flow-flow.stage-produces.keep",
  [ACCESS]: "/tmp/zz-access-flow.stage-produces.keep",
};

const MINE = "every stage says what it leaves behind, and the document it names names it back";
const SDLC_DOCS = "sdlc closes on its review, gates it, and leaves its audits ungated";
const CONFORM = "every plugin declares what it is, what it ships, and what each stage leaves behind";
const DOC_STAGE = "a document's declared stage is a stage its flow has";

const original: Record<string, string> = {};
for (const [path, keep] of Object.entries(KEEP)) {
  original[path] = readFileSync(path, "utf8");
  if (!original[path].trim()) { console.error(`${path} is empty — refusing to plant into it`); process.exit(1); }
  cpSync(path, keep);
  if (!statSync(keep).size) { console.error(`${keep} is empty — refusing to plant`); process.exit(1); }
}

const restore = () => { for (const [path, keep] of Object.entries(KEEP)) cpSync(keep, path); };
/** Mutate one manifest through a function of its parsed self. One file at a time. */
const mutate = (path: string, fn: (m: Manifest) => void) => {
  const m: Manifest = JSON.parse(original[path]);
  fn(m);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
};

/** One gate run, as two maps: every check that ran, and the sentence each failing one gave. */
function run() {
  let out: string;
  try {
    out = execFileSync("node", ["scripts/gate.ts"], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    out = execOutput(err);
  }
  const lines = out.split("\n");
  const ran = new Set<string>();
  const failed = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    const ok = /^\s*✓ (.+)$/.exec(line);
    if (ok) { ran.add(ok[1]); continue; }
    const no = /^\s*✗ (.+)$/.exec(line);
    if (no) { ran.add(no[1]); failed.set(no[1], (lines[i + 1] ?? "").trim()); }
  }
  return { ran, failed };
}

const fail: string[] = [];

/** Assert, for one mutation: the named checks ran, the ones that should fire did, the ones that
 *  should not did not. DELIBERATE: everything else the gate says is ignored — the lock and the
 *  marketplace go red on any manifest edit at all. */
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

// Nothing below separates a planted defect from one already on the tree unless all four names
// start green. DELIBERATE: outside the try — process.exit skips a finally, and nothing is
// planted yet, so there is nothing to clean up.
{
  const { ran, failed } = run();
  for (const name of [MINE, SDLC_DOCS, CONFORM, DOC_STAGE]) {
    if (!ran.has(name)) fail.push(`"${name}" did not run at all — this plant cannot measure it`);
    else if (failed.has(name)) fail.push(`"${name}" is already failing before anything was planted: ${failed.get(name)}`);
  }
  // The two values the controls turn on must already be what the controls assume, or a control
  // proves nothing about them. Read from the tree, not assumed.
  const sdlc: Manifest = JSON.parse(original[SDLC]);
  const exec = (sdlc.stages ?? []).find((s: Stage) => s.name === "sdlc-execute");
  if (exec?.produces !== "nothing") fail.push(`sdlc-execute declares produces: ${exec?.produces} — the control assumes "nothing"`);
  const ev: Manifest = JSON.parse(original[EVAL]);
  const kinds = new Set((ev.stages ?? []).map((s: Stage) => s.produces));
  // Only "record" is required of the untouched tree: zz-plugin-eval's current eight stages hold
  // no "nothing" example of their own (four produce "record", four produce a document — see
  // catalog/zz/zz-plugin-eval/flow.json), so case 5 below plants one rather than assuming it.
  if (!kinds.has("record")) {
    fail.push(`zz-plugin-eval declares no "record" stage (${[...kinds].join(", ")}) — the control has no subject`);
  }
  // A non-flow package, for the exemption control. zz-access must have no documents and no
  // stages, or the control is about something else.
  const acc: Manifest = JSON.parse(original[ACCESS]);
  if ((acc.documents ?? []).length || (acc.stages ?? []).length) {
    fail.push("zz-access declares documents or stages — it is not the non-flow subject this control needs");
  }
  if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
}

try {
  // 1. A stage with no produces. Planted on zz-plugin-identify, whose produces is "record", so
  //    removing it orphans no document and this tests presence alone. `manifests-conform.ts`
  //    fires too, because it names zz-plugin-eval in a list of four; a fifth flow would be
  //    covered only by MINE.
  mutate(EVAL, (m) => { delete (m.stages ?? []).find((s) => s.name === "zz-plugin-identify")!.produces; });
  measure("a stage with no produces", { fires: [MINE, CONFORM], quiet: [SDLC_DOCS, DOC_STAGE] });
  restore();

  // 2. `produces` naming a document the manifest does not declare. On the same record-producing
  //    stage, for the same reason: nothing is orphaned, so the only thing broken is the forward
  //    claim.
  mutate(EVAL, (m) => { (m.stages ?? []).find((s) => s.name === "zz-plugin-identify")!.produces = "invented.md"; });
  measure("produces naming a document the flow does not declare",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 3. A declared document produced by no stage, with no `stage` field, which is what makes it
  //    invisible to catalog-stages.ts — that check skips a document with no stage.
  mutate(EVAL, (m) => { m.documents!.push({ name: "orphan.md", role: "ground" }); });
  measure("a declared document produced by no stage",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 4. The one-way case. findings.md points at a real stage — zz-plugin-evaluate, which produces
  //    "record" — while zz-plugin-explain goes on producing findings.md. Forward resolution
  //    passes and no document is orphaned; only reciprocity breaks.
  mutate(EVAL, (m) => { (m.documents ?? []).find((d) => d.name === "findings.md")!.stage = "zz-plugin-evaluate"; });
  measure("a document naming a stage that produces something else",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 5. Control: "record" and "nothing" are both answers, not omissions. zz-plugin-eval's current
  //    eight stages hold no "nothing" example of their own (four produce "record", four produce
  //    a document), so this plants one: zz-plugin-observe's own "record" becomes "nothing", a
  //    real value change on a non-document stage — changing a document-producing stage would
  //    orphan its document instead. Not vacuous — a rule demanding a document name from every
  //    stage fires on this exactly as it would on "record".
  mutate(EVAL, (m) => {
    (m.stages ?? []).find((s) => s.name === "zz-plugin-observe")!.produces = "nothing";
  });
  measure('CONTROL: a non-document stage answers "nothing" instead of "record"',
          { quiet: [MINE, SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 6. Control: the same, in the flow whose output is the repository. sdlc-execute produces
  //    "nothing", and a check demanding a document here would force a fake build.md into
  //    existence. SDLC_DOCS is not in `quiet`: it asserts sdlc-execute declares "nothing" by
  //    name, so it fires on this edit, correctly.
  mutate(SDLC, (m) => { (m.stages ?? []).find((s) => s.name === "sdlc-execute")!.produces = "record"; });
  measure('CONTROL: sdlc-execute, whose output is the repository, declares "record"',
          { quiet: [MINE, DOC_STAGE] });
  restore();

  // 7. Control: a non-flow package is not this check's subject. zz-access declares no
  //    documents, so a stage of it is not asked what it produces. The stage names a skill
  //    zz-access ships and is not its entry skill, so neither "stages names a skill it ships"
  //    nor the phantom-stage rule fires. CONFORM is not in `quiet`: it names zz-access and
  //    demands produces of every stage whether or not it is a flow, and MINE must not.
  mutate(ACCESS, (m) => { m.stages = [{ name: "zz-doctor" }]; });
  measure("CONTROL: a non-flow package with a stage that declares no produces",
          { quiet: [MINE, SDLC_DOCS, DOC_STAGE] });
  restore();

  // 8. And it stops when the planting does. A check still red after restore is measuring the
  //    tree it was run in rather than the defect.
  measure("after restore", { quiet: [MINE, SDLC_DOCS, CONFORM, DOC_STAGE] });
} finally {
  restore();
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("stage-produces plant: ok");
