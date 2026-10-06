/**
 * Frontmatter at the boundary: what a caller may send, and what is refused rather than quietly
 * dropped. A field a caller types that the platform silently discards is worse than a refusal — the
 * write succeeds, the document looks right, and the field the caller believes they set is absent.
 *
 * The rule an envelope a caller sends is held to: content's envelope never becomes the stored
 * envelope — the keys the platform owns are ignored and reported, a malformed key is refused, and
 * only the platform renders the envelope. It REPLACES "content that opens with frontmatter is
 * refused" (`frontmatterRefusal`, deleted in Phase 2 of 2026-10-06-doc-write-and-update-paradigm):
 * that rule refused a Markdown thematic break too, and a document read back and sent whole. The
 * new one is run, not read — `normalizeContent` from the built zz-core, on planted envelopes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { ONE_LINE, contractsSource, functionBody, root, sourceFiles, zzCoreSource, zzCoreTools, errMessage,
         withoutComments } from "../read.ts";
import { check } from "../run.ts";

/** What the built `normalizeContent` and `bodyEnvelopeRefusal` answer for each input, or why they
 *  could not be run — a probe that cannot run is reported as that, never as a pass. Run from
 *  `dist`: the module imports @zz/contracts and its siblings, so its text cannot be lifted out. */
function normalized(inputs: { content: string; named?: Record<string, unknown> }[]):
    { content: { body?: string; metadata?: Record<string, unknown>; normalised?: string[]; refusals?: string[] };
      opened: string | null }[] | string {
  const mod = join(root, "services/zz-core/dist/document-normalize.js");
  if (!existsSync(mod)) return `${mod} does not exist — this check runs the built normalisation and there is none`;
  const probe = `
    import { bodyEnvelopeRefusal, normalizeContent } from ${JSON.stringify(mod)};
    const inputs = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify(inputs.map((i) =>
      ({ content: normalizeContent(i.content, i.named ?? {}), opened: bodyEnvelopeRefusal(i.content) }))));
  `;
  try {
    return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe, JSON.stringify(inputs)],
      { encoding: "utf8", cwd: root }));
  } catch (err) {
    return `document-normalize.js could not be run: ${errMessage(err).slice(-300)}`;
  }
}

/** Every key the platform writes or renders that a caller might plant in an envelope it sends. */
const PLANTED = ["flow", "type", "status", "version", "updated_at", "approved_by", "approved_at", "outcome",
                 "closed_by", "accepted_by", "content_revision", "revision_note", "sources", "supports", "stage"];

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
  // document_write and document_edit take the body, and the platform renders the envelope. An
  // envelope a caller sends anyway is taken apart rather than stored: `flow`, the field that
  // decides which gates govern the initiative, is the platform's, and a planted one must be
  // ignored and reported — never become the stored `flow`.
  //
  // REPLACES "frontmatterRefusal refuses content that opens with frontmatter": that refusal is
  // gone, and what holds now is that the planted keys never reach the metadata a write stores.
  // Run on the built module, so this cannot drift from what the platform actually does.
  const ran = normalized([{ content: "---\nflow: some-other-flow\ntype: guide\nstatus: approved\n---\n\n# x\n" }]);
  if (typeof ran === "string") return ran;
  const [{ content }] = ran;
  if (content.refusals || content.body !== "# x\n") {
    return `normalizeContent no longer separates a planted envelope from its body (${JSON.stringify(content)}) — ` +
           "the rest of this check would pass by asking a question that has stopped mattering";
  }
  if (/flow|type|status/.test(JSON.stringify(content.metadata))) {
    return `a planted envelope reached the metadata a write stores: ${JSON.stringify(content.metadata)}`;
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
  // document_write, and document_edit's whole-body `content`, separate an envelope a caller sends
  // and never store it as one (below). An edit batch has no content to inspect — it has a `find` and a `replace` — and
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

  // And each route that takes a whole body has to separate its envelope, or the rule holds on
  // nothing: document_write's handler, and document_edit's whole `content` in the change service.
  // A body an edit batch or a section MAKES is asked whether it opens with an envelope.
  //
  // REPLACES "each route consults frontmatterRefusal": content's envelope never becomes the stored
  // envelope. The platform-owned keys are ignored and reported, a malformed key is refused, and a
  // made body that opens with a recognised envelope is refused — run below, on planted envelopes.
  const tools = zzCoreTools();
  const write = tools.find((t) => t.name === "document_write")?.body ?? "";
  if (!/normalizeContent\(args\.content\b/.test(withoutComments(write))) {
    bad.push("document_write does not normalise its content, so an envelope a caller sent reaches the store as one");
  }
  if (!/normalizeContent\(mode === "content" \? a\.content/.test(code)) {
    bad.push("document_edit's whole-body `content` is not normalised before it is written");
  }
  if (!/bodyEnvelopeRefusal\(next\)/.test(code)) {
    bad.push("document_edit no longer asks whether the body an edit batch or a section makes opens with an envelope");
  }
  const ran = normalized([
    { content: `---\n${PLANTED.map((k) => `${k}: planted`).join("\n")}\ntitle: Kept\n---\n# Spec\n` },
    { content: "---\r\nstatus: approved\r\ndueDate: soon\r\n---\r\n# Spec\r\n" },
    { content: "---\n\n# Spec after a rule\n" },
  ]);
  if (typeof ran === "string") return [...bad, ran].join("; ");
  const [owned, malformed, rule] = ran;
  if (owned.content.refusals) {
    bad.push(`an envelope of platform-owned keys was refused rather than ignored: ${owned.content.refusals.join(" | ")}`);
  } else {
    const leaked = PLANTED.filter((k) => JSON.stringify(owned.content.metadata ?? {}).includes(`"${k}"`));
    const unreported = PLANTED.filter((k) => !(owned.content.normalised ?? []).some((l) => new RegExp(`\\b${k}\\b`).test(l)));
    if (leaked.length) bad.push(`${leaked.join(", ")} planted in content reached the stored envelope`);
    if (unreported.length) bad.push(`${unreported.join(", ")} planted in content ${unreported.length > 1 ? "were" : "was"} dropped without a word`);
    if (owned.content.metadata?.title !== "Kept") bad.push("an envelope's editable `title` was not taken");
  }
  if (!(malformed.content.refusals ?? []).some((r) => /UNSUPPORTED_METADATA.*dueDate/.test(r))) {
    bad.push(`a malformed key in a CRLF envelope is not refused by name: ${JSON.stringify(malformed.content)}`);
  }
  if (rule.content.body !== "---\n\n# Spec after a rule\n" || rule.opened !== null) {
    bad.push("a thematic break at the top of a body is no longer kept as markdown");
  }
  if (owned.opened === null || malformed.opened === null) {
    bad.push("a body that opens with a recognised envelope is not refused on the edit path");
  }
  return bad.length ? bad.join("; ") : null;
});
