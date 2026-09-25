// The three verification stages leave a document, and keep their independence. A `produces`
// entry in the manifest is a claim; this check makes it true.
//
// Where the instruction lives differs by stage, and this check follows it rather than
// demanding one shape. The two audits load `sdlc-audit-criteria` first and delegate the
// failure modes, the JSON envelope and the mechanics of recording a round to it, keeping only
// which document and what it is for. `sdlc-review` loads no library and inlines everything,
// and leaves both kinds of record: its document `verifies` others, so its rounds are sources
// supporting that document and the document itself is written by the main agent.
//
// DELIBERATE: a library is read only when the skill references it by the load imperative.
// Concatenating it unconditionally would assert a property of a file the worker may never
// open, so an audit that dropped its "Load `sdlc-audit-criteria` first" line would keep
// passing while its worker was never told to write anything.
//
// DELIBERATE: bodies only, with frontmatter and HTML design notes cut away first, and the
// independence controls do not look for "read-only". The audits carry "Read-only." in their
// frontmatter `description:`, which no rewrite of a body can clear.
//
// What is not guarded: the reverse direction, a library requiring something the stage
// forbids; prohibitions phrased in words the BANS patterns do not cover; and whether any
// particular sentence is imperative — the check asserts the tool is named where the recording
// is instructed, so it catches the recording instruction going away entirely rather than one
// of two mentions of it.
import { readFileSync } from "node:fs";

const fail: string[] = [];
const skillPath = (name: string) => `catalog/sdlc/sdlc-flow/skills/${name}/SKILL.md`;

// From the manifest, not a list retyped here: a rename in flow.json would otherwise leave
// this check testing a document name nothing produces.
interface Stage { name: string; produces?: string; supports?: string }
interface Flow { stages?: Stage[]; documents?: Array<{ name: string; verifies?: string[] }> }
const flow: Flow = JSON.parse(readFileSync("catalog/sdlc/sdlc-flow/flow.json", "utf8"));
const produces = new Map((flow.stages ?? []).map(
  (s): [string, string | undefined] => [s.name, s.produces]));
const supports = new Map((flow.stages ?? []).map(
  (s): [string, string | undefined] => [s.name, s.supports]));
const verifying = new Set((flow.documents ?? []).filter((d) => d.verifies?.length).map((d) => d.name));

// DELIBERATE: the load imperative, not a mention of the library's name. Both audits also
// refer to their library in passing, so keying on the bare name lets an audit delete its
// "Load ... first" instruction and keep passing. Not hard-coded to one library: whatever a
// stage says to load is what this follows.
const LOAD_IMPERATIVE = /Load `([a-z0-9-]+)` first/g;

// An unqualified ban on writing: a stage that writes its findings and also says "change
// nothing" hands a worker two opposite instructions in one run. A scoping phrase in the same
// sentence is what makes it an instruction about the material rather than about writing.
const BANS = [/\bchange nothing\b/gi, /\bwrites? no file\b/gi, /\bdo not write it to a file\b/gi];
const SCOPED = /^[^.\n]{0,80}?\b(in|within|to) (the|its|that|what|any|this)\b/i;
const unqualifiedBans = (text: string) => {
  const hits = [];
  for (const re of BANS) {
    for (const m of text.matchAll(re)) {
      if (!SCOPED.test(text.slice(m.index + m[0].length))) hits.push(m[0].trim());
    }
  }
  return hits;
};
const STAGES = ["sdlc-spec-audit", "sdlc-plan-audit", "sdlc-review"];

// The body: frontmatter and HTML comments removed. A design note about the skill is not what
// instructs the worker.
const bodyOf = (text: string) =>
  text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");

for (const stage of STAGES) {
  // What this stage leaves, from the manifest: a document it writes, or a source supporting
  // one. The two audits produce evidence about the document they read; `sdlc-review` writes
  // the flow's closing document.
  const produced = produces.get(stage);
  const target = supports.get(stage);
  const isSource = produced === "source";
  if (isSource && !target) {
    fail.push(`${stage} produces a source and names no document in supports`);
    continue;
  }
  if (!isSource && (!produced || !produced.endsWith(".md"))) {
    fail.push(`${stage} produces ${produced ?? "nothing the flow declares"}, so there is nothing for it to leave`);
    continue;
  }
  const doc = isSource ? (target as string) : (produced as string);
  const own = bodyOf(readFileSync(skillPath(stage), "utf8"));

  // Naming its own target is never delegated: the library serves both audits and cannot say
  // which document this worker read.
  if (!own.includes(doc)) fail.push(`${stage} does not name ${doc}`);

  // Everything else may live in a library — but only one this stage says to load.
  const libs = [...own.matchAll(LOAD_IMPERATIVE)].map((m) => m[1]);
  const sources = [[stage, own]];
  for (const lib of libs) {
    try { sources.push([lib, bodyOf(readFileSync(skillPath(lib), "utf8"))]); }
    catch { fail.push(`${stage} says to load ${lib} first, and no such skill exists`); }
  }
  const reach = sources.map(([, body]) => body).join("\n");
  const where = libs.length ? `${stage} (nor ${libs.join(", ")}, which it loads)` : stage;

  // Nothing the worker is handed may forbid the write the stage owes, including a file the
  // stage merely loads.
  for (const [name, body] of sources) {
    for (const ban of unqualifiedBans(body)) {
      fail.push(`${stage} must write ${doc}, but ${name === stage ? "it" : `${name}, which it loads,`} ` +
                `says "${ban}" with nothing scoping it to the material under review`);
    }
  }

  // The artifact, through the platform's own tool: `source_add` for a stage whose result is
  // evidence, `document_write` for one that writes a document — and both for a stage whose
  // document verifies others, whose rounds are sources supporting it.
  const rounds = isSource || verifying.has(doc);
  if (rounds) {
    if (!/source_add/.test(reach)) fail.push(`${where} does not register its round as a source`);
    // `supports` ties the round to the document it read: the platform refuses that document's
    // next version until this source is cited.
    if (!/supports/.test(reach)) fail.push(`${where} registers a source without naming what it supports`);
    if (isSource && /document_write/.test(reach)) {
      fail.push(`${where} writes a document; an audit round is a source, and doing both puts ` +
                "one round on the record twice");
    }
  }
  if (!isSource) {
    if (!/document_write/.test(reach)) fail.push(`${where} does not write its document`);
    if (/you write no file|write no file/i.test(reach)) fail.push(`${where} still says it writes no file`);
    // `document_write` is create-or-overwrite and there is no append tool, so a second round
    // through a bare write destroys the first; the read is what makes it an append. A source
    // needs none of this — `source_add` writes a new file every time.
    if (!/document_read/.test(reach)) {
      fail.push(`${where} writes ${doc} without reading it first, so a later round overwrites the earlier ones`);
    }
  }

  // The report survives the document: the dispatching agent decides what happens next from
  // the returned JSON, so a stage that wrote its file and returned prose breaks its caller.
  if (!/FINAL text response|FINAL response/i.test(reach)) {
    fail.push(`${where} no longer says its JSON block is the final text response`);
  }

  // Independence survives the write: recording a finding is not fixing one, and a stage that
  // fixes what it finds removes the evidence that anything was wrong.
  if (!/chang(e|es|ing) nothing|do not (edit|fix)|not fixing/i.test(reach)) {
    fail.push(`${where} lost its read-only discipline: nothing says it changes nothing in what it is given`);
  }
  if (!/did not write/i.test(reach)) {
    fail.push(`${where} lost the reader-did-not-write-this discipline`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("verification stages write: ok");
