/**
 * The envelope: who writes its fields, and the single place each decision lives.
 *
 * `flow`, `type`, `status`, `version`, `approved_by` — the platform stamps all of them, and
 * the whole governance story rests on a model never being able to write one. Every check
 * here is about that boundary holding in exactly one place.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contractsSource, gateOwnSource, root, sourceFiles, toolAtLine, unbuilt, zzCoreSource } from "../read.ts";
import { check } from "../run.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. Here it is an `execFileSync` failure, which carries `stdout`/`stderr`
 *  rather than a plain `message`. */
function execStderr(err: unknown): string {
  const e = err && typeof err === "object" ? err as Record<string, unknown> : {};
  return e.stderr !== undefined ? String(e.stderr) : String(err);
}
import { envelopeFields, ownedFields } from "../facts.ts";

check("one function decides what a document's envelope says", () => {
  // The READING half of this rule lives in "nothing reads an envelope field except
  // parseEnvelope", which covers every source rather than the four files this named. Two
  // checks for one rule is the shape this repository refuses everywhere else, and here the
  // narrower one would have decided wherever they disagreed.
  //
  // What is left is the WRITING half, which nothing else covers: an envelope value
  // interpolated straight into `${k}: ${v}` is how a second `status:` line got into a
  // document in the first place, after which initiative_status reported the gate as passed
  // and named a fabricated approver while document_write still called the document draft.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    let inRenderer = false;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      // `export ` too: the renderer moved into its own module when zz-core was split, and an
      // exemption keyed to the unexported form stopped matching the one function it exists for.
      if (/^(export )?function renderEnvelope\b/.test(line)) inRenderer = true;   // the renderer itself
      else if (inRenderer && line === "}") inRenderer = false;
      if (inRenderer) return;
      if (/`\$\{k\}: \$\{/.test(line) && !/renderEnvelope/.test(line)) {
        bad.push(`${rel}:${i + 1}: renders an envelope line by hand — use renderEnvelope`);
      }
    });
  }
  return bad.length ? bad.join("; ") : null;
});

// "ONE parser" only holds if nothing goes around it, and things kept going around it. Four
// regexes read `status` before parseEnvelope existed; three more survived it — `version`
// scanned the WHOLE document rather than the frontmatter, and two read `flow` — and all of
// them took the FIRST match where parseEnvelope takes the LAST. An envelope with two of a
// field therefore had two different truths at once, which is how initiative_status once
// called a document approved while document_write called it draft.
//
// A field list rather than a guess at what a regex is for: it is exact, and the day the
// envelope grows a field, adding it here is the same edit as adding it anywhere else.
check("nothing reads an envelope field except parseEnvelope", () => {
  // FROM THE SCHEMA. This was twelve names written out here, and the envelope has eighteen —
  // so `closed_by`, `no_signoff_reason`, `supports`, `sources`, `tags`, `date`, `added_at`
  // and `title` could each be read by a hand-rolled regex and nothing would say so. The
  // comment that stood here argued a list was fine because "adding a field here is the same
  // edit as adding it anywhere else". It was not: eight fields were added elsewhere and not
  // here, which is what a second copy always does.
  const FIELDS = envelopeFields();
  if (FIELDS.length < 10) return "the envelope schema could not be read from @zz/contracts";
  // READS only — `.match`, `.exec`, `.test`. A `.replace` on an envelope field is a WRITE,
  // and parseEnvelope is not its answer: the fix there is to scope the replacement to the
  // frontmatter block so it cannot reach a body line that happens to start with the field
  // name. That is done at each site rather than checked here, because this check cannot
  // tell a scoped subject from an unscoped one.
  const field = new RegExp(String.raw`/\^(?:${FIELDS.join("|")}):`);
  const bad: string[] = [];
  // ANY regex literal on an envelope field, not only one used on the same line. This asked
  // for `.match`, `.exec` or `.test` beside it, so a pattern assigned to a constant and used
  // three lines down was invisible — and a second, narrower copy of this same rule lived in
  // "one function decides what a document's envelope says", which caught that shape across
  // four files and only four. Two checks for one rule means the weaker one decides where
  // they disagree; there is one now, and it is this.
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    // The parser itself is where the regexes belong.
    if (rel === join("packages", "contracts", "src", "index.ts")) continue;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((line, i) => {
      if (!field.test(line)) return;
      if (/\.replace\(/.test(line)) return;   // a write, scoped at its own site
      bad.push(`${rel}:${i + 1} reads an envelope field with its own regex`);
    });
  }
  return bad.length
    ? `${bad.join("; ")} — route it through parseEnvelope, which takes the last value of a ` +
      "repeated key and reads the frontmatter rather than the whole document"
    : null;
});

check("only an act may move the fields the platform owns", () => {
  // ownershipCheck refuses a write that introduces or changes status, approved_by,
  // approved_at, outcome or closed_by — unless the caller passes `via`, saying it is the act
  // that legitimately moves them. That makes `via` a bypass, and a bypass is only safe while
  // the list of callers holding it is exactly the list that should.
  //
  // Both directions have already bitten once each in the same afternoon: document_revise,
  // whose entire job is to move status back to draft, was refused by the guard until it said
  // so; and the guard itself was claimed in a tool description before it existed. A rule
  // this easy to get backwards belongs in the gate rather than in someone's memory.
  const ACTS = ["document_approve", "initiative_close", "document_revise"];
  const src = zzCoreSource();
  const lines = src.split("\n");
  const holders: { tool: string; via: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/documentGuards\(/.test(lines[i])) continue;
    const call = lines.slice(i, i + 3).join(" ");
    const via = /documentGuards\([^)]*,\s*"([a-z_]+)"\s*\)/.exec(call);
    if (!via) continue;
    // Which tool this call sits inside, from the one parser. Walking upward for a line that
    // is exactly `  "name",` under a bare `registerTool(` only ever found the newline form —
    // reformat approve to `registerTool("document_approve", {` and its guard call became "(unknown)",
    // which this check reports as an act passing the wrong `via`. A confusing failure about a
    // reformat, in the check that guards who may own a document's fields.
    const tool = toolAtLine(src, i) ?? "(unknown)";
    holders.push({ tool, via: via[1], line: i + 1 });
  }
  const wrong = holders.filter((h) => !ACTS.includes(h.tool) || h.via !== h.tool);
  const missing = ACTS.filter((a) => !holders.some((h) => h.tool === a));
  const bad = [
    ...wrong.map((h) => `server.ts:${h.line} — ${h.tool} passes via "${h.via}"`),
    ...missing.map((a) => `${a} no longer passes via, so its own writes are refused`),
  ];
  return bad.length
    ? `${bad.join("; ")} — \`via\` says "this is the act that owns these fields"; only ` +
      `${ACTS.join(", ")} may say it, and each may say only its own name`
    : null;
});

check("the envelope vocabulary is defined once", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // status, outcome and the five platform-owned fields were literals in three places at
  // once: const arrays in zz-core, a regex inside statusCheck, and a TypeScript interface in
  // @zz/catalog describing the same manifest zz-core described again in a narrower local
  // view. Nothing tied them together, so a word could be added in one and enforced in
  // neither — and none of the three could be shown to somebody writing a flow from outside.
  //
  // @zz/contracts holds the schema and everything else imports it. This check refuses a
  // second copy: the vocabulary as a literal list anywhere but the definition.
  const bad = [];
  // EVERY source file, not a list of the four that had a copy. Named files are the instances
  // somebody found; the rule is that the vocabulary lives in @zz/contracts and nowhere else.
  // manifest-audit spelled the statuses out for as long as it existed and was never in the
  // list — it imports parseEnvelope from the contract already, so nothing stopped it
  // importing the words too.
  // .mjs too, because THIS FILE is .mjs and had four copies of the vocabulary in it: the
  // owned fields twice as a regex and once as a string, and the envelope's field list a
  // fourth time. The check that refuses second copies could not see the file it lives in.
  const files = sourceFiles(["services", "packages", "scripts"], [".ts"])
    .filter((f) => !f.startsWith("packages/contracts/"));
  // The words as a LITERAL SET — a list, an alternation, or a chain of comparisons against
  // each of them — rather than any mention of them.
  const COPIES = [
    /\[\s*"draft"\s*,\s*"approved"\s*\]/,
    /\(\s*draft\s*\|\s*approved\s*\)/,
    /\[\s*"delivered"\s*,\s*"accepted"\s*,\s*"abandoned"\s*\]/,
    /\[\s*"status"\s*,\s*"approved_by"\s*,\s*"approved_at"/,
    /"draft"[\s\S]{0,24}"approved"|"approved"[\s\S]{0,24}"draft"/,
    /"delivered"[\s\S]{0,40}"accepted"|"accepted"[\s\S]{0,40}"delivered"/,
  ];
  for (const f of files) {
    // This file has to SPELL the vocabulary to look for it, in COPIES just above. Exempted
    // by name, the way the comment-record check exempts it for the same reason.
    if (gateOwnSource(f)) continue;
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;    // comments quote the vocabulary to explain it
      // A line held to the contract BY THE COMPILER is not a second copy. initiative_close() must name
      // all three outcomes — it is where the platform derives which one applies — and it is
      // annotated `(typeof OUTCOMES)[number]`, so a typo there fails the build.
      // Over the whole STATEMENT, not the line: the annotation sits on the first line and the
      // words spill onto the second, so a line-only test exempted the declaration and flagged
      // its own continuation. Split ONCE — this sat inside the loop, re-splitting an
      // eight-thousand-line file for every one of its lines.
      let from = i;
      while (from > 0 && !/[;{}]\s*$/.test(lines[from - 1])) from -= 1;
      if (/\bOUTCOMES\b|\bSTATUSES\b|\bPLATFORM_OWNED\b/.test(lines.slice(from, i + 1).join(" "))) continue;
      if (COPIES.some((re) => re.test(line))) {
        bad.push(`${f}:${i + 1}`);
      }
    }
  }
  // And both schemas must still EMIT. jsonSchema throws on a construct it has no rule for —
  // deliberately, because publishing a schema weaker than the one being validated against
  // would be worse than none. The cost of that choice is that adding a zod type to the
  // envelope turns /schemas/envelope.json into a 500 at request time, on a public endpoint,
  // while /health stays green. Emitting them here moves that to the gate.
  const emit = `
    import { Envelope, CatalogManifest, jsonSchema } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const out = [];
    for (const [name, schema] of [["envelope", Envelope], ["manifest", CatalogManifest]]) {
      try {
        const js = jsonSchema(schema);
        if (!js.properties || !Object.keys(js.properties).length) out.push(name + " emitted no properties");
      } catch (e) { out.push(name + " cannot be emitted: " + e.message); }
    }
    process.stdout.write(out.join("; "));
  `;
  try {
    const emitted = execFileSync("node", ["--input-type=module", "-e", emit], { encoding: "utf8" }).trim();
    if (emitted) bad.push(emitted);
  } catch (err) {
    bad.push(`the schemas could not be emitted: ${execStderr(err).slice(-200)}`);
  }
  return bad.length
    ? `${bad.join(", ")} — @zz/contracts defines this vocabulary; import STATUSES, ` +
      "OUTCOMES or PLATFORM_OWNED rather than restating it, and keep both schemas emittable"
    : null;
});

check("the model writes the body and the platform writes the envelope", () => {
  // Every envelope field comes either from a fact the platform holds — which flow governs
  // this initiative, what role the manifest gives the document, what day it is — or from an
  // explicit act. "The model typed it into some YAML" was a third source, and the cost was
  // countable: of 93 approved documents here, four had no approved_at and two no
  // approved_by; two smoke runs signed a gate as `team_one`, a team slug; the first
  // live run closed an initiative `accepted` that nobody had accepted. The ANONYMOUS
  // blocklist exists to catch the worst of that, and its own comment admits there is no way
  // to test whether a string is a person — it exists only because a model typed the field.
  //
  // So document_write and document_revise refuse content that opens with frontmatter, and a
  // skill that still shows one in a fenced block is teaching a call that now fails on the
  // first save. Both halves, together: the refusal without the templates would break every
  // flow, and the templates without the refusal would drift straight back.
  const src = zzCoreSource();
  const bad: string[] = [];
  for (const tool of ["document_write", "document_revise"]) {
    if (!new RegExp(`frontmatterRefusal\\(content, "${tool}"\\)`).test(src)) {
      bad.push(`${tool} accepts frontmatter the model composed`);
    }
  }
  for (const rel of sourceFiles(["catalog", "skills"], ["SKILL.md"])) {
    let fenced = false;
    for (const [i, line] of readFileSync(join(root, rel), "utf8").split("\n").entries()) {
      if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
      // A fenced document template opening with `---` is a frontmatter template.
      if (fenced && /^---[ \t]*$/.test(line)) {
        bad.push(`${rel}:${i + 1} still templates frontmatter`);
        break;
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("the envelope is stamped by what governs the document", () => {
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  // Two paths through stampEnvelope, and the second one is easy to forget: a document the
  // manifest DECLARES gets flow, type, status and version; a document it does not — and
  // `learnings.md` is one, because the handover is the platform's step appended below every
  // manifest — gets only the date. It used to get nothing at all, which was invisible while
  // the model still wrote frontmatter and became a document with no date in it the moment
  // that stopped. The index was fine throughout: it stamps now() itself. The FILE was not,
  // and the file is what a team keeps when they walk away from us.
  //
  // Stamping status or version there would be worse than the gap: the platform asserting a
  // gate lifecycle for a document no flow governs.
  try {
    const out = execFileSync("node", [join(root, "scripts/probes/envelope-shape.ts"), root],
                             { encoding: "utf8" });
    return out.trim() || null;
  } catch (err) {
    return `the envelope shape could not be read: ${execStderr(err).slice(-200)}`;
  }
});

check("nothing tells an agent to write a field the platform owns", () => {
  // The five owned fields are stamped by document_approve() and initiative_close(), and a hand write is refused.
  // "no skill template hands a model a field the platform owns" stops a skill TEMPLATE
  // carrying one. This is the other half: the platform's
  // own prose telling an agent to write one.
  //
  // initiative_status is where it mattered. That tool computes "the next move" and is
  // consulted every turn, and it said a gate "must be recorded in the frontmatter" and told
  // the agent to "record the outcome on spec.md" — both of which the platform now refuses. An
  // agent following the next_move it is told to trust would be refused by the very write it
  // was sent to make, with no way to reconcile the two.
  //
  // Two more got past the first version of this check, and both say something about how to
  // write it. gateCheck told the agent to "patch <doc>'s frontmatter (status: approved,
  // approved_by, approved_at)" — the verb list did not have `patch`. The close-time gate
  // error said "Record the approval — status: approved with approved_by and approved_at",
  // built by concatenating four string literals, so no single LINE held both halves and a
  // line-at-a-time scan could not see it. Messages are written across lines because they are
  // long; the agent reads the joined sentence, so the check now reads it that way too.
  const OWNED = `(${ownedFields().join("|")})`;
  const TELLS = new RegExp("(record|write|set|put|add|patch|fill|stamp)\\b.{0,70}?\\b" + OWNED + "\\b", "is");
  // The message the agent reads, not the expression that builds it. A long error is written
  // as several literals joined by `+`, so the words either side of a join are separated in
  // SOURCE by a quote, a plus and a newline that the reader never sees. Matching across that
  // punctuation is what the earlier version could not do: "Record the " + "approval — status:
  // approved" reads as one sentence and was stored as two strings, and a pattern that refused
  // to cross a quote could not see the sentence at all.
  const spoken = (buf: string): string => [...buf.matchAll(/`([^`]*)`|"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "").join(" ");
  // Prose that names the rule rather than instructing a write: the platform is the subject,
  // or the sentence already points at the act that does the stamping.
  const DESCRIBES = /platform|refus|by hand|document_approve\(|initiative_close\(|is stamped|are stamped|stamps /i;
  // Only text an AGENT READS. `status` is also a column on the `team` table and a filter in
  // the index query, and `update team set status = 'archived'` is not an instruction to
  // anyone — judging those by the same words called three correct lines defects. The bug this
  // check exists for is always in a message: an ERROR, a tool description, or the `why` on a
  // next_move. Scanning that surface is the question rather than a proxy for it.
  const SPEAKS = /ERROR:|\.describe\(|description:|why:/;
  // A SECOND shape, which the verb-and-field pattern cannot see: prose that locates the
  // gate in the frontmatter rather than in the act. "A gate is not passed until the
  // document's frontmatter says so" names no owned field and gives no instruction, and it
  // was sitting in the generated agent preset — the prompt every LibreChat agent on this
  // platform is built on — saying the opposite of what the platform now does. The router
  // skill said it too. Both were true before document_approve() existed, which is exactly why this
  // phrasing outlives the thing it described.
  const LOCATES = /\bgate\b[^.]{0,60}\bfrontmatter\b|\bfrontmatter\b[^.]{0,60}\b(approv|gate)/i;
  // A THIRD shape, and the simplest — which is why it should have been the rule from the
  // start. Since the model writes no frontmatter at all, ANY message telling it to put
  // something there is wrong, whatever the field. Both patterns above are about the fields
  // the platform OWNS, so flowDeclarationCheck's "Add `flow: <name>` to this document's
  // frontmatter" slipped past both: `flow` is a caller ARGUMENT now, not an owned field.
  const PUTS_IN_FRONTMATTER = /\b(add|put|set|write|record|include)\b[^.]{0,80}\bfrontmatter\b/i;
  const bad: string[] = [];
  // EVERY service source, not the four somebody thought of. This list grew twice by being
  // wrong: the three server files were scanned and client-package.ts — which EMITS the router
  // every agent on every client reads — was not, and its text said "a gate passes only once
  // the document's frontmatter records the approval", true before document_approve() existed and an
  // instruction to do a refused thing after. kb.ts registers tools and writes refusals of its
  // own and was never in the list either. A file that speaks to an agent is the rule; naming
  // the files is a list that goes stale the next time one is added.
  for (const f of sourceFiles(["services"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    const lines = src.split("\n");
    let buf = "", start = 0;
    for (const [i, line] of lines.entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) { buf = ""; continue; }   // comments explain the rule
      if (!buf) start = i;
      buf += " " + line.trim();
      // A message split across concatenated literals is one sentence; keep joining until the
      // expression ends, then judge the whole thing.
      if (/\+\s*$/.test(line.trim())) continue;
      const said = spoken(buf);
      // client-package.ts is agent-facing END TO END — every literal in it is text written
      // for another machine to read — so the ERROR:/description: markers that identify a
      // message in a server file would exclude all of it. Widening the file list without
      // this changed nothing, which is what testing the check rather than trusting it showed.
      // admin.ts builds the generated agent preset — prose for a machine, with no ERROR: or
      // description: to mark it — but it also runs SQL against the `principal` and `team`
      // tables, whose own `status` column has nothing to do with a document's. Adding the
      // file wholesale called `update team set status = 'archived'` a defect. So: prose in
      // these files counts as a message, and a statement does not.
      const isSql = /\b(update|insert into|delete from|select)\s/i.test(buf);
      const alwaysProse = f.endsWith("client-package.ts") || (f.endsWith("admin.ts") && !isSql);
      const isMessage = alwaysProse || SPEAKS.test(buf);
      // "Put X in the frontmatter" is wrong on its own terms, so it is judged WITHOUT the
      // descriptive exemption. flowDeclarationCheck's sentence both instructed and explained
      // — "Add `flow: <name>` to this document's frontmatter — the platform stamps every
      // later document from it" — and the word `platform` in the second half exempted the
      // first. An exemption for prose that names the rule must not cover a sentence that
      // also gives the instruction.
      const flat = PUTS_IN_FRONTMATTER.test(said);
      const owned = (TELLS.test(said) || LOCATES.test(said)) && !DESCRIBES.test(said);
      if (isMessage && (flat || owned)) bad.push(`${f.split("/").pop()}:${start + 1}`);
      buf = "";
    }
  }
  return bad.length
    ? `${bad.join(", ")} tell an agent to write a field the platform stamps — name document_approve() or initiative_close() instead`
    : null;
});

check("where a frontmatter block starts and ends is spelled once", () => {
  // EIGHT spellings across three packages, and they did not agree on how a block ENDS.
  // parseEnvelope closed on `\n---`; zz-core's five on `\n---[ \t]*\n?`; indexDoc's body-strip
  // on `\n---\n?`, which does not tolerate a trailing space on the fence; kb.ts's document
  // read required a newline after it, so a document ending exactly at its closing fence had a
  // full envelope to one and none at all to the other.
  //
  // Consolidating those left three more that a search for `^---[ ` could not see, because
  // they were written `^---[\s\S]` and `^---\n`: the sources panel's body strip, and
  // client-package's two reads of a SKILL's frontmatter. A skill's frontmatter and a
  // document's envelope are different vocabularies inside the same syntax, and where that
  // block starts and ends is one fact — the copies that required `---\n` exactly parsed a
  // fence written `--- ` differently from the ones that did not.
  //
  // Matched on the SHAPE — an anchored `---` in a pattern that then spans lines — rather than
  // on any one spelling, since spelling is what hid three of them.
  const bad: string[] = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    if (rel === "packages/contracts/src/index.ts") continue;   // where it is defined
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      // `/^---` … `[\s\S]` in one regex literal is a frontmatter BLOCK. A `/^---[ \t]*$/m`
      // is a single LINE and a different question — @zz/catalog uses one to find the
      // separator in a hand-written prompt file, which is not an envelope at all.
      for (const m of ln.matchAll(/\/\^---[^/\n]*\/[a-z]*/g)) {
        if (!/\[\\s\\S\]/.test(m[0])) continue;
        bad.push(`${rel}:${i + 1} spells the frontmatter block again as ${m[0]} — @zz/contracts ` +
                 "has ENVELOPE_BLOCK and documentBody, and the copies disagreed about the fence");
      }
    });
  }
  // And the definition has to still be there to point at.
  const contracts = contractsSource();
  if (!/export const ENVELOPE_BLOCK =/.test(contracts)) {
    bad.push("@zz/contracts no longer exports ENVELOPE_BLOCK, so there is nothing to spell once");
  }
  if (!/export function documentBody\(/.test(contracts)) {
    bad.push("@zz/contracts no longer exports documentBody, so every body strip must spell it again");
  }
  return bad.length ? bad.join("; ") : null;
});
