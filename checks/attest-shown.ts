#!/usr/bin/env node
/**
 * Does `approvalBasis` answer the question an approval asks — which review context of the caller's
 * covers exactly the snapshot it signs — and does the approval record what it rests on?
 *
 * Fixtures rather than a live store: the answer must not depend on a machine or a network. The
 * record is the presentation's `zz.event` rows — each carrying its context, target, baseline, kind
 * and span — so the fixture is a stubbed `pg.Pool` answering the one statement that reads them.
 * `checks/approve-needs-present.ts` drives the same function over the real presenter; this one
 * holds the rules on rows written by hand, where each case can be one row away from another:
 *
 *   - coverage is whole: a full presentation every page of which was recorded covers its target,
 *     one that left a gap does not, and a delta covers its target only on a covered baseline;
 *   - the most recent covering context is the one used, and one that covered only an earlier
 *     snapshot is not — the refusal names it as the context to present in;
 *   - a passed context must be one of the caller's, and a passed one that covers the target is used
 *     even when a later context covers it too;
 *   - the read is scoped to the caller: the principal, the credential, the team and the document
 *     are what the statement is asked with;
 *   - a read that fails refuses (fail-closed): the old check let an approval through on an error;
 *   - the approval's record names the context, the snapshot, the signer and the caller.
 *
 * And `recordPresented` sets `presented_at` — the pin rule's input, no longer an approval's — on
 * exactly the row a presentation pinned, and a failure is the caller's to see: it runs inside the
 * presentation's transaction, which must not commit a record the column missed.
 *
 * Run: node checks/attest-shown.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const INIT = "2026-01-01-fixture";
const TEAM = "t1";
const REL = `${INIT}/d.md`;
const [G1, G2] = ["cr_g1aaaaaaaaaaaaaaaaaaaaaaaa", "cr_g2aaaaaaaaaaaaaaaaaaaaaaaa"];
const [A, B, C] = ["rc_aaaaaaaaaaaaaaaaaaaaaaaaaa", "rc_bbbbbbbbbbbbbbbbbbbbbbbbbb", "rc_cccccccccccccccccccccccc"];

/** One recorded page, as the statement returns it, in recorded order. */
interface Page { context: string; target: string; baseline: string | null; kind: "full" | "delta"; start: number; end: number; total: number }
const full = (context: string, target: string, start = 0, end = 100): Page =>
  ({ context, target, baseline: null, kind: "full", start, end, total: 100 });
const delta = (context: string, baseline: string, target: string): Page =>
  ({ context, target, baseline, kind: "delta", start: 0, end: 40, total: 40 });
let pages: Page[] = [];
let broken = false;
const asked: unknown[][] = [];
const askedSql: string[] = [];

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  if (!/e\.detail->>'review_context' as context/.test(sql)) return { rows: [], rowCount: 0 };
  asked.push(values);
  askedSql.push(sql);
  if (broken) throw new Error("connection terminated");
  const rows = pages.filter((p) => values[5] === null || p.context === values[5]);
  return { rows, rowCount: rows.length };
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(new URL(`file://${process.cwd()}/${p}`).href);
const { approvalBasis, approvalRecord, recordPresented } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const me = { team: TEAM, email: "Ada@zz.test", credential: "pat", client: null };
const basis = async (target: string, a: { context?: string } = {}): Promise<string> => {
  const b = await approvalBasis(db()!, me, REL, target, a);
  return "refusal" in b ? b.refusal : b.context;
};

let failed = 0;
let ran = 0;
const is = (ok: boolean, name: string, got: unknown) => {
  ran += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  (got ${JSON.stringify(got)})`}`);
};

const cases: [string, Page[], string, { context?: string }, (got: string) => boolean][] = [
  ["a full presentation, every page recorded   -> its context", [full(A, G1, 0, 60), full(A, G1, 60, 100)], G1, {},
   (g) => g === A],
  ["a full presentation that left a gap        -> none", [full(A, G1, 0, 50), full(A, G1, 60, 100)], G1, {},
   (g) => g.startsWith("ERROR: PRESENTATION_REQUIRED — no review context of yours covers")],
  // Pages of two contexts never combine, even of one target.
  ["half in one context, half in another       -> none", [full(A, G1, 0, 50), full(B, G1, 50, 100)], G1, {},
   (g) => g.startsWith("ERROR: PRESENTATION_REQUIRED")],
  ["a delta on a covered baseline              -> its context", [full(A, G1), delta(A, G1, G2)], G2, {},
   (g) => g === A],
  ["a delta on a baseline never covered        -> none", [full(A, G1, 0, 50), delta(A, G1, G2)], G2, {},
   (g) => g.startsWith("ERROR: PRESENTATION_REQUIRED")],
  ["two contexts covering it                   -> the most recent", [full(A, G2), full(B, G2)], G2, {},
   (g) => g === B],
  // Most recent by its last page: A was shown again after B.
  ["recency is the context's last page         -> that context", [full(A, G1), full(B, G2), full(A, G2)], G2, {},
   (g) => g === A],
  ["only an earlier snapshot covered           -> none, naming it", [full(A, G1)], G2, {},
   (g) => g.startsWith(`ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${G2}`) && g.includes(`review_context: "${A}"`)],
  ["the covering context is older than another -> the covering one", [full(A, G2), full(C, G1)], G2, {},
   (g) => g === A],
  ["a passed context covering it               -> that one, not the latest", [full(A, G2), full(B, G2)], G2, { context: A },
   (g) => g === A],
  ["a passed context that is not the caller's  -> refused", [full(A, G2)], G2, { context: C },
   (g) => g.startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${C} is not one of yours for ${REL}`)],
  ["a passed context mid-presentation          -> refused, to finish it", [full(A, G2, 0, 50)], G2, { context: A },
   (g) => g.startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${A} has not covered ${G2}`)],
  ["a passed context still presenting it, on a covered baseline -> refused, to finish it",
   [full(A, G1), full(A, G2, 0, 50)], G2, { context: A },
   (g) => g.startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${A} has not covered ${G2}`) && g.includes("offset")],
  ["a passed context that covered an earlier one -> conflict", [full(A, G1)], G2, { context: A },
   (g) => g.startsWith(`ERROR: APPROVAL_CONFLICT — ${REL} is at content revision ${G2} now, not ${G1}`)],
  ["nothing presented at all                   -> none", [], G1, {},
   (g) => g.startsWith("ERROR: PRESENTATION_REQUIRED — no review context of yours covers") && g.includes("document_present")],
];
for (const [name, fixture, target, a, want] of cases) {
  pages = fixture;
  const got = await basis(target, a);
  is(want(got), name, got);
}

// The read is the caller's: the team, the initiative, the document, the principal, the credential.
asked.length = 0;
pages = [full(A, G1)];
await basis(G1);
is(asked.length > 0 && asked.every((v) => v[0] === TEAM && v[1] === INIT && v[2] === REL && v[3] === me.email && v[4] === "pat"),
   "the coverage read is scoped to the caller's team, document, principal and credential", asked);
is(askedSql.length > 0 && askedSql.every((q) => /lower\(e\.detail->>'user'\) = lower\(\$4\)/.test(q)
     && /coalesce\(e\.detail->>'credential', ''\) = \$5/.test(q) && /e\.subject = \$3/.test(q)),
   "the coverage statement's WHERE constrains the principal, the credential and the document by the bound values", askedSql);

// Fail-closed: a read that cannot answer refuses, found or passed.
broken = true;
for (const a of [{}, { context: A }]) {
  const got = await basis(G1, a);
  is(got.startsWith(`ERROR: ${REL} was not approved — what was presented of it could not be read`) && got.includes("connection terminated"),
     `a coverage read that fails refuses${"context" in a ? " (context passed)" : ""}`, got);
}
broken = false;

// The approval's record: what it rests on, whose decision it is, and who recorded it.
{
  const rec = approvalRecord({ caller: "bo@zz.test", signer: "ada@zz.test", context: A, target: G2 });
  is(JSON.stringify(rec) === JSON.stringify({ user: "bo@zz.test", signer: "ada@zz.test", review_context: A, content_revision: G2 }),
     "the approval's record names the caller, the signer, the context and the snapshot", rec);
}

// The writer: the named row, and a failure thrown to the transaction
{
  const seen: { sql: string; values: unknown[] }[] = [];
  await recordPresented({ query: async (sql: string, values: unknown[]) => { seen.push({ sql, values }); return { rows: [], rowCount: 1 }; } },
                        "d-1", 4);
  is(seen.length === 1 && /set presented_at = now\(\) where r\.doc_id = \$1::uuid and r\.revision = \$2$/.test(seen[0]!.sql)
     && JSON.stringify(seen[0]!.values) === '["d-1",4]', "recordPresented writes the named row only", seen);
  let thrown = false;
  try { await recordPresented({ query: async () => { throw new Error("down"); } }, "d-1", 4); } catch { thrown = true; }
  is(thrown, "a failed write is thrown to the presentation's transaction", thrown);
}

// And the approval path actually asks
//
// Everything above drives `approvalBasis` against a fixture, which proves the function is right and
// nothing about whether anything calls it: unwire the call from `document_approve`, leave the import
// in place, and every case above still passes. `checks/eval-tools-moved.ts` asserts initiative-acts
// imports attest, and an unused import is still an import.
const HANDLER = "services/zz-core/src/tools/initiative-acts.ts";
const src = readFileSync(HANDLER, "utf8");
// Both ends guarded. A `-1` for the terminator made `slice(0, -1)` the whole TAIL of the file, so
// the search became "does any later handler in this file name it" — and a `document_approve` that
// had stopped asking passed on the strength of some other tool's code.
const opens = src.indexOf('"document_approve"');
const closes = opens < 0 ? -1 : src.indexOf("\n  );", opens);
if (opens < 0 || closes < 0) {
  console.error(`\nattest-shown: ${HANDLER} has no document_approve handler this check can find — ` +
    "nothing here was read, so nothing was attested.");
  failed++;
} else {
  const body = src.slice(opens, closes);
  if (!body.includes("approvalBasis(") || !body.includes("approvalRecord(")) {
    console.error(`\nattest-shown: ${HANDLER}'s document_approve handler never calls approvalBasis and ` +
      "approvalRecord — so an approval is recorded without asking which presentation of exactly these " +
      "bytes it rests on, which is the one thing this file exists to attest.");
    failed++;
  }
}

if (failed) {
  console.error(`\nattest-shown: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(`\nattest-shown: ${ran} cases passed`);
