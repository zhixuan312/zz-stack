/**
 * The envelope: who writes its fields, and the single place each decision lives.
 *
 * `flow`, `type`, `status`, `version`, `approved_by` — the platform stamps all of them and no
 * model may write one. Every check here is about that boundary holding in one place.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contractsSource, gateOwnSource, root, sourceFiles, toolAtLine, unbuilt, zzCoreSource, withoutComments} from "../read.ts";
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
  // The reading half of this rule is "nothing reads an envelope field except parseEnvelope",
  // which covers every source. What is left here is the writing half: an envelope value
  // interpolated straight into `${k}: ${v}` is how a second `status:` line gets into a
  // document, after which two readers disagree about whether the gate passed.
  const bad: string[] = [];
  for (const rel of sourceFiles(["services", "packages"], [".ts"])) {
    let inRenderer = false;
    readFileSync(join(root, rel), "utf8").split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
      // `export ` too: the renderer is exported, so an exemption keyed to the unexported
      // form matches nothing.
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

// "One parser" only holds if nothing goes around it. A hand-rolled regex takes the first
// match where parseEnvelope takes the last, so an envelope carrying a field twice has two
// truths at once — one reader calling a document approved while another calls it draft.
check("nothing reads an envelope field except parseEnvelope", () => {
  // From the schema, not a hand-written list. A list here goes stale the first time a field
  // is added to the envelope elsewhere.
  const FIELDS = envelopeFields();
  if (FIELDS.length < 10) return "the envelope schema could not be read from @zz/contracts";
  // Reads only — `.match`, `.exec`, `.test`. A `.replace` on an envelope field is a write,
  // and the fix there is to scope the replacement to the frontmatter block so it cannot reach
  // a body line starting with the field name. Done at each site, because this check cannot
  // tell a scoped subject from an unscoped one.
  const field = new RegExp(String.raw`/\^(?:${FIELDS.join("|")}):`);
  const bad: string[] = [];
  // Any regex literal on an envelope field, not only one used on the same line: a pattern
  // assigned to a constant and used three lines down is the shape a same-line test misses.
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
  // that legitimately moves them. `via` is a bypass, so it is only safe while the list of
  // callers holding it is exactly the list that should.
  const ACTS = ["document_approve", "initiative_close", "document_revise"];
  const src = zzCoreSource();
  const lines = src.split("\n");
  const holders: { tool: string; via: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/documentGuards\(/.test(lines[i])) continue;
    const call = lines.slice(i, i + 3).join(" ");
    const via = /documentGuards\([^)]*,\s*"([a-z_]+)"\s*\)/.exec(call);
    if (!via) continue;
    // Which tool this call sits inside, from the one parser. Walking upward for a bare
    // `registerTool(` followed by a name line finds only the newline form, so a reformat to
    // `registerTool("document_approve", {` would report the act as passing the wrong `via`.
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
  // @zz/contracts holds the schema and everything else imports it. This check refuses a
  // second copy: the vocabulary as a literal list anywhere but the definition.
  const bad = [];
  // Every source file, not a named list of the ones somebody found a copy in.
  const files = sourceFiles(["services", "packages", "scripts"], [".ts"])
    .filter((f) => !f.startsWith("packages/contracts/"));
  // The words as a literal set — a list, an alternation, or a chain of comparisons against
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
    // This file has to spell the vocabulary to look for it, in copies just above. Exempted
    // by name, the way the comment-record check exempts it.
    if (gateOwnSource(f)) continue;
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;    // comments quote the vocabulary to explain it
      // A line held to the contract by the compiler is not a second copy: initiative_close()
      // names all three outcomes and is annotated `(typeof OUTCOMES)[number]`, so a typo
      // there fails the build.
      //
      // Judged over the whole statement, not the line — the annotation sits on the first line
      // and the words spill onto the second.
      let from = i;
      while (from > 0 && !/[;{}]\s*$/.test(lines[from - 1])) from -= 1;
      if (/\bOUTCOMES\b|\bSTATUSES\b|\bPLATFORM_OWNED\b/.test(lines.slice(from, i + 1).join(" "))) continue;
      if (COPIES.some((re) => re.test(line))) {
        bad.push(`${f}:${i + 1}`);
      }
    }
  }
  // And both schemas must still emit. jsonSchema throws on a construct it has no rule for,
  // so adding a zod type to the envelope turns /schemas/envelope.json into a 500 at request
  // time on a public endpoint while /health stays green. Emitting here moves that to the gate.
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
  // explicit act. So document_write and document_revise refuse content that opens with
  // frontmatter, and a skill still showing one in a fenced block teaches a call that fails on
  // the first save. Both halves are checked together: the refusal without the templates
  // breaks every flow, and the templates without the refusal drift back.
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
  // Two paths through stampEnvelope: a document the manifest declares gets flow, type, status
  // and version; a document it does not declare gets only the date.
  //
  // DELIBERATE: status and version are not stamped on the second path. That would assert a
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
  // The owned fields are stamped by document_approve() and initiative_close(), and a
  // hand write is refused. "no skill template hands a model a field the platform owns" stops
  // a skill template carrying one; this is the other half — the platform's own prose telling
  // an agent to write one.
  //
  // Judged on the joined sentence: a long message is built from several string literals, so
  // no single line holds both halves of it.
  const OWNED = `(${ownedFields().join("|")})`;
  const TELLS = new RegExp("(record|write|set|put|add|patch|fill|stamp)\\b.{0,70}?\\b" + OWNED + "\\b", "is");
  // The message the agent reads, not the expression that builds it. The words either side of
  // a `+` join are separated in source by a quote, a plus and a newline the reader never
  // sees, so the pattern has to cross that punctuation.
  const spoken = (buf: string): string => [...buf.matchAll(/`([^`]*)`|"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "").join(" ");
  // Prose that names the rule rather than instructing a write: the platform is the subject,
  // or the sentence already points at the act that does the stamping.
  const DESCRIBES = /platform|refus|by hand|document_approve\(|initiative_close\(|is stamped|are stamped|stamps /i;
  // Only text an agent reads. `status` is also a column on the `team` table, and
  // `update team set status = 'archived'` instructs nobody. The defect this check exists for
  // is always in a message: an ERROR, a tool description, or the `why` on a next_move.
  const SPEAKS = /ERROR:|\.describe\(|description:|why:/;
  // A second shape the verb-and-field pattern cannot see: prose that locates the gate in the
  // frontmatter rather than in the act. "A gate is not passed until the document's
  // frontmatter says so" names no owned field and gives no instruction.
  const LOCATES = /\bgate\b[^.]{0,60}\bfrontmatter\b|\bfrontmatter\b[^.]{0,60}\b(approv|gate)/i;
  // A third shape: the model writes no frontmatter at all, so any message telling it to put
  // something there is wrong, whatever the field. The two patterns above cover only the
  // fields the platform owns, and `flow` is a caller argument rather than one of them.
  const PUTS_IN_FRONTMATTER = /\b(add|put|set|write|record|include)\b[^.]{0,80}\bfrontmatter\b/i;
  const bad: string[] = [];
  // Every service source, not a named list. client-package.ts emits the router every agent on
  // every client reads, and a tool module writes refusals of its own: a file that speaks to an
  // agent is the rule.
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
      // client-package.ts is agent-facing end to end — every literal in it is text written
      // for another machine — so the ERROR:/description: markers that identify a message in a
      // server file would exclude all of it. admin.ts builds the generated agent preset, also
      // prose with no marker, but it runs SQL against the `principal` and `team` tables whose
      // own `status` column has nothing to do with a document's. So: prose in these files
      // counts as a message, and a statement does not.
      const isSql = /\b(update|insert into|delete from|select)\s/i.test(buf);
      const alwaysProse = f.endsWith("client-package.ts") || (f.endsWith("admin.ts") && !isSql);
      const isMessage = alwaysProse || SPEAKS.test(buf);
      // "Put X in the frontmatter" is wrong on its own terms, so it is judged without the
      // descriptive exemption. An exemption for prose that names the rule must not cover a
      // sentence that also gives the instruction.
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
  // Where a frontmatter block starts and ends is one fact, and the copies disagreed about how
  // it ends: `\n---`, `\n---[ \t]*\n?`, `\n---\n?` and a form requiring a newline after the
  // fence each read a fence written `--- `, or a document ending at its closing fence,
  // differently. A skill's frontmatter and a document's envelope are different vocabularies
  // inside the same syntax and share this one fact.
  //
  // Matched on the shape — an anchored `---` in a pattern that then spans lines — rather than
  // on any one spelling, since spelling is what hid three of them.
  const bad: string[] = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    if (rel === "packages/contracts/src/index.ts") continue;   // where it is defined
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
      // `/^---` … `[\s\S]` in one regex literal is a frontmatter block. A `/^---[ \t]*$/m`
      // is a single line and a different question — @zz/catalog uses one to find the
      // separator in a hand-written prompt file, which is not an envelope at all.
      for (const m of ln.matchAll(/\/\^---[^/\n]*\/[a-z]*/g)) {
        if (!/\[\\s\\S\]/.test(m[0])) continue;
        bad.push(`${rel}:${i + 1} spells the frontmatter block again as ${m[0]} — @zz/contracts ` +
                 "has ENVELOPE_BLOCK and documentBody, and the copies disagreed about the fence");
      }
    });
  }
  // And the definition has to still be there to point at.
  const contracts = withoutComments(contractsSource());
  if (!/export const ENVELOPE_BLOCK =/.test(contracts)) {
    bad.push("@zz/contracts no longer exports ENVELOPE_BLOCK, so there is nothing to spell once");
  }
  if (!/export function documentBody\(/.test(contracts)) {
    bad.push("@zz/contracts no longer exports documentBody, so every body strip must spell it again");
  }
  return bad.length ? bad.join("; ") : null;
});
