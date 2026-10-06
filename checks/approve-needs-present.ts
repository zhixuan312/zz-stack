#!/usr/bin/env node
/**
 * `document_approve` refuses a document whose current content was never presented.
 *
 * The fact is a COLUMN now — `doc_revision.presented_at` — so this drives it against a stubbed
 * `pg.Pool`, which is the fixture discipline a row-backed function has: the same three things a
 * temporary store used to prove, driven through the real `present` and the real
 * `shownSinceLastChange`.
 *
 *   1. the fact, over the real presenter: false after a write, true after a present, false again
 *      after a rewrite of the revision's bytes, true after a present of those;
 *   2. the registration: it asks that fact and returns the "present it first" refusal on
 *      `false` — a refusal after the write would record the approval it refused.
 *
 * DELIBERATE: the presenter is `present` (document-present.ts), not the module the old store half
 * lived in, and the column it sets is what the reader reads. A check that set the column itself
 * would prove the reader and nothing about the writer.
 *
 * Run: node checks/approve-needs-present.ts
 */
import { readFileSync } from "node:fs";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const INIT = "2026-09-26-approve";
const REL = `${INIT}/spec.md`;
const TEAM = "t1";

/** The fixture's own state: one document, one revision, and the two instants that decide it. */
const doc = {
  written_at: "2026-09-26T00:00:00.000Z",
  presented_at: null as string | null,
  body: "# Spec\n\nbody\n",
};

const seen: string[] = [];
pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  seen.push(sql);
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });

  // DELIBERATE: the two routes that decide this check come FIRST. The generic `from zz.doc d`
  // arm below matches the presented_at select's own text too, and answering that with a document
  // row — which carries no `presented_at` — reads as "nobody was shown it" whatever the fixture
  // says. A router answers by first match, so the specific one goes above the general one.
  // THE FACT: the current revision's two instants
  if (/select r\.presented_at::text as presented_at/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "spec.md") return one([]);
    return one([{ presented_at: doc.presented_at, written_at: doc.written_at }]);
  }
  // THE WRITE: the presenter records that somebody was shown the current revision
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) {
    // `now()` stands just past the revision's own write, which is what a present made after a
    // write is. The fixture's instants are derived rather than taken from the wall clock, so the
    // check does not depend on how fast it runs.
    doc.presented_at = new Date(Date.parse(doc.written_at) + 1000).toISOString();
    return { rows: [], rowCount: 1 };
  }

  // documents the team holds, by initiative — what every reader starts from
  if (/from zz\.doc d\b/.test(sql) && /where t\.slug = \$1 and i\.slug = \$2 and d\.path = \$3/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "spec.md") return one([]);
    return one([{ id: "d1", initiative: INIT, path: "spec.md", flow: "", type: "", status: "draft",
                  outcome: null, current_revision: 1, approved_revision: null,
                  current_version: 1, content_generation: "0", updated_at: doc.written_at }]);
  }
  // the history of that document
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    return one([{ revision: 1, version: 1, content_state: "retained", title: "Spec", body: doc.body, tags: [],
                  content_hash: "h", revision_note: null, fields: null,
                  written_by: "u@zz.test", written_at: doc.written_at,
                  approved_by: null, approved_at: null }]);
  }
  // what that revision cites
  if (/from zz\.doc_link l\b/.test(sql)) return one([]);
  // the `shown` projection, written beside it
  if (/insert into zz\.event\b/.test(sql)) return { rows: [], rowCount: 1 };
  if (/from zz\.team where slug = \$1|select slug from zz\.team/.test(sql)) return one([{ slug: TEAM }]);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(new URL(`file://${process.cwd()}/${p}`).href);
const { present } = await load("services/zz-core/dist/document-present.js");
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The fact, over the real presenter
/** Stand in for a write: the revision's bytes are new, so its `written_at` moves past the
 *  present. An in-place patch does exactly this, which is why the comparison is `>`. */
const rewrite = () => {
  const base = doc.presented_at ? Date.parse(doc.presented_at) : Date.parse(doc.written_at);
  doc.written_at = new Date(base + 1000).toISOString();
};

rewrite();
is(await shownSinceLastChange(db()!, TEAM, REL) === false,
   "written and never presented, and the approval would pass");
await present(db()!, TEAM, REL, undefined, "u@zz.test");
is(doc.presented_at !== null, "presenting did not record that anybody was shown the revision");
is(await shownSinceLastChange(db()!, TEAM, REL) === true,
   "presented after the write, and the approval would still refuse");
rewrite();
is(await shownSinceLastChange(db()!, TEAM, REL) === false,
   "rewritten after the present, and the approval would pass on unseen bytes");
await present(db()!, TEAM, REL, undefined, "u@zz.test");
is(await shownSinceLastChange(db()!, TEAM, REL) === true,
   "the rewritten bytes presented, and the approval would still refuse");

// The control: a document the team does not hold is not "presented" — it is not there, and the
// reader answers null rather than false, because a missing record is not evidence of a present.
is(await shownSinceLastChange(db()!, TEAM, `${INIT}/nope.md`) === null,
   "a document nothing holds reads as unpresented rather than as unanswerable");

// 2. The registration refuses on it, before it writes
const src = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");
const at = src.indexOf('"document_approve"');
const handler = at < 0 ? "" : src.slice(at, src.indexOf("server.registerTool(", at + 1));
if (!handler) fail.push("document_approve is not registered in initiative-acts.ts");
else {
  const asked = handler.indexOf("shownSinceLastChange(");
  const refused = handler.search(/if \(fetched === false\)\s*\{\s*return text\(\s*`ERROR: present it first/);
  const persisted = handler.indexOf("saveDocument(");
  is(asked >= 0, "document_approve no longer asks shownSinceLastChange");
  is(refused > asked, "document_approve does not return the \"present it first\" refusal when the content was not presented");
  is(persisted < 0 || refused < persisted, "document_approve refuses only after it has persisted the approval");
  is(!/NOT FETCHED/.test(handler), "document_approve still carries the old note-instead-of-refusal text");
}

if (fail.length) {
  console.error(`approve-needs-present: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("approve-needs-present: refused before a present, accepted after it, refused again after a rewrite");
