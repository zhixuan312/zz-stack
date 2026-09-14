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
 * Run: node checks/document-rules.mjs   (also run by scripts/gate.mjs)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = join(process.cwd(), "services/zz-core/dist/document-rules.js");
const R = await import(pathToFileURL(mod).href);

let failed = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
};
const refuses = (name, got) => { const ok = typeof got === "string" && got.length > 0; if (!ok) failed += 1; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`); };
const allows = (name, got) => is(name, got, null);

/* ── initiativeNameShape — the path a name becomes ────────────────────────── */
allows("a dated slug is a name",              R.initiativeNameShape("2026-09-11-sample-intake"));
refuses("a traversal is refused",             R.initiativeNameShape("../../etc"));
refuses("a slash is refused",                 R.initiativeNameShape("2026-09-11/sample-intake"));
refuses("an absolute path is refused",        R.initiativeNameShape("/etc/passwd"));
refuses("an empty name is refused",           R.initiativeNameShape(""));

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
is("a markdown document is indexable",         R.indexable("2026-09-11-x/spec.md"), true);
is("a frozen snapshot is indexable",           R.indexable("2026-09-11-x/_versions/spec.v1.md"), true);
is("the activity log is not a document",       R.indexable("2026-09-11-x/activity.jsonl"), false);

/* ── decisionRows — a FIT LEDGER, read out of a body ──────────────────────── */
// The vocabulary is native / achievable / workaround / not_possible — what a BLOCK can do,
// not whether an acceptance criterion is met. The key shapes are AC-N.N and FR-N, so the two
// halves of a row come from different worlds and only this function knows they pair up.
const rows = R.decisionRows([
  "| Claim | Verdict | Detail |",
  "| AC-1.1 | native | the block does this itself |",
  "| FR-3 | Not possible | nothing there answers it |",
].join("\n"));
is("both key shapes are read, and prose spelling is normalised",
   rows.map((r) => [r.key, r.verdict]).sort(),
   [["AC-1.1", "native"], ["FR-3", "not_possible"]]);
is("a verdict outside the vocabulary is not a row",
   R.decisionRows("| AC-1.1 | met | the endpoint answers |"), []);
is("a body with no table yields nothing", R.decisionRows("# Spec\n\njust prose\n"), []);

if (failed) { console.error(`\ndocument-rules: ${failed} case(s) failed`); process.exit(1); }
console.log(`\ndocument-rules: all cases passed`);
