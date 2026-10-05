#!/usr/bin/env node
/**
 * Arrays, versions, a discoverable history — and the attestation still counts per document.
 *
 * This runs the code rather than matching its text, the way `checks/attest-shown.ts` does:
 *   - the real zod schemas, harvested by handing `registerArtifactTools` a stub server and
 *     parsing values through them;
 *   - the real `loadDocument` driven over a fixture of `zz.doc`/`zz.doc_revision` rows, which is
 *     where a version lives now — a revision is a ROW, not a frozen file, so "which versions are
 *     filed" is the revision list and a version that is not there is refused by the same reader
 *     that answers one that is;
 *   - `writeGuard` and `safePath`, asked whether a mechanical record is still unwritable and
 *     whether a path that walks out is still refused;
 *   - `shownSinceLastChange` as the oracle for the per-document record — the same function an
 *     approval leans on has to answer "fetched" for both documents of a batch and for neither
 *     of them when history was what got opened.
 *
 * Two assertions stay source-level and are named as such below, with what each catches.
 *
 * Run: node checks/document-reads.ts   (also run by scripts/gate.ts)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const TEAM = "t1";
const INIT = "2026-01-01-fixture";

/** The fixture: two documents, and spec.md's three approvals. A revision is a row. */
interface Rev { revision: number; body: string; approved_by: string | null; approved_at: string | null;
                written_at: string }
const docs = new Map<string, { id: string; revisions: Rev[]; current: number;
                               presented_at: string | null }>();
docs.set("spec.md", {
  id: "d-spec", current: 10, presented_at: null,
  revisions: [
    { revision: 1, body: "# Spec\n\nThe first approval.", approved_by: "ada@zz.test",
      approved_at: "2026-01-05", written_at: "2026-01-05T00:00:00.000Z" },
    { revision: 2, body: "# Spec\n\nThe second approval.", approved_by: "bo@zz.test",
      approved_at: "2026-02-09", written_at: "2026-02-09T00:00:00.000Z" },
    { revision: 10, body: "# Spec\n\nThe current draft.", approved_by: null,
      approved_at: null, written_at: "2026-03-01T00:00:00.000Z" },
  ],
});
docs.set("plan.md", {
  id: "d-plan", current: 1, presented_at: null,
  revisions: [{ revision: 1, body: "# Plan\n\nThe current plan.", approved_by: null,
                approved_at: null, written_at: "2026-01-01T00:00:00.000Z" }],
});

/* The statement the history was read with. The stub cannot show an ORDER BY by its answer: it
 * returns the fixture's revisions in the order the fixture declared them, and the fixture is
 * already sorted — so an ordered read and an unordered one produce the same list here. The
 * statement is what this check can actually disprove. */
let historySql = "";

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  const name = String(values[2] ?? "");
  const d = docs.get(name);
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    historySql = sql;
    const hit = [...docs.values()].find((x) => x.id === String(values[0]));
    return one((hit?.revisions ?? []).map((r: Rev) => ({
      revision: r.revision, content_state: "retained", title: name, body: r.body, tags: [],
      content_hash: "h", revision_note: null, fields: null, written_by: "w@zz.test",
      written_at: r.written_at, approved_by: r.approved_by, approved_at: r.approved_at })));
  }
  if (/from zz\.doc_link l\b/.test(sql)) return one([]);
  // DELIBERATE: the routes that decide this check come FIRST. The generic `from zz.doc d` arm
  // matches the presented_at select's own text too — it has `d.path = $3` — and answering that
  // with a document row, which carries no `presented_at`, reads as "nobody was shown it"
  // whatever the fixture says. A router answers by first match.
  if (/select r\.presented_at::text as presented_at/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || !d) return one([]);
    const rev = d.revisions.find((r) => r.revision === d.current)!;
    return one([{ presented_at: d.presented_at, written_at: rev.written_at }]);
  }
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) {
    // `now()` stands just past the CURRENT revision's own write, which is what a present made
    // after a write is.
    if (d) {
      const cur = d.revisions.find((r) => r.revision === d.current)!;
      d.presented_at = new Date(Date.parse(cur.written_at) + 1000).toISOString();
    }
    return { rows: [], rowCount: 1 };
  }
  if (/from zz\.doc d\b/.test(sql) && /d\.path = \$3/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || !d) return one([]);
    const rev = d.revisions.find((r) => r.revision === d.current)!;
    return one([{ id: d.id, initiative: INIT, path: name, flow: "", type: "", status: "draft",
                  outcome: null, current_revision: d.current, approved_revision: null,
                  updated_at: rev.written_at }]);
  }
  if (/insert into zz\.event\b/.test(sql)) return one([]);
  if (/from zz\.team where slug = \$1|select slug from zz\.team/.test(sql)) return one([{ slug: TEAM }]);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const { loadDocument } = await load("services/zz-core/dist/versions.js");
const { present } = await load("services/zz-core/dist/document-present.js");
const { writeGuard, safePath } = await load("services/zz-core/dist/paths.js");
const { shownSinceLastChange } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The real schemas, not the words around them
//
// `registerTool(name, def, handler)` on a stub: the definitions that reach the MCP SDK are the
// definitions a client is offered, so parsing a value through one answers what the tool
// accepts.
interface ZodLike { safeParse: (v: unknown) => { success: boolean } }
interface ToolDef { inputSchema?: Record<string, ZodLike>; [key: string]: unknown }

const tools = new Map<string, ToolDef>();
const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
registerArtifactTools({ registerTool: (name: string, def: ToolDef) => tools.set(name, def) });

for (const name of ["document_read", "document_present"]) {
  const def = tools.get(name);
  if (!def) { fail.push(`${name} is not registered`); continue; }
  const shape = def.inputSchema ?? {};
  const path = shape.path;
  if (!path) { fail.push(`${name} takes no \`path\``); continue; }
  is(path.safeParse("2026-01-01-x/spec.md").success,
     `${name} no longer accepts a single path as a string`);
  is(path.safeParse(["2026-01-01-x/spec.md", "2026-01-01-x/plan.md"]).success,
     `${name} does not accept an ARRAY of paths — its \`path\` schema refuses one`);
  const version = shape.version;
  if (!version) { fail.push(`${name} takes no \`version\``); continue; }
  is(version.safeParse(3).success, `${name}'s \`version\` refuses a version number`);
  is(version.safeParse(undefined).success, `${name}'s \`version\` is not optional`);
}
// The shelf argument is document_read's alone. Asserted because an inputSchema rewritten
// around `path` is exactly where it would be dropped.
is(tools.get("document_read")?.inputSchema?.scope?.safeParse("platform").success,
   "document_read lost `scope` — the platform journal became unreadable again");

// 2. The history, read from the rows
const history = (await loadDocument(TEAM, `${INIT}/spec.md`)).ok;
if (!history) { fail.push("spec.md does not resolve to the revisions the fixture holds"); }
else {
  const loaded = await loadDocument(TEAM, `${INIT}/spec.md`);
  const versions = loaded.ok ? (loaded.history as Array<{ revision: number }>).map((r) => r.revision) : [];
  is(versions.join(",") === "1,2,10",
     `the version list is ${JSON.stringify(versions)}, expected [1,2,10] — the reader reordered what ` +
     "the database gave it");
  // COUPLED: the statement, not the list. The stub answers in fixture order and the fixture is
  // sorted, so the assertion above holds whether or not the query asks for that order.
  is(/order by r\.revision\b/.test(historySql),
     `the history is read with ${JSON.stringify(historySql)} — a history the database is free to ` +
     "order as it likes reads as a history with gaps");
  // A shared prefix is not a shared document: spec-review.md is its own document and must not be
  // filed under spec.md's history.
  const review = await loadDocument(TEAM, `${INIT}/spec-review.md`);
  is(!review.ok, "spec-review.md resolved to a document — a prefix is not a history");
  // Each version's approval comes off THAT version's row. Read off the current document instead
  // and every version would say "draft", with no approver and no date.
  const v1 = await loadDocument(TEAM, `${INIT}/spec.md`, 1);
  const v2 = await loadDocument(TEAM, `${INIT}/spec.md`, 2);
  const v10 = await loadDocument(TEAM, `${INIT}/spec.md`, 10);
  is(v1.ok && /approved_by: ada@zz\.test/.test(v1.text) && /approved_at: 2026-01-05/.test(v1.text),
     "version 1's approval is not read from that version's own row");
  is(v2.ok && /approved_by: bo@zz\.test/.test(v2.text) && /approved_at: 2026-02-09/.test(v2.text),
     "version 2's approval is not read from that version's own row");
  is(v10.ok && /The current draft/.test(v10.text) && !/approved_by/.test(v10.text),
     "the current revision reads as approved although nobody signed it");
}

// A version that does not exist is refused, and the refusal names the ones that do.
const missing = await loadDocument(TEAM, `${INIT}/spec.md`, 9);
is(!missing.ok && /\bv1\b/.test(missing.refusal) && /\bv2\b/.test(missing.refusal)
   && /\bv10\b/.test(missing.refusal),
   `version 9 is not refused with the versions that exist — got ${JSON.stringify(missing.ok ? "" : missing.refusal)}`);
is((await loadDocument(TEAM, `${INIT}/spec.md`, 2)).ok, "version 2 is refused although it is filed");
const absent = await loadDocument(TEAM, `${INIT}/plan.md`, 2);
is(!absent.ok && absent.why === "no_version",
   "a version of a document that has one revision is not refused");

// 3. The record, per document, with shownSinceLastChange as the oracle
const shown = async (rel: string) => shownSinceLastChange(db()!, TEAM, rel);
is(await shown(`${INIT}/spec.md`) === false, "written and never presented, and the approval would pass");
const presented = await present(db()!, TEAM, `${INIT}/spec.md`, undefined, "u@zz.test");
is(/# Spec/.test(presented) && /The current draft/.test(presented),
   "document_present does not return the document's body");
is(!/^---/m.test(presented) && !/^status:/m.test(presented),
   "the envelope is handed back as frontmatter for the reader to parse rather than stated");
is(/version 10/.test(presented) && /status draft/.test(presented),
   "the version and status are not stated separately");
is(/v1 approved by ada@zz\.test on 2026-01-05/.test(presented)
   && /v2 approved by bo@zz\.test on 2026-02-09/.test(presented),
   "the response does not list the versions that exist with what each was approved as and when");
is(await shown(`${INIT}/spec.md`) === true, "presenting the current revision did not record it");

// Two documents, two records. One record for a batch would let an approval on the document nobody
// opened read as attested, because shownSinceLastChange answers per document.
await present(db()!, TEAM, `${INIT}/plan.md`, undefined, "u@zz.test");
is(await shown(`${INIT}/spec.md`) === true && await shown(`${INIT}/plan.md`) === true,
   "after presenting both documents the record still says one of them was never fetched");

// Opening history must not vouch for the present. The record is per REVISION, so a present of v1
// is a present of v1 and says nothing about the draft the document points at now.
docs.get("spec.md")!.presented_at = null;
const historical = await present(db()!, TEAM, `${INIT}/spec.md`, 1, "u@zz.test");
is(/The first approval/.test(historical) && !/The current draft/.test(historical),
   "`version: 1` did not return the copy filed at the first approval");
is(await shown(`${INIT}/spec.md`) === false,
   "fetching an old version marks the current revision as presented");

// 4. A mechanical record is still unwritable, and a path that walks out is still refused
is(typeof writeGuard(`${INIT}/_ledger.md`) === "string",
   "writeGuard no longer refuses the outcome ledger — the platform's own record of a close " +
   "became writable, and a record anything may rewrite is not a record");
is(typeof writeGuard("_knowledge/nodes/0001-x.md") === "string",
   "writeGuard no longer refuses a hand-written journal node");
is(writeGuard(`${INIT}/spec.md`) === null,
   "writeGuard now refuses an ordinary document — the guard is too wide, not too narrow");
// The store had a `_versions/` directory and the guard protected it. There is none any more: a
// version is a `doc_revision` row, so the name is an ordinary one and the refusal that named it
// is gone with the thing it protected. What still holds is the path rule, and it is asserted
// where it lives.
let traversalRefused = false;
try { await safePath(`${INIT}/x/../spec.md`); } catch { traversalRefused = true; }
is(traversalRefused, "safePath no longer refuses a path that walks out of the store");

// 5. Two source-level assertions, and what each catches
//
// Neither can be run: both handlers resolve through `db()` and the session. The loops are read
// rather than executed, and each assertion fails on the specific defect the contract names rather
// than on the absence of a word.
const src = readFileSync("services/zz-core/src/tools/artifacts.ts", "utf8");
const slice = (tool: string) => {
  const at = src.indexOf(`registerTool(\n    "${tool}"`);
  // Both ends. `at < 0 ? null` was guarded and the terminator was not, so a `-1` there made
  // `slice(at, -1)` the whole tail of the file and every assertion below read the wrong code.
  const end = at < 0 ? -1 : src.indexOf("\n  );", at);
  return at < 0 || end < 0 ? null : src.slice(at, end);
};

// document_present must record nothing of its own. The per-document helper owns the record and
// section 3 proves it answers per document, so a batch collapsing to a single record means the
// record was hoisted back into the registration.
const presentSlice = slice("document_present");
if (!presentSlice) fail.push("document_present is not registered");
else {
  is(/present\(/.test(presentSlice),
     "document_present no longer calls `present` — whatever it does instead is not the " +
     "per-document path this check drives");
  is(!/recordPresented\(/.test(presentSlice) && !/action: "shown"/.test(presentSlice),
     "document_present writes the `shown` record in the registration rather than per document " +
     "— one record for a batch makes an approval look attested when only its neighbour was read");
}

// document_read must not return from inside its loop: an array where one path is unreadable
// returns the readable ones and names the failure for that entry. Everything between the loop
// and the handler's final `return text(` is loop body, so a `return` in that window ends the
// whole call.
const read = slice("document_read");
if (!read) fail.push("document_read is not registered");
else {
  const loop = read.search(/for \(const \w+ of /);
  const last = read.lastIndexOf("return text(");
  if (loop < 0) {
    fail.push("document_read has no loop over its paths — it cannot be reading an array");
  } else if (last < loop) {
    fail.push("document_read returns before it loops — the array is resolved somewhere this " +
              "check cannot see");
  } else {
    is(!/\breturn\b/.test(read.slice(loop, last)),
       "document_read returns from inside its per-path loop — one unreadable path then costs " +
       "the caller every readable one");
  }
}

// A path that does not exist says what to call next, not only that it is missing: the eval of
// 2026-09-26 found one caller who, told only "review.md does not exist", went on to present a
// different initiative's document.
is(/document_list\(prefix: "\$\{initiative\}"\)/.test(src),
   "document_read's does-not-exist refusal no longer names document_list for the initiative");
is(/initiative_status\(\) lists the open ones/.test(src),
   "document_read's does-not-exist refusal no longer names initiative_status for a missing initiative");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("document reads: ok");
