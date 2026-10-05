#!/usr/bin/env node
/**
 * Does `shownSinceLastChange` actually answer the question it claims to?
 *
 * Fixtures rather than a live store: the answer must not depend on a machine or a network.
 *
 * COUPLED: the record is `doc_revision.presented_at`, read against the revision's own
 * `written_at`, so the fixture is a stubbed `pg.Pool` rather than a temporary activity log. The
 * cases are the same ones the journal version drove, because the question is the same one — only
 * its home moved, and the move is the whole point: a log can be swept, and the gate it backs
 * fails OPEN when it is.
 *
 * Run: node checks/attest-shown.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const INIT = "2026-01-01-fixture";
const TEAM = "t1";
const T0 = "2026-01-01T00:00:00.000Z";
const at = (n: number) => new Date(Date.parse(T0) + n * 1000).toISOString();

/** The fixture's documents: which revision each is at, when it was written, and whether anybody
 *  has been shown it. A document with no entry is one this initiative does not hold. */
type Rev = { written_at: string | null; presented_at: string | null };
let docs = new Map<string, Rev>();

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  if (!/select r\.presented_at::text as presented_at/.test(sql)) return { rows: [], rowCount: 0 };
  if (values[0] !== TEAM || values[1] !== INIT) return { rows: [], rowCount: 0 };
  const rev = docs.get(String(values[2]));
  return rev
    ? { rows: [{ presented_at: rev.presented_at, written_at: rev.written_at }], rowCount: 1 }
    : { rows: [], rowCount: 0 };
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(new URL(`file://${process.cwd()}/${p}`).href);
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

/** A present is recorded against the current revision and is strictly after its write. */
const shown = (rev: Rev): Rev => ({ ...rev, presented_at: at(9) });

const cases: [string, boolean | null, Map<string, Rev>][] = [
  ["written then shown then approved      -> fetched", true,
   new Map([["d.md", shown({ written_at: at(1), presented_at: null })]])],
  // ONE case, not two. This was written twice — once for "revised after the present" and once for
  // "the bytes rewritten in place by a patch" — with the same fixture both times, so the second
  // asserted nothing the first did not. It cannot be two: this function reads the current
  // revision's `presented_at` and `written_at` and compares INSTANTS, and the fixture has no
  // revision number for the two scenarios to differ by. That is the point of the comparison — a
  // version comparison cannot see an in-place rewrite, which is why it is on instants at all.
  ["shown at v1, then written again later   -> NOT fetched", false,
   new Map([["d.md", { written_at: at(3), presented_at: at(2) }]])],
  ["shown AFTER the last write            -> fetched", true,
   new Map([["d.md", { written_at: at(2), presented_at: at(3) }]])],
  // Strictly after: a present at the very instant of the write it would attest is not after it,
  // and nothing in the record says which came first. The mutation suite's first full run changed
  // `>` to `>=` and every case above still passed.
  ["shown at the SAME instant as the write -> NOT fetched", false,
   new Map([["d.md", { written_at: at(2), presented_at: at(2) }]])],
  // Another document's fetch must not vouch for this one — the column is per revision.
  ["another document was the one shown    -> NOT fetched", false,
   new Map([["d.md", { written_at: at(2), presented_at: null }],
            ["other.md", shown({ written_at: at(1), presented_at: null })]])],
  // Silence, not a warning, when there is nothing to be "since".
  ["a revision with no recorded write     -> null (silent)", null,
   new Map([["d.md", { written_at: null, presented_at: at(2) }]])],
];

let failed = 0;
for (const [name, want, fixture] of cases) {
  docs = fixture;
  const got = await shownSinceLastChange(db()!, TEAM, `${INIT}/d.md`);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}  (got ${got})`);
}
// No such document, and a path that is not '<initiative>/<doc>.md'.
for (const [name, arg, want] of [
  ["no such document at all              -> null (silent)", `${INIT}/absent.md`, null],
  ["a path that is not initiative/doc     -> null (silent)", "d.md", null],
] as const) {
  docs = new Map([["d.md", shown({ written_at: at(1), presented_at: null })]]);
  const got = await shownSinceLastChange(db()!, TEAM, arg);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}  (got ${got})`);
}

// And the approval path actually asks
//
// Everything above drives `shownSinceLastChange` against a fixture, which proves the function is
// right and nothing about whether anything calls it: unwire the call from `document_approve`,
// leave the import in place, and every case above still passes.
// `checks/eval-tools-moved.ts` asserts initiative-acts imports attest, and an unused import is
// still an import.
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
  if (!body.includes("shownSinceLastChange(")) {
    console.error(`\nattest-shown: ${HANDLER}'s document_approve handler never calls ` +
      "shownSinceLastChange — so an approval is recorded without asking whether the document was " +
      "ever shown to the person approving it, which is the one thing this file exists to attest.");
    failed++;
  }
}

if (failed) {
  console.error(`\nattest-shown: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(`\nattest-shown: ${cases.length + 2} cases passed`);
