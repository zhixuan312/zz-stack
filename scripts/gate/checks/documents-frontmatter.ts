/**
 * Frontmatter at the boundary: what a caller may send, and what is refused rather than quietly
 * dropped. A field a caller types that the platform silently discards is worse than a refusal — the
 * write succeeds, the document looks right, and the field the caller believes they set is absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { ONE_LINE, contractsSource, functionBody, root, sourceFiles, zzCoreSource, zzCoreTools, errMessage,
         withoutComments } from "../read.ts";
import { check } from "../run.ts";

// A value somebody typed, inside hand-written YAML quotes.
//
// client-package generates the frontmatter of every file a person installs. Most of it is slugs the
// platform controls; `agentName` is free text from a manifest. A YAML scalar built by hand around an
// interpolation is a quoting decision made by hoping — an agent called `My "Special" Agent` closes
// the quote early and the command then silently does not exist. JSON.stringify is a correct YAML
// double-quoted scalar.
check("generated frontmatter quotes what it interpolates", () => {
  const rel = join("services", "gateway", "src", "client-package.ts");
  const src = readFileSync(join(root, rel), "utf8");
  const bad: string[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    // A frontmatter key whose value is a hand-quoted string containing an interpolation. Indented
    // keys too — a YAML file's keys are indented by definition, so anchoring the key to the backtick
    // misses `    url: "${s.url}"`.
    if (!/`\s*[a-z_]+:\s*"[^"]*\$\{/i.test(line)) return;
    bad.push(`${rel}:${i + 1} builds a quoted YAML scalar around an interpolation — ` +
             "JSON.stringify the whole value, as the standalone command does");
  });
  return bad.join("\n");
});

check("a frontmatter field that will not appear is refused, never dropped", () => {
  // The flow's own fields — sdlc's pointers between stages, say — arrive as an
  // argument, because a value the agent was told is worth more than YAML it composed. Two things can
  // be wrong with one: the name belongs to the envelope, or the name is not a frontmatter name at
  // all. A dropped field produces `written: <path> (N chars)` and a document with no such field in
  // it.
  //
  // Both halves are the rule. Every tool that takes `fields` must run the refusal, so a third write
  // path cannot be added without one; and the name predicate must exist once, so it cannot be
  // half-changed in a copy the refusal does not see.
  const src = zzCoreSource();
  const bad: string[] = [];

  for (const t of zzCoreTools()) {
    if (!/\bfields:\s*z\.record\(/.test(t.body)) continue;
    if (!/\bfieldRefusal\(fields\)/.test(t.body)) {
      bad.push(`${t.name} takes \`fields\` and never calls fieldRefusal, so a name it cannot ` +
               "write is dropped instead of reported");
    }
  }

  // Counted across the whole file rather than inside fieldRefusal: what matters is that no second
  // copy exists, and a check that only read the refusal would pass while a copy sat in the writer.
  const copies = [...src.matchAll(/\^\[a-z\]\[a-z0-9_\]\*\$/g)].length;
  if (copies !== 1) {
    bad.push(`the frontmatter-name pattern appears ${copies} times in zz-core; it belongs to ` +
             "FIELD_NAME alone, and a copy in a write path is a rule that can be half-changed");
  }

  return bad.length ? bad.join("; ") : null;
});

check("a caller's words cannot write a frontmatter field", () => {
  // renderEnvelope is the one place an envelope is rendered, and every value goes through it: the
  // readers are line-based, so a value carrying a newline does not corrupt a document, it inserts a
  // field. parseEnvelope takes the last value of a repeated key, so a tag carrying
  // `"\nflow: other"` rewrites `flow` — which resolves the chain, deciding which gates, which
  // required documents and which closing rule govern the initiative. ownershipCheck cannot see it,
  // because `flow` is not one of the fields the platform owns.
  //
  // Held as a property, not as a shape: the rule is one renderer and one tag rule every write path
  // calls, and either alone would pass a check that read the source for the other. So envelopeFor is
  // lifted out and run on the tag that broke it, and the call sites are checked separately.
  const src = zzCoreSource();
  const bad: string[] = [];

  const envelopeFor = functionBody(src, "envelopeFor");
  const renderEnvelope = functionBody(src, "renderEnvelope");
  if (!envelopeFor || !renderEnvelope) {
    return "zz-core no longer defines envelopeFor and renderEnvelope — this check cannot run";
  }
  let build;
  try {
    build = new Function("chain", "relPath", "body", "opts", `
      const oneLine = (v) => String(v).replace(/[\\r\\n]+/g, " ").trim();
      function renderEnvelope(env, order) {${renderEnvelope}}
      ${envelopeFor}
    `);
  } catch (err) {
    return `envelopeFor could not be evaluated: ${errMessage(err)} — the ` +
           "extraction must fail loudly rather than quietly stop checking";
  }

  const chain = { name: "ops-flow", roles: {}, docs: new Set(["spec.md"]), documents: [] };
  const doc = build(chain, "i/spec.md", "# Spec\n\nbody\n",
    { tags: ["ordinary", "harmless\nflow: some-other-flow\ntype: guide"] });
  // Read back exactly as parseEnvelope does, last value of a repeated key and all.
  const env: Record<string, string> = {};
  const fm = /^---[ \t]*\n([\s\S]*?)\n---/.exec(doc);
  for (const line of (fm?.[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (kv) env[kv[1]] = kv[2].trim();
  }
  if (env.flow !== "ops-flow") {
    bad.push(`a tag rewrote the envelope's flow to ${JSON.stringify(env.flow)} — which is ` +
             "what decides the gates, the required documents and the closing rule");
  }
  if ("type" in env) bad.push("a tag wrote a `type` the manifest never gave the document");

  // The other writer. document_approve() and initiative_close() edit an envelope rather than
  // rendering one, through setEnvelopeField and putEnvelopeField, whose value is not always the
  // platform's own. A newline adds a field rather than corrupting one, and parseEnvelope takes the
  // last value of a repeated key, so `on_behalf_of: "Dana\nflow: other"` writes a flow the platform
  // did not choose. ownershipCheck cannot see it: approve and close pass `via`, and it returns null
  // on `via` by design.
  const setBody = functionBody(src, "setEnvelopeField");
  const putBody = functionBody(src, "putEnvelopeField");
  if (!setBody || !putBody) {
    return "zz-core no longer defines setEnvelopeField and putEnvelopeField — cannot run";
  }
  let put;
  try {
    // oneLine is passed, not written into the source: spelling its regex in the template literal
    // puts it through template-literal escaping, so the generated code carries a real carriage
    // return and line feed inside `/[...]/` and `new Function` fails with "missing /". The check
    // says which of the two it found.
    // COUPLED: ENVELOPE_BLOCK is @zz/contracts', shared by every reader of a frontmatter block, and
    // is read from there — so a move fails loudly rather than passing on a body it cannot run.
    const contracts = contractsSource();
    const pattern = /export const ENVELOPE_BLOCK = (\/.*\/)[a-z]*;/.exec(contracts);
    if (!pattern) return "ENVELOPE_BLOCK cannot be read from @zz/contracts";
    put = new Function("oneLine", "ENVELOPE_BLOCK", "doc", "field", "value", `
      function setEnvelopeField(doc, field, value) {${setBody}}
      function putEnvelopeField(doc, field, value) {${putBody}}
      return putEnvelopeField(doc, field, value);
    `).bind(null, ONE_LINE, new Function(`return ${pattern[1]}`)());
  } catch (err) {
    return `the envelope editors could not be evaluated: ${errMessage(err)}`;
  }
  const base = "---\nflow: ops-flow\ntype: spec\nstatus: draft\n---\n\n# Spec\n\nbody\n";
  const read = (d: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const block = /^---[ \t]*\n([\s\S]*?)\n---/.exec(d);
    for (const line of (block?.[1] ?? "").split("\n")) {
      const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  };
  // Both halves: adding a field that was absent, and rewriting one that was there.
  for (const [field, why] of [["approved_by", "document_approve(on_behalf_of)"], ["status", "a rewrite"]]) {
    const after = read(put(base, field, "Dana Reyes\nflow: some-other-flow\noutcome: accepted"));
    if (after.flow !== "ops-flow") {
      bad.push(`${why} rewrote the envelope's flow to ${JSON.stringify(after.flow)}`);
    }
    if ("outcome" in after) bad.push(`${why} wrote an outcome the platform never derived`);
  }

  // The third writer. A source document is written by source_add and by document_edit's
  // `source_content`.
  // `supports` is what initiative_status reads to flag an approved document for refinement, and
  // `type` is what knowledge_search filters on — so a title carrying a newline could file a source
  // as a spec, or point it at somebody else's document.
  const srcBody = functionBody(src, "sourceDocument");
  if (!srcBody) {
    bad.push("zz-core no longer defines sourceDocument — a source envelope is being built " +
             "somewhere this cannot see");
  } else {
    let makeSource;
    try {
      makeSource = new Function("oneLine", "opts", `
        function renderEnvelope(env, order) {${renderEnvelope}}
        ${srcBody}
      `).bind(null, ONE_LINE);
      const made = read(makeSource({
        title: "Ops meeting\ntype: spec\nstage: sdlc-review\nsupports: plan.md",
        by: "dana@example.com", day: "2026-08-30", stage: "sdlc-spec-audit", content: "notes",
      }));
      // The title is TEXT: its newline, its `type:` and its `stage:` are characters of the title,
      // not envelope keys. So both fields must carry what the ARGUMENTS said — `type` is the
      // stage a caller passed (and the literal `source` when they passed none), and never the
      // `spec` the title claimed.
      if (made.type !== "sdlc-spec-audit") {
        bad.push(`a source title filed the document as ${JSON.stringify(made.type)}`);
      }
      if (made.stage !== "sdlc-spec-audit") {
        bad.push(`a source title repointed stage at ${JSON.stringify(made.stage)}`);
      }
    } catch (err) {
      bad.push(`sourceDocument could not be evaluated: ${errMessage(err)}`);
    }
  }

  // And the rule that stops it arriving at all. Every tool taking `tags` has to bring them to the one
  // spelling, and there are two honest ways depending on which direction they travel: a write
  // refuses a tag it cannot store, and a query folds the caller's filter down to match a store that
  // is already normalised. What no tool may do is neither — one zz.doc.tags column filled by three
  // tools under two rules.
  for (const t of zzCoreTools()) {
    if (!/\btags\b[^)]{0,80}z\.array\(z\.string\(\)\)/.test(t.body)) continue;
    const refuses = /\btagRefusal\(tags\)/.test(t.body);
    const folds = /\btags[.?]*\.map\([^;]*toLowerCase\(\)/.test(t.body);
    if (!refuses && !folds) {
      bad.push(`${t.name} takes \`tags\` and neither refuses a malformed one nor folds it — ` +
               "so it fills or queries zz.doc.tags under no rule at all");
    }
  }

  return bad.length ? bad.join("; ") : null;
});

check("nothing sends the platform a document with frontmatter in it", () => {
  // document_write and document_edit take the body. The refusal says so — "takes the document's
  // BODY — the frontmatter is written by the platform, not by hand" — and `flow`, the one thing a
  // caller genuinely decides, is a named argument.
  //
  // The rule is run, not read: frontmatterRefusal is lifted out of zz-core and asked about each
  // builder's output, so this cannot drift from what the platform actually refuses.
  const core = zzCoreSource();
  const body = functionBody(core, "frontmatterRefusal");
  if (!body) return "zz-core no longer defines frontmatterRefusal — this check cannot run";
  let refuses;
  try {
    refuses = new Function("content", "tool", body);
  } catch (err) {
    return `frontmatterRefusal could not be evaluated: ${errMessage(err)}`;
  }
  // The rule itself, so a change that stopped refusing anything would be visible here rather
  // than only as this check quietly passing.
  if (!refuses("---\nflow: ops-flow\n---\n\n# x\n", "document_write")) {
    return "frontmatterRefusal no longer refuses content that opens with frontmatter — the " +
           "rest of this check would pass by asking a question that has stopped mattering";
  }

  const bad: string[] = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // A template literal that opens a document, anywhere outside zz-core itself — the one thing
    // allowed to compose an envelope, and it does it through renderEnvelope. The whole service, not
    // one file in it: naming server.ts reports write-guards.ts's stampEnvelope for building one.
    if (rel.startsWith("services/zz-core/src/")) continue;
    for (const m of src.matchAll(/`---\\n/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const text = src.split("\n")[line - 1];
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;         // prose about the rule
      bad.push(`${rel}:${line} builds a document that opens with frontmatter — send the body, ` +
               "and pass `flow` as the argument document_write takes");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no write path lets a caller type an envelope field", () => {
  // The envelope is the platform's and the body is the caller's; there is no third source.
  // document_write, and document_edit's whole-body `content`, refuse content that opens with
  // frontmatter. An edit batch has no content to inspect — it has a `find` and a `replace` — and
  // `find: "flow: ops-flow"` would land in the envelope as readily as in a section, so document_edit
  // applies a batch, and a section, to the BODY alone, and composes the envelope itself from the
  // stored one and its named arguments. The envelope is not text an edit can reach.
  //
  // ownershipCheck is not enough on that path: it compares the fields in PLATFORM_OWNED, and
  // `flow` is not one of them. `flow` decides which gates, which required documents and which
  // closing rule govern the initiative, and stampEnvelope only ever adds it, so an edited one would
  // stand. `version` is the same shape.
  //
  // Run over the four edits that matter and the one the tool exists for, through the primitive
  // document_edit applies — `applyEdits`, compiled from zz-core — on the text it applies it to, the
  // document's body as @zz/contracts' `documentBody` cuts it. The property is about what an edit
  // can reach, not how the refusal is spelled.
  //
  // Removed with `document_patch`, which edited the whole stored text and so had to compare the
  // envelope block before and after (`envelopeEditRefusal`): an edit that never sees the envelope
  // has nothing to compare.
  const core = zzCoreSource();
  const plan = functionBody(core, "planEdit");
  if (!plan) return "zz-core no longer defines planEdit — this check cannot run";
  const code = plan.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const bad: string[] = [];
  if (!/const body = documentBody\(loaded\.text\);/.test(code)
      || !/applyEdits\(body, a\.edits/.test(code) || !/sectionBody\(path, body, a\)/.test(code)) {
    bad.push("document_edit no longer applies an edit batch and a section to the body alone — an " +
             "edit that can reach the stored envelope can retype the flow, the version or a gate");
  }
  if (!/`\$\{renderEnvelope\(env, \[[^\]]*\]\)\}\\n\$\{next\}`/.test(code)) {
    bad.push("document_edit's candidate is no longer its own rendered envelope followed by the " +
             "edited body, so this check no longer knows where an edit's text lands");
  }

  const contracts = contractsSource();
  const pattern = /export const ENVELOPE_BLOCK = (\/.*\/)[a-z]*;/.exec(contracts);
  if (!pattern) return "ENVELOPE_BLOCK cannot be read from @zz/contracts";
  const cut = functionBody(contracts, "documentBody");
  if (!cut) return "@zz/contracts no longer defines documentBody — this check cannot run";
  let documentBody: (text: string) => string;
  let applyEdits: (body: string, edits: { find: string; replace: string }[]) => { body?: string; code?: string };
  try {
    documentBody = new Function("ENVELOPE_BLOCK", "content", cut)
      .bind(null, new Function(`return ${pattern[1]}`)());
    const mod: Record<string, unknown> = {};
    const js = ts.transpileModule(readFileSync(join(root, "services/zz-core/src/document-edits.ts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("exports", js)(mod);
    applyEdits = mod.applyEdits as typeof applyEdits;
  } catch (err) {
    return `documentBody or applyEdits could not be evaluated: ${errMessage(err)}`;
  }

  const doc = [
    "---", "flow: ops-flow", "type: spec", "title: Enquiries", "status: draft",
    "version: 1", "updated_at: 2026-08-30", "---", "", "# Spec", "", "<!-- brief: context -->", "",
  ].join("\n");
  const cases: [string, string, boolean, string][] = [
    ["flow: ops-flow", "flow: some-other-flow", true, "relabels which flow governs the initiative"],
    ["version: 1", "version: 99", true, "rewrites the version the platform derives from the causes"],
    ["status: draft", "status: approved", true, "signs a gate by hand"],
    ["title: Enquiries", "title: Enquiries\noutcome: accepted", true, "adds an outcome nobody derived"],
    ["<!-- brief: context -->", "The service takes 400 enquiries a week.", false,
     "fills a section, which is what an edit is for"],
  ];
  for (const [find, replace, shouldRefuse, why] of cases) {
    const got = applyEdits(documentBody(doc), [{ find, replace }]);
    const refused = !("body" in got);
    if (refused !== shouldRefuse) {
      bad.push(`an edit that ${why} is ${refused ? `refused (${got.code})` : "applied"} and should be ` +
               `${shouldRefuse ? "refused" : "applied"}`);
    }
  }

  // And each route that takes a whole body has to consult the frontmatter refusal, or the rule
  // holds on nothing.
  for (const tool of ["document_write", "document_edit"]) {
    if (!new RegExp(`frontmatterRefusal\\([^,]+, "${tool}"\\)`).test(withoutComments(core))) {
      bad.push(`${tool} does not call frontmatterRefusal, so content that opens with an envelope ` +
               "reaches the store");
    }
  }
  if (!/const fm = mode === "content" \? frontmatterRefusal\(a\.content/.test(code)) {
    bad.push("document_edit's whole-body `content` is not asked frontmatterRefusal before it is written");
  }
  return bad.length ? bad.join("; ") : null;
});
