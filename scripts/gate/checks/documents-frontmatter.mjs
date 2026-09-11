/**
 * Frontmatter at the boundary: what a caller may send, and what is refused rather than
 * quietly dropped.
 *
 * A field a caller types that the platform silently discards is worse than a refusal — the
 * write succeeds, the document looks right, and the field the caller believes they set is
 * simply absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ONE_LINE, between, contractsSource, functionBody, root, sourceFiles, toolsIn, zzCoreSource, zzCoreTools } from "../read.mjs";
import { check } from "../run.mjs";

// A VALUE SOMEBODY TYPED, INSIDE HAND-WRITTEN YAML QUOTES.
//
// client-package generates the frontmatter of every file a person installs. Most of it is
// slugs the platform controls, and one field is not: `agentName` is free text an admin gives
// install_flow — "agent_name is what the team sees" — and it was interpolated into
// `description: "Run the ${…} flow…"`. An agent called `My "Special" Agent` closes the quote
// early, and the client then cannot parse the command: it silently does not exist, and
// nothing anywhere says why.
//
// The file already knew the answer. Forty lines down, the standalone command builds the same
// field with JSON.stringify, and says why.
//
// The rule is the general one: a YAML scalar built by hand around an interpolation is a
// quoting decision made by hoping. JSON.stringify is a correct YAML double-quoted scalar.
check("generated frontmatter quotes what it interpolates", () => {
  const rel = join("services", "gateway", "src", "client-package.ts");
  const src = readFileSync(join(root, rel), "utf8");
  const bad = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    // A frontmatter key whose value is a hand-quoted string containing an interpolation.
    // Indented keys too. The first version anchored the key to the backtick, so
    // `    url: "${s.url}"` — the Hermes config, where the value is the operator's own
    // GATEWAY_PUBLIC_URL — was invisible. A YAML file's keys are indented by definition.
    if (!/`\s*[a-z_]+:\s*"[^"]*\$\{/i.test(line)) return;
    bad.push(`${rel}:${i + 1} builds a quoted YAML scalar around an interpolation — ` +
             "JSON.stringify the whole value, as the standalone command does");
  });
  return bad.join("\n");
});

check("a frontmatter field that will not appear is refused, never dropped", () => {
  // The flow's OWN fields — sm's `building_block`, sdlc's pointers between stages — arrive as
  // an argument because a value the agent was TOLD is worth more than YAML it composed. Two
  // things can be wrong with one: the name belongs to the envelope, or the name is not a
  // frontmatter name at all. Only the first was ever said out loud.
  //
  // The second was enforced by `/^[a-z][a-z0-9_]*$/` written twice — once inside envelopeFor
  // and once inside revise_document — and both copies DROPPED the field and carried on. So
  // `buildingBlock` where the skill said `building_block` produced `written: <path> (N chars)`
  // and a document with no such field in it, which is the failure this repository keeps
  // finding: a call that did not error and did not do the thing either.
  //
  // Both halves are the rule. Every tool that takes `fields` must run the refusal, so a third
  // write path cannot be added without one; and the name predicate must exist ONCE, so it
  // cannot be half-changed in a copy the refusal does not see.
  const src = zzCoreSource();
  const bad = [];

  for (const t of zzCoreTools()) {
    if (!/\bfields:\s*z\.record\(/.test(t.body)) continue;
    if (!/\bfieldRefusal\(fields\)/.test(t.body)) {
      bad.push(`${t.name} takes \`fields\` and never calls fieldRefusal, so a name it cannot ` +
               "write is dropped instead of reported");
    }
  }

  // Counted across the whole file rather than looked for inside fieldRefusal: what matters is
  // that no SECOND copy exists, and a check that only read the refusal would pass while a
  // copy sat in the writer.
  const copies = [...src.matchAll(/\^\[a-z\]\[a-z0-9_\]\*\$/g)].length;
  if (copies !== 1) {
    bad.push(`the frontmatter-name pattern appears ${copies} times in zz-core; it belongs to ` +
             "FIELD_NAME alone, and a copy in a write path is a rule that can be half-changed");
  }

  return bad.length ? bad.join("; ") : null;
});

check("a caller's words cannot write a frontmatter field", () => {
  // renderEnvelope's docblock calls it "the one place an envelope is rendered, and the reason
  // every value goes through it": the readers are line-based, so a value carrying a newline
  // does not corrupt a document, it INSERTS A FIELD. It was not the one place. envelopeFor
  // built the same frontmatter by concatenating strings, and `tags` was the one value it
  // concatenated raw — title and stakeholder went through oneLine and tags did not.
  //
  // write_file with `tags: ["ordinary", "harmless\nflow: other\ntype: guide"]` produced an
  // envelope whose flow parseEnvelope reads as `other`, because it takes the LAST value of a
  // repeated key. `flow` is what resolves the chain, so which gates, which required documents
  // and which closing rule govern the initiative became the caller's to choose — and
  // ownershipCheck cannot see it, because `flow` is not one of the fields the platform owns.
  //
  // Held as a PROPERTY, not as a shape. The fix is two things at once — one renderer, and one
  // tag rule every write path calls — and either alone would still pass a check that read the
  // source for the other. So envelopeFor is lifted out and run on the tag that broke it, and
  // the call sites are checked separately.
  const src = zzCoreSource();
  const bad = [];

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
    return `envelopeFor could not be evaluated: ${String(err.message ?? err)} — the ` +
           "extraction must fail loudly rather than quietly stop checking";
  }

  const chain = { name: "ops-flow", roles: {}, docs: new Set(["spec.md"]), documents: [] };
  const doc = build(chain, "i/spec.md", "# Spec\n\nbody\n",
    { tags: ["ordinary", "harmless\nflow: some-other-flow\ntype: guide"] });
  // Read back exactly as parseEnvelope does, LAST value of a repeated key and all.
  const env = {};
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

  // THE OTHER WRITER. approve() and close() do not render an envelope, they edit one —
  // through setEnvelopeField and putEnvelopeField, whose own comment says the value "is not
  // always the platform's own" and then guarded only the substitution patterns. A newline is
  // the more serious half: it does not corrupt a field, it adds one, and parseEnvelope takes
  // the LAST value of a repeated key. `approve(on_behalf_of: "Dana\nflow: other")` wrote a
  // flow the platform had not chosen, through the tool whose description says the platform
  // writes that field and a hand-written one is refused — and ownershipCheck cannot see it,
  // because approve and close pass `via` and it returns null on `via` by design.
  const setBody = functionBody(src, "setEnvelopeField");
  const putBody = functionBody(src, "putEnvelopeField");
  if (!setBody || !putBody) {
    return "zz-core no longer defines setEnvelopeField and putEnvelopeField — cannot run";
  }
  let put;
  try {
    // oneLine is PASSED, not written into the source. Spelling it in the template literal put
    // its regex through template-literal escaping first, so the generated code carried a real
    // carriage return and line feed inside `/[...]/` — a regex split across two lines, and
    // `new Function` failed with "missing /". The check reported a broken extraction rather
    // than a broken invariant, which is exactly why it says which of the two it found.
    // ENVELOPE_BLOCK is @zz/contracts' now, shared by every reader of a frontmatter block.
    // These two used to spell the pattern inline; when it moved, this check failed with
    // "ENVELOPE_BLOCK is not defined" rather than passing on a body it could no longer run,
    // which is the extraction failing loudly the way it is meant to.
    const contracts = contractsSource();
    const pattern = /export const ENVELOPE_BLOCK = (\/.*\/)[a-z]*;/.exec(contracts);
    if (!pattern) return "ENVELOPE_BLOCK cannot be read from @zz/contracts";
    put = new Function("oneLine", "ENVELOPE_BLOCK", "doc", "field", "value", `
      function setEnvelopeField(doc, field, value) {${setBody}}
      function putEnvelopeField(doc, field, value) {${putBody}}
      return putEnvelopeField(doc, field, value);
    `).bind(null, ONE_LINE, new Function(`return ${pattern[1]}`)());
  } catch (err) {
    return `the envelope editors could not be evaluated: ${String(err.message ?? err)}`;
  }
  const base = "---\nflow: ops-flow\ntype: spec\nstatus: draft\n---\n\n# Spec\n\nbody\n";
  const read = (d) => {
    const out = {};
    const block = /^---[ \t]*\n([\s\S]*?)\n---/.exec(d);
    for (const line of (block?.[1] ?? "").split("\n")) {
      const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
      if (kv) out[kv[1]] = kv[2].trim();
    }
    return out;
  };
  // Both halves: adding a field that was absent, and rewriting one that was there.
  for (const [field, why] of [["approved_by", "approve(on_behalf_of)"], ["status", "a rewrite"]]) {
    const after = read(put(base, field, "Dana Lim\nflow: some-other-flow\noutcome: accepted"));
    if (after.flow !== "ops-flow") {
      bad.push(`${why} rewrote the envelope's flow to ${JSON.stringify(after.flow)}`);
    }
    if ("outcome" in after) bad.push(`${why} wrote an outcome the platform never derived`);
  }

  // THE THIRD WRITER. A source document is written by add_source and by revise_document, and
  // for a while by two hand-built envelopes of which one escaped its title and one did not.
  // `supports` is what initiative_status reads to flag an approved document for refinement,
  // and `type` is what search_knowledge filters on — so a title carrying a newline could file
  // a source as a spec, or point it at somebody else's document.
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
        title: "Ops meeting\ntype: spec\nsupports: plan.md",
        by: "dana@example.com", day: "2026-08-30", supports: "spec.md", content: "notes",
      }));
      if (made.type !== "source") {
        bad.push(`a source title filed the document as ${JSON.stringify(made.type)}`);
      }
      if (made.supports !== "spec.md") {
        bad.push(`a source title repointed supports at ${JSON.stringify(made.supports)}`);
      }
    } catch (err) {
      bad.push(`sourceDocument could not be evaluated: ${String(err.message ?? err)}`);
    }
  }

  // And the rule that stops it arriving at all. Every tool taking `tags` has to bring them to
  // the one spelling, and there are two honest ways depending on which direction they travel:
  // a WRITE refuses a tag it cannot store, because silently rewriting somebody's tag is the
  // trade safePath refuses for a path; a QUERY folds the caller's filter down, because a
  // value arriving from outside has to be matched against a store that is already normalised.
  // What no tool may do is neither, which is what write_file and revise_document did — the
  // same zz.doc.tags column filled by three tools under two rules, one of which was no rule.
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
  // write_file and revise_document take the BODY. The platform says so in the refusal itself —
  // "takes the document's BODY — the frontmatter is written by the platform, not by hand" —
  // and `flow`, the one thing a caller genuinely decides, is a named argument.
  //
  // chain-check went on building `---\nflow: …\n---` into its content long after its own
  // docblock had been rewritten to describe the argument. So every write in it was refused,
  // and the probe that exists to say "the platform still works when the model provider is
  // down" could not complete one. It needs a live deployment, which is why nothing caught it.
  //
  // The rule is RUN, not read: frontmatterRefusal is lifted out of zz-core and asked about
  // each builder's output, so this cannot drift from what the platform actually refuses.
  const core = zzCoreSource();
  const body = functionBody(core, "frontmatterRefusal");
  if (!body) return "zz-core no longer defines frontmatterRefusal — this check cannot run";
  let refuses;
  try {
    refuses = new Function("content", "tool", body);
  } catch (err) {
    return `frontmatterRefusal could not be evaluated: ${String(err.message ?? err)}`;
  }
  // The rule itself, so a change that stopped refusing anything would be visible here rather
  // than only as this check quietly passing.
  if (!refuses("---\nflow: ops-flow\n---\n\n# x\n", "write_file")) {
    return "frontmatterRefusal no longer refuses content that opens with frontmatter — the " +
           "rest of this check would pass by asking a question that has stopped mattering";
  }

  const bad = [];
  for (const rel of sourceFiles(["packages", "services"], [".ts"])) {
    const src = readFileSync(join(root, rel), "utf8");
    // A template literal that OPENS a document, anywhere outside zz-core itself — which is
    // the one thing allowed to compose an envelope, and does it through renderEnvelope.
    //
    // THE WHOLE SERVICE, not one file in it. This named server.ts, and the moment stampEnvelope
    // moved into write-guards.ts the check reported the one function allowed to build an
    // envelope for building one. The comment above already said "zz-core itself"; the code
    // said one path.
    if (rel.startsWith("services/zz-core/src/")) continue;
    for (const m of src.matchAll(/`---\\n/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const text = src.split("\n")[line - 1];
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;         // prose about the rule
      bad.push(`${rel}:${line} builds a document that opens with frontmatter — send the body, ` +
               "and pass `flow` as the argument write_file takes");
    }
  }
  return bad.length ? bad.join("; ") : null;
});

check("no write path lets a caller type an envelope field", () => {
  // "The envelope is the platform's; the body is yours ... there is no third source, and 'the
  // model typed it into some YAML' was the third source." write_file and revise_document
  // refuse content that OPENS with frontmatter. patch_file has no content to inspect — it has
  // a `find` and a `replace` — and `find: "flow: ops-flow"` lands in the envelope as readily as
  // in a section. It was the third source, still open.
  //
  // ownershipCheck is not enough on that path: it compares the five fields in PLATFORM_OWNED,
  // and `flow` is not one of them. `flow` decides which gates, which required documents and
  // which closing rule govern the initiative, and stampEnvelope only ever ADDS it, so a
  // patched one stands. `version` is the same shape.
  //
  // RUN over the four edits that matter and the one the tool exists for, because the property
  // is about what the guard concludes, not how it is spelled.
  const src = zzCoreSource();
  const body = functionBody(src, "envelopeEditRefusal");
  if (!body) return "zz-core no longer defines envelopeEditRefusal — this check cannot run";
  const contracts = contractsSource();
  const pattern = /export const ENVELOPE_BLOCK = (\/.*\/)[a-z]*;/.exec(contracts);
  if (!pattern) return "ENVELOPE_BLOCK cannot be read from @zz/contracts";

  let refuse;
  try {
    refuse = new Function("ENVELOPE_BLOCK", "before", "after", body)
      .bind(null, new Function(`return ${pattern[1]}`)());
  } catch (err) {
    return `envelopeEditRefusal could not be evaluated: ${String(err.message ?? err)}`;
  }

  const doc = [
    "---", "flow: ops-flow", "type: spec", "title: Enquiries", "status: draft",
    "version: 1", "updated_at: 2026-08-30", "---", "", "# Spec", "", "<!-- brief: context -->", "",
  ].join("\n");
  const patched = (find, replace) => doc.replace(find, () => replace);
  const bad = [];
  const cases = [
    ["flow: ops-flow", "flow: some-other-flow", true, "relabels which flow governs the initiative"],
    ["version: 1", "version: 99", true, "rewrites the version revise_document owns"],
    ["status: draft", "status: approved", true, "signs a gate by hand"],
    ["title: Enquiries", "title: Enquiries\noutcome: accepted", true, "adds an outcome nobody derived"],
    ["<!-- brief: context -->", "The service takes 400 enquiries a week.", false,
     "fills a section, which is what patch_file is for"],
  ];
  for (const [find, replace, shouldRefuse, why] of cases) {
    const got = Boolean(refuse(doc, patched(find, replace)));
    if (got !== shouldRefuse) {
      bad.push(`a patch that ${why} is ${got ? "refused" : "allowed"} and should be ` +
               `${shouldRefuse ? "refused" : "allowed"}`);
    }
  }

  // And each write path has to consult its own refusal, or the rule holds on nothing.
  for (const t of zzCoreTools()) {
    if (t.name === "patch_file" && !/envelopeEditRefusal\(/.test(t.body)) {
      bad.push("patch_file does not call envelopeEditRefusal — it edits text in place, so it " +
               "is the one path with no content to inspect for frontmatter");
    }
    if ((t.name === "write_file" || t.name === "revise_document") &&
        !/frontmatterRefusal\(content/.test(t.body)) {
      bad.push(`${t.name} does not call frontmatterRefusal, so content that opens with an ` +
               "envelope reaches the store");
    }
  }
  return bad.length ? bad.join("; ") : null;
});
