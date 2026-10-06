#!/usr/bin/env node
/**
 * `document_approve` signs exactly the snapshot a review context of the caller's covered — and a
 * presentation is one of a review context: full first, then only what changed.
 *
 * The record is the presentation's own `zz.event` row, written with the check that the row still
 * holds what was shown, in one transaction. What an approval rests on is read from those rows by
 * `approvalBasis` (attest.ts). This drives the real `present` and the real `approvalBasis` against a
 * stubbed `pg.Pool` (its `connect` too, for the transaction):
 *
 *   1. the basis, over the real presenter: none after a write (`PRESENTATION_REQUIRED`), the
 *      context a present minted after it, none again after a rewrite of the revision's bytes —
 *      naming the context to present it in — and the new context after a present of those;
 *   2. the review context: a present without one mints `rc_…` and presents in full, its row
 *      carrying the context, the target, no baseline, `full`, the span, the credential, and the
 *      reply's own length; a present passing it back after a change presents the DELTA — the
 *      records and the edited section, not the unchanged one — and covers the new target, which an
 *      approval then rests on; once more with nothing changed is `no change since <baseline> —
 *      covered`; the context passed by another principal, or by the same one under another
 *      credential, is unknown to them and starts a new one, in full;
 *   3. what an approval may rest on: presenting twice without a context resolves to the most recent
 *      context; another principal's context, or one presented under another credential — a console
 *      session's for an agent, and the reverse — never applies, passed or not; a stale
 *      `expected_revision` and a passed context whose covered snapshot is not the current one are
 *      `APPROVAL_CONFLICT`, naming the current revision and what changed; a coverage read that
 *      fails refuses;
 *   4. the race: a row that moved between the read and the record answers so, writes no row and
 *      covers nothing; a current row written before generations were recorded per row is stamped
 *      with the document's generation at its first presentation;
 *   5. the registration: it asks `approvalBasis` and returns its refusal before it writes, answers
 *      a lost compare-and-swap as `APPROVAL_CONFLICT`, and hands the approval's record to the seal.
 *
 * DELIBERATE: the presenter is `present` (document-present.ts) and the rows it writes are what the
 * reader reads. A check that wrote the rows itself would prove the reader and nothing about the
 * writer.
 *
 * Run: node checks/approve-needs-present.ts
 */
import { readFileSync } from "node:fs";

import { contentRevision } from "@zz/contracts";
import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const INIT = "2026-09-26-approve";
const REL = `${INIT}/spec.md`;
const TEAM = "t1";
const DOC = "00000000-0000-0000-0000-0000000000d1";

/** The fixture: one document, its rows, and the instants that decide the old check. `own` is a
 *  row's own generation — null on a row written before generations were recorded per row. */
const KEPT = "kept: a section long enough that the change set is shorter than the document. ".repeat(4);
const rows: { revision: number; body: string; own: string | null }[] =
  [{ revision: 1, body: `# Spec\n\n## A\n\n${KEPT}\n\n## B\n\nbody\n`, own: "0" }];
const doc = { current: 1, generation: 0, written_at: "2026-09-26T00:00:00.000Z", presented_at: null as string | null,
              /** What `rowHeld` answers for the generation, when a test moves the row under the present. */
              movedTo: null as number | null };
const events: { kind: string; subject: string; detail: Record<string, unknown> }[] = [];
const stamps: unknown[][] = [];
/** When set, the read of a context's pages fails — what a coverage read that cannot answer is. */
let broken = false;
const cur = () => rows.find((r) => r.revision === doc.current)!;

async function route(text: string, values: unknown[] = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();
  const one = (r: Record<string, unknown>[]) => ({ rows: r, rowCount: r.length });
  // DELIBERATE: the routes that decide this check come FIRST. The generic `from zz.doc d` arm
  // below matches several of their texts too, and a router answers by first match.
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) {
    // `now()` stands just past the revision's own write, which is what a present after a write is.
    if (values[0] === DOC && values[1] === doc.current) doc.presented_at = new Date(Date.parse(doc.written_at) + 1000).toISOString();
    return { rows: [], rowCount: 1 };
  }
  if (/as own_generation/.test(sql)) {
    return one([{ id: DOC, current_revision: doc.current, content_generation: String(doc.movedTo ?? doc.generation),
                  own_generation: doc.movedTo !== null ? String(doc.movedTo) : cur().own }]);
  }
  if (/set content_generation = d\.content_generation/.test(sql)) {
    stamps.push(values);
    const r = rows.find((x) => x.revision === values[1]);
    if (r && r.own === null) r.own = String(doc.generation);
    return { rows: [], rowCount: 1 };
  }
  if (/e\.detail->>'review_context' as context/.test(sql)) {
    if (broken) throw new Error("the event table is unreachable");
    return one(events.filter((e) => e.subject === values[2] && e.detail.review_context
        && String(e.detail.user).toLowerCase() === String(values[3]).toLowerCase()
        && (e.detail.credential ?? "") === values[4] && (values[5] === null || e.detail.review_context === values[5]))
      .map((e) => ({ context: e.detail.review_context, target: e.detail.target, baseline: e.detail.baseline,
                     kind: e.detail.kind, start: e.detail.start, end: e.detail.end, total: e.detail.total })));
  }
  if (/from zz\.doc d\b/.test(sql) && /where t\.slug = \$1 and i\.slug = \$2 and d\.path = \$3/.test(sql)) {
    if (values[0] !== TEAM || values[1] !== INIT || values[2] !== "spec.md") return one([]);
    return one([{ id: DOC, initiative: INIT, path: "spec.md", flow: "", type: "", status: "draft",
                  outcome: null, current_revision: doc.current, approved_revision: null,
                  current_version: 1, content_generation: String(doc.generation), updated_at: doc.written_at }]);
  }
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    return one(rows.map((r) => ({ revision: r.revision, version: 1, content_state: "retained", title: "Spec", body: r.body,
                                  tags: [], content_hash: "h", revision_note: null, fields: null,
                                  written_by: "u@zz.test", written_at: doc.written_at, approved_by: null,
                                  approved_at: null, content_generation: r.own })));
  }
  if (/from zz\.doc_link l\b/.test(sql)) return one([]);
  if (/insert into zz\.event\b/.test(sql)) {
    events.push({ kind: String(values[3]), subject: String(values[4]), detail: JSON.parse(String(values[5])) });
    return { rows: [], rowCount: 1 };
  }
  if (/from zz\.team where slug = \$1|select slug from zz\.team/.test(sql)) return one([{ slug: TEAM }]);
  return one([]);
}
pg.Pool.prototype.query = route as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async () => ({ query: route, release() {} })) as unknown as typeof pg.Pool.prototype.connect;

const load = (p: string) => import(new URL(`file://${process.cwd()}/${p}`).href);
const { present } = await load("services/zz-core/dist/document-present.js");
const { approvalBasis } = await load("services/zz-core/dist/attest.js");
const { db } = await load("services/zz-core/dist/platform-db.js");

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const me = { team: TEAM, email: "u@zz.test", credential: "pat", client: "zz-plugin" };
const show = async (who = me, ask: Record<string, unknown> = {}): Promise<string> =>
  (await present(db()!, who, REL, ask, false)).text;
const cr = (g: number) => contentRevision(DOC, g);
/** Stand in for a change: the bytes are new, the generation moves, and the row's own write with
 *  them. `pinned` files a new row, as a change to a presented row does; otherwise it is rewritten. */
const change = (body: string, pinned: boolean) => {
  doc.generation += 1;
  if (pinned) { rows.push({ revision: doc.current + 1, body, own: String(doc.generation) }); doc.current += 1; }
  else Object.assign(cur(), { body, own: String(doc.generation) });
  const base = doc.presented_at ? Date.parse(doc.presented_at) : Date.parse(doc.written_at);
  doc.written_at = new Date(base + 1000).toISOString();
};

/** What an approval of the current snapshot would rest on: the context, or the refusal. */
const basis = async (who = me, a: { expected?: string; context?: string } = {}): Promise<string> => {
  const b = await approvalBasis(db()!, who, REL, cr(doc.generation), a);
  return "refusal" in b ? b.refusal : `${b.context} ${b.target}`;
};
const ctxOf = (reply: string): string => /Review context: (rc_[a-z2-7]{26})/.exec(reply)?.[1] ?? "";

// 1. The basis, over the real presenter
change(cur().body, false);
const unshown = await basis();
is(unshown.startsWith(`ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${cr(1)}, the current snapshot of ${REL}`)
   && unshown.includes("document_present"),
   `written and never presented, and the approval would rest on something: ${unshown}`);
const firstTotal = cur().body.trim().length;
const first = await show();
is(doc.presented_at !== null, "presenting did not pin the row it showed (`presented_at`, the pin rule's input)");
is(await basis() === `${ctxOf(first)} ${cr(1)}`, `presented after the write, and the approval has no basis: ${await basis()}`);
change(cur().body.replace("body", "body, rewritten"), false);
const rewritten = await basis();
is(rewritten.startsWith(`ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${cr(2)}`)
   && rewritten.includes(`review_context: "${ctxOf(first)}"`),
   `rewritten after the present, and the approval does not refuse naming the context to present it in: ${rewritten}`);
const second = await show();
is(await basis() === `${ctxOf(second)} ${cr(2)}`, `the rewritten bytes presented, and the approval has no basis: ${await basis()}`);
// The control: a document the team does not hold rests on nothing.
const nope = await approvalBasis(db()!, me, `${INIT}/nope.md`, cr(2), {});
is("refusal" in nope && nope.refusal.startsWith("ERROR: PRESENTATION_REQUIRED"), "a document nothing holds has a basis");

// 2. The review context
const ctx = /Review context: (rc_[a-z2-7]{26}) — full, target (cr_\S+), baseline none, covered\./.exec(first);
is(ctx && ctx[2] === cr(1), `a present without a context does not mint one and present in full: ${first.split("\n").slice(0, 3).join(" | ")}`);
const row = events[0];
is(row?.kind === "document.shown" && row.detail.review_context === ctx?.[1] && row.detail.target === cr(1)
   && row.detail.baseline === null && row.detail.kind === "full" && row.detail.start === 0
   && row.detail.end === row.detail.total && row.detail.total === firstTotal
   && row.detail.credential === "pat" && row.detail.client === "zz-plugin"
   && row.detail.text_chars === first.length && row.detail.meta_bytes === 0,
   `the presentation's row does not carry its context, target, kind, span, credential and sizes: ${JSON.stringify(row)}`);
const rc = ctx?.[1] ?? "";
// The second present (after the rewrite) minted its own context; this one continues the first.
const again = await show(me, { review_context: rc, full: true });
is(new RegExp(`Review context: ${rc} — full, target ${cr(2)}, baseline ${cr(1)}, covered\\.`).test(again),
   `\`full: true\` in a context with a covered baseline does not present in full: ${again.split("\n")[1]}`);
change(cur().body.replace("## B\n\nbody, rewritten", "## B\n\nbody, edited"), true);
const delta = await show(me, { review_context: rc });
is(new RegExp(`Review context: ${rc} — delta \\(1 record\\), target ${cr(3)}, baseline ${cr(2)}, covered\\.`).test(delta)
   && delta.includes('edited "## B" at section 3') && delta.includes("body, edited") && !delta.includes("kept"),
   `a present in a context with a covered baseline does not present only what changed: ${delta}`);
is(await basis() === `${rc} ${cr(3)}` && await basis(me, { context: rc }) === `${rc} ${cr(3)}`,
   `a complete delta did not make the new snapshot one the approval rests on, in its context: ${await basis()}`);
const deltaRow = events[events.length - 1];
is(deltaRow?.detail.kind === "delta" && deltaRow.detail.baseline === cr(2) && deltaRow.detail.target === cr(3),
   `the delta's row does not name its baseline and target: ${JSON.stringify(deltaRow?.detail)}`);
const same = await show(me, { review_context: rc });
is(same.includes(`Review context: ${rc} — no change since ${cr(3)} — covered.`) && !same.includes("kept"),
   `a present with nothing changed since the baseline does not say so: ${same}`);
const borrowed: Record<string, string> = {};
for (const [who, why] of [[{ ...me, email: "v@zz.test" }, "another principal"], [{ ...me, credential: "forwarded" }, "another credential"]] as const) {
  const other = await show(who, { review_context: rc });
  is(other.includes(`The review context ${rc} is not one of yours for ${REL}, so a new one was started.`)
     && /Review context: rc_[a-z2-7]{26} — full, target/.test(other) && !other.includes(`Review context: ${rc}`),
     `a context presented under ${why} is borrowed rather than replaced by a new one, in full: ${other.split("\n").slice(0, 3).join(" | ")}`);
  borrowed[why] = ctxOf(other);
}

// 3. What an approval may rest on
{
  // Another principal's context, or the caller's own under another credential, never applies —
  // passed, or found. Each of them was shown cr(3) in a context of their own, which they rest on.
  const v = { ...me, email: "v@zz.test" };
  const fwd = { ...me, credential: "forwarded" };
  for (const [who, theirs, why] of [[v, borrowed["another principal"], "another principal"],
                                     [fwd, borrowed["another credential"], "another credential"]] as const) {
    const mine = await basis(me, { context: theirs });
    is(mine.startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${theirs} is not one of yours for ${REL}`),
       `a context presented to ${why} was accepted for the caller's approval: ${mine}`);
    const lent = await basis(who, { context: rc });
    is(lent.startsWith(`ERROR: PRESENTATION_REQUIRED — the review context ${rc} is not one of yours for ${REL}`),
       `the caller's context was accepted for ${why}'s approval: ${lent}`);
    is(await basis(who) === `${theirs} ${cr(3)}`, `${why}, shown the snapshot in a context of their own, has no basis: ${await basis(who)}`);
  }
  is(await basis() === `${rc} ${cr(3)}`, `the caller's basis moved to a context shown to someone else: ${await basis()}`);

  // A console session's context never satisfies an agent's approval, nor the reverse.
  change(cur().body.replace("## A", "## A, for the console"), true);
  const session = { ...me, credential: "session" };
  const shownThere = await show(session);
  is(await basis(session) === `${ctxOf(shownThere)} ${cr(4)}`, `the console's own present is no basis for its approval: ${await basis(session)}`);
  const agent = await basis();
  is(agent.startsWith(`ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${cr(4)}`),
     `a console session's presentation satisfied an agent's approval: ${agent}`);
  const shownHere = await show();
  is(await basis() === `${ctxOf(shownHere)} ${cr(4)}` && await basis(session) === `${ctxOf(shownThere)} ${cr(4)}`,
     "an agent's presentation and a console session's do not each rest on their own context");

  // Presenting twice without a context: the target is the same, and the most recent context is used.
  const twice = await show();
  is(ctxOf(twice) !== ctxOf(shownHere) && await basis() === `${ctxOf(twice)} ${cr(4)}`,
     `presenting twice without a context does not resolve to the most recent one: ${await basis()}`);

  // A stale `expected_revision`: the conflict names the current revision and what changed.
  const stale = await basis(me, { expected: cr(3), context: rc });
  is(stale.startsWith(`ERROR: APPROVAL_CONFLICT — ${REL} is at content revision ${cr(4)} now, not ${cr(3)}`)
     && stale.includes('renamed "## A" to "## A, for the console"') && stale.includes("nothing was approved"),
     `a stale expected_revision is not a conflict naming the current revision and what changed: ${stale}`);
  is(await basis(me, { expected: cr(4) }) === `${ctxOf(twice)} ${cr(4)}`, "the current expected_revision is refused");
  const unknown = await basis(me, { expected: "cr_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
  is(unknown.startsWith(`ERROR: APPROVAL_CONFLICT — ${REL} is at content revision ${cr(4)} now, not cr_aaaaaaaaaaaaaaaaaaaaaaaaaa`)
     && /cannot be named/.test(unknown),
     `an expected_revision naming no snapshot is not a conflict saying what changed cannot be named: ${unknown}`);
  // A passed context whose covered snapshot is no longer current: what it showed is not what is signed.
  const behind = await basis(me, { context: rc });
  is(behind.startsWith(`ERROR: APPROVAL_CONFLICT — ${REL} is at content revision ${cr(4)} now, not ${cr(3)}`)
     && behind.includes('renamed "## A"'),
     `a passed context that covered an earlier snapshot is not a conflict naming what changed since: ${behind}`);

  // A coverage read that fails refuses — passed or found — and names no basis.
  broken = true;
  for (const a of [{}, { context: rc }]) {
    const down = await basis(me, a);
    is(down.startsWith(`ERROR: ${REL} was not approved — what was presented of it could not be read`) && down.includes("unreachable"),
       `a coverage read that failed did not refuse${"context" in a ? " (context passed)" : ""}: ${down}`);
  }
  broken = false;
}

// 4. The race, and the legacy row
const before = events.length;
const presentedBefore = doc.presented_at;
change(cur().body.replace("## B", "## B, renamed"), true);
doc.movedTo = doc.generation + 1;
const raced = await show();
is(raced.startsWith(`ERROR: ${REL} changed while it was being presented — it is at content revision ${cr(doc.generation + 1)} now`)
   && events.length === before && doc.presented_at === presentedBefore,
   `a row that moved under the present was recorded or covered: ${raced}`);
doc.movedTo = null;
cur().own = null;
const legacy = await show();
is(stamps.some((v) => v[0] === DOC && v[1] === doc.current) && cur().own === String(doc.generation)
   && events[events.length - 1]?.detail.target === cr(doc.generation) && legacy.includes(`target ${cr(doc.generation)}`),
   `a current row with no generation of its own was not stamped at its first presentation: ${JSON.stringify(stamps)}`);

// 5. The registration asks the basis and refuses before it writes
const src = readFileSync("services/zz-core/src/tools/initiative-acts.ts", "utf8");
const at = src.indexOf('"document_approve"');
const handler = at < 0 ? "" : src.slice(at, src.indexOf("server.registerTool(", at + 1));
if (!handler) fail.push("document_approve is not registered in initiative-acts.ts");
else {
  const asked = handler.search(/const basis = await approvalBasis\(/);
  const refused = handler.search(/if \("refusal" in basis\) return text\(basis\.refusal\)/);
  const persisted = handler.indexOf("saveDocument(");
  is(asked >= 0, "document_approve no longer asks approvalBasis");
  is(refused > asked, "document_approve does not return approvalBasis's refusal");
  is(persisted > refused, "document_approve refuses only after it has persisted the approval");
  is(/expected_revision/.test(handler) && /review_context/.test(handler), "document_approve does not take expected_revision and review_context");
  is(/STATE_CHANGED\)[\s\S]{0,200}approvalConflict\(/.test(handler),
     "a lost compare-and-swap is not answered as APPROVAL_CONFLICT");
  is(/record: approvalRecord\(/.test(handler.slice(persisted)) && !/recordAct\(/.test(handler),
     "the approval's record is not handed to the seal's transaction, or a second act row is written");
  is(!/shownSinceLastChange|present it first|NOT FETCHED/.test(handler), "document_approve still carries the old presentation check");
}

// The panel approves what it showed: the snapshot it displayed and the context it recorded under.
{
  const panel = readFileSync("services/zz-core/app/panel.ts", "utf8");
  const sign = panel.slice(panel.indexOf("async function sign("), panel.indexOf("\n}\n", panel.indexOf("async function sign(")));
  is(/name: "document_approve"/.test(sign) && /expected_revision: s\.doc\.content_revision/.test(sign)
     && /review_context: s\.doc\.review_context/.test(sign),
     "the panel's Approve does not send the revision it displayed and its review context");
}

if (fail.length) {
  console.error(`approve-needs-present: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("approve-needs-present: an approval rests on a context of the caller's covering exactly the current snapshot — " +
            "the most recent, or the one passed; never another principal's or credential's; a stale target is a conflict " +
            "naming what changed, and a failed read refuses; a moved row covers nothing; a legacy row is stamped");
