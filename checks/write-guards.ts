#!/usr/bin/env node
/**
 * The write guards, exercised — the refusals that protect the store.
 *
 * Each one answers "may this write land?" and returns an instructive refusal or null. They are
 * pure functions of a chain, a path and a document's text.
 *
 * The cases below are weighted towards the dangerous direction. A guard that refuses too much
 * is reported within the hour; a guard that lets something through is silent — a fabricated
 * approver, a second `status:` line, a close on a gate nobody passed. So what is pinned here
 * is mostly that the refusals fire.
 *
 * Run: node checks/write-guards.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const G = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/write-guards.js")).href);

let failed = 0;
const refuses = (name: string, got: unknown) => {
  const ok = typeof got === "string" && got.length > 0;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
};
const allows = (name: string, got: unknown) => {
  const ok = got === null;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (refused: ${JSON.stringify(got)})`}`);
};

/** A flow that declares one gated document with two required sections. */
const chain = {
  name: "sdlc-flow",
  documents: [{ name: "spec.md", role: "agreement", gate: true, sections: ["Context", "Problem"] }],
  stages: [],
  docs: new Set(["spec.md"]),
  requires: {},
  closingDoc: "spec.md",
  closeRequires: ["spec.md"],
  roles: { "spec.md": "agreement" },
};
const P = "2026-09-11-x/spec.md";
const doc = (env: Record<string, string>, body = "# Spec\n\n## Context\n\nc\n\n## Problem\n\np\n") =>
  "---\n" + Object.entries(env).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n" + body;

/* statusCheck — the two words, and only those */
allows("draft is a status",       G.statusCheck(chain, P, doc({ status: "draft" })));
allows("approved is a status",    G.statusCheck(chain, P, doc({ status: "approved" })));
refuses("accepted is not a status — it is an outcome, and this is the category error the "
      + "model keeps making at close",
        G.statusCheck(chain, P, doc({ status: "accepted" })));
refuses("a made-up status is refused", G.statusCheck(chain, P, doc({ status: "in_review" })));

/* outcomeCheck — the ledger is counted by these words */
allows("delivered is an outcome",  G.outcomeCheck(chain, P, doc({ status: "approved", outcome: "delivered" })));
allows("accepted is an outcome",   G.outcomeCheck(chain, P, doc({ status: "approved", outcome: "accepted" })));
refuses("a fourth word invents a ledger row nobody can total",
        G.outcomeCheck(chain, P, doc({ status: "approved", outcome: "shipped" })));

/* attributionCheck — a signature exists so somebody can be asked */
// The pair is atomic: a gated document carrying approved_by without approved_at is refused.
// Half a signature reads as signed and cannot be dated.
allows("a person and a date together are an attribution",
       G.attributionCheck(chain, P, doc({ status: "approved", approved_by: "someone@example.com", approved_at: "2026-09-11" }), "xuan"));
refuses("a signer with no date is half a signature",
        G.attributionCheck(chain, P, doc({ status: "approved", approved_by: "someone@example.com" }), "xuan"));
allows("a draft needs no attribution at all",
       G.attributionCheck(chain, P, doc({ status: "draft" }), "xuan"));
refuses("'the stakeholder' is nobody",
        G.attributionCheck(chain, P, doc({ status: "approved", approved_by: "the stakeholder", approved_at: "2026-09-11" }), "xuan"));
refuses("'unknown' is nobody",
        G.attributionCheck(chain, P, doc({ status: "approved", approved_by: "unknown", approved_at: "2026-09-11" }), "xuan"));
refuses("the team's own name is not a person",
        G.attributionCheck(chain, P, doc({ status: "approved", approved_by: "xuan", approved_at: "2026-09-11" }), "xuan"));

/* sectionCheck — a draft may be half-written, a gate may not */
allows("a draft missing a section is allowed — that is what draft means",
       G.sectionCheck(chain, P, doc({ status: "draft" }, "# Spec\n\n## Context\n\nc\n")));
refuses("a document offered as approved may not be missing one",
        G.sectionCheck(chain, P, doc({ status: "approved" }, "# Spec\n\n## Context\n\nc\n")));
allows("approved with every declared section is allowed",
       G.sectionCheck(chain, P, doc({ status: "approved" })));

/* stampEnvelope — the platform writes the envelope */
const stamped = G.stampEnvelope(chain, P, doc({ status: "draft" }));
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
if (count(stamped, /^status:/gm) !== 1) { failed += 1; console.log("  FAIL stamping leaves exactly one status line"); }
else console.log("  ok   stamping leaves exactly one status line");
if (!/^flow: sdlc-flow$/m.test(stamped)) { failed += 1; console.log("  FAIL the flow that governs is stamped from the chain"); }
else console.log("  ok   the flow that governs is stamped from the chain");
if (!/^type: agreement$/m.test(stamped)) { failed += 1; console.log("  FAIL the role is stamped from the manifest, not from what the writer typed"); }
else console.log("  ok   the role is stamped from the manifest, not from what the writer typed");

/* normalizeSections — it renames, and silence is the risk */
// A flow declares its section headings; a writer types something close. This renames the
// writer's heading to the declared one so the gate that requires it can find it. The rename
// is silent in the document — the only trace is the `renamed` list handed to the caller.
const ns = (body: string) => G.normalizeSections(chain, P, doc({ status: "draft" }, body));
{
  const r = ns("# Spec\n\n## The context\n\nc\n\n## Problem\n\np\n");
  const ok = /^## Context$/m.test(r.content) && r.renamed.length === 1;
  if (!ok) { failed += 1; console.log(`  FAIL a near-miss heading is renamed to what the flow declares  (renamed: ${JSON.stringify(r.renamed)})`); }
  else console.log("  ok   a near-miss heading is renamed to what the flow declares");
}
{
  const r = ns("# Spec\n\n## Context\n\nc\n\n## Problem\n\np\n");
  const ok = r.renamed.length === 0 && r.content.includes("## Context");
  if (!ok) { failed += 1; console.log(`  FAIL an exact heading is left alone  (renamed: ${JSON.stringify(r.renamed)})`); }
  else console.log("  ok   an exact heading is left alone");
}
{
  // The dangerous direction: a heading about something else must not be captured, or the
  // document silently loses the section it did have.
  const r = ns("# Spec\n\n## Appendix\n\na\n\n## Problem\n\np\n");
  const ok = r.content.includes("## Appendix");
  if (!ok) { failed += 1; console.log(`  FAIL an unrelated heading is not captured  (renamed: ${JSON.stringify(r.renamed)})`); }
  else console.log("  ok   an unrelated heading is not captured");
}

/* isoToday — every date this platform writes */
if (!/^\d{4}-\d{2}-\d{2}$/.test(G.isoToday())) { failed += 1; console.log("  FAIL isoToday is YYYY-MM-DD"); }
else console.log("  ok   isoToday is YYYY-MM-DD");

if (failed) { console.error(`\nwrite-guards: ${failed} case(s) failed`); process.exit(1); }
console.log(`\nwrite-guards: all cases passed`);
