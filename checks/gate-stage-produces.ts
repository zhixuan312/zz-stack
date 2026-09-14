/**
 * The plant: break the stage/document contract four ways, prove THAT check goes red by name,
 * and prove the three shapes that are legitimate stay green. Restore, prove it stops.
 *
 * WHY IT READS CHECK NAMES AND NOT THE EXIT STATUS. The plan's sketch for this task asked
 * `gate() === 0`, and in this repository that measures nothing. Touching any catalog manifest
 * turns the gate red several times over ON THE EDIT ITSELF — what plugins.lock.json says the
 * catalog ships, whether the committed marketplace is what the catalog renders, the package
 * digest. A neighbouring task measured it: its real case failed seven checks and BOTH of its
 * controls failed five, so an exit-status plant records its own controls as failures against a
 * rule that is behaving perfectly. Red for unrelated reasons is the exact failure a break-test
 * exists to rule out. The question here is "did THIS check fail, by name", which is falsifiable
 * in both directions and independent of whatever else the tree is in the middle of.
 *
 * THE GATE IS RUN WITHOUT --quiet ON PURPOSE. A passing check prints a line too, and that is
 * the only way to tell "this check passed" from "the gate died before reaching it".
 *
 * WHY THE MUTATIONS ARE IN zz-plugin-eval AND NOT IN sdlc-flow. When this plant was written,
 * `checks/sdlc-documents.ts` asserted all three properties — presence, forward resolution,
 * reciprocity — for `catalog/sdlc/sdlc-flow/flow.json`, named as a literal. A plant that broke
 * sdlc-flow would have turned two checks red and proved nothing about the new one: every case
 * would have been satisfiable by the rule that was already there. So each case below mutates
 * the manifest that copy could not see, and asserts it stays GREEN while the new check fires.
 *
 * THAT COPY IS NOW GONE — the generic check made it redundant and it was deleted, which is what
 * the measurement below was evidence for. The cases stay where they are: zz-plugin-eval exercises
 * a flow whose stages use all three kinds of `produces`, and SDLC_DOCS staying quiet through them
 * now says something slightly different but still worth asserting — that what remains in that
 * file is about sdlc alone and does not fire on another flow's manifest.
 *
 * CASE 4 IS THE ONE THE TASK IS ABOUT. A one-way check — resolve `produces` forward, confirm
 * the document exists — passes a manifest where a document points at a stage that points
 * somewhere else. Case 4 is exactly that manifest: every stage's `produces` resolves, every
 * document is produced by some stage, and only the reciprocity fails. It also asserts
 * `catalog-stages.ts`'s "a document's declared stage is a stage its flow has" stays QUIET,
 * because the stage it names is real — which is the difference between the two rules, measured.
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

// Exact paths, one file each, outside the repository. A directory copy into a stale path is
// how an agent on this initiative destroyed two source trees.
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

/** One gate run, as two maps: every check that RAN, and the sentence each failing one gave. */
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

/** Assert, for one mutation: the named checks ran, the ones that should fire did, the ones
 *  that should not did not. Everything else the gate says is deliberately not its business —
 *  STATE.md's declared check count goes stale the moment a check is added, and the lock and
 *  the marketplace go red on any manifest edit at all. */
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
// start green. OUTSIDE the try, because process.exit skips a finally and a refusal that ran a
// cleanup it did not need reads as a cleanup somebody can rely on. Nothing is planted yet.
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
  if (!kinds.has("record") || !kinds.has("nothing")) {
    fail.push(`zz-plugin-eval declares neither a "record" nor a "nothing" stage (${[...kinds].join(", ")}) — the control has no subject`);
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
  // 1. A STAGE WITH NO produces. Planted on zz-plugin-locate, whose produces is "nothing", so
  //    removing it orphans no document and this case tests presence and nothing else.
  //    `manifests-conform.ts` fires too — it hardcodes zz-plugin-eval in a list of four — and
  //    that is named here rather than hidden: presence is the one property already covered for
  //    today's four packages, and the fifth flow anybody adds is covered only by MINE.
  mutate(EVAL, (m) => { delete (m.stages ?? []).find((s) => s.name === "zz-plugin-locate")!.produces; });
  measure("a stage with no produces", { fires: [MINE, CONFORM], quiet: [SDLC_DOCS, DOC_STAGE] });
  restore();

  // 2. produces NAMING A DOCUMENT THE MANIFEST DOES NOT DECLARE. On the same "nothing" stage,
  //    for the same reason: nothing is orphaned, so the only thing broken is the forward claim.
  mutate(EVAL, (m) => { (m.stages ?? []).find((s) => s.name === "zz-plugin-locate")!.produces = "invented.md"; });
  measure("produces naming a document the flow does not declare",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 3. A DECLARED DOCUMENT PRODUCED BY NO STAGE. No `stage` field on it, which is what makes it
  //    invisible to catalog-stages.ts — that check skips a document with no stage — and the
  //    reason this is a separate loop in the check rather than the mirror of the first one.
  mutate(EVAL, (m) => { m.documents!.push({ name: "orphan.md", role: "ground" }); });
  measure("a declared document produced by no stage",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 4. THE ONE-WAY CASE. findings.md keeps pointing at a REAL stage — zz-plugin-judge, which
  //    produces "record" — while zz-plugin-report goes on producing findings.md. Forward
  //    resolution passes, no document is orphaned, and catalog-stages.ts's "a document's
  //    declared stage is a stage its flow has" passes because the stage exists. Only reciprocity
  //    breaks, and only a two-way check can see it.
  mutate(EVAL, (m) => { (m.documents ?? []).find((d) => d.name === "findings.md")!.stage = "zz-plugin-judge"; });
  measure("a document naming a stage that produces something else",
          { fires: [MINE], quiet: [SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 5. CONTROL — "record" and "nothing" are ANSWERS. Swapped between the two non-document
  //    values only: changing a document-producing stage would orphan its document and redden
  //    the gate for a different and correct reason. Not vacuous — under a rule demanding a
  //    document name from every stage, both of these fire.
  mutate(EVAL, (m) => {
    (m.stages ?? []).find((s) => s.name === "zz-plugin-locate")!.produces = "record";
    (m.stages ?? []).find((s) => s.name === "zz-plugin-profile")!.produces = "nothing";
  });
  measure('CONTROL: "record" and "nothing" swapped between two non-document stages',
          { quiet: [MINE, SDLC_DOCS, CONFORM, DOC_STAGE] });
  restore();

  // 6. CONTROL — the same, in the flow whose output is the REPOSITORY. sdlc-execute produces
  //    "nothing"; a check that demanded a document here would force a fake build.md into
  //    existence. SDLC_DOCS is deliberately NOT in `quiet`: it asserts sdlc-execute declares
  //    "nothing" by name, so it fires on this edit, correctly, and that is its rule and not
  //    this one's.
  mutate(SDLC, (m) => { (m.stages ?? []).find((s) => s.name === "sdlc-execute")!.produces = "record"; });
  measure('CONTROL: sdlc-execute, whose output is the repository, declares "record"',
          { quiet: [MINE, DOC_STAGE] });
  restore();

  // 7. CONTROL — A NON-FLOW PACKAGE IS NOT THIS CHECK'S SUBJECT. zz-access declares no
  //    documents, so it is not a flow, so a stage of it is not asked what it produces. The
  //    stage names a skill zz-access really ships and is not its entry skill, so neither
  //    "stages names a skill it ships" nor the phantom-stage rule fires on the shape itself.
  //    CONFORM is not in `quiet`: it hardcodes zz-access and demands produces of every stage of
  //    it whether or not it is a flow, so it fires — which is the point, since a check that
  //    iterated every package rather than every FLOW would do the same, and MINE must not.
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
