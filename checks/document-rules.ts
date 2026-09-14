#!/usr/bin/env node
/**
 * The pure document rules, exercised.
 *
 * THIS FILE IS THE POINT OF THE SPLIT. Every function below lived inside a 6,114-line
 * `server.ts` where nothing could import it, so nothing could call it, so every claim about it
 * was a claim about how the source reads. Three audit rounds and a full review can read a
 * predicate and agree with it; none of that is the predicate answering.
 *
 * Cases are chosen for the property, not for coverage: the shape that would be wrong in the
 * FLATTERING direction — a refusal that lets something through, an escape that does not escape.
 *
 * Run: node checks/document-rules.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = join(process.cwd(), "services/zz-core/dist/document-rules.js");
const R = await import(pathToFileURL(mod).href);

// TWO MODULES, ONE SUBJECT, since Task I-38. `indexable`, `isoDate` and `decisionRows` are the
// rules the knowledge INDEX derives a row by, and they moved to `@zz/indexing` with the indexer
// that is their only caller — the gateway now serves `knowledge_reindex` and a package is the
// only thing two services can both import. They are still pure, still the most testable code
// here, and still exercised below; only the import moved.
const idx = join(process.cwd(), "packages/indexing/dist/index.js");
const I = await import(pathToFileURL(idx).href);

let failed = 0;
const is = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
};
const refuses = (name: string, got: unknown) => { const ok = typeof got === "string" && got.length > 0; if (!ok) failed += 1; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`); };
const allows = (name: string, got: unknown) => is(name, got, null);

/* ── slugRefusal — the slug a name is built from ───────────────────────────
 *
 * This replaced initiativeNameShape, which read a name a model had already composed. The
 * caller sends a SLUG now and initiative-record.ts builds the name from it and the platform's
 * clock, so a name without a date is unreachable rather than refused — and what is left to
 * check is the slug. The traversal cases carry over unchanged; the last one is new, and it is
 * the mistake a caller reaches by being helpful. */
allows("an ordinary slug is a slug",          R.slugRefusal("sample-intake"));
refuses("a traversal is refused",             R.slugRefusal("../../etc"));
refuses("a slash is refused",                 R.slugRefusal("2026-09-11/sample-intake"));
refuses("an absolute path is refused",        R.slugRefusal("/etc/passwd"));
refuses("an empty slug is refused",           R.slugRefusal(""));
refuses("a dot-entry is refused",             R.slugRefusal(".git"));
refuses("a slug that is already dated is refused, or the name would carry two",
                                              R.slugRefusal("2026-09-11-sample-intake"));

/* ── frontmatterRefusal — the platform writes the envelope, never the caller ── */
refuses("content opening with --- is refused", R.frontmatterRefusal("---\nflow: sdlc-flow\n---\n\n# Spec\n", "document_write"));
allows("a body starting at its title is fine", R.frontmatterRefusal("# Spec\n\nbody\n", "document_write"));

/* ── fieldRefusal — a caller's own keys, bounded ──────────────────────────── */
allows("a plain field is allowed",             R.fieldRefusal({ proposed_team_nodes: "2" }));
refuses("an envelope field is refused",        R.fieldRefusal({ status: "approved" }));
refuses("a field name with a capital is refused", R.fieldRefusal({ Status: "x" }));
refuses("a field name with a dash is refused", R.fieldRefusal({ "my-field": "x" }));
allows("no fields at all is allowed",          R.fieldRefusal(undefined));

/* ── envelopeEditRefusal — the governance fields are the platform's ───────── */
const base = "---\nflow: sdlc-flow\ntype: spec\nstatus: draft\n---\n\n# Spec\n\nbody\n";
allows("an unchanged envelope is allowed",     R.envelopeEditRefusal(base, base));
refuses("hand-writing status is refused",      R.envelopeEditRefusal(base, base.replace("status: draft", "status: approved")));

/* ── tableRow — the escape that keeps a table one table ───────────────────── */
is("a pipe in a cell cannot break the row",
   R.tableRow("a|b", "c"), "| a/b | c |\n");
is("a newline in a cell cannot break the row",
   R.tableRow("a\nb", "c"), "| a b | c |\n");

/* ── renderEnvelope — one writer, and it never drops a field ──────────────── */
// The declared order first, then everything else the caller set. Writing this down because
// the obvious reading is that `order` is a filter, and it is not: a field outside it is still
// written, at the end. A caller who sets a key the order does not name gets it in the file.
is("declared order first, then whatever else was set",
   R.renderEnvelope({ flow: "sdlc-flow", status: "draft", nope: "x" }, ["flow", "status"]),
   "---\nflow: sdlc-flow\nstatus: draft\nnope: x\n---\n");
is("a field in the order but unset is skipped, not written empty",
   R.renderEnvelope({ flow: "sdlc-flow" }, ["flow", "status"]),
   "---\nflow: sdlc-flow\n---\n");

/* ── indexable — what the index will hold ─────────────────────────────────── */
is("a markdown document is indexable",         I.indexable("2026-09-11-x/spec.md"), true);
is("a frozen snapshot is indexable",           I.indexable("2026-09-11-x/_versions/spec.v1.md"), true);
is("the activity log is not a document",       I.indexable("2026-09-11-x/activity.jsonl"), false);

/* ── decisionRows — a FIT LEDGER, read out of a body ──────────────────────── */
// The vocabulary is native / achievable / workaround / not_possible — what a BLOCK can do,
// not whether an acceptance criterion is met. The key shapes are AC-N.N and FR-N, so the two
// halves of a row come from different worlds and only this function knows they pair up.
const rows = I.decisionRows([
  "| Claim | Verdict | Detail |",
  "| AC-1.1 | native | the block does this itself |",
  "| FR-3 | Not possible | nothing there answers it |",
].join("\n"));
is("both key shapes are read, and prose spelling is normalised",
   rows.map((r: { key: string; verdict: string }) => [r.key, r.verdict]).sort(),
   [["AC-1.1", "native"], ["FR-3", "not_possible"]]);
is("a verdict outside the vocabulary is not a row",
   I.decisionRows("| AC-1.1 | met | the endpoint answers |"), []);
is("a body with no table yields nothing", I.decisionRows("# Spec\n\njust prose\n"), []);

if (failed) { console.error(`\ndocument-rules: ${failed} case(s) failed`); process.exit(1); }
console.log(`\ndocument-rules: all cases passed`);
