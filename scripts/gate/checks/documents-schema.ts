/**
 * The published schema against the validator that enforces it.
 *
 * Two artifacts describing one contract: a schema clients read to know what is allowed, and
 * the code that decides. They are checked in BOTH directions here — a schema weaker than the
 * validator promises what will be refused, and a schema stricter than it hides what works.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, contractsSource, firstOf, functionBody, root, sourceFiles, trackedFiles, unbuilt, zzCoreSource, zzCoreTools } from "../read.ts";
import { check } from "../run.ts";
import { flows } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

check("every state the schema allows can actually be reached", () => {
  // team.status could be 'active' or 'archived', four queries gated real access on it —
  // whose documents you can see, whose block grants count — and NOTHING could set it. There
  // was no way to retire a team, so it was being done by renaming the slug by hand in SQL.
  //
  // A state with no writer is worse than a missing feature: the guards reading it look like
  // working access control, and reviewing them tells you nothing, because the branch they
  // protect is unreachable. This finds them the only mechanical way there is — the schema
  // says which states exist, so every one of them must appear in something that writes.
  const sql = sourceFiles(["services/gateway/migrations"], [".sql"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  // Both service trees AND the packages: a state can be set from anywhere that talks to the
  // database, and the two directories named here were the two that existed when this was
  // written. Recursive, too — the flat readdir missed any subdirectory from the start.
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const unreachable = [];
  // REPLAYED, not read flat — the same lesson the `_at` column check already carries.
  // An inline `check (kind in (...))` gets the name `<table>_<col>_check`, and a later
  // migration may drop it: `skill_kind_check` went when `common` stopped being a kind.
  // Read flat, this reported the dropped list's values as unreachable states forever,
  // which is a true sentence about a constraint that no longer exists.
  const dropped = new Set(
    [...sql.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_.]+)/gi)]
      .map((d) => d[1].split(".").pop()),
  );
  // A DROPPED COLUMN RETIRES EVERY STATE IT COULD HOLD, and that is a stronger fact than any
  // constraint name. The set above matches on the name Postgres GIVES an inline check —
  // `<table>_<col>_check` — so a constraint declared with a name of its own is invisible to
  // it: 038 called its one `console_session_door_known`, 044 dropped the whole `door` column,
  // and this check went on reporting 'ssoauth' as an unreachable state of a column that no
  // longer exists. Reading the drop directly is both simpler and harder to get wrong than
  // guessing what a constraint was called.
  const droppedColumns = new Set(
    [...sql.matchAll(/alter\s+table\s+(?:zz\.)?(\w+)[\s\S]{0,120}?drop\s+column\s+(?:if\s+exists\s+)?(\w+)/gi)]
      .map((d) => `${d[1]}.${d[2]}`),
  );
  for (const m of sql.matchAll(/(\w+)\s+text[^,]*?check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)|check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)/gi)) {
    const col = m[2] ?? m[4];
    const values = m[3] ?? m[5];
    // The table this column sits in — the NEAREST `create table` above the match,
    // not the first one in the file. A greedy anchored regex finds the first, which
    // named the earliest table in the earliest migration for every column in the set.
    //
    // ALTER counts too, and it did not. A constraint added by `alter table X add constraint`
    // sits in no `create table` at all, so the nearest one above it named whatever table
    // happened to be declared last — for `console_session.door`, added by 038 and dropped by
    // 044, that was a different table entirely, and the retirement below could never match.
    // Whichever statement opened LAST is the one this constraint belongs to.
    const before = sql.slice(0, m.index);
    const opens = [...before.matchAll(
      /(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?)(?:zz\.)?(\w+)/gi)];
    const table = opens.length ? opens[opens.length - 1][1] : "";
    if (table && dropped.has(`${table}_${col}_check`)) continue;
    if (table && droppedColumns.has(`${table}.${col}`)) continue;
    for (const lit of values.matchAll(/'([^']*)'/g)) {
      const v = lit[1];
      if (v === "") continue;   // the empty default is not a state anyone sets
      // Deliberately loose: the value must merely be NAMED somewhere in the source. Writes
      // are not always literals — pat_issue sets scope from a bound parameter fed by a
      // z.enum, and demanding `scope = 'admin'` reported that as unreachable when it is the
      // normal way to write a state. What cannot be argued with is the other direction: a
      // value the code never names cannot be written by it. 'archived' appeared nowhere in
      // any TypeScript file, which is exactly how a team could never be retired.
      if (!new RegExp(`['"]${v}['"]`).test(src)) {
        unreachable.push(`${col}='${v}' is allowed by the schema and never named in the source`);
      }
    }
  }
  return unreachable.length ? unreachable.join("; ") : null;
});

check("every envelope field the platform writes is one the schema declares", () => {
  // The Envelope in @zz/contracts is PUBLISHED at /schemas/envelope.json — it is what
  // somebody outside this repository reads before writing a flow, which is the whole reason
  // it is a schema and not an interface. So a field the platform writes and the schema does
  // not name is a rulebook that is wrong about its own author.
  //
  // Two were: `contributed_by`, written by source_add and read by both source_list and the
  // knowledge base, and `revision_note`, written by document_revise on every revision. And
  // it was not only documentation: zz-core's RESERVED_ENVELOPE is derived from these keys,
  // so an undeclared field is also one a flow may claim for itself and collide with.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const declared = new Set(JSON.parse(execFileSync("node", ["--input-type=module", "-e",
    `import { Envelope } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "process.stdout.write(JSON.stringify(Object.keys(Envelope.shape)));"], { encoding: "utf8" })));
  if (declared.size < 5) return "the Envelope schema emitted almost no fields — this check reads nothing";

  // zz-core's document writer, which is the only place a document envelope is composed:
  // `env.<field> =` on a parsed envelope, and putEnvelopeField by name.
  // THE WHOLE SERVICE. Composing an envelope is zz-core's rule, not one file's habit.
  const f = "zz-core";
  const src = zzCoreSource();
  const bad: string[] = [];
  src.split("\n").forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
    // setEnvelopeField TOO. It was not read, and it is how knowledge_supersede writes
    // `supersededBy` — a field the platform writes on every supersede and the schema did not
    // declare, which is the very thing this check exists to find. A check that reads two of
    // the three writers finds two thirds of the defect.
    for (const m of [...ln.matchAll(/\benv\.([a-zA-Z_]+)\s*=(?!=)/g),
                     ...ln.matchAll(/(?:put|set)EnvelopeField\([^,]+,\s*"([a-zA-Z_]+)"/g)]) {
      if (!declared.has(m[1])) bad.push(`${f}:${i + 1} writes '${m[1]}'`);
    }
  });
  return bad.length
    ? `${firstOf(bad)} — the published schema does not declare it, and a flow may therefore claim the name`
    : null;
});

check("everything that reads a source reads the fields sourceDocument writes", () => {
  // A source's envelope is composed by the platform, so its keys are the only ones any reader
  // may use. This has been got wrong twice: source_list read `added_by`, a field nothing has
  // ever written, and carries a comment saying every source came back with an empty author;
  // the web sources endpoint added this release then read `added_by` too, written by guessing
  // the name rather than by reading it three thousand lines away.
  //
  // Neither failed. An absent field is an empty string, so the reader shows a blank where a
  // person's name belongs and nothing anywhere says why.
  //
  // Read from sourceDocument, which is now the one writer. It used to read source_add's
  // template literal — and while it did, document_revise was building a SECOND source
  // envelope forty lines of its own away, which this check could not see and which escaped
  // its title differently. A check that reads one of two copies is a check on half the code.
  const core = zzCoreSource();
  const builder = functionBody(core, "sourceDocument") ?? "";
  const written = new Set([...builder.matchAll(/(?:\{|,)\s*([a-z_]+):/g)].map((m) => m[1]));
  if (written.size < 5) {
    return "the source envelope is no longer built where this can read it (found " +
           `${[...written].join(", ") || "nothing"}) — sourceDocument is the one writer`;
  }
  const bad: string[] = [];
  // Wherever a source is read, not the two files it is read in today. The defect this exists
  // for — source_list reading `added_by` where source_add writes `contributed_by`, so the
  // reader showed a blank where a person's name belongs — is available to any reader, and a
  // third one would be written by copying one of these two.
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      // A read of a source's envelope: env.<field> near the word source, or in a block that
      // builds a source row. Narrow on purpose — env is used for documents too.
      for (const m of line.matchAll(/\benv\.([a-z_]+)/g)) {
        const field = m[1];
        // Only fields that LOOK like source metadata; document fields are a different set.
        if (!/^(added_by|contributed_by|author|added_at|supports|contributor)$/.test(field)) continue;
        if (!written.has(field)) {
          bad.push(`${f}:${i + 1} reads env.${field}, which sourceDocument never writes`);
        }
      }
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("every subject kind the platform accepts is one a skill teaches", () => {
  // knowledge_add refuses a subject tag whose kind is not one of five — block, flow, provider,
  // interface, platform — and the refusal names them, which is the right behaviour AFTER
  // somebody has guessed wrong. Before that, the only way to know a kind exists is a skill
  // that says so: zz-kb-usage teaches tagging to everyone and zz-distil teaches it to the
  // platform team.
  //
  // Both list all five today and nothing holds them there. A sixth kind added to the enum
  // ships accepted-but-untaught — the search that makes the tag worth having
  // (`knowledge_search(tags=["block:casebox"])`) only works if people write the tag, and they
  // write what they were told. zz-kb-usage says it plainly: a kind nobody knows about is
  // "the search says nothing is known while the knowledge sits right there".
  const code = zzCoreSource();
  const decl = /const SUBJECT_KINDS = \[([^\]]*)\]/.exec(code)?.[1];
  if (!decl) return "SUBJECT_KINDS is no longer where this can read it";
  const kinds = [...decl.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  if (!kinds.length) return "SUBJECT_KINDS is empty";
  const bad: string[] = [];
  for (const rel of ["skills/zz-platform/SKILL.md", "skills/zz-handover/SKILL.md"]) {
    const f = join(root, rel);
    if (!existsSync(f)) { bad.push(`${rel} is missing — it is where a tag kind is taught`); continue; }
    const text = readFileSync(f, "utf8");
    const missing = kinds.filter((k) => !text.includes(`\`${k}:`));
    if (missing.length) bad.push(`${rel} never names ${missing.join(", ")}`);
  }
  return bad.length ? `${bad.join("; ")} — knowledge_add accepts ${kinds.join(", ")}` : null;
});

check("the published schema is never weaker than the validator", () => {
  // jsonSchema exists so somebody outside this repository can be told their manifest is not
  // legal BEFORE a write is refused, and its own comment says an unknown construct throws
  // rather than "degrading to {}", because "a schema that silently publishes as weaker than
  // it is would be worse than none".
  //
  // Its ZodObject case ignored `unknownKeys`. zod's default DROPS an unknown key, so
  // `standalon: ["zz-okr"]` validated, installed and produced no command — an instruction
  // ignored with nothing saying why. Making the manifest strict fixes that; publishing it
  // without `additionalProperties: false` would have made the rulebook accept what the
  // platform refuses, which is the same defect pointed the other way.
  //
  // Checked against the real schemas: a closed one must publish closed, and every manifest in
  // the catalog must still satisfy it.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import { CatalogManifest, FlowDoc, jsonSchema } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "const js = jsonSchema(CatalogManifest);" +
    "process.stdout.write(JSON.stringify({" +
    "  manifestStrict: CatalogManifest._def.unknownKeys === 'strict'," +
    "  docStrict: FlowDoc._def.unknownKeys === 'strict'," +
    "  manifestClosed: js.additionalProperties === false," +
    "  docClosed: js.properties.documents.items.additionalProperties === false," +
    "  typoRefused: !CatalogManifest.safeParse({ name: 'x', standalon: [] }).success," +
    // The fields the schema declares, FROM the schema. This was seventeen names written out
    // below, which is the second copy this very check exists to refuse: adding a field to
    // CatalogManifest and not editing the gate would have reported every manifest using it
    // as declaring something "the schema now refuses", about a manifest the schema accepts.
    "  declared: Object.keys(CatalogManifest.shape)," +
    "}));"], { cwd: root, encoding: "utf8" });
  const r = JSON.parse(out);
  const bad: string[] = [];
  if (!r.manifestStrict) bad.push("CatalogManifest is not strict — a mistyped field is dropped in silence");
  if (!r.docStrict) bad.push("FlowDoc is not strict — a mistyped document field is dropped in silence");
  if (r.manifestStrict && !r.manifestClosed) {
    bad.push("CatalogManifest is strict and publishes without additionalProperties:false — the " +
             "rulebook accepts what the platform refuses");
  }
  if (r.docStrict && !r.docClosed) bad.push("FlowDoc is strict and publishes open");
  if (!r.typoRefused) bad.push("a manifest with an unknown key still parses");
  // And the schema has to still accept what this repository actually ships.
  const declared = new Set(r.declared);
  if (declared.size < 10) bad.push("CatalogManifest emitted almost no fields — this half reads nothing");
  for (const f of flows) {
    const m = JSON.parse(readFileSync(join(f.dir, "flow.json"), "utf8"));
    const unknown = Object.keys(m).filter((k) => !declared.has(k));
    if (unknown.length) bad.push(`${f.flow} declares ${unknown.join(", ")}, which the schema now refuses`);
  }
  return bad.length ? bad.join("; ") : null;
});

check("a section rename the platform reports is a section the document has", () => {
  // normalizeSections renames a heading that is a clear near miss for one the flow requires,
  // and REPORTS the rename — deliberately, because "a platform that quietly edits prose is
  // worse than one that asks". The report is what the author reads, and it is the only place
  // they learn the platform touched their document.
  //
  // It reported a rename it had not made. `headings` is read once from the original content
  // and never re-derived, so a heading already renamed stayed on the list for every later
  // target, and one author heading can contain the words of two required sections: sdlc's
  // explore.md declares `Background` and `Current state`, and `## Background and current
  // state` contains both. The second pass matched the stale entry, replaced nothing, and
  // pushed the rename regardless. The document came back with `## Background`, no
  // `## Current state`, and a message saying both had been made.
  //
  // RUN, not read. The property is about what the function does to a document, and no
  // arrangement of its source proves it — the fix is that the report is derived from the
  // change rather than asserted beside it, and a later edit could reintroduce the assertion
  // in a shape no regex here would recognise. So the body is lifted out of the source and
  // evaluated on the case that broke it, exactly as NAMING lifts client-package.ts's
  // derivations: source rather than dist, because the gate runs before tsc necessarily has.
  const src = zzCoreSource();
  const body = functionBody(src, "normalizeSections")?.replace(/<string>/g, "");
  if (!body) return "zz-core no longer defines normalizeSections() — this check cannot run";

  let normalize;
  try {
    normalize = new Function("chain", "relPath", "content", body);
  } catch (err) {
    return `normalizeSections could not be evaluated: ${errMessage(err)} — the ` +
           "extraction must fail loudly rather than quietly stop checking";
  }

  // One author heading whose words contain two of the required sections. Both the headings
  // and the sections are sdlc-flow's own, so this is the document a real explore stage
  // writes, not a shape invented to fail.
  const cases = [
    { why: "one heading contains the words of two required sections",
      sections: ["Background", "Current state", "Rough direction"],
      doc: "# E\n\n## Background and current state\n\nt\n\n## Rough direction\n\nt\n" },
    { why: "the near miss this function exists for",
      sections: ["What past work recorded", "Fit"],
      doc: "# S\n\n## What past work with these blocks recorded\n\nt\n\n## Fit\n\nt\n" },
    { why: "the same heading written twice",
      sections: ["Background", "Current state"],
      doc: "# E\n\n## Background and current state\n\nt\n\n## Background and current state\n\nt\n" },
  ];

  const bad: string[] = [];
  for (const c of cases) {
    let r;
    try {
      r = normalize({ documents: [{ name: "d.md", sections: c.sections }] }, "i/d.md", c.doc);
    } catch (err) {
      bad.push(`${c.why}: threw ${errMessage(err)}`);
      continue;
    }
    const have = new Set([...r.content.matchAll(/^##[ \t]+(.*)$/gm)].map((m) => m[1].trim()));
    for (const line of r.renamed) {
      const claimed = (line.split("→")[1] ?? "").replace(/`|##/g, "").trim();
      if (!have.has(claimed)) {
        bad.push(`${c.why}: reported \`## ${claimed}\` and the document does not have it`);
      }
    }
  }
  return bad.length
    ? `${bad.join("; ")} — the rename report is what tells an author the platform edited ` +
      "their document, and one naming a section that is not there makes them stop looking " +
      "for the section the gate is about to refuse them for"
    : null;
});

check("a subject tag the platform teaches is a subject tag it accepts", () => {
  // `block:casebox`, `flow:ops-flow`. knowledge_add's description asks for one in capitals,
  // subjectTagError exists to check its kind against a closed set, five skills teach the
  // form, and db.ts names it as what makes the journal queryable rather than searchable.
  //
  // Every one of those calls was refused. The loop straight after subjectTagError tested the
  // tag against PLAIN_TOKEN — the rule for an evidence entry, which is a path segment and
  // has no colon in it — so a subject tag passed the rule written for it and was then
  // rejected as not "a plain word". Complete and unreachable: every piece of the feature
  // existed except a character class, and the one test that would have caught it lives in
  // chain-check, which needs a running server and is not this gate.
  //
  // Two rules about one string, in two files, is the arrangement that guarantees they will
  // disagree again. This is what holds them together — and it holds the DESCRIPTION too,
  // because what the model is told to send is as much the contract as what the code checks.
  const src = zzCoreSource();

  const kindsSrc = /const SUBJECT_KINDS = \[([^\]]*)\]/.exec(src);
  const tagSrc = /const TAG_TOKEN = (\/.*\/)[a-z]*;/.exec(src);
  if (!kindsSrc) return "zz-core no longer defines SUBJECT_KINDS — this check cannot run";
  if (!tagSrc) return "zz-core no longer defines TAG_TOKEN — this check cannot run";
  const kinds = [...kindsSrc[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  let TAG;
  try {
    TAG = new Function(`return ${tagSrc[1]}`)();
  } catch (err) {
    return `TAG_TOKEN is not a literal this check can evaluate: ${errMessage(err)}`;
  }
  if (!kinds.length) return "SUBJECT_KINDS is empty — no subject tag could be written at all";

  const bad: string[] = [];
  for (const k of kinds) {
    if (!TAG.test(`${k}:example-name`)) {
      bad.push(`subjectTagError accepts the kind \`${k}\` and TAG_TOKEN refuses \`${k}:…\``);
    }
  }
  // Plain tags must still work: the subject form is an addition, and a rule that only
  // admitted `kind:name` would refuse every ordinary tag in the corpus.
  if (!TAG.test("retrieval")) bad.push("TAG_TOKEN refuses an ordinary one-word tag");
  // And what the rule exists to keep out, on BOTH halves of the key. A tag is written into
  // ONE frontmatter line and read back by splitting it, so a newline inserts a field rather
  // than corrupting one, a comma turns one tag into two, and a bracket or quote ends the
  // value early. `CaseBox` is here for a different reason and the same cost: a tag is matched by
  // equality and search folds the words a person typed, so an uppercase tag is stored,
  // indexed and unreachable — which is the drift subjectTagError's own docblock names.
  for (const nope of ["a,b", "block:o g", "block:", ":casebox", "[x]", "a\"b", "a\nb", "a\rb", "CaseBox", "Block:casebox"]) {
    if (TAG.test(nope)) {
      bad.push(`TAG_TOKEN accepts ${JSON.stringify(nope)}, which cannot survive the ` +
               "frontmatter round trip or cannot be found once it has");
    }
  }

  // WHAT THE MODEL IS TOLD TO SEND. Every `kind:name` example in knowledge_add's own
  // description, checked against the rules that will judge it.
  const tool = zzCoreTools().find((t) => t.name === "knowledge_add");
  if (!tool) return "zz-core no longer registers knowledge_add — this check cannot run";
  // THE DESCRIPTION, not the whole handler. Scanning the body found the examples in this
  // tool's own refusal message and counted them as teaching — so a description that stopped
  // showing the form still satisfied the check, which is the check passing on evidence it
  // produced itself. The description is what reaches the model; nothing else here does.
  const dFrom = tool.body.indexOf("description:"), dTo = tool.body.indexOf("inputSchema:");
  if (dFrom < 0 || dTo < dFrom) {
    return "knowledge_add's description could not be delimited — this check cannot run";
  }
  const taught = [...tool.body.slice(dFrom, dTo).matchAll(/`([a-z]+):([A-Za-z0-9][A-Za-z0-9._-]*)`/g)];
  for (const [full, kind, name] of taught) {
    if (!kinds.includes(kind)) {
      bad.push(`knowledge_add's description teaches ${full}, and \`${kind}\` is not a SUBJECT_KINDS kind`);
    } else if (!TAG.test(`${kind}:${name}`)) {
      bad.push(`knowledge_add's description teaches ${full}, and TAG_TOKEN refuses it`);
    }
  }
  if (!taught.length) {
    bad.push("knowledge_add's description no longer shows a subject tag — the form is checked " +
             "by code nothing tells the model about");
  }

  return bad.length ? bad.join("; ") : null;
});

check("every envelope field the platform reads is one the schema publishes", () => {
  // The Envelope schema is what a tenant writing their own flow is shown — "rules spread
  // across validation functions cannot be quoted, published, or read before the file is
  // written". It is also what RESERVED_ENVELOPE is derived from, so a field missing here is a
  // name a flow may claim for itself.
  //
  // Three fields had already been found missing one at a time — contributed_by,
  // revision_note, supersededBy — each with a comment saying the schema "omitted a field the
  // platform writes itself". `evidence` was the fourth: knowledge_add writes it, indexDoc puts
  // it in zz.doc.evidence, and knowledge_search expands the knowledge graph along it. A flow
  // could have declared its own `evidence` field on a chain document and landed in those
  // edges.
  //
  // Found by asking the question mechanically instead of one field at a time, which is what
  // this now does.
  const contracts = contractsSource();
  const at = contracts.indexOf("export const Envelope = z.object({");
  const end = contracts.indexOf("export type Envelope");
  if (at < 0 || end < at) return "the Envelope schema cannot be located in @zz/contracts";
  const declared = new Set(
    [...contracts.slice(at, end).matchAll(/^ {2}([a-zA-Z_]+):/gm)].map((m) => m[1]));
  if (declared.size < 10) return `only ${declared.size} envelope fields read — the shape moved`;

  // ONE EXCEPTION, and it is not an oversight. ops-select writes `server: "<tool prefix>"` as
  // the flow's own field, indexDoc splits it into zz.decision.blocks, and that column is what
  // `reconcile --block` joins on to answer "what has this team predicted about casebox". Declaring
  // it would put it in RESERVED_ENVELOPE and refuse the write the feature depends on. The
  // exception is named here so it stays a decision rather than becoming a gap.
  const READ_BUT_A_FLOW_FIELD = new Set(["server"]);

  // Property reads that are string or array methods rather than envelope fields.
  const METHODS = new Set([
    "trim", "replace", "split", "slice", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
    "includes", "length", "match", "test", "padStart", "padEnd", "join", "map", "filter",
    "toFixed", "localeCompare", "repeat", "charAt", "indexOf", "concat", "at", "normalize",
    "search", "trimEnd", "trimStart", "valueOf", "toString",
  ]);

  const bad: string[] = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    if (!/\bparseEnvelope\(/.test(src)) continue;
    // What in this file holds a parsed envelope.
    // THE ENVELOPE ITSELF, not a field off one. `const out = parseEnvelope(content).outcome`
    // binds a string, and taking it for an envelope made every `out.push(...)` elsewhere in
    // the file read as an undeclared field — the name is file-wide here and the binding is
    // not. Requiring the statement to END at the call excludes every `.field` read; `[^;]`
    // lets the call wrap across lines without running into the next statement.
    const names = [...new Set([...src.matchAll(
      /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*)?=\s*(?:await\s+)?(?:parseEnvelope|envelopeOf|frontmatter)\([^;]*?\)\s*;/g,
    )].map((m) => m[1]))];
    const note = (field: string, index: number): void => {
      if (METHODS.has(field) || declared.has(field) || READ_BUT_A_FLOW_FIELD.has(field)) return;
      bad.push(`${rel}:${src.slice(0, index).split("\n").length} reads \`${field}\` off a ` +
               "document envelope and @zz/contracts does not declare it — so the published " +
               "schema omits it and RESERVED_ENVELOPE does not defend the name");
    };
    for (const n of names) {
      // The lookbehind matters: without it `env` matches inside `process.env.TEAM_DB_URL`,
      // and the check reports environment variables as undeclared envelope fields.
      for (const m of src.matchAll(new RegExp(`(?<![.\\w])${n}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, "g"))) {
        note(m[1], m.index);
      }
    }
    // No parens inside, so this cannot run past the call it belongs to and pick up a later
    // property access on some other expression.
    for (const m of src.matchAll(/(?:parseEnvelope|envelopeOf|frontmatter)\([^;()]*\)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      note(m[1], m.index);
    }
  }
  return bad.length ? [...new Set(bad)].join("; ") : null;
});

check("the published schema is exactly as strict as the validator", () => {
  // /schemas/envelope.json and /schemas/manifest.json are the rulebook a tenant writing their
  // own flow is handed, and the argument for emitting them from the zod schemas is that "a
  // hand-maintained schema beside a live validator is exactly the second definition this one
  // exists to remove". jsonSchema's own docblock goes further: an unknown construct THROWS,
  // because "a schema that silently publishes as weaker than it is would be worse than none".
  //
  // It published `z.string().min(1)` as `{"type":"string"}`. Three fields — Envelope's `flow`
  // and `type`, and a manifest's `documents[].name` — told a reader an empty string was legal
  // and the platform refused it, which is the round trip publishing a rulebook removes.
  //
  // RUN against the real schemas, the way the acting-team rule is: for every constrained
  // field, the emitted keyword must carry the validator's own value.
  const probe = `
    import { Envelope, CatalogManifest, jsonSchema } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};
    const bad = [];
    const walk = (schema, path, emitted) => {
      const d = schema._def;
      if (d.typeName === "ZodOptional") return walk(d.innerType, path, emitted);
      if (d.typeName === "ZodArray") return walk(d.type, path + "[]", emitted && emitted.items);
      if (d.typeName === "ZodObject") {
        for (const [k, v] of Object.entries(d.shape())) {
          walk(v, path + "." + k, emitted && emitted.properties && emitted.properties[k]);
        }
        return;
      }
      if (d.typeName !== "ZodString") return;
      for (const c of d.checks || []) {
        const kw = c.kind === "min" ? "minLength" : c.kind === "max" ? "maxLength" : null;
        if (!kw) bad.push(path + " carries a string check '" + c.kind + "' the emitter has no rule for");
        else if (!emitted || emitted[kw] !== c.value) {
          bad.push(path + " is validated with " + c.kind + "(" + c.value + ") and publishes as " +
                   JSON.stringify(emitted) + " — the rulebook is weaker than the rule");
        }
      }
    };
    walk(Envelope, "envelope", jsonSchema(Envelope));
    walk(CatalogManifest, "manifest", jsonSchema(CatalogManifest));
    // And it still refuses what it cannot express, which is what makes the rest trustworthy.
    try {
      jsonSchema({ _def: { typeName: "ZodString", checks: [{ kind: "url" }] } });
      bad.push("jsonSchema dropped a string check it has no rule for instead of throwing");
    } catch (e) { /* the throw is the behaviour under test */ }
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    return out.trim() || null;
  } catch (err) {
    const stderr = err && typeof err === "object" ? (err as Record<string, unknown>).stderr : undefined;
    return `the published schema could not be compared against the validator: ${String(stderr ?? err).slice(-300)}`;
  }
});

check("the schema's own document names things that exist", () => {
  // "The migrations in this directory ARE the schema: there is no separate design document,
  // because one would drift from them." 001 says that in its second line, which makes every
  // comment here load-bearing — it is the only description of the schema anybody gets.
  //
  // 003 described `agent_name` as feeding "an Open WebUI preset, codex stanza". Both were
  // gone: the front end was replaced and the terminal projection became a generated plugin
  // package. So the schema's only design document told a reader this column fed two things
  // that do not exist, in a repository whose own check refuses a product name in a
  // comparison and could not see a `.sql` comment.
  //
  // WHAT IS CHECKABLE IS A NAME, not a claim. Deciding that "feeds an Open WebUI preset" is
  // stale while "the migrations that RECORD the swap say Open WebUI" is correct means
  // knowing which noun the sentence is about, and every word-list that stands in for that
  // flags the correction along with the defect — this gate has learned twice that a check
  // which calls correct prose a defect is a check people switch off.
  //
  // So the rule is the convention instead: name a column, a table or a function in
  // BACKTICKS, and it must exist somewhere in this repository. That is the same rule as
  // "a skill citing another document's section cites one that exists", applied to the
  // document that defines the store — and it converts an unbackticked style nothing can
  // check into one that fails when the thing it names goes away.
  const files = sourceFiles(["services/gateway/migrations"], [".sql"]);
  if (!files.length) return "no migrations found — this check reads nothing";
  // COMMENTS STRIPPED FIRST, and the first draft of this check did not: the corpus included
  // the migration files whole, so a comment naming a column that exists nowhere matched
  // ITSELF and the check passed with the defect reinstated. Found by putting one in. This
  // file records that shape more often than any other, and it is as available to a new check
  // as to old code.
  let corpus = "";
  for (const f of trackedFiles() ?? []) {
    if (!/\.(ts|mjs|sql|sh|md|json|yml|yaml)$/.test(f)) continue;
    // Tracked is not present: a file deleted in the working tree stays tracked until the
    // deletion is staged, and reading it throws — reporting a check that could not RUN as one
    // that FAILED.
    if (!existsSync(join(root, f))) continue;
    const text = readFileSync(join(root, f), "utf8");
    corpus += f.endsWith(".sql")
      ? text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n")
      : text;
  }
  if (corpus.length < 10_000) return "the repository could not be read — this check reads nothing";
  const bad: string[] = [];
  for (const rel of files) {
    readFileSync(join(root, rel), "utf8").split("\n").forEach((ln, i) => {
      if (!ln.trimStart().startsWith("--")) return;
      for (const m of ln.matchAll(/`([A-Za-z_][A-Za-z0-9_.]{2,})`/g)) {
        // `zz.doc.body` is named by its last segment wherever it is declared or read.
        const leaf = m[1].split(".").pop();
        if (new RegExp(`\\b${leaf}\\b`).test(corpus)) continue;
        bad.push(`${rel}:${i + 1} names \`${m[1]}\`, which nothing in this repository has — ` +
                 "these files are the schema's only design document, so a name that is gone " +
                 "from the code is gone from the only place a reader can check it");
      }
    });
  }
  return bad.join("\n");
});

check("a subject tag is reachable from the word it is about", () => {
  // The platform spends real effort on subject tags: TAG_TOKEN admits one colon, tagRefusal
  // explains the form, subjectTagError refuses a kind the platform does not have, and
  // knowledge_add's description names the payoff in as many words — "what have we learned about
  // casebox" becomes a query instead of a search through documents.
  //
  // knowledge_search's tag arm could not answer it. Its candidate words come from splitting
  // the query on everything that is not a letter or a digit, so `casebox` is a token and
  // `block:casebox` can never be one — and the stored tag is that one string, colon included. The
  // arm matched plain tags, missed every subject tag, and looked like it worked because the
  // lexical arm usually found the node by its prose. A vocabulary validated on the way in and
  // unreachable on the way out is a write-only column with a checker attached.
  //
  // So: wherever the query's own words are matched against the tag column, they are expanded
  // by the kinds first. The caller's explicit `tags` filter is a different thing and is
  // deliberately not expanded — there the caller typed the whole tag.
  const src = zzCoreSource();
  const bad: string[] = [];

  const split = /const tokens = [^;]*?split\(\/\[([^\]]*)\]\+\/\)/s.exec(src);
  if (!split) {
    return "knowledge_search no longer derives query words with a split() this rule can read " +
           "— re-establish what a token may contain before trusting the arm below";
  }
  if (split[1].includes(":")) {
    // If a token could ever carry a colon the expansion is unnecessary, and leaving it would
    // be the dormant code this repository refuses. Say so rather than passing quietly.
    bad.push("the query tokenizer now admits ':' — a token can spell a subject tag directly, " +
             "so the SUBJECT_KINDS expansion in the tag arm is dead and should go");
  }

  const arm = between(src, "let tagged: KbRow[] = []", "let neighbours");
  // COMMENTS STRIPPED. The paragraph explaining this expansion sits inside the arm and names
  // SUBJECT_KINDS, so a check reading the arm whole passes on its own justifying prose the
  // moment the code beneath it is removed — the failure mode two checks here have already had.
  const code = (arm.text ?? "").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (!arm.text) {
    bad.push(`knowledge_search's tag-retrieval arm is no longer readable here: ${arm.why}`);
  } else if (!/SUBJECT_KINDS/.test(code)) {
    bad.push("knowledge_search matches the query's own words against `tags` without expanding " +
             "them by SUBJECT_KINDS — `casebox` cannot equal `block:casebox`, so every subject tag the " +
             "platform validates is invisible to the arm that exists to read tags");
  }

  // And the vocabulary has to still be the compound one, or the expansion is answering a
  // question nobody asks any more.
  if (!/const TAG_TOKEN = [^;]*:/.test(src)) {
    bad.push("TAG_TOKEN no longer admits a colon, so `block:casebox` is not a tag — the expansion " +
             "in knowledge_search's tag arm is inventing candidates that cannot be stored");
  }
  return bad.join("\n");
});
