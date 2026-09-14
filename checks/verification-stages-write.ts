// The three verification stages leave a document, and keep their independence.
//
// THE MANIFEST CLAIMS, THIS CHECK MAKES THE CLAIM TRUE. Task I-23 gave `sdlc-spec-audit`,
// `sdlc-plan-audit` and `sdlc-review` a `produces` entry each, and @zz/contracts calls a
// document name there "a CLAIM the rest of the manifest can be held to". For one task the
// flow declared three documents no skill wrote — a stage that produces nothing a reader can
// open, announced to every caller of `skill_view` as though it did.
//
// WHERE THE INSTRUCTION LIVES IS NOT THE SAME FOR ALL THREE, and this check follows it rather
// than demanding one shape. The two audits load `sdlc-audit-criteria` first and delegate to it
// — the eleven failure modes, the JSON envelope, and now the mechanics of recording a round —
// keeping only what is theirs: which document, and what that document is for. `sdlc-review`
// loads no library and inlines everything, its own ten categories included. Forcing review to
// delegate to a skill it never opens would be the real asymmetry.
//
// SO THE LIBRARY IS READ ONLY WHEN THE SKILL ACTUALLY REFERENCES IT. Concatenating it
// unconditionally would assert a property of a file the worker may never open: an audit that
// dropped its "Load `sdlc-audit-criteria` first" line would keep passing while its worker was
// never told to write anything. Keyed on the reference, that mutation goes red.
//
// WHAT THIS CHECK ASSERTS BEYOND THE PLAN'S DRAFT, and why. The plan authored a shorter
// version of this file. Measured against the untouched tree it discriminated correctly on the
// WRITE (7 failures), and measured against a tree where all three skills write their document
// but have had every independence sentence deleted from their bodies, it printed
// "verification stages write: ok". Two reasons, both verified by running it:
//
//   - `/read-only|do not.*(edit|fix)/i` was tested against the WHOLE file, and every one of
//     these three carries "Read-only." in its frontmatter `description:`. No rewrite of the
//     body can ever clear that string, so the control could not fail.
//   - the `sdlc-review`-only `/did not write/i` control matched the same frontmatter line.
//     Deleting "You did not write this code" from the body left it green.
//
// THE CROSS-FILE CLASS IS GUARDED, the general form: whatever a stage says to load is read,
// and an unqualified ban on writing in ANY of it fails. What is NOT guarded is the reverse
// direction — a library requiring something the stage forbids — and prohibitions phrased in
// words these three patterns do not cover.
//
// THE OTHER LIMIT, stated rather than discovered later: it asserts that the tool is
// NAMED where the recording is instructed, not that any particular sentence is imperative.
// Deleting one of two mentions of `document_write` from the library's recording paragraph
// leaves it green — and correctly so, because the surviving sentences still tell the worker to
// write. What it does catch is the recording instruction going away entirely, which is the
// failure that matters and is mutation-tested below.
//
// So bodies are what is tested here, with frontmatter and HTML design notes cut away first.
// And `read-only` is no longer the string being looked for: `sdlc-review` says "Read-only git
// is available" in an unrelated instruction about establishing the change-set, which would
// satisfy a bare /read-only/ match forever.
import { readFileSync } from "node:fs";

const fail: string[] = [];
const skillPath = (name: string) => `catalog/sdlc/sdlc-flow/skills/${name}/SKILL.md`;

// FROM THE MANIFEST, not from a list retyped here. This check and `sdlc-documents.mjs` would
// otherwise be two copies of one fact, and a rename in flow.json would leave this one testing
// a document name nothing produces any more.
interface Stage { name: string; produces?: string }
interface Flow { stages?: Stage[] }
const flow: Flow = JSON.parse(readFileSync("catalog/sdlc/sdlc-flow/flow.json", "utf8"));
const produces = new Map((flow.stages ?? []).map(
  (s): [string, string | undefined] => [s.name, s.produces]));

// THE LOAD IMPERATIVE, not a mention of a name. Both audits ALSO refer to their library in
// passing ("the eleven failure modes in `sdlc-audit-criteria` are about prose"), and keying on
// the bare name let an audit delete its "Load ... first" instruction and keep passing on the
// strength of that aside — measured, it printed ok. This is the sentence that actually makes a
// worker open the file, so this is the sentence delegation is keyed on. Not hard-coded to one
// library: whatever a stage says to load is what this follows.
const LOAD_IMPERATIVE = /Load `([a-z0-9-]+)` first/g;

// AN UNQUALIFIED BAN ON WRITING. "Change nothing" was written when nothing in this flow wrote
// anything, so it meant "do not fix what you are auditing" and read as "do not write at all".
// Once a stage writes its findings, the unqualified form is a worker being handed two opposite
// instructions in one run — and the one that carried it, `sdlc-audit-criteria:28`, is a file the
// stage skills LOAD rather than one of the three this check reads. It matched no "writes no
// file" pattern either, so nothing here would have seen it. A scoping phrase in the same
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

// The BODY: frontmatter and HTML comments removed. A design note explaining that read-only is
// a discipline is commentary about the skill; the worker is instructed by the prose.
const bodyOf = (text: string) =>
  text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");

for (const stage of STAGES) {
  const doc = produces.get(stage);
  if (!doc || !doc.endsWith(".md")) {
    fail.push(`${stage} produces ${doc ?? "nothing the flow declares"}, so there is no document to write`);
    continue;
  }
  const own = bodyOf(readFileSync(skillPath(stage), "utf8"));

  // NAMING ITS OWN DOCUMENT IS THE STAGE'S OWN JOB and is never delegated: the library serves
  // both audits and cannot say which of the two documents this worker is writing.
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

  // NOTHING THE WORKER IS HANDED MAY FORBID THE WRITE THE STAGE OWES — including a file the
  // stage merely loads. This is the cross-file half, and it is the half that was unguarded.
  for (const [name, body] of sources) {
    for (const ban of unqualifiedBans(body)) {
      fail.push(`${stage} must write ${doc}, but ${name === stage ? "it" : `${name}, which it loads,`} ` +
                `says "${ban}" with nothing scoping it to the material under review`);
    }
  }

  // 1. THE WRITE. The document the manifest promises, through the platform's write tool.
  if (!/document_write/.test(reach)) fail.push(`${where} does not write its document`);
  if (/you write no file|write no file/i.test(reach)) fail.push(`${where} still says it writes no file`);

  // 2. THE APPEND. `document_write` is create-or-OVERWRITE and there is no append tool, so
  // three audit rounds through a bare write leave one round on the record and silently
  // destroy the two the method exists to make possible. The read is what makes it an append.
  if (!/document_read/.test(reach)) {
    fail.push(`${where} writes ${doc} without reading it first, so a later round overwrites the earlier ones`);
  }

  // 3. THE REPORT SURVIVES THE DOCUMENT. The dispatching agent decides what happens next from
  // the returned JSON; a stage that wrote its file and returned prose has broken the caller.
  if (!/FINAL text response|FINAL response/i.test(reach)) {
    fail.push(`${where} no longer says its JSON block is the final text response`);
  }

  // 4. INDEPENDENCE SURVIVES THE WRITE — the control the whole task turns on. Recording a
  // finding is not fixing one, and a stage that fixes what it finds removes the evidence that
  // anything was ever wrong. Bodies only, and not the word "read-only", for the reasons above.
  if (!/chang(e|es|ing) nothing|do not (edit|fix)|not fixing/i.test(reach)) {
    fail.push(`${where} lost its read-only discipline: nothing says it changes nothing in what it is given`);
  }
  if (!/did not write/i.test(reach)) {
    fail.push(`${where} lost the reader-did-not-write-this discipline`);
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("verification stages write: ok");
