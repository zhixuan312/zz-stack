#!/usr/bin/env node
/**
 * An approval is sealed at the instant it was given, and `sources_after_approval` lists only a
 * source filed after that instant (bug f8944085).
 *
 * `document_approve` stamped the seal with the day, so `zz.doc_revision.approved_at` held that
 * day's midnight and a source filed minutes BEFORE the approval read as filed after it. This
 * drives the real code, loaded from dist:
 *
 *   1. `approvalStamp`, at an injected clock: the envelope's day is the reporting zone's
 *      (ZZ_TZ), the seal is the instant itself, and `dayOf` reads the seal back as that day —
 *      including a seal made before 08:00 in Singapore, whose UTC date is the day before.
 *   2. `initiativeState` over a stubbed pool: an approved spec sealed with that stamp, one source
 *      filed a minute before the approval and one a minute after. Only the later is listed. A row
 *      sealed before the fix keeps its midnight, and on it the earlier source still lists.
 *   3. `sealOf`, the approval a close or an eval writer carries forward: the stored instant,
 *      verbatim — never the envelope's day, which would put the midnight back on the revision.
 *   4. `closedMove`, the sentence a person reads once the handover is approved: the seal's day in
 *      the reporting zone, never the column's text.
 *
 * The stamp is handed to the fixture as it is. Postgres in a UTC session casts a bare date to
 * that date's UTC midnight, and `Date.parse` reads a bare date the same way, so the fixture
 * stores exactly what the database would.
 *
 * Run: node checks/approval-instant.ts
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";
process.env.ZZ_TZ = "Asia/Singapore";

const TEAM = "t1";
const docs = new Map<string, Record<string, unknown>[]>();

pg.Pool.prototype.query = (async function query(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/select i\.slug, i\.flow, i\.closed_at::text/.test(sql)) {
    return one(((values[1] as string[]) ?? []).filter((n) => docs.has(n)).map((slug) => ({
      slug, flow: null, closed_at: null, closed_by: null, outcome: null })));
  }
  if (/from zz\.doc d\b/.test(sql) && /order by d\.path/.test(sql)) return one(docs.get(String(values[0])) ?? []);
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { approvalStamp } = await load("services/zz-core/dist/tools/initiative-acts.js");
const { initiativeState } = await load("services/zz-core/dist/tools/initiative-status.js");
const { sealOf } = await load("services/zz-core/dist/indexing.js");
const { dayOf } = await load("services/zz-core/dist/versions.js");
const { closedMove } = await load("services/zz-core/dist/tools/initiative-closed.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The stamp: a day for the reader, the instant for the seal
const NOW = new Date("2026-10-20T03:00:00.000Z");   // 11:00 in Singapore
const stamp = approvalStamp(NOW) as { day: string; at: string };
is(stamp.day === "2026-10-20", `the envelope's day is ${stamp.day}, not the reporting zone's 2026-10-20`);
is(Date.parse(stamp.at) === NOW.getTime(), `an approval at ${NOW.toISOString()} is sealed as ${stamp.at}, not as that instant`);
const early = approvalStamp(new Date("2026-10-19T18:00:00.000Z")) as { day: string; at: string };   // 02:00 in Singapore
is(early.day === "2026-10-20" && dayOf(early.at) === early.day,
   `a seal at 02:00 in Singapore reads back as ${dayOf(early.at)} beside an envelope day of ${early.day}`);

// 2. Only a source filed after the approval's instant is listed
const minute = 60_000;
const row = (path: string, extra: Record<string, unknown>) => ({
  id: path, path, initiative: "", flow: "", type: "", status: "", outcome: null, approved_by: null,
  approved_at: null, closed_by: null, title: path, body: "", tags: [], current_revision: 1,
  approved_revision: null, approved_outcome: null, current_version: 1, approved_before: null,
  fields: null, supports: [], ...extra });
const listed = async (slug: string, approvedAt: string): Promise<string[]> => {
  docs.set(slug, [
    row("sources/before.md", { updated_at: new Date(NOW.getTime() - minute).toISOString(), supports: ["spec.md"] }),
    row("sources/after.md", { updated_at: new Date(NOW.getTime() + minute).toISOString(), supports: ["spec.md"] }),
    row("spec.md", { status: "approved", approved_by: "ada@zz.test", approved_at: approvedAt,
                     approved_revision: 1, updated_at: approvedAt }),
  ]);
  const chain = { name: null, documents: [], stages: [], docs: new Set(), requires: {}, closingDoc: "",
                  closeRequires: [], roles: {} };
  const st = await initiativeState(db()!, TEAM, slug, chain, []);
  return (st.sources_after_approval as { source: string }[]).map((s) => s.source).sort();
};
const now = await listed("2026-10-20-sealed", stamp.at);
is(JSON.stringify(now) === JSON.stringify(["sources/after.md"]),
   `sources_after_approval is ${JSON.stringify(now)} for a source filed a minute before the approval ` +
   "and one a minute after — only the later was filed after it");
const legacy = await listed("2026-10-20-legacy", "2026-10-20 00:00:00+00");
is(JSON.stringify(legacy) === JSON.stringify(["sources/after.md", "sources/before.md"]),
   `a row sealed at midnight before the fix answers ${JSON.stringify(legacy)} — it is kept as it was, not repaired`);

// 3. A write carrying the approval forward carries the instant stored
const approved = "---\ntitle: Spec\nstatus: approved\napproved_by: ada@zz.test\napproved_at: 2026-10-20\n---\n\n# Spec\n";
const carried = sealOf(approved, { approved_by: "ada@zz.test", approved_at: "2026-10-20 03:00:00+00" });
is(carried?.by === "ada@zz.test" && carried?.at === "2026-10-20 03:00:00+00",
   `a carried seal is ${JSON.stringify(carried)} — it must be the stored instant, or a close puts the midnight back`);
is(sealOf(approved.replace("status: approved", "status: draft"), { approved_by: "ada@zz.test", approved_at: "2026-10-20 03:00:00+00" }) === null,
   "a draft carries a seal forward");
is(sealOf(approved, { approved_by: null, approved_at: null }) === null && sealOf(approved, null) === null,
   "a revision that holds no seal has one carried forward from its envelope");

// 4. A person reads the handover's approval as a day
const handover = { name: "handover.md", role: "handover", exists: true, status: "approved", gate: true,
                   approved_by: "ada@zz.test", approved_at: "2026-10-19 18:00:00+00" };   // 02:00 in Singapore
const closed = closedMove("2026-10-20-closed", "accepted", null, [handover], new Map()) as { why: string };
is(closed.why.includes("was approved by ada@zz.test on 2026-10-20."),
   `a closed initiative says "${closed.why}" — the handover's approval is read by a person, as the reporting zone's day`);

if (fail.length) {
  console.error(`approval-instant: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("approval-instant: an approval is sealed at its instant and read back as the reporting zone's day; " +
            "only a source filed after that instant is listed, a midnight seal is kept, a carried seal keeps the instant, " +
            "and a closed initiative names the handover's approval by its day");
