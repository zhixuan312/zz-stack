/**
 * The published schema against the validator that enforces it.
 *
 * Two artifacts describing one contract: a schema clients read to know what is allowed, and
 * the code that decides. Checked in both directions — a schema weaker than the validator
 * promises what will be refused, and a schema stricter than it hides what works.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { between, contractsSource, firstOf, functionBody, root, sourceFiles, trackedFiles, unbuilt, zzCoreSource, zzCoreTools, withoutComments} from "../read.ts";
import { check } from "../run.ts";
import { flows } from "../facts.ts";

/** A caught value is never typed as an Error — narrow the shape actually being read.
 *  `unknown?.message` narrows to `{}`, which has no properties at all. */
function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

check("every state the schema allows can actually be reached", () => {
  // A state with no writer reads as working access control: the guards reading it protect a
  // branch nothing can reach. The schema says which states exist, so every one of them must
  // appear in something that writes.
  const sql = sourceFiles(["services/gateway/migrations"], [".sql"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  // Both service trees and the packages, recursively: a state can be set from anywhere that
  // talks to the database.
  const src = sourceFiles(["services", "packages"], [".ts"])
    .map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  const unreachable = [];
  // Replayed, not read flat. An inline `check (kind in (...))` gets the name
  // `<table>_<col>_check` and a later migration may drop it; read flat, the dropped list's
  // values are reported as unreachable states of a constraint that no longer exists.
  const dropped = new Set(
    [...sql.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?([a-z0-9_.]+)/gi)]
      .map((d) => d[1].split(".").pop()),
  );
  // A dropped column retires every state it could hold, and that is a stronger fact than any
  // constraint name: the set above matches the name Postgres gives an inline check, so a
  // constraint declared with a name of its own is invisible to it.
  const droppedColumns = new Set(
    [...sql.matchAll(/alter\s+table\s+(?:zz\.)?(\w+)[\s\S]{0,120}?drop\s+column\s+(?:if\s+exists\s+)?(\w+)/gi)]
      .map((d) => `${d[1]}.${d[2]}`),
  );
  // And a dropped table retires every state of every column on it. Neither a constraint drop
  // nor a column drop appears for those columns — you do not drop a column off a table you are
  // dropping — so without this their states are reported unreachable forever.
  const droppedTables = new Set(
    [...sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:zz\.)?(\w+)/gi)].map((d) => d[1]),
  );
  // A third spelling, because `001_init.sql` is a pg_dump. The two forms above are how a person
  // writes an inline constraint -- `check (status in ('active','deactivated'))`; pg_dump renders
  // the same constraint as `CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text])))`.
  for (const m of sql.matchAll(/(\w+)\s+text[^,]*?check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)|check\s*\(\s*(\w+)\s+in\s*\(([^)]*)\)\s*\)|check\s*\(\(\s*(\w+)\s*=\s*any\s*\(\s*array\[([^\]]*)\]/gi)) {
    const col = m[2] ?? m[4] ?? m[6];
    const values = m[3] ?? m[5] ?? m[7];
    // The table this column sits in — the nearest statement opening above the match, not the
    // first one in the file. ALTER counts: a constraint added by `alter table X add
    // constraint` sits in no `create table` at all, so whichever statement opened last is the
    // one this constraint belongs to.
    const before = sql.slice(0, m.index);
    const opens = [...before.matchAll(
      /(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?)(?:zz\.)?(\w+)/gi)];
    const table = opens.length ? opens[opens.length - 1][1] : "";
    if (table && droppedTables.has(table)) continue;
    if (table && dropped.has(`${table}_${col}_check`)) continue;
    if (table && droppedColumns.has(`${table}.${col}`)) continue;
    for (const lit of values.matchAll(/'([^']*)'/g)) {
      const v = lit[1];
      if (v === "") continue;   // the empty default is not a state anyone sets
      // DELIBERATE: loose — the value must merely be named somewhere in the source. Writes are
      // not always literals; pat_issue sets scope from a bound parameter fed by a z.enum, and
      // demanding `scope = 'admin'` would report that as unreachable. The other direction
      // holds: a value the code never names cannot be written by it.
      if (!new RegExp(`['"]${v}['"]`).test(src)) {
        unreachable.push(`${col}='${v}' is allowed by the schema and never named in the source`);
      }
    }
  }
  return unreachable.length ? unreachable.join("; ") : null;
});

check("every envelope field the platform writes is one the schema declares", () => {
  // The Envelope in @zz/contracts is published at /schemas/envelope.json — what somebody
  // outside this repository reads before writing a flow. zz-core's RESERVED_ENVELOPE is
  // derived from these keys, so a field the platform writes and the schema does not declare is
  // also a name a flow may claim for itself and collide with.
  const nothingToRun = unbuilt();
  if (nothingToRun) return nothingToRun;
  const declared = new Set(JSON.parse(execFileSync("node", ["--input-type=module", "-e",
    `import { Envelope } from ${JSON.stringify(join(root, "packages/contracts/dist/index.js"))};` +
    "process.stdout.write(JSON.stringify(Object.keys(Envelope.shape)));"], { encoding: "utf8" })));
  if (declared.size < 5) return "the Envelope schema emitted almost no fields — this check reads nothing";

  // zz-core's document writer, which is the only place a document envelope is composed:
  // `env.<field> =` on a parsed envelope, and putEnvelopeField by name. The whole service,
  // because composing an envelope is zz-core's rule rather than one file's habit.
  const f = "zz-core";
  const src = zzCoreSource();
  const bad: string[] = [];
  src.split("\n").forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
    // setEnvelopeField too: it is how knowledge_supersede writes `supersededBy`.
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
  // may use. An absent field reads as an empty string rather than failing, so a reader naming
  // a field nothing writes shows a blank where a person's name belongs.
  //
  // Read from sourceDocument, which is the one writer.
  const core = zzCoreSource();
  const builder = functionBody(core, "sourceDocument") ?? "";
  const written = new Set([...builder.matchAll(/(?:\{|,)\s*([a-z_]+):/g)].map((m) => m[1]));
  if (written.size < 5) {
    return "the source envelope is no longer built where this can read it (found " +
           `${[...written].join(", ") || "nothing"}) — sourceDocument is the one writer`;
  }
  const bad: string[] = [];
  // Wherever a source is read, not the two files it is read in today: any reader can name a
  // field nothing writes.
  for (const f of sourceFiles(["services", "packages"], [".ts"])) {
    const src = readFileSync(join(root, f), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      // A read of a source's envelope: env.<field> near the word source, or in a block that
      // builds a source row. Narrow on purpose — env is used for documents too.
      for (const m of line.matchAll(/\benv\.([a-z_]+)/g)) {
        const field = m[1];
        // Only fields that look like source metadata; document fields are a different set.
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
  // knowledge_add refuses a subject tag whose kind is not in SUBJECT_KINDS. The only way to
  // know a kind exists before guessing wrong is a skill that teaches it, so a kind added to
  // the enum and taught nowhere ships accepted-but-unwritten: the search that makes the tag
  // worth having only works if people write the tag.
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
  // legal before a write is refused. zod's default drops an unknown key, so a mistyped field
  // like `standalon:` validates, installs and produces no command; a strict schema published
  // without `additionalProperties: false` is the same defect pointed the other way.
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
    // The fields the schema declares, from the schema: a list written out here would report
    // every manifest using a newly added field as declaring something the schema refuses.
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
  // normalizeSections renames a heading that is a clear near miss for one the flow requires
  // and reports the rename; the report is the only place an author learns the platform touched
  // their document. One author heading can contain the words of two required sections, so a
  // rename can be reported that was never made.
  //
  // Run, not read: the property is about what the function does to a document, and no
  // arrangement of its source proves it. The body is lifted out of the source and evaluated —
  // source rather than dist, because the gate runs before tsc necessarily has.
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
  // and the sections are sdlc-flow's own, so this is the document a real explore stage writes.
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
  // A subject tag is `plugin:sdlc`, `flow:sdlc-flow`. Two rules govern one string:
  // subjectTagError checks its kind against SUBJECT_KINDS, and TAG_TOKEN checks its shape. A
  // kind one accepts and the other refuses makes the whole tag unwritable.
  //
  // knowledge_add's own description is checked against the same two rules: what the model is
  // told to send is as much the contract as what the code checks.
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
  // And what the rule exists to keep out, on both halves of the key. A tag is written into one
  // frontmatter line and read back by splitting it, so a newline inserts a field, a comma
  // turns one tag into two, and a bracket or quote ends the value early. An uppercase tag is
  // stored and indexed but unreachable: tags match by equality and search folds what a person
  // typed.
  for (const nope of ["a,b", "block:o g", "block:", ":casebox", "[x]", "a\"b", "a\nb", "a\rb", "CaseBox", "Block:casebox"]) {
    if (TAG.test(nope)) {
      bad.push(`TAG_TOKEN accepts ${JSON.stringify(nope)}, which cannot survive the ` +
               "frontmatter round trip or cannot be found once it has");
    }
  }

  // What the model is told to send: every `kind:name` example in knowledge_add's own
  // description, checked against the rules that will judge it.
  const tool = zzCoreTools().find((t) => t.name === "knowledge_add");
  if (!tool) return "zz-core no longer registers knowledge_add — this check cannot run";
  // The description, not the whole handler: scanning the body would count the examples in this
  // tool's own refusal message as teaching. The description is what reaches the model.
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
  // The Envelope schema is what a tenant writing their own flow is shown, and what
  // RESERVED_ENVELOPE is derived from: a field the platform reads and the schema does not
  // declare is a name a flow may claim for itself.
  const contracts = contractsSource();
  const at = contracts.indexOf("export const Envelope = z.object({");
  const end = contracts.indexOf("export type Envelope");
  if (at < 0 || end < at) return "the Envelope schema cannot be located in @zz/contracts";
  const declared = new Set(
    [...contracts.slice(at, end).matchAll(/^ {2}([a-zA-Z_]+):/gm)].map((m) => m[1]));
  if (declared.size < 10) return `only ${declared.size} envelope fields read — the shape moved`;

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
    // What in this file holds a parsed envelope — the envelope itself, not a field off one:
    // `const out = parseEnvelope(content).outcome` binds a string, and taking it for an
    // envelope makes every `out.push(...)` elsewhere in the file read as an undeclared field.
    // Requiring the statement to end at the call excludes every `.field` read; `[^;]` lets the
    // call wrap across lines without running into the next statement.
    const names = [...new Set([...src.matchAll(
      /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]*)?=\s*(?:await\s+)?(?:parseEnvelope|envelopeOf|frontmatter)\([^;]*?\)\s*;/g,
    )].map((m) => m[1]))];
    const note = (field: string, index: number): void => {
      if (METHODS.has(field) || declared.has(field)) return;
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
  // own flow is handed, emitted from the zod schemas. jsonSchema throws on a construct it
  // cannot express rather than publishing something weaker than the rule.
  //
  // Run against the real schemas: for every constrained field, the emitted keyword must carry
  // the validator's own value.
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
  // The migrations in this directory are the schema: there is no separate design document, so
  // their comments are the only description of the store a reader gets.
  //
  // What is checkable is a name, not a claim. The rule is the convention: a column, table or
  // function named in backticks in a migration comment must exist somewhere in this
  // repository.
  const files = sourceFiles(["services/gateway/migrations"], [".sql"]);
  if (!files.length) return "no migrations found — this check reads nothing";
  // Comments stripped from the corpus first, or a comment naming a column that exists nowhere
  // matches itself.
  let corpus = "";
  for (const f of trackedFiles() ?? []) {
    if (!/\.(ts|mjs|sql|sh|md|json|yml|yaml)$/.test(f)) continue;
    // Tracked is not present: a file deleted in the working tree stays tracked until the
    // deletion is staged, and reading it throws.
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
  // knowledge_search's candidate words come from splitting the query on everything that is not
  // a letter or a digit, so `sdlc` is a token and `plugin:sdlc` can never be one — while
  // the stored tag is that one string, colon included. Wherever the query's own words are
  // matched against the tag column they are therefore expanded by SUBJECT_KINDS first.
  //
  // DELIBERATE: the caller's explicit `tags` filter is not expanded — there the caller typed
  // the whole tag.
  const src = withoutComments(zzCoreSource());
  const bad: string[] = [];

  // Trailing flags are part of the literal: the class is a `u`-mode one, so a reader that only
  // accepted an unflagged literal would report the tokenizer as unreadable.
  const split = /const tokens = [^;]*?split\(\/\[([^\]]*)\]\+\/[a-z]*\)/s.exec(src);
  if (!split) {
    return "knowledge_search no longer derives query words with a split() this rule can read " +
           "— re-establish what a token may contain before trusting the arm below";
  }
  if (split[1].includes(":")) {
    // If a token could ever carry a colon the expansion is dead code. Say so rather than
    // passing quietly.
    bad.push("the query tokenizer now admits ':' — a token can spell a subject tag directly, " +
             "so the SUBJECT_KINDS expansion in the tag arm is dead and should go");
  }

  const arm = between(src, "let tagged: KbRow[] = []", "let neighbours");
  // Comments stripped: the paragraph explaining this expansion sits inside the arm and names
  // SUBJECT_KINDS, so reading the arm whole would pass on the prose once the code is removed.
  const code = (arm.text ?? "").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  if (!arm.text) {
    bad.push(`knowledge_search's tag-retrieval arm is no longer readable here: ${arm.why}`);
  } else if (!/SUBJECT_KINDS/.test(code)) {
    bad.push("knowledge_search matches the query's own words against `tags` without expanding " +
             "them by SUBJECT_KINDS — `sdlc` cannot equal `plugin:sdlc`, so every subject tag the " +
             "platform validates is invisible to the arm that exists to read tags");
  }

  // And the vocabulary has to still be the compound one, or the expansion is answering a
  // question nobody asks any more.
  if (!/const TAG_TOKEN = [^;]*:/.test(src)) {
    bad.push("TAG_TOKEN no longer admits a colon, so `plugin:sdlc` is not a tag — the expansion " +
             "in knowledge_search's tag arm is inventing candidates that cannot be stored");
  }
  return bad.join("\n");
});
