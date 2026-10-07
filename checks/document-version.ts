#!/usr/bin/env node
/**
 * checks/document-version.ts — the version a change lands in, and what a change may never touch,
 * through a real zz-core on a throwaway database (AC-1.2, AC-1.4).
 *
 *   node checks/document-version.ts   # needs Docker and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - every row of spec v6's version table: a create is v1 (a draft where the flow gates it); a
 *     draft's change with no cause new to its version stays in it, and one with a new cause opens
 *     the next; an approved body is refused without a cause and opens the next version, as a
 *     draft, with one — its signed snapshot untouched; metadata alone keeps the version and makes
 *     an approved snapshot a new draft snapshot; an approval moves neither the version nor the
 *     content identity; `no_change` moves nothing, consumes nothing and is recorded when keyed;
 *   - several causes in one call open one version; a source the current version already cites,
 *     named again, opens none;
 *   - a same-version snapshot carries its version's causes; `version: N` reads and presents N's
 *     last retained state, and an approved snapshot it superseded reads by its content revision; a snapshot shown in part stays pinned by the generation it
 *     showed when a rewrite keeping its identity moves its write time past the showing;
 *   - a closed initiative's gated correction is a draft beside its sealed revision, the close and
 *     its ledger untouched, `handover.md` writable and approvable meanwhile and `initiative_status`
 *     awaiting the correction's approval while reporting the outcome; a failure injected while the
 *     correction clears the approval commits nothing; a changed outcome is refused by the real
 *     `documentGuards`, called in this process; an ungated correction invents no status; a
 *     correction of a closing snapshot nobody was shown or signed files a new row beside it;
 *   - the act boundary: an approval meeting an edit committed after its read is APPROVAL_CONFLICT,
 *     naming the current revision and what changed; a close meeting one records on it; a close
 *     whose document moves twice answers that it changed while being closed, and commits nothing;
 *   - exact-target approval: presenting twice without a context and then approving rests on the
 *     most recent context, and the approval's one act row records that context and the snapshot it
 *     signed; a stale `expected_revision` — a metadata-only change after display included — is
 *     APPROVAL_CONFLICT naming what changed, an approval without one is PRESENTATION_REQUIRED
 *     naming the context to present in, and the delta presented in it is then approved; an
 *     approval that would rename a heading is refused, sealing nothing; an approval and a close
 *     keep the version's note.
 *
 * Races are staged with the order in which PostgreSQL grants one advisory lock — the per-document
 * key `saveDocument` takes; an injected failure is a trigger created for its case and dropped
 * after it. Both write only the database the check started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-version";

const first = (reply: string): string => reply.split("\n")[0];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Row {
  id: string; version: number; revision: number; status: string; approved_revision: number | null;
  generation: string;
}

/** The document's row: what its version, snapshot, status and content generation are now. */
async function rowOf(c: Core, path: string): Promise<Row> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  const { rows } = await c.sql.query<Row>(
    `select d.id::text as id, d.current_version as version, d.current_revision as revision, d.status,
            d.approved_revision, d.content_generation::text as generation
       from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2`, [initiative, name]);
  return rows[0] ?? c.fail(`row of ${path}`, "no such document");
}

/** One stored snapshot, as its signer left it. */
async function snapshot(c: Core, path: string, revision: number): Promise<string> {
  const { rows } = await c.sql.query<{ s: string }>(
    `select concat_ws('|', r.version, r.title, r.body, r.content_hash, r.approved_by, r.approved_at, r.fields::text) as s
       from zz.doc_revision r where r.doc_id = $1::uuid and r.revision = $2`, [(await rowOf(c, path)).id, revision]);
  return rows[0]?.s ?? c.fail(`snapshot ${path}@${revision}`, "no such revision");
}

/** The content revision a read of the current document states. */
async function tokenOf(c: Core, path: string): Promise<string> {
  const read = await c.ok(`read ${path}`, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(`read ${path}`, `no content_revision in: ${read}`);
}

/** The citations one stored snapshot carries. */
async function citesOfRevision(c: Core, path: string, revision: number): Promise<string[]> {
  const { rows } = await c.sql.query<{ to: string; linked_by: string | null }>(
    `select l.to_doc_id::text || '@' || l.to_revision as to, l.linked_by from zz.doc_link l
      where l.from_doc_id = $1::uuid and l.from_revision = $2 and l.kind = 'cites' order by 1`,
    [(await rowOf(c, path)).id, revision]);
  return rows.map((r) => `${r.to} ${r.linked_by ?? "-"}`);
}

/** The close as `zz.initiative` and the ledger of close events record it. */
async function closeRecord(c: Core, initiative: string): Promise<string> {
  const { rows } = await c.sql.query<{ s: string }>(
    `select concat_ws('|', coalesce(i.closed_at::text, '-'), coalesce(i.outcome, '-'), coalesce(i.closed_by::text, '-'),
                      coalesce(i.accepted_by, '-'),
                      (select count(*) from zz.event e where e.initiative_id = i.id and e.kind = 'initiative_close')) as s
       from zz.initiative i where i.slug = $1`, [initiative]);
  return rows[0]?.s ?? c.fail(`close of ${initiative}`, "no such initiative");
}

/** The close record once the close's own ledger event has landed — `platformEvent` writes it
 *  after the reply, so a record read at once can be a row short of what the close left. */
async function settledClose(c: Core, initiative: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const record = await closeRecord(c, initiative);
    if (!record.endsWith("|0")) return record;
    await new Promise((r) => setTimeout(r, 50));
  }
  return c.fail(`close of ${initiative}`, "its ledger event never landed");
}

/** The close record once nothing more lands — the same three reads in a row, as `settled`
 *  (scripts/schema/rollback-cases.ts) waits. "Not recorded again" read at once would pass a second
 *  close event written after the reply, the way the first one is. */
async function quietClose(c: Core, initiative: string): Promise<string> {
  let last = await closeRecord(c, initiative);
  for (let same = 0, i = 0; same < 3; i++) {
    if (i > 100) c.fail(`close of ${initiative}`, "the record never settled");
    await new Promise((r) => setTimeout(r, 200));
    const now = await closeRecord(c, initiative);
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return last;
}

/** A spec the spec gate approves: every declared section, one phase, one core statement with its
 *  evidence (scripts/control-loop-e2e.ts). */
const SPEC_BODY =
  "## Context\nx\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n" +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";
const EXPLORE_BODY = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";

async function versionTable(c: Core): Promise<void> {
  const V = await c.open("version-table");
  const n = `${V}/notes.md`;

  let step = "absent → document_write: v1, with no status where nothing gates it";
  await c.ok(step, "document_write", { path: n, content: "# Notes\n\none\n" });
  let row = await rowOf(c, n);
  if (row.version !== 1 || row.revision !== 1 || row.status !== "") c.fail(step, JSON.stringify(row));
  if (/^status:/m.test(await c.ok(step, "document_read", { path: n }))) c.fail(step, "a status was invented");
  c.pass(step);

  step = "a draft's body change with no cause new to its version stays in it, with a fresh content identity";
  let token = await tokenOf(c, n);
  let reply = await c.ok(step, "document_edit", { path: n, edits: [{ find: "one", replace: "two" }] });
  if (first(reply) !== `edited: ${n} — v1` || (await rowOf(c, n)).version !== 1) c.fail(step, reply);
  if ((await tokenOf(c, n)) === token) c.fail(step, "the content revision did not move");
  c.pass(step);

  step = "a draft's body change with a new cause opens the next version";
  token = await tokenOf(c, n);
  reply = await c.ok(step, "document_edit",
    { path: n, edits: [{ find: "two", replace: "three" }], source_content: "the call moved it to three" });
  if (first(reply) !== `edited: ${n} — v2 (new version)` || (await rowOf(c, n)).version !== 2) c.fail(step, reply);
  if ((await tokenOf(c, n)) === token) c.fail(step, "the content revision did not move");
  c.pass(step);

  step = "several causes in one call open one version";
  const s1 = await c.source(step, { initiative: V, title: "First input", content: "one input" });
  const s2 = await c.source(step, { initiative: V, title: "Second input", content: "another" });
  const rel = (p: string): string => p.slice(V.length + 1);
  reply = await c.ok(step, "document_edit", { path: n, edits: [{ find: "three", replace: "four" }],
                                              sources: [rel(s1), rel(s2)], source_content: "and a third" });
  if (first(reply) !== `edited: ${n} — v3 (new version)`) c.fail(step, reply);
  const listed = /^causes \(\d+\): (.*)$/m.exec(reply)?.[1].split(", ") ?? [];
  if (listed.length !== 3 || !listed.includes(`${s1} (agent)`) || !listed.includes(`${s2} (agent)`)) c.fail(step, reply);
  if ((await rowOf(c, n)).version !== 3) c.fail(step, JSON.stringify(await rowOf(c, n)));
  c.pass(step);

  step = "a source the current version already cites, named again, opens no version";
  reply = await c.ok(step, "document_edit", { path: n, edits: [{ find: "four", replace: "five" }], sources: [rel(s1)] });
  if (first(reply) !== `edited: ${n} — v3` || !/^causes \(0\): none$/m.test(reply)) c.fail(step, reply);
  c.pass(step);

  step = "an approval moves neither the public version nor the content identity";
  row = await rowOf(c, n);
  token = await tokenOf(c, n);
  await c.sign(n);
  const signed = await rowOf(c, n);
  if (signed.version !== row.version || signed.generation !== row.generation || signed.status !== "approved") {
    c.fail(step, `${JSON.stringify(row)} → ${JSON.stringify(signed)}`);
  }
  if ((await tokenOf(c, n)) !== token) c.fail(step, "the approval moved the content revision");
  c.pass(step);

  step = "an approved body changed with no cause is refused, and nothing changes";
  await c.refused(step, "document_edit", { path: n, edits: [{ find: "five", replace: "six" }] }, /^ERROR: CAUSE_REQUIRED — /);
  if (JSON.stringify(await rowOf(c, n)) !== JSON.stringify(signed) || (await tokenOf(c, n)) !== token) {
    c.fail(step, JSON.stringify(await rowOf(c, n)));
  }
  c.pass(step);

  step = "an approved body changed with its cause opens the next version, and the signed snapshot is untouched";
  const sealed = await snapshot(c, n, signed.revision);
  reply = await c.ok(step, "document_edit",
    { path: n, edits: [{ find: "five", replace: "six" }], source_content: "six, the stakeholder said" });
  if (first(reply) !== `edited: ${n} — v4 (new version)` || !/^status: none$/m.test(reply)) c.fail(step, reply);
  row = await rowOf(c, n);
  if (row.version !== 4 || row.status !== "" || row.approved_revision !== signed.revision) c.fail(step, JSON.stringify(row));
  if ((await snapshot(c, n, signed.revision)) !== sealed) c.fail(step, "the signed snapshot changed");
  const v3 = await c.ok(step, "document_read", { path: n, version: 3 });
  if (!/^status: approved$/m.test(v3) || !/five/.test(v3)) c.fail(step, `version 3 reads: ${v3}`);
  c.pass(step);

  step = "metadata alone keeps an approved version and files a new draft snapshot carrying its causes";
  await c.sign(n);
  const approved = await rowOf(c, n);
  token = await tokenOf(c, n);
  reply = await c.ok(step, "document_edit", { path: n, title: "Notes, renamed" });
  if (first(reply) !== `edited: ${n} — v4` || !/^causes \(0\): none$/m.test(reply)) c.fail(step, reply);
  row = await rowOf(c, n);
  if (row.version !== 4 || row.revision !== approved.revision + 1 || row.status === "approved"
      || row.approved_revision !== approved.revision) c.fail(step, JSON.stringify(row));
  if ((await tokenOf(c, n)) === token) c.fail(step, "the content revision did not move");
  const carried = await citesOfRevision(c, n, row.revision);
  if (!carried.length || JSON.stringify(carried) !== JSON.stringify(await citesOfRevision(c, n, approved.revision))) {
    c.fail(step, `causes not carried: ${JSON.stringify(carried)}`);
  }
  c.pass(step);

  step = "version: N reads and presents N's last retained state; the approved snapshot it superseded reads by its content revision";
  const readV4 = await c.ok(step, "document_read", { path: n, version: 4 });
  if (/^status: approved$/m.test(readV4) || !/^title: Notes, renamed$/m.test(readV4)) c.fail(step, `v4 before re-approval: ${readV4}`);
  const shownV4 = await c.ok(step, "document_present", { path: n, version: 4 });
  if (!/version 4\b/.test(shownV4) || /status approved/.test(shownV4) || !/six/.test(shownV4)) c.fail(step, `present v4: ${shownV4}`);
  const sealedV4 = await c.ok(step, "document_read", { path: n, content_revision: token });
  if (!/^status: approved$/m.test(sealedV4) || /Notes, renamed/.test(sealedV4)) c.fail(step, `the approved snapshot by ${token}: ${sealedV4}`);
  await c.sign(n);
  if (!/title: Notes, renamed/.test(await c.ok(step, "document_read", { path: n, version: 4 }))) {
    c.fail(step, "v4 does not read as its last snapshot");
  }
  // A version no one approved, with two snapshots: the presented one is pinned, so the change
  // after it files a second row in the same version, and the version reads as that last one.
  const m = `${V}/memo.md`;
  await c.ok(step, "document_write", { path: m, content: "# Memo\n\nfirst\n" });
  await c.ok(step, "document_present", { path: m });
  reply = await c.ok(step, "document_edit", { path: m, edits: [{ find: "first", replace: "last" }] });
  if (first(reply) !== `edited: ${m} — v1` || (await rowOf(c, m)).revision !== 2) c.fail(step, reply);
  if (!/last/.test(await c.ok(step, "document_read", { path: m, version: 1 }))
      || !/last/.test(await c.ok(step, "document_present", { path: m, version: 1 }))) {
    c.fail(step, "v1 does not read as its last snapshot");
  }
  c.pass(step);

  step = "a snapshot shown in part stays pinned when a rewrite keeping its identity moves its write past the showing";
  const pp = `${V}/partly.md`;
  await c.ok(step, "document_write", { path: pp, content: `# Partly\n\n${"a line shown in part.\n".repeat(40)}` });
  await c.ok(step, "document_present", { path: pp, limit: 200 });
  // What an identity-keeping rewrite — a stamp, or an eval document written again unchanged — leaves:
  // the same generation, written after the showing's `ts`.
  await c.sql.query(
    `update zz.doc_revision r set written_at = now() + interval '1 minute' from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where r.doc_id = d.id and r.revision = d.current_revision and i.slug = $1 and d.path = 'partly.md'`, [V]);
  reply = await c.ok(step, "document_edit", { path: pp, edits: [{ find: "# Partly", replace: "# Partly, edited" }] });
  if (first(reply) !== `edited: ${pp} — v1` || (await rowOf(c, pp)).revision !== 2) {
    c.fail(step, `the shown row was rewritten in place: ${reply} ${JSON.stringify(await rowOf(c, pp))}`);
  }
  c.pass(step);

  step = "no_change moves nothing, consumes nothing, and a keyed one is recorded";
  row = await rowOf(c, n);
  token = await tokenOf(c, n);
  const sources = async (): Promise<number> => (await c.sql.query<{ n: number }>(
    `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path like 'sources/%'`, [V])).rows[0].n;
  const before = await sources();
  reply = await c.ok(step, "document_edit",
    { path: n, title: "Notes, renamed", source_content: "words that change nothing", request_id: "nc-1" });
  if (first(reply) !== `edited: ${n} — v4 (no change)`) c.fail(step, reply);
  if (JSON.stringify(await rowOf(c, n)) !== JSON.stringify(row) || (await tokenOf(c, n)) !== token) {
    c.fail(step, "the document moved");
  }
  if ((await sources()) !== before) c.fail(step, "a cause was captured");
  const { rows: kept } = await c.sql.query<{ result: string }>(
    "select receipt->>'result' as result from zz.doc_request where request_id = 'nc-1'");
  if (kept[0]?.result !== "no_change") c.fail(step, `request row: ${JSON.stringify(kept)}`);
  c.pass(step);

  step = "a gated document: v1 a draft, a caused change a draft of the next version, metadata on its approval a draft of the same";
  const G = await c.open("version-gated", "sdlc-flow");
  const spec = `${G}/spec.md`;
  await c.ok(step, "document_write", { path: `${G}/explore.md`, content: EXPLORE_BODY });
  await c.ok(step, "document_write", { path: spec, content: SPEC_BODY });
  row = await rowOf(c, spec);
  if (row.version !== 1 || row.status !== "draft") c.fail(step, `created: ${JSON.stringify(row)}`);
  reply = await c.ok(step, "document_edit", { path: spec, section: "Problem", content: "## Problem\ny\n",
                                              source_content: "the problem, restated" });
  if (first(reply) !== `edited: ${spec} — v2 (new version)` || !/^status: draft$/m.test(reply)) c.fail(step, reply);
  await c.sign(spec);
  reply = await c.ok(step, "document_edit", { path: spec, title: "The spec, retitled" });
  if (first(reply) !== `edited: ${spec} — v2` || !/^status: draft$/m.test(reply)) c.fail(step, reply);
  c.pass(step);
}

async function closedCorrections(c: Core): Promise<void> {
  // ---- gated: an sdlc initiative walked to its close, closed on review.md
  const K = await c.open("closed-gated", "sdlc-flow");
  const review = `${K}/review.md`;
  let step = "a gated initiative is walked to its close";
  await c.ok(step, "document_write", { path: `${K}/explore.md`, content: EXPLORE_BODY });
  await c.ok(step, "document_write", { path: `${K}/spec.md`, content: SPEC_BODY });
  await c.sign(`${K}/spec.md`);
  await c.source(step, { initiative: K, title: "spec audit", content: "no blocking findings", supports: ["spec.md"], stage: "sdlc-spec-audit" });
  await c.ok(step, "document_write", { path: `${K}/plan.md`, content: "## Full-suite gate\nRun the gate.\n" });
  await c.sign(`${K}/plan.md`);
  await c.source(step, { initiative: K, title: "plan audit", content: "no blocking findings", supports: ["plan.md"], stage: "sdlc-plan-audit" });
  await c.ok(step, "document_write", { path: review, content: "## Verdict\nShip it.\n" });
  await c.source(step, { initiative: K, title: "review round", supports: ["review.md"], stage: "sdlc-review",
    content: "no blocking findings\n\n```json\n" +
      JSON.stringify({ round: 1, scope: { base: "HEAD~1", head: "HEAD" }, findings: [], resolved: [] }) + "\n```\n" });
  await c.sign(review);
  const closed = await c.ok(step, "initiative_close", { initiative: K, disposition: "finished" });
  if (!new RegExp(`^${esc(K)} closed as accepted`).test(closed)) c.fail(step, closed);
  c.pass(step);
  const record = await settledClose(c, K);
  const sealedRow = await rowOf(c, review);
  const sealed = await snapshot(c, review, sealedRow.revision);

  step = "a failure injected while a correction clears the approval leaves nothing committed";
  const correction = { path: review, edits: [{ find: "Ship it.", replace: "Ship it, with the fix." }],
                       source_content: "the review missed a case", source_title: "Correction input", request_id: "corr-1" };
  await c.sql.query(`create function zz.inject_clear_approval() returns trigger language plpgsql as $$
                       begin raise exception 'injected: the approval is being cleared'; end $$`);
  await c.sql.query(`create trigger inject_clear_approval before update on zz.doc for each row
                       when (old.id = '${sealedRow.id}'::uuid and old.status = 'approved' and new.status <> 'approved')
                       execute function zz.inject_clear_approval()`);
  try {
    await c.refused(step, "document_edit", correction, /could not be written: .*injected: the approval is being cleared/);
  } finally {
    await c.sql.query("drop trigger inject_clear_approval on zz.doc");
    await c.sql.query("drop function zz.inject_clear_approval()");
  }
  const left = await c.sql.query<{ revisions: number; captured: number; requests: number; cites: number }>(
    `select (select count(*)::int from zz.doc_revision where doc_id = $1::uuid) as revisions,
            (select count(*)::int from zz.doc d join zz.initiative i on i.id = d.initiative_id
              where i.slug = $2 and d.path like 'sources/%correction-input%') as captured,
            (select count(*)::int from zz.doc_request where request_id = 'corr-1') as requests,
            (select count(*)::int from zz.doc_link where from_doc_id = $1::uuid and from_revision > $3) as cites`,
    [sealedRow.id, K, sealedRow.revision]);
  const r0 = left.rows[0];
  if (r0.revisions !== sealedRow.revision || r0.captured || r0.requests || r0.cites
      || JSON.stringify(await rowOf(c, review)) !== JSON.stringify(sealedRow)) {
    c.fail(step, `left behind: ${JSON.stringify(r0)} ${JSON.stringify(await rowOf(c, review))}`);
  }
  c.pass(step);

  step = "a closed gated document's correction is a draft of the next version, the close and its ledger untouched";
  let reply = await c.ok(step, "document_edit", correction);
  if (first(reply) !== `edited: ${review} — v2 (new version)` || !/^status: draft$/m.test(reply)) c.fail(step, reply);
  const now = await c.ok(step, "document_read", { path: review });
  if (!/^outcome: accepted$/m.test(now) || /^approved_by:/m.test(now)) c.fail(step, `current: ${now}`);
  if ((await quietClose(c, K)) !== record) c.fail(step, `close: ${record} → ${await closeRecord(c, K)}`);
  if ((await snapshot(c, review, sealedRow.revision)) !== sealed) c.fail(step, "the sealed revision changed");
  const v1 = await c.ok(step, "document_read", { path: review, version: 1 });
  if (!/^status: approved$/m.test(v1) || !/^outcome: accepted$/m.test(v1) || !/Ship it\.\n/.test(v1)) {
    c.fail(step, `v1 reads: ${v1}`);
  }
  c.pass(step);

  step = "handover.md is writable and approvable while the correction waits";
  await c.ok(step, "document_write", { path: `${K}/handover.md`, content:
    "## What this initiative taught\nx\n\n## Recorded for the platform\nx\n\n## Proposed for the team\nx\n" });
  await c.sign(`${K}/handover.md`);
  c.pass(step);

  step = "initiative_status awaits the correction's approval and still reports the outcome";
  let st = await c.status(K);
  if (st.outcome !== "accepted" || st.next_move?.action !== "await_approval" || st.next_move.document !== "review.md"
      || !/closed with outcome: accepted/.test(st.next_move.why ?? "")) c.fail(step, JSON.stringify(st));
  c.pass(step);

  step = "approving the correction signs it alone: the close is neither reopened nor recorded again";
  await c.sign(review);
  st = await c.status(K);
  if ((await quietClose(c, K)) !== record || st.next_move?.action !== "closed") {
    c.fail(step, `${await closeRecord(c, K)} ${JSON.stringify(st)}`);
  }
  c.pass(step);

  step = "metadata alone on a closed gated document: the same version, a draft awaiting its own approval, no cause";
  const token = await tokenOf(c, review);
  reply = await c.ok(step, "document_edit", { path: review, title: "Review, retitled" });
  if (first(reply) !== `edited: ${review} — v2` || !/^status: draft$/m.test(reply) || !/^causes \(0\): none$/m.test(reply)) {
    c.fail(step, reply);
  }
  if ((await tokenOf(c, review)) === token || (await quietClose(c, K)) !== record) c.fail(step, "identity or close");
  if ((await c.status(K)).next_move?.action !== "await_approval") c.fail(step, "no approval awaited");
  c.pass(step);

  step = "a changed outcome is refused by the real documentGuards";
  const core = await c.inProcess();
  const text = await c.ok(step, "document_read", { path: review });
  const changed = text.replace(/^outcome: accepted$/m, "outcome: delivered");
  if (changed === text) c.fail(step, `no outcome line in: ${text}`);
  const judge = async (t: string) =>
    core.documentGuards(await core.chainFor(core.pool, c.team, review, t), review, t, c.team, "document_edit");
  const refusal = await judge(changed);
  if (!refusal || !/is the document this initiative closed on \(outcome: accepted.*would alter what the close recorded/.test(refusal)) {
    c.fail(step, `refusal: ${refusal}`);
  }
  if (/would alter what the close recorded/.test((await judge(text)) ?? "")) c.fail(step, "the unchanged outcome was refused too");
  c.pass(step);

  // ---- ungated: a freeform initiative closed on a document nothing gates
  const U = await c.open("closed-ungated");
  const u = `${U}/notes.md`;
  step = "an ungated closed document's correction invents no status or approval, and leaves the close";
  await c.ok(step, "document_write", { path: u, content: "# Notes\n\nkept\n" });
  await c.sign(u);
  const closedU = await c.ok(step, "initiative_close", { initiative: U, disposition: "finished", document: "notes.md" });
  if (!/closed as accepted/.test(closedU)) c.fail(step, closedU);
  const recordU = await settledClose(c, U);
  await c.refused(step, "document_edit", { path: u, edits: [{ find: "kept", replace: "fixed" }] }, /^ERROR: CAUSE_REQUIRED — /);
  reply = await c.ok(step, "document_edit",
    { path: u, edits: [{ find: "kept", replace: "fixed" }], source_content: "the record had a typo" });
  if (first(reply) !== `edited: ${u} — v2 (new version)` || !/^status: none$/m.test(reply)) c.fail(step, reply);
  const read = await c.ok(step, "document_read", { path: u });
  if (/^(status|approved_by):/m.test(read) || !/^outcome: accepted$/m.test(read)) c.fail(step, `current: ${read}`);
  if ((await quietClose(c, U)) !== recordU || (await c.status(U)).outcome !== "accepted") c.fail(step, "the close moved");
  if (!/^status: approved$/m.test(await c.ok(step, "document_read", { path: u, version: 1 }))) c.fail(step, "v1 lost its seal");
  c.pass(step);

  // ---- a closing snapshot nobody was shown or signed: the close rests on it all the same
  const P = await c.open("closed-unpinned");
  const pn = `${P}/notes.md`;
  step = "a correction of a closing snapshot nobody was shown or signed files a new row, and the one the close rests on stays";
  await c.ok(step, "document_write", { path: pn, content: "# Notes\n\nas closed\n" });
  const closedP = await c.ok(step, "initiative_close", { initiative: P, disposition: "finished", document: "notes.md" });
  if (!new RegExp(`^${esc(P)} closed as `).test(closedP)) c.fail(step, closedP);
  const atClose = await rowOf(c, pn);
  const closing = await snapshot(c, pn, atClose.revision);
  reply = await c.ok(step, "document_edit", { path: pn, edits: [{ find: "as closed", replace: "corrected" }] });
  if (first(reply) !== `edited: ${pn} — v1`) c.fail(step, reply);
  if ((await rowOf(c, pn)).revision !== atClose.revision + 1 || (await snapshot(c, pn, atClose.revision)) !== closing) {
    c.fail(step, `the closing snapshot was rewritten in place: ${JSON.stringify(await rowOf(c, pn))}`);
  }
  c.pass(step);
}

async function actRaces(c: Core): Promise<void> {
  const A = await c.open("act-races");

  let step = "an approval meeting an edit committed after its read is APPROVAL_CONFLICT, naming what changed";
  const r = `${A}/race.md`;
  // A section the edit leaves alone, so what changed is shorter than the document and is named.
  const kept = "## Kept\n\n" + "a line the edit never touches.\n".repeat(8);
  await c.ok(step, "document_write", { path: r, content: `# Race\n\nbefore\n\n${kept}` });
  await c.ok(step, "document_present", { path: r });
  const presentedAt = await tokenOf(c, r);
  const second = c.client();
  let key = c.docKey(r);
  await c.hold(key);
  let edit: Promise<string>;
  let act: Promise<string>;
  try {
    edit = c.call(step, "document_edit", { path: r, edits: [{ find: "before", replace: "after" }] });
    await c.waiters(step, key, 1);
    act = c.call(step, "document_approve", { path: r }, second);
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  let [edited, answered] = await Promise.all([edit, act]);
  if (first(edited) !== `edited: ${r} — v1`) c.fail(step, `edit: ${edited}`);
  if (!answered.startsWith(`ERROR: APPROVAL_CONFLICT — ${r} is at content revision ${await tokenOf(c, r)} now, not ${presentedAt}`)
      || !answered.includes(`changed since ${presentedAt}`) || !answered.includes('edited "# Race"')) {
    c.fail(step, `approve: ${answered}`);
  }
  if ((await rowOf(c, r)).status === "approved" || !/after/.test(await c.ok(step, "document_read", { path: r }))) {
    c.fail(step, "the approval sealed, or the edit was lost");
  }
  c.pass(step);

  step = "a close meeting an edit committed after its read records on the edited document";
  const C = await c.open("close-race");
  const cn = `${C}/notes.md`;
  await c.ok(step, "document_write", { path: cn, content: "# Notes\n\nbefore\n" });
  key = c.docKey(cn);
  await c.hold(key);
  try {
    edit = c.call(step, "document_edit", { path: cn, edits: [{ find: "before", replace: "after" }] });
    await c.waiters(step, key, 1);
    act = c.call(step, "initiative_close", { initiative: C, disposition: "finished", document: "notes.md" }, second);
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  [edited, answered] = await Promise.all([edit, act]);
  if (first(edited) !== `edited: ${cn} — v1`) c.fail(step, `edit: ${edited}`);
  if (!new RegExp(`^${esc(C)} closed as accepted`).test(answered)) c.fail(step, `close: ${answered}`);
  const closedText = await c.ok(step, "document_read", { path: cn });
  if (!/after/.test(closedText) || !/^outcome: accepted$/m.test(closedText) || !/\|accepted\|/.test(await closeRecord(c, C))) {
    c.fail(step, `${closedText}\n${await closeRecord(c, C)}`);
  }
  c.pass(step);

  step = "a close whose document moves twice answers that it changed while being closed, and commits nothing";
  const T = await c.open("close-moved-twice");
  const tn = `${T}/notes.md`;
  await c.ok(step, "document_write", { path: tn, content: "# Notes\n\nstill\n" });
  // What an edit's commit leaves on the state: the current row stamped again.
  const move = () => c.sql.query(
    `update zz.doc_revision r set written_at = now() from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where r.doc_id = d.id and r.revision = d.current_revision and i.slug = $1 and d.path = 'notes.md'`, [T]);
  key = c.docKey(tn);
  await c.hold(key);
  try {
    act = c.call(step, "initiative_close", { initiative: T, disposition: "finished", document: "notes.md" });
    await c.waiters(step, key, 1);
    await move();
    // The first attempt meets the moved state and lets go; the holder has the lock back before
    // the retry, which reads again and waits behind it — and the state moves once more.
    await c.release(key, true);
    await c.waiters(step, key, 1);
    await move();
  } finally {
    await c.release(key);
  }
  answered = await act;
  if (answered !== `ERROR: ${T} changed while it was being closed — call initiative_close again`) c.fail(step, answered);
  if (/^outcome:/m.test(await c.ok(step, "document_read", { path: tn })) || !(await closeRecord(c, T)).startsWith("-|-|")) {
    c.fail(step, `committed: ${await closeRecord(c, T)}`);
  }
  c.pass(step);
}

async function exactTarget(c: Core): Promise<void> {
  const X = await c.open("exact-target");
  const ctxOf = (reply: string): string => /^Review context: (rc_[a-z2-7]{26})/m.exec(reply)?.[1] ?? "";

  let step = "presenting twice without a context, then approving, rests on the most recent context, recorded on its one act row";
  const t = `${X}/twice.md`;
  await c.ok(step, "document_write", { path: t, content: "# Twice\n\nshown twice\n" });
  const [one, two] = [ctxOf(await c.ok(step, "document_present", { path: t })), ctxOf(await c.ok(step, "document_present", { path: t }))];
  const signed = await tokenOf(c, t);
  if (!one || !two || one === two) c.fail(step, `two presents without a context gave ${one} and ${two}`);
  const approved = await c.ok(step, "document_approve", { path: t });
  if (!approved.includes(`Signed: content revision ${signed}, as presented in review context ${two}.`)) c.fail(step, approved);
  const acts = (await c.sql.query<{ detail: Record<string, string> }>(
    `select e.detail from zz.event e join zz.initiative i on i.id = e.initiative_id
      where i.slug = $1 and e.subject = $2 and e.kind = 'document.document_approve'`, [X, t])).rows;
  const d = acts[0]?.detail;
  if (acts.length !== 1 || d.review_context !== two || d.content_revision !== signed || d.signer !== c.email || d.user !== c.email) {
    c.fail(step, `the approval's act rows: ${JSON.stringify(acts)}`);
  }
  c.pass(step);

  step = "a metadata-only change after display is APPROVAL_CONFLICT for the revision shown, PRESENTATION_REQUIRED without it, and the delta presented in its context is approved";
  const m = `${X}/metadata.md`;
  await c.ok(step, "document_write", { path: m, content: "---\ntitle: Shown\n---\n\n# Metadata\n\n" +
                                                         "the body stays as it was shown.\n".repeat(8) });
  const ctx = ctxOf(await c.ok(step, "document_present", { path: m }));
  const shown = await tokenOf(c, m);
  await c.ok(step, "document_edit", { path: m, title: "Renamed after display" });
  const now = await tokenOf(c, m);
  const stale = await c.call(step, "document_approve", { path: m, expected_revision: shown, review_context: ctx });
  if (now === shown || !stale.startsWith(`ERROR: APPROVAL_CONFLICT — ${m} is at content revision ${now} now, not ${shown}`)
      || !stale.includes('title: was "Shown"; now "Renamed after display"')) {
    c.fail(step, `stale expected_revision: ${stale}`);
  }
  // The revision alone, with no context to fall back on: it is the revision that is refused.
  const alone = await c.call(step, "document_approve", { path: m, expected_revision: shown });
  if (!alone.startsWith(`ERROR: APPROVAL_CONFLICT — ${m} is at content revision ${now} now, not ${shown}`)) {
    c.fail(step, `a stale expected_revision with no context: ${alone}`);
  }
  const implicit = await c.call(step, "document_approve", { path: m });
  if (!implicit.startsWith(`ERROR: PRESENTATION_REQUIRED — no review context of yours covers ${now}`)
      || !implicit.includes(`review_context: "${ctx}"`)) {
    c.fail(step, `no covering context: ${implicit}`);
  }
  if ((await rowOf(c, m)).status === "approved") c.fail(step, "a refused approval sealed the document");
  const delta = await c.ok(step, "document_present", { path: m, review_context: ctx });
  if (!new RegExp(`^Review context: ${ctx} — delta \\(1 record\\), target ${now}, baseline ${shown}, covered\\.$`, "m").test(delta)) {
    c.fail(step, `the delta after a metadata change: ${delta}`);
  }
  await c.ok(step, "document_approve", { path: m, expected_revision: now, review_context: ctx });
  if ((await rowOf(c, m)).status !== "approved") c.fail(step, "the approval of the presented delta did not seal");
  c.pass(step);

  step = "an approval that would rename a heading to the one the flow declares is refused, and seals nothing";
  const H = await c.open("approve-rename", "sdlc-flow");
  const hs = `${H}/spec.md`;
  await c.ok(step, "document_write", { path: `${H}/explore.md`, content: EXPLORE_BODY });
  await c.ok(step, "document_write", { path: hs, content: SPEC_BODY });
  // A body stored before the flow's declared section was named so: a near miss approval would rename.
  const hid = (await rowOf(c, hs)).id;
  await c.sql.query("update zz.doc_revision set body = replace(body, '## Problem\n', '## The Problem\n') where doc_id = $1::uuid", [hid]);
  await c.sql.query("update zz.doc set body = replace(body, '## Problem\n', '## The Problem\n') where id = $1::uuid", [hid]);
  const hctx = ctxOf(await c.ok(step, "document_present", { path: hs }));
  const held = await rowOf(c, hs);
  await c.refused(step, "document_approve", { path: hs, expected_revision: await tokenOf(c, hs), review_context: hctx },
    new RegExp(`^ERROR: ${esc(hs)} .*\`## The Problem\` → \`## Problem\`.*document_edit`, "s"));
  if (JSON.stringify(await rowOf(c, hs)) !== JSON.stringify(held)) c.fail(step, `sealed: ${JSON.stringify(await rowOf(c, hs))}`);
  c.pass(step);

  step = "an approval and a close keep the version's note";
  const nn = `${X}/noted.md`;
  await c.ok(step, "document_write", { path: nn, content: "# Noted\n\nfirst\n" });
  await c.ok(step, "document_edit", { path: nn, edits: [{ find: "first", replace: "second" }], note: "the second pass" });
  const noteOf = async (): Promise<string | null> => (await c.sql.query<{ note: string | null }>(
    `select r.revision_note as note from zz.doc d join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where d.id = $1::uuid`, [(await rowOf(c, nn)).id])).rows[0]?.note ?? null;
  await c.sign(nn);
  if ((await noteOf()) !== "the second pass") c.fail(step, `after the approval: ${await noteOf()}`);
  await c.ok(step, "initiative_close", { initiative: X, disposition: "finished", document: "noted.md" });
  if ((await noteOf()) !== "the second pass") c.fail(step, `after the close: ${await noteOf()}`);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: versions follow causes, signed snapshots stay as signed, and a closed record's correction is a draft: ok`,
  async (c) => {
    await versionTable(c);
    await closedCorrections(c);
    await actRaces(c);
    await exactTarget(c);
  });
