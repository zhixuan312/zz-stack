#!/usr/bin/env node
/**
 * checks/document-normalize-rules.ts — the normalisation module's table of inputs and outcomes,
 * pure: no database, no zz-core, nothing but the built `document-normalize.js` (AC-2.1).
 *
 *   node checks/document-normalize-rules.ts   # needs a built tree (`npm run build`)
 *
 * The rule the cases hold: content's envelope never becomes the stored envelope. A recognised
 * envelope — the platform's own `ENVELOPE_BLOCK`, after any leading blank lines, CRLF or LF, every
 * line inside it `key: value` — is separated from the body; its editable keys and flow fields are
 * taken unless a named argument says otherwise, every key the platform writes is ignored and
 * reported, and any other key is refused by name. Anything else that starts with `---` — a thematic
 * break, a YAML document that is not a key block, SQL — is the body, byte for byte. Tags are
 * lower-cased; a reference loses `./` and its own initiative's prefix and gains `.md`, and one that
 * leaves the initiative is refused. Every normalisation is one reported line.
 *
 * Exit 0: every case held. Exit 1: the failing cases, each with what it got.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Named = { title?: string; tags?: string[]; stakeholder?: string; fields?: Record<string, string> };
type Outcome = { body: string; metadata: Named; normalised: string[] } | { refusals: string[] };
type Refs = { refs: string[]; normalised: string[] } | { refusals: string[] };

const N = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-normalize.js")).href) as {
  normalizeContent(content: string, named: Named): Outcome;
  normalizeRefs(entries: string[] | undefined, initiative: string): Refs;
  normalizeTags(tags: string[] | undefined): { tags: string[] | undefined; normalised: string[] };
  bodyEnvelopeRefusal(body: string): string | null;
};

let failed = 0;
const holds = (name: string, ok: boolean, got: unknown): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         got ${JSON.stringify(got)}`}`);
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Taken: the body and metadata expected, and one reported line per key the envelope carried. */
function taken(name: string, content: string, named: Named, body: string, metadata: Named, lines: number): Outcome {
  const got = N.normalizeContent(content, named);
  holds(name, !("refusals" in got) && got.body === body && same(got.metadata, metadata) && got.normalised.length === lines, got);
  return got;
}
/** Literal: the content is the body, every byte, and nothing is reported. */
function literal(name: string, content: string): void {
  const got = N.normalizeContent(content, {});
  holds(name, !("refusals" in got) && got.body === content && got.normalised.length === 0 && same(got.metadata, {}), got);
}
/** Refused: every refusal matches one of `want`, and every `want` is answered. */
function refused(name: string, content: string, named: Named, want: RegExp[]): string[] {
  const got = N.normalizeContent(content, named);
  const r = "refusals" in got ? got.refusals : [];
  holds(name, r.length === want.length && want.every((w) => r.some((x) => w.test(x))), got);
  return r;
}

/* No envelope: the content is the body, and the named arguments are the metadata. */
taken("a body starting at its heading is the body", "# Spec\n\nbody\n", { title: "Spec" }, "# Spec\n\nbody\n", { title: "Spec" }, 0);

/* A recognised envelope, in every spelling a caller sends one. */
taken("an LF envelope is separated: its title taken, its status ignored",
      "---\ntitle: Hello\nstatus: approved\n---\n\n# T\n", {}, "# T\n", { title: "Hello" }, 2);
taken("a CRLF envelope is separated, and the body keeps its CRLF",
      "---\r\ntitle: Hello\r\nflow: other-flow\r\n---\r\n\r\n# T\r\nline\r\n", {}, "# T\r\nline\r\n", { title: "Hello" }, 2);
taken("an envelope after leading blank lines is recognised",
      "\n\n---\ntitle: X\n---\n# T\n", {}, "# T\n", { title: "X" }, 1);
taken("an envelope after a leading blank line, in CRLF, is recognised",
      "\r\n---\r\nstatus: approved\r\n---\r\n# Front\n", {}, "# Front\n", {}, 1);
taken("an envelope closed at the end of the content leaves an empty body",
      "---\ntitle: X\n---", {}, "", { title: "X" }, 1);
taken("an empty editable value takes nothing and is reported", "---\ntitle:\n---\n# T\n", {}, "# T\n", {}, 1);
taken("a flow field is taken into `fields`", "---\ncomponent: billing\n---\n# T\n", {}, "# T\n",
      { fields: { component: "billing" } }, 1);

/* Not an envelope: the body, byte for byte. */
literal("a thematic break at the top is markdown", "---\n\nAfter a rule\n");
literal("two thematic breaks around a heading are markdown", "---\n\n# T\n\n---\n");
literal("a YAML document that is not a key block is content", "---\nname: x\nitems:\n  - a\n  - b\n---\nrest\n");
literal("SQL between dashes is content", "---\nSELECT * FROM t WHERE a = 1;\n---\n-- comment\n");
literal("SQL opening with a comment is content", "-- schema\ncreate table t (a int);\n");
literal("a closing fence that runs on is not a fence", "---\ntitle: x\n----\nbody\n");
literal("a key with a space in it is not a key line", "---\nDue Date: x\n---\n# T\n");

/* Every key the platform writes or renders: ignored, each reported, none taken. */
const SERVER = ["flow", "type", "status", "version", "updated_at", "approved_by", "approved_at", "outcome",
  "closed_by", "accepted_by", "no_signoff_reason", "content_revision", "revision_note", "sources", "date",
  "added_at", "contributed_by", "supports", "stage", "audits_version", "evidence", "supersededBy",
  "verified_against", "eval_run_id"];
const all = taken("every server-owned key is ignored and reported, one line each",
  `---\n${SERVER.map((k) => `${k}: planted-${k}`).join("\n")}\n---\n# T\n`, {}, "# T\n", {}, SERVER.length);
if (!("refusals" in all)) {
  const unreported = SERVER.filter((k) => !all.normalised.some((l) => l.includes(k)));
  holds("each ignored line names its key", unreported.length === 0, unreported);
  holds("no planted value reaches the metadata", !JSON.stringify(all.metadata).includes("planted"), all.metadata);
}

/* A document read back and sent whole: its own envelope, every rendered key, is not a change. */
const readBack = [
  "---", "flow: sdlc-flow", "type: spec", "title: Spec", "tags: alpha, beta", "version: 2",
  "content_revision: cr_aaaaaaaaaaaaaaaaaaaaaaaaaa", "updated_at: 2026-10-06", "status: draft",
  "revision_note: tightened the scope", "sources: 2026-10-06-x/sources/2026-10-06-call.md",
  "stakeholder: Ana", "component: billing", "---", "", "# Spec", "", "body", "",
].join("\n");
const back = taken("a read-back envelope gives back exactly its editable metadata", readBack, {}, "# Spec\n\nbody\n",
  { title: "Spec", tags: ["alpha", "beta"], stakeholder: "Ana", fields: { component: "billing" } }, 12);
if (!("refusals" in back)) {
  holds("its `sources` line is reported, never taken as causes",
        back.normalised.some((l) => /\bsources\b/.test(l)) && !("sources" in back.metadata), back);
  holds("its `revision_note` is reported", back.normalised.some((l) => /\brevision_note\b/.test(l)), back.normalised);
}
taken("the same read-back with the same named arguments agrees", readBack,
  { title: "Spec", tags: ["beta", "alpha"], stakeholder: "Ana", fields: { component: "billing" } }, "# Spec\n\nbody\n",
  { title: "Spec", tags: ["beta", "alpha"], stakeholder: "Ana", fields: { component: "billing" } }, 12);

/* Conflicts and unknown keys: refused, every one of them at once, never lost. */
let r = refused("a title that differs from the named one is METADATA_CONFLICT naming both values",
  "---\ntitle: Alpha\n---\n# T\n", { title: "Beta" }, [/^ERROR: METADATA_CONFLICT — .*"Alpha".*"Beta"/]);
refused("tags, stakeholder and a flow field that differ are three conflicts, reported together",
  "---\ntags: a, b\nstakeholder: Ana\ncomponent: billing\n---\n# T\n",
  { tags: ["c"], stakeholder: "Bo", fields: { component: "ledger" } },
  [/^ERROR: METADATA_CONFLICT — .*tags/, /^ERROR: METADATA_CONFLICT — .*stakeholder/, /^ERROR: METADATA_CONFLICT — .*component/]);
r = refused("unknown keys are UNSUPPORTED_METADATA, every one named in one refusal",
  "---\ndueDate: x\nDue-Date: y\ntitle: ok\n---\n# T\n", {}, [/^ERROR: UNSUPPORTED_METADATA — /]);
holds("the refusal names both unknown keys", r.length === 1 && r[0].includes("dueDate") && r[0].includes("Due-Date"), r);
refused("a conflict and an unknown key are both reported", "---\ntitle: A\nWeird: 1\n---\n# T\n", { title: "B" },
  [/^ERROR: METADATA_CONFLICT/, /^ERROR: UNSUPPORTED_METADATA/]);
refused("a body that still opens with an envelope after the first is refused",
  "---\ntitle: A\n---\n---\nstatus: approved\n---\n# T\n", {}, [/^ERROR: UNSUPPORTED_METADATA — .*named argument/]);

/* Tags: lower-cased, each change one line; the tag rule itself stays tagRefusal's. */
let t = N.normalizeTags([" Alpha ", "beta", "Plugin:SDLC"]);
holds("tags are lower-cased, one line per tag changed", same(t.tags, ["alpha", "beta", "plugin:sdlc"]) && t.normalised.length === 2, t);
t = N.normalizeTags(undefined);
holds("no tags are no tags", t.tags === undefined && t.normalised.length === 0, t);
taken("an envelope's tags are lower-cased too", "---\ntags: Foo, bar\n---\n# T\n", {}, "# T\n", { tags: ["foo", "bar"] }, 2);
taken("named tags are lower-cased with no envelope", "# T\n", { tags: ["Foo"] }, "# T\n", { tags: ["foo"] }, 1);

/* References: same-initiative spelling normalised, anything that leaves it refused. */
const I = "2026-10-06-x";
const refs = (name: string, entries: string[], want: string[], lines: number): void => {
  const got = N.normalizeRefs(entries, I);
  holds(name, !("refusals" in got) && same(got.refs, want) && got.normalised.length === lines, got);
};
refs("`./` is dropped and `.md` added", ["./spec"], ["spec.md"], 1);
refs("this initiative's prefix is dropped", [`${I}/spec.md`, `./${I}/plan`], ["spec.md", "plan.md"], 2);
refs("a canonical entry is untouched and unreported", ["spec.md", "sources/2026-10-06-call.md"],
     ["spec.md", "sources/2026-10-06-call.md"], 0);
refs("a source path gains `.md`", ["sources/2026-10-06-call"], ["sources/2026-10-06-call.md"], 1);
refs("another extension is kept", ["notes.txt"], ["notes.txt"], 0);
refs("a dot inside a name is not an extension", ["v1.2-notes"], ["v1.2-notes.md"], 1);
const out = N.normalizeRefs(["2026-01-01-other/spec.md", "../spec.md", "sources/../x.md", "/abs/spec.md", "spec"], I);
holds("another initiative, `..` and an absolute path are each refused, all at once",
      "refusals" in out && out.refusals.length === 4 && out.refusals.every((x) => /^ERROR: INVALID_MODE — /.test(x)), out);
holds("no entries are no entries", same(N.normalizeRefs(undefined, I), { refs: [], normalised: [] }), N.normalizeRefs(undefined, I));

/* The edit path: a body an edit batch or a section makes may not open with a recognised envelope. */
const said = N.bodyEnvelopeRefusal("---\nflow: sdlc-flow\n---\n# Front\n");
holds("a body opening with a recognised envelope is refused, saying to send named arguments",
      typeof said === "string" && /named argument/.test(said) && !/opens with one/.test(said), said);
holds("the same after a blank line, in CRLF", typeof N.bodyEnvelopeRefusal("\n---\r\nstatus: approved\r\n---\r\n# Front\n") === "string", null);
holds("a body opening with a thematic break is literal", N.bodyEnvelopeRefusal("---\n\n# Front\n") === null, null);

if (failed) { console.error(`\ndocument-normalize-rules: ${failed} case(s) failed`); process.exit(1); }
console.log("\ndocument-normalize-rules: envelopes, literal bodies, server-owned keys, conflicts, tags and references: ok");
