#!/usr/bin/env node
/**
 * checks/document-edit-races.ts — what a change does when it meets another, when it is sent
 * again, and when its transaction fails part-way, through a real zz-core on a throwaway database
 * (AC-1.1, AC-1.5).
 *
 *   node checks/document-edit-races.ts   # needs Docker and a built tree (`npm run build`)
 *
 * What it establishes, one line per case:
 *
 *   - races: two edits sending one `base` — one lands and the other is BASE_CONFLICT naming the
 *     token the first left; two sending none — both land, in the order the lock granted them; an
 *     approval landing between an edit's read and its commit — the edit is computed again and
 *     answers CAUSE_REQUIRED; an edit landing between an approval's read and its write — the edit
 *     stands and the approval is APPROVAL_CONFLICT, naming the snapshot it read and the current one,
 *     and seals nothing; an edit
 *     landing between a close's read and its write — the edit stands, and the initiative's row is
 *     closed exactly when its closing document carries the outcome; two creates of one path — one
 *     document, the other TARGET_EXISTS; an A→B→A change — A's token is not revived;
 *   - `request_id`: a replay answers the first receipt marked ` (replayed)` and writes nothing; two
 *     identical keyed requests released together commit once; a keyed replay after a later edit is
 *     still the first receipt, not BASE_CONFLICT; a keyed `no_change` is recorded and replays; a
 *     keyed create replays before TARGET_EXISTS; a changed request under a used key, and the same
 *     arguments sent to the other tool under it, are REQUEST_ID_CONFLICT; an unkeyed resend is
 *     `no_change`; a replay survives a restart of zz-core; a caller whose membership was removed
 *     is refused, not replayed; a replay prints the next move the first call stated, labelled as of
 *     then, and the one there is now; a keyed change whose captured source took a suffixed name
 *     replays that name, never the one it asked for;
 *   - an injected failure at each statement a change commits — the captured source, the document
 *     row, the cause links, the request row and the change's own `document.*` event row — leaves
 *     nothing committed, and the same keyed change lands once the failure is gone;
 *   - an upload (AC-4.1, AC-4.2): `upload_start` answers its id, a `curl --fail-with-body` PUT to
 *     `/upload/<id>` and a `/u/<secret>` link, and refuses with no GATEWAY_PUBLIC_URL; a staged
 *     `.md` becomes a document by the rules typed content follows, a `.csv` and a non-envelope
 *     `.yaml` are stored byte for byte (a BOM removed and said), an envelope-shaped `.yaml` is
 *     refused into a document with its way out and taken as a source, and `document_edit` takes one
 *     as the whole body; one used, another principal's or team's, expired or unstaged is refused
 *     and writes nothing; a refused write, a fault in the commit and a body over the stored limit
 *     leave it unconsumed; of two writes consuming one, one lands; a keyed consumption replays after
 *     the upload expired, while an independent one is refused; an unkeyed no_change consumes
 *     nothing and a keyed one consumes and records; `source_add` takes one literally, its receipt
 *     naming file, digest and route, and with a `request_id` files one source — on a retry, after
 *     the first was filed on another day, and for two identical calls in flight.
 *
 * Races are staged with the order PostgreSQL grants one advisory lock: the check holds the
 * per-document key `saveDocument` takes, starts the first call, waits until `pg_locks` shows it
 * queued, starts the second, waits for two, and lets go — the first commits, the second finds the
 * state moved. An injected failure is a trigger created for its case and dropped after it. Both,
 * and the membership removal, write only the database the check started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found, then zz-core's last output.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";

import { documentBody } from "@zz/contracts";
import type { Mcp } from "@zz/mcp-client";

import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-edit-races";
// `upload_start` builds its routes on the address a client dials; the child inherits it.
process.env.GATEWAY_PUBLIC_URL ??= "https://api.example.test";

const first = (reply: string): string => reply.split("\n")[0];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A receipt's own lines — the first line, content revision, status, sections and causes. */
const receipt = (reply: string): string[] => reply.split("\n").slice(0, 5);
const CONFLICT = /^ERROR: REQUEST_ID_CONFLICT — this request_id was used for a different request/;

async function tokenOf(c: Core, step: string, path: string): Promise<string> {
  const read = await c.ok(step, "document_read", { path });
  return /^content_revision: (cr_[a-z2-7]{26})$/m.exec(read)?.[1] ?? c.fail(step, `no content_revision in: ${read}`);
}

async function bodyOf(c: Core, step: string, path: string): Promise<string> {
  return documentBody(await c.ok(step, "document_read", { path }));
}

/** Everything a write could leave in one initiative, and every request row: what "wrote nothing"
 *  is compared on. */
async function facts(c: Core, initiative: string): Promise<string> {
  const { rows } = await c.sql.query<{ s: string }>(
    `select json_build_object(
       'docs', (select json_agg(json_build_array(d.path, d.current_revision, d.current_version, d.content_generation,
                                                 d.status, d.approved_revision, d.updated_at) order by d.path)
                  from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1),
       'revisions', (select json_agg(json_build_array(r.doc_id, r.revision, r.written_at, r.approved_at) order by r.doc_id, r.revision)
                       from zz.doc_revision r join zz.doc d on d.id = r.doc_id
                       join zz.initiative i on i.id = d.initiative_id where i.slug = $1),
       'links', (select count(*) from zz.doc_link l join zz.doc d on d.id = l.from_doc_id
                   join zz.initiative i on i.id = d.initiative_id where i.slug = $1),
       'requests', (select count(*) from zz.doc_request))::text as s`, [initiative]);
  return rows[0].s;
}

/** The document's content generation. */
async function generationOf(c: Core, path: string): Promise<number> {
  const [initiative, name] = [path.split("/")[0], path.split("/").slice(1).join("/")];
  const { rows } = await c.sql.query<{ g: string }>(
    `select d.content_generation::text as g from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = $2`, [initiative, name]);
  return Number(rows[0]?.g ?? c.fail(`generation of ${path}`, "no such document"));
}

/**
 * Two calls on one document, granted its lock in the order they are started: the first queues
 * behind the check's hold, the second behind the first, and both are let go together. Each has
 * read the document before it queued.
 */
async function staged(c: Core, step: string, path: string, one: () => Promise<string>,
                      two: () => Promise<string>): Promise<[string, string]> {
  const key = c.docKey(path);
  await c.hold(key);
  let a: Promise<string>;
  let b: Promise<string>;
  try {
    a = one();
    await c.waiters(step, key, 1);
    b = two();
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  return Promise.all([a, b]);
}

async function races(c: Core, second: Mcp): Promise<void> {
  const R = await c.open("races");
  const body = "# Race\n\nalpha\n\nbeta\n";

  let step = "two edits sending one `base`: one lands, the other is BASE_CONFLICT naming the token it left";
  const s = `${R}/same-base.md`;
  await c.ok(step, "document_write", { path: s, content: body });
  const base = await tokenOf(c, step, s);
  let [a, b] = await staged(c, step, s,
    () => c.call(step, "document_edit", { path: s, base, edits: [{ find: "alpha", replace: "ALPHA" }] }),
    () => c.call(step, "document_edit", { path: s, base, edits: [{ find: "beta", replace: "BETA" }] }, second));
  let now = await tokenOf(c, step, s);
  if (first(a) !== `edited: ${s} — v1` || !a.includes(`content revision: ${now}`)) c.fail(step, `first: ${a}`);
  if (!new RegExp(`^ERROR: BASE_CONFLICT — ${esc(s)} is at content revision ${now} now`).test(b)) c.fail(step, `second: ${b}`);
  if ((await bodyOf(c, step, s)) !== "# Race\n\nALPHA\n\nbeta\n") c.fail(step, "the conflicting edit landed");
  c.pass(step);

  step = "two edits sending no `base`: both land, in the order the lock granted them";
  const n = `${R}/no-base.md`;
  await c.ok(step, "document_write", { path: n, content: body });
  const g = await generationOf(c, n);
  [a, b] = await staged(c, step, n,
    () => c.call(step, "document_edit", { path: n, edits: [{ find: "alpha", replace: "ALPHA" }] }),
    () => c.call(step, "document_edit", { path: n, edits: [{ find: "beta", replace: "BETA" }] }, second));
  if (a.startsWith("ERROR") || b.startsWith("ERROR")) c.fail(step, `${a}\n---\n${b}`);
  if ((await bodyOf(c, step, n)) !== "# Race\n\nALPHA\n\nBETA\n") c.fail(step, "an edit was lost");
  const [ta, tb] = [/^content revision: (\S+)$/m.exec(a)?.[1], /^content revision: (\S+)$/m.exec(b)?.[1]];
  // The first commits generation g+1; the second, computed again on top of it, g+2 — the token now.
  if ((await generationOf(c, n)) !== g + 2 || tb !== (await tokenOf(c, step, n)) || ta === tb) {
    c.fail(step, `generation ${await generationOf(c, n)} from ${g}; tokens ${ta}, ${tb}`);
  }
  c.pass(step);

  step = "an approval landing between an edit's read and its commit sends the edit back, and it answers CAUSE_REQUIRED";
  const p = `${R}/approve-first.md`;
  await c.ok(step, "document_write", { path: p, content: body });
  await c.ok(step, "document_present", { path: p });
  [a, b] = await staged(c, step, p,
    () => c.call(step, "document_approve", { path: p }),
    () => c.call(step, "document_edit", { path: p, edits: [{ find: "alpha", replace: "ALPHA" }] }, second));
  if (a.startsWith("ERROR")) c.fail(step, `approve: ${a}`);
  if (!new RegExp(`^ERROR: CAUSE_REQUIRED — ${esc(p)} is approved`).test(b)) c.fail(step, `edit: ${b}`);
  if ((await bodyOf(c, step, p)) !== body || !/^status: approved$/m.test(await c.ok(step, "document_read", { path: p }))) {
    c.fail(step, "the edit landed, or the approval was lost");
  }
  c.pass(step);

  step = "an edit landing between an approval's read and its write stands, and the approval is APPROVAL_CONFLICT naming both snapshots";
  const e = `${R}/edit-first.md`;
  await c.ok(step, "document_write", { path: e, content: body });
  await c.ok(step, "document_present", { path: e });
  const read = await tokenOf(c, step, e);
  [a, b] = await staged(c, step, e,
    () => c.call(step, "document_edit", { path: e, edits: [{ find: "alpha", replace: "ALPHA" }] }),
    () => c.call(step, "document_approve", { path: e }, second));
  if (first(a) !== `edited: ${e} — v1`) c.fail(step, `edit: ${a}`);
  if (!new RegExp(`^ERROR: APPROVAL_CONFLICT — ${esc(e)} is at content revision ${esc(await tokenOf(c, step, e))} now, ` +
                  `not ${read}, the snapshot this approval was for; nothing was approved`).test(b)) {
    c.fail(step, `approve: ${b}`);
  }
  const after = await c.ok(step, "document_read", { path: e });
  if (documentBody(after) !== "# Race\n\nALPHA\n\nbeta\n" || /^status: approved$/m.test(after)) c.fail(step, after);
  c.pass(step);

  step = "an edit landing between a close's read and its write stands, and the initiative is closed exactly when its closing document carries the outcome";
  const C = await c.open("close-meets-edit");
  const cn = `${C}/notes.md`;
  await c.ok(step, "document_write", { path: cn, content: body });
  [a, b] = await staged(c, step, cn,
    () => c.call(step, "document_edit", { path: cn, edits: [{ find: "alpha", replace: "ALPHA" }] }),
    () => c.call(step, "initiative_close", { initiative: C, disposition: "finished", document: "notes.md" }, second));
  if (first(a) !== `edited: ${cn} — v1`) c.fail(step, `edit: ${a}`);
  if (!new RegExp(`^${esc(C)} closed as accepted`).test(b)) c.fail(step, `close: ${b}`);
  const closing = await c.ok(step, "document_read", { path: cn });
  const row = (await c.sql.query<{ closed: boolean; outcome: string | null }>(
    "select closed_at is not null as closed, outcome from zz.initiative where slug = $1", [C])).rows[0];
  const carried = /^outcome: (.*)$/m.exec(closing)?.[1] ?? null;
  if (documentBody(closing) !== "# Race\n\nALPHA\n\nbeta\n" || !row.closed || carried === null || row.outcome !== carried) {
    c.fail(step, `row ${JSON.stringify(row)}, document carries ${carried}: ${closing}`);
  }
  c.pass(step);

  step = "two creates of one path released together: one document, and the other is TARGET_EXISTS";
  const t = `${R}/created-twice.md`;
  [a, b] = await staged(c, step, t,
    () => c.call(step, "document_write", { path: t, content: "# First\n" }),
    () => c.call(step, "document_write", { path: t, content: "# Second\n" }, second));
  if (!first(a).startsWith(`written: ${t}`)) c.fail(step, `first: ${a}`);
  if (b !== `ERROR: TARGET_EXISTS — ${t} exists; change it with document_edit`) c.fail(step, `second: ${b}`);
  const docs = (await c.sql.query<{ n: number }>(
    `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path = 'created-twice.md'`, [R])).rows[0].n;
  if (docs !== 1 || (await bodyOf(c, step, t)) !== "# First\n") c.fail(step, `${docs} documents`);
  c.pass(step);

  step = "an A→B→A change does not revive A's content revision";
  const x = `${R}/aba.md`;
  await c.ok(step, "document_write", { path: x, content: "# A\n" });
  const tA = await tokenOf(c, step, x);
  await c.ok(step, "document_edit", { path: x, content: "# B\n" });
  const tB = await tokenOf(c, step, x);
  await c.ok(step, "document_edit", { path: x, base: tB, content: "# A\n" });
  now = await tokenOf(c, step, x);
  if (now === tA || now === tB || tA === tB) c.fail(step, `tokens ${tA}, ${tB}, ${now}`);
  await c.refused(step, "document_edit", { path: x, base: tA, content: "# C\n" },
    new RegExp(`^ERROR: BASE_CONFLICT — ${esc(x)} is at content revision ${now} now`));
  c.pass(step);
}

async function requests(c: Core, second: Mcp): Promise<string> {
  const Q = await c.open("requests");
  const q = `${Q}/notes.md`;
  await c.ok("write the keyed document", "document_write", { path: q, content: "# Notes\n\none\n\ntwo\n\nthree\n" });

  let step = "a keyed edit sent again answers its first receipt, marked (replayed), and writes nothing";
  const keyed = { path: q, edits: [{ find: "one", replace: "ONE" }], request_id: "replay-1" };
  const firstReply = await c.ok(step, "document_edit", keyed);
  let before = await facts(c, Q);
  let again = await c.ok(step, "document_edit", keyed);
  const want = receipt(firstReply);
  want[0] += " (replayed)";
  if (receipt(again).join("\n") !== want.join("\n")) c.fail(step, `first:\n${firstReply}\nagain:\n${again}`);
  if ((await facts(c, Q)) !== before) c.fail(step, "the replay wrote");
  c.pass(step);

  step = "two identical keyed edits released together commit once";
  const twin = { path: q, edits: [{ find: "two", replace: "TWO" }], request_id: "twin-1" };
  const g = await generationOf(c, q);
  const [a, b] = await staged(c, step, q, () => c.call(step, "document_edit", twin),
                              () => c.call(step, "document_edit", twin, second));
  if (first(a) !== `edited: ${q} — v1` || first(b) !== `edited: ${q} — v1 (replayed)`) c.fail(step, `${a}\n---\n${b}`);
  if (receipt(b).slice(1).join("\n") !== receipt(a).slice(1).join("\n")) c.fail(step, `receipts differ:\n${a}\n---\n${b}`);
  const rows = (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.doc_request where request_id = 'twin-1'")).rows[0].n;
  if ((await generationOf(c, q)) !== g + 1 || rows !== 1) c.fail(step, `generation ${await generationOf(c, q)} from ${g}, ${rows} request rows`);
  c.pass(step);

  step = "a keyed edit replayed after a later edit answers its first receipt, not BASE_CONFLICT";
  const based = { path: q, base: await tokenOf(c, step, q), edits: [{ find: "three", replace: "THREE" }], request_id: "based-1" };
  const landed = await c.ok(step, "document_edit", based);
  await c.ok(step, "document_edit", { path: q, edits: [{ find: "# Notes", replace: "# Notes, later" }] });
  again = await c.ok(step, "document_edit", based);
  if (first(again) !== `${first(landed)} (replayed)` || receipt(again)[1] !== receipt(landed)[1]) c.fail(step, `first:\n${landed}\nagain:\n${again}`);
  c.pass(step);

  step = "a keyed no_change is recorded and replays";
  const current = await bodyOf(c, step, q);
  const same = { path: q, content: current, request_id: "same-1" };
  const gNow = await generationOf(c, q);
  const noChange = await c.ok(step, "document_edit", same);
  if (first(noChange) !== `edited: ${q} — v1 (no change)`) c.fail(step, noChange);
  again = await c.ok(step, "document_edit", same);
  const recorded = (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.doc_request where request_id = 'same-1'")).rows[0].n;
  if (first(again) !== `edited: ${q} — v1 (no change) (replayed)` || recorded !== 1 || (await generationOf(c, q)) !== gNow) {
    c.fail(step, `${again}; ${recorded} request rows`);
  }
  c.pass(step);

  step = "a keyed create replays before TARGET_EXISTS, after a later edit of what it created too";
  const k = `${Q}/created.md`;
  const create = { path: k, content: "# Created\n", request_id: "create-1" };
  const created = await c.ok(step, "document_write", create);
  await c.ok(step, "document_edit", { path: k, content: "# Created, then changed\n" });
  before = await facts(c, Q);
  again = await c.ok(step, "document_write", create);
  if (first(again) !== `${first(created)} (replayed)` || receipt(again)[1] !== receipt(created)[1]) c.fail(step, `first:\n${created}\nagain:\n${again}`);
  if ((await facts(c, Q)) !== before) c.fail(step, "the replay wrote");
  await c.refused(step, "document_write", { path: k, content: "# Created\n" }, /^ERROR: TARGET_EXISTS — /);
  c.pass(step);

  step = "a changed request under a used key is REQUEST_ID_CONFLICT, and writes nothing";
  before = await facts(c, Q);
  await c.refused(step, "document_edit", { ...keyed, edits: [{ find: "ONE", replace: "uno" }] }, CONFLICT);
  await c.refused(step, "document_edit", { ...keyed, note: "the same change, with a note" }, CONFLICT);
  if ((await facts(c, Q)) !== before) c.fail(step, "the conflict wrote");
  c.pass(step);

  step = "the same arguments sent to the other tool under the same key are REQUEST_ID_CONFLICT";
  await c.refused(step, "document_edit", create, CONFLICT);
  await c.refused(step, "document_write", same, CONFLICT);
  if ((await facts(c, Q)) !== before) c.fail(step, "the conflict wrote");
  c.pass(step);

  step = "an unkeyed identical resend answers no_change";
  const plain = { path: q, content: "# Plain\n\nresent\n" };
  await c.ok(step, "document_edit", plain);
  before = await facts(c, Q);
  again = await c.ok(step, "document_edit", plain);
  if (first(again) !== `edited: ${q} — v1 (no change)` || (await facts(c, Q)) !== before) c.fail(step, again);
  c.pass(step);

  // Carried into Phase 2's wave 3: the stored receipt was built before the write reserved the
  // captured source's name, so a replay named the name asked for, not the one filed.
  step = "a keyed change whose captured source took a suffixed name replays the name it was filed under";
  const taken = await c.source(step, { initiative: Q, title: "Taken words", content: "already here" });
  const filed = taken.replace(/\.md$/, "-2.md");
  const capturing = { path: q, edits: [{ find: "# Plain", replace: "# Plain, captured" }], source_content: "the words",
                      source_title: "Taken words", request_id: "captured-1" };
  const capturedReply = await c.ok(step, "document_edit", capturing);
  again = await c.ok(step, "document_edit", capturing);
  for (const reply of [capturedReply, again]) {
    if (!new RegExp(`^causes \\(1\\): ${esc(filed)} \\(agent\\)$`, "m").test(reply)
        || !reply.includes(`source name: ${taken} was taken, so the words were filed as ${filed}`)) c.fail(step, reply);
  }
  if (first(again) !== `${first(capturedReply)} (replayed)`) c.fail(step, again);
  c.pass(step);

  step = "a replay prints the next move as of the first call, then the one there is now";
  const F = await c.open("requests-flow", "sdlc-flow");
  const e = `${F}/explore.md`;
  const body = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";
  await c.ok(step, "document_write", { path: e, content: body });
  const keyedFlow = { path: e, edits: [{ find: "## Background\nx", replace: "## Background\ny" }], request_id: "flow-1" };
  const flowReply = await c.ok(step, "document_edit", keyedFlow);
  const then = /\n\nNext move: (.+)$/.exec(flowReply)?.[1] ?? c.fail(step, `the first call states no next move: ${flowReply}`);
  await c.ok(step, "document_write", { path: `${F}/spec.md`, content: "# Spec\n" });
  again = await c.ok(step, "document_edit", keyedFlow);
  const moves = /\n\nNext move \(as of the first call\): (.+)\nNext move \(now\): (.+)$/.exec(again);
  if (!moves || moves[1] !== then || moves[2] === then) c.fail(step, `first:\n${flowReply}\nagain:\n${again}`);
  c.pass(step);

  return firstReply;
}

/** The five statements a change commits after its document's lock, each failed in turn. The event
 *  trigger is scoped to `document.*` rows: the gateway's `tool_call` row for the call is not the
 *  change's. */
const INJECTED: { at: string; table: string; when: (docId: string) => string }[] = [
  { at: "the captured source", table: "zz.doc", when: () => "before insert on zz.doc for each row when (new.path like 'sources/%')" },
  { at: "the document row", table: "zz.doc", when: (id) => `before update on zz.doc for each row when (old.id = '${id}'::uuid)` },
  { at: "the cause links", table: "zz.doc_link", when: () => "before insert on zz.doc_link for each row when (new.kind = 'cites')" },
  { at: "the request row", table: "zz.doc_request", when: () => "before insert on zz.doc_request for each row" },
  { at: "the event row", table: "zz.event", when: () => "before insert on zz.event for each row when (new.kind like 'document.%')" },
];

async function injected(c: Core): Promise<void> {
  const J = await c.open("inject");
  const j = `${J}/notes.md`;
  await c.ok("write the approved document", "document_write", { path: j, content: "# Notes\n\nalpha\n" });
  await c.sign(j);
  const id = (await c.sql.query<{ id: string }>(
    `select d.id::text as id from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path = 'notes.md'`,
    [J])).rows[0].id;
  // A caused change to an approved body: a captured source, a new row, its cause link and its request.
  const change = { path: j, edits: [{ find: "alpha", replace: "ALPHA" }], source_content: "the words behind it",
                   request_id: "inject-1" };
  await c.sql.query(`create function zz.inject_failure() returns trigger language plpgsql as $$
                       begin raise exception 'injected at %', tg_argv[0]; end $$`);
  try {
    for (const f of INJECTED) {
      const step = `a failure injected at ${f.at} leaves nothing committed`;
      const before = await facts(c, J);
      await c.sql.query(`create trigger inject_failure ${f.when(id)} execute function zz.inject_failure('${f.at}')`);
      try {
        await c.refused(step, "document_edit", change,
          new RegExp(`^ERROR: ${esc(j)} could not be written: injected at ${esc(f.at)}`));
      } finally {
        await c.sql.query(`drop trigger inject_failure on ${f.table}`);
      }
      if ((await facts(c, J)) !== before) c.fail(step, `committed:\n${before}\n${await facts(c, J)}`);
      if ((await bodyOf(c, step, j)) !== "# Notes\n\nalpha\n") c.fail(step, "the body moved");
      // No edit of this initiative has committed yet, so any act row of one is the failed change's.
      const acts = (await c.sql.query<{ n: number }>(
        `select count(*)::int as n from zz.event e join zz.initiative i on i.id = e.initiative_id
          where i.slug = $1 and e.kind in ('document.edit', 'document.source')`, [J])).rows[0].n;
      if (acts) c.fail(step, `${acts} event rows of the failed change committed`);
      c.pass(step);
    }
  } finally {
    await c.sql.query("drop function zz.inject_failure()");
  }
  const step = "the same keyed change lands once the failure is gone";
  const landed = await c.ok(step, "document_edit", change);
  if (first(landed) !== `edited: ${j} — v2 (new version)` || (await bodyOf(c, step, j)) !== "# Notes\n\nALPHA\n") c.fail(step, landed);
  c.pass(step);
}

/** What `upload_start` answers. */
interface Started { upload: string; shell: string; link: string }

async function startUpload(c: Core, step: string, filename: string, via?: Mcp): Promise<Started> {
  const reply = await c.ok(step, "upload_start", { filename }, via);
  try { return JSON.parse(reply) as Started; } catch { return c.fail(step, `upload_start did not answer JSON: ${reply}`); }
}

/** Bytes bound to an upload as the gateway's staging route binds them: once, with who staged them
 *  (the owner for a token staging, nobody for a link). Answers their sha256. */
async function stageBytes(c: Core, id: string, bytes: Buffer | string, via: "token" | "link" = "token"): Promise<string> {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  const sha = createHash("sha256").update(buf).digest("hex");
  await c.sql.query(`update zz.upload set byte_count = $2, sha256 = $3, body = $4, staged_via = $5::text,
                            staged_by = case when $5::text = 'token' then principal_id end
                      where id = $1`, [id, buf.length, sha, buf, via]);
  return sha;
}

/** Started through the door and staged: the id and the digest. */
async function upload(c: Core, step: string, filename: string, bytes: Buffer | string,
                      via: "token" | "link" = "token"): Promise<{ id: string; sha: string }> {
  const { upload: id } = await startUpload(c, step, filename);
  return { id, sha: await stageBytes(c, id, bytes, via) };
}

/** An upload's consumption, as the write that consumed it left it. */
async function usedOf(c: Core, id: string): Promise<{ consumed: boolean; body: boolean; operation: string | null; digest: string | null }> {
  return (await c.sql.query(
    `select consumed_at is not null as consumed, body is not null as body, consumed_by_operation as operation,
            consumed_digest as digest from zz.upload where id = $1`, [id])).rows[0];
}

async function unconsumed(c: Core, step: string, id: string): Promise<void> {
  const u = await usedOf(c, id);
  if (u.consumed || !u.body) c.fail(step, `${id} was consumed: ${JSON.stringify(u)}`);
}

/** The window an upload is staged in, moved into the past. */
const expire = (c: Core, id: string) => c.sql.query(
  "update zz.upload set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id = $1", [id]);

async function uploads(c: Core, second: Mcp): Promise<void> {
  const U = await c.open("uploads");
  const url = process.env.GATEWAY_PUBLIC_URL ?? "";
  let said: string;

  let step = "upload_start answers its id, a `curl --fail-with-body` PUT to /upload/<id> with the person's token, and a /u/<secret> link";
  const started = await startUpload(c, step, "it's notes.md");
  if (!/^up_[a-z2-7]{26}$/.test(started.upload)) c.fail(step, JSON.stringify(started));
  if (!started.shell.startsWith("curl --fail-with-body -T 'it'\\''s notes.md' -H \"Authorization: Bearer $")
      || !started.shell.endsWith(` ${url}/upload/${started.upload}`)) c.fail(step, started.shell);
  const secret = new RegExp(`^${esc(url)}/u/(us_[a-z2-7]{52})$`).exec(started.link)?.[1] ?? c.fail(step, started.link);
  const row = (await c.sql.query(
    `select u.filename, u.link_secret_hash, extract(epoch from u.expires_at - u.created_at)::int as window, p.email,
            t.slug, u.sha256 from zz.upload u join zz.principal p on p.id = u.principal_id join zz.team t on t.id = u.team_id
      where u.id = $1`, [started.upload])).rows[0];
  if (row?.filename !== "it's notes.md" || row.link_secret_hash !== createHash("sha256").update(secret).digest("hex")
      || row.window !== 900 || row.email !== c.email || row.slug !== c.team || row.sha256 !== null) c.fail(step, JSON.stringify(row));
  await c.refused(step, "upload_start", { filename: "dir/notes.md" }, /^ERROR: "dir\/notes\.md" is not a filename/);
  await c.refused(step, "upload_start", { filename: "minutes.pdf" }, /^ERROR: UNSUPPORTED_FORMAT — /);
  c.pass(step);

  step = "a staged .md upload becomes a document by the rules typed content follows, consumed in its commit, the receipt naming the file";
  const md = await upload(c, step, "notes.md", "---\ntitle: From a file\n---\n# Uploaded\n\nbody line\n");
  const d = `${U}/from-file.md`;
  said = await c.ok(step, "document_write", { path: d, upload: md.id });
  if ((await bodyOf(c, step, d)) !== "# Uploaded\n\nbody line\n") c.fail(step, await bodyOf(c, step, d));
  for (const want of [`upload: ${md.id} — "notes.md", 49 bytes, sha256 ${md.sha}, staged via token by ${c.email}`, "took title"]) {
    if (!said.includes(want)) c.fail(step, `no "${want}" in: ${said}`);
  }
  let used = await usedOf(c, md.id);
  if (!used.consumed || used.body || used.operation !== `document_write ${d}` || !/^[0-9a-f]{64}$/.test(used.digest ?? "")) {
    c.fail(step, JSON.stringify(used));
  }
  c.pass(step);

  step = "a .csv and a .yaml opening with `---` that is no envelope are stored byte for byte, a BOM removed and said; the CSV takes an edit";
  const csvText = "name,score\r\nada,3\r\n\r\n";
  const csv = await upload(c, step, "scores.csv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvText)]));
  const t = `${U}/scores.md`;
  said = await c.ok(step, "document_write", { path: t, upload: csv.id });
  if ((await bodyOf(c, step, t)) !== csvText || !said.includes('removed the byte-order mark "scores.csv" opened with')) c.fail(step, said);
  const yamlText = "---\n- one\n- two\n";
  const yaml = await upload(c, step, "list.yaml", yamlText);
  await c.ok(step, "document_write", { path: `${U}/list.md`, upload: yaml.id });
  if ((await bodyOf(c, step, `${U}/list.md`)) !== yamlText) c.fail(step, await bodyOf(c, step, `${U}/list.md`));
  await c.ok(step, "document_edit", { path: t, edits: [{ find: "ada,3", replace: "ada,4" }] });
  if ((await bodyOf(c, step, t)) !== csvText.replace("ada,3", "ada,4")) c.fail(step, await bodyOf(c, step, t));
  c.pass(step);

  step = "an envelope-shaped non-Markdown upload is refused into a document by name, with its way out, and taken as a source";
  const shaped = await upload(c, step, "config.yaml", "---\nkey: value\n---\nrest: here\n");
  await c.refused(step, "document_write", { path: `${U}/config.md`, upload: shaped.id },
    /^ERROR: UNSUPPORTED_METADATA — "config\.yaml" opens with .*source_add.*another line/s);
  await unconsumed(c, step, shaped.id);
  const shapedSource = await c.ok(step, "document_read", { path: await c.source(step, { initiative: U, title: "Config", upload: shaped.id }) });
  if (!documentBody(shapedSource).startsWith("---\nkey: value\n---\nrest: here\n")) c.fail(step, shapedSource);
  c.pass(step);

  step = "document_edit takes a staged upload as the whole body, beside metadata";
  const next = await upload(c, step, "notes.md", "# Replaced\n\nfrom a file\n");
  said = await c.ok(step, "document_edit", { path: d, upload: next.id, title: "Replaced by upload" });
  if (first(said) !== `edited: ${d} — v1` || (await bodyOf(c, step, d)) !== "# Replaced\n\nfrom a file\n"
      || !(await usedOf(c, next.id)).consumed) c.fail(step, said);
  c.pass(step);

  step = "an upload used, another principal's, another team's, expired or unstaged is refused and writes nothing";
  let before = await facts(c, U);
  await c.refused(step, "document_write", { path: `${U}/again.md`, upload: md.id }, /^ERROR: UPLOAD_USED — /);
  const theirs = await startUpload(c, step, "theirs.md", c.client({ email: await c.member() }));
  await stageBytes(c, theirs.upload, "# Theirs\n");
  await c.refused(step, "document_write", { path: `${U}/theirs.md`, upload: theirs.upload }, /^ERROR: FORBIDDEN — /);
  const otherTeam = await upload(c, step, "other.md", "# Other\n");
  await c.sql.query(`with t as (insert into zz.team (slug, name, created_by)
                                select 'other-team', 'Other', id from zz.principal where email = $1 returning id)
                     update zz.upload set team_id = (select id from t) where id = $2`, [c.email, otherTeam.id]);
  await c.refused(step, "document_write", { path: `${U}/other.md`, upload: otherTeam.id }, /^ERROR: FORBIDDEN — /);
  const late = await upload(c, step, "late.md", "# Late\n");
  await expire(c, late.id);
  await c.refused(step, "document_write", { path: `${U}/late.md`, upload: late.id }, /^ERROR: UPLOAD_EXPIRED — /);
  const unstaged = await startUpload(c, step, "unstaged.md");
  await c.refused(step, "source_add", { initiative: U, title: "Unstaged", upload: unstaged.upload }, /^ERROR: UPLOAD_MISSING — /);
  await c.refused(step, "source_add", { initiative: U, title: "Both", upload: unstaged.upload, content: "x" }, /^ERROR: INVALID_MODE — /);
  if ((await facts(c, U)) !== before) c.fail(step, "a refused upload wrote");
  for (const id of [theirs.upload, otherTeam.id]) await unconsumed(c, step, id);
  c.pass(step);

  step = "a refused write, a fault in the write's commit, and a body over the stored limit each leave the upload unconsumed";
  const kept = await upload(c, step, "kept.md", "# Kept\n");
  await c.refused(step, "document_write", { path: d, upload: kept.id }, /^ERROR: TARGET_EXISTS — /);
  await unconsumed(c, step, kept.id);
  const k = `${U}/kept.md`;
  await c.sql.query(`create function zz.upload_fault() returns trigger language plpgsql as $$
                       begin raise exception 'injected at %', tg_argv[0]; end $$`);
  try {
    for (const [at, when] of [["the consumption", "before update on zz.upload for each row"],
                              ["the event row", "before insert on zz.event for each row when (new.kind like 'document.%')"]]) {
      await c.sql.query(`create trigger upload_fault ${when} execute function zz.upload_fault('${at}')`);
      try {
        await c.refused(`${step}: ${at}`, "document_write", { path: k, upload: kept.id },
          new RegExp(`^ERROR: ${esc(k)} could not be written: injected at ${at}`));
      } finally {
        await c.sql.query(`drop trigger upload_fault on ${when.split(" ")[3]}`);
      }
      await unconsumed(c, `${step}: ${at}`, kept.id);
    }
  } finally {
    await c.sql.query("drop function zz.upload_fault()");
  }
  await c.ok(step, "document_write", { path: k, upload: kept.id });
  const big = await upload(c, step, "big.txt", Buffer.alloc(8 * 1024 * 1024, 0x61));
  await c.refused(step, "document_write", { path: `${U}/big.md`, upload: big.id }, /^ERROR: SIZE_LIMIT — /);
  await unconsumed(c, step, big.id);
  c.pass(step);

  step = "two writes consuming one upload, released together: one lands, the other is UPLOAD_USED";
  const once = await upload(c, step, "once.md", "# Once\n");
  const [pa, pb] = [`${U}/once-a.md`, `${U}/once-b.md`];
  for (const p of [pa, pb]) await c.hold(c.docKey(p));
  let calls: Promise<string>[];
  try {
    calls = [c.call(step, "document_write", { path: pa, upload: once.id }),
             c.call(step, "document_write", { path: pb, upload: once.id }, second)];
    for (const p of [pa, pb]) await c.waiters(step, c.docKey(p), 1);
  } finally {
    for (const p of [pa, pb]) await c.release(c.docKey(p));
  }
  const replies = await Promise.all(calls);
  if (replies.filter((r) => !r.startsWith("ERROR")).length !== 1
      || replies.filter((r) => /^ERROR: UPLOAD_USED — /.test(r)).length !== 1) c.fail(step, replies.join("\n---\n"));
  c.pass(step);

  step = "a keyed consumption replays its first receipt after the upload expired, while an independent one is refused";
  const keyedUp = await upload(c, step, "keyed.md", "# Keyed\n");
  const keyed = { path: `${U}/keyed.md`, upload: keyedUp.id, request_id: "upload-1" };
  const landed = await c.ok(step, "document_write", keyed);
  await expire(c, keyedUp.id);
  said = await c.ok(step, "document_write", keyed);
  if (first(said) !== `${first(landed)} (replayed)`) c.fail(step, `first:\n${landed}\nagain:\n${said}`);
  await c.refused(step, "document_write", { ...keyed, path: `${U}/keyed-2.md`, request_id: "upload-2" }, /^ERROR: UPLOAD_EXPIRED — /);
  await c.refused(step, "document_write", { ...keyed, upload: (await upload(c, step, "keyed.md", "# Keyed\n")).id }, CONFLICT);
  c.pass(step);

  step = "an upload that changes nothing consumes nothing unkeyed, and is consumed and recorded keyed";
  const same = await upload(c, step, "same.md", await bodyOf(c, step, d));
  said = await c.ok(step, "document_edit", { path: d, upload: same.id });
  if (first(said) !== `edited: ${d} — v1 (no change)`) c.fail(step, said);
  await unconsumed(c, step, same.id);
  said = await c.ok(step, "document_edit", { path: d, upload: same.id, request_id: "same-upload-1" });
  used = await usedOf(c, same.id);
  const recorded = (await c.sql.query<{ n: number }>(
    "select count(*)::int as n from zz.doc_request where request_id = 'same-upload-1'")).rows[0].n;
  if (first(said) !== `edited: ${d} — v1 (no change)` || !used.consumed || recorded !== 1) c.fail(step, `${said}; ${recorded} request rows`);
  c.pass(step);

  step = "source_add takes a staged upload literally, its receipt naming the file, its digest and the route that staged it";
  const minutes = await upload(c, step, "minutes.txt", "  Minutes\n\n- agreed\n", "link");
  said = await c.ok(step, "source_add", { initiative: U, title: "Minutes", upload: minutes.id });
  const minutesAt = /^source recorded: (\S+)$/m.exec(said)?.[1] ?? c.fail(step, said);
  if (!said.includes(`upload: ${minutes.id} — "minutes.txt", 20 bytes, sha256 ${minutes.sha}, staged via link`)
      || (await usedOf(c, minutes.id)).operation !== `source_add ${minutesAt}`) c.fail(step, said);
  const minutesRead = await c.ok(step, "document_read", { path: minutesAt });
  if (!documentBody(minutesRead).startsWith("  Minutes\n\n- agreed\n")) c.fail(step, minutesRead);
  c.pass(step);
}

/** How many sources of `initiative` a title slugs to, whatever day they were filed on. */
async function sourcesNamed(c: Core, initiative: string, slug: string): Promise<number> {
  return (await c.sql.query<{ n: number }>(
    `select count(*)::int as n from zz.doc d join zz.initiative i on i.id = d.initiative_id
      where i.slug = $1 and d.path ~ ('^sources/\\d{4}-\\d{2}-\\d{2}-' || $2 || '(-\\d+)?\\.md$')`, [initiative, slug])).rows[0].n;
}

async function sourceRequests(c: Core, second: Mcp): Promise<void> {
  const S = await c.open("source-requests");
  let step = "source_add with a request_id files one source: a retry replays it, after it was filed on another day too";
  const keyed = { initiative: S, title: "Keyed source", content: "said once", request_id: "source-1" };
  const filed = await c.source(step, keyed);
  let again = await c.ok(step, "source_add", keyed);
  if (first(again) !== `source recorded: ${filed} (replayed)`) c.fail(step, again);
  await c.sql.query(
    `update zz.doc d set path = regexp_replace(d.path, '^sources/\\d{4}-\\d{2}-\\d{2}-', 'sources/2026-01-01-')
       from zz.initiative i where i.id = d.initiative_id and i.slug = $1 and d.path = $2`, [S, filed.slice(S.length + 1)]);
  again = await c.ok(step, "source_add", keyed);
  if (first(again) !== `source recorded: ${filed} (replayed)` || (await sourcesNamed(c, S, "keyed-source")) !== 1) c.fail(step, again);
  await c.refused(step, "source_add", { ...keyed, content: "said differently" }, CONFLICT);
  c.pass(step);

  // COUPLED: the request's own lock, as saveDocument takes it for a source — `req:<team>/<principal
  // id>/<initiative>/sources/<request_id>` — held here so both calls are seen queued on it.
  step = "two identical keyed source_add calls in flight file one source";
  const twin = { initiative: S, title: "Twin source", content: "once", request_id: "source-2" };
  const principal = (await c.sql.query<{ id: string }>("select id::text as id from zz.principal where email = $1", [c.email])).rows[0].id;
  const key = `req:${c.team}/${principal}/${S}/sources/source-2`;
  await c.hold(key);
  let a: Promise<string>;
  let b: Promise<string>;
  try {
    a = c.call(step, "source_add", twin);
    await c.waiters(step, key, 1);
    b = c.call(step, "source_add", twin, second);
    await c.waiters(step, key, 2);
  } finally {
    await c.release(key);
  }
  const replies = (await Promise.all([a, b])).map(first).sort();
  if (!/^source recorded: \S+$/.test(replies[0]) || replies[1] !== `${replies[0]} (replayed)`
      || (await sourcesNamed(c, S, "twin-source")) !== 1) c.fail(step, replies.join("\n"));
  c.pass(step);
}

async function afterRestart(c: Core, firstReply: string): Promise<void> {
  const keyed = { path: firstReply.split("\n")[0].replace(/^edited: (\S+) — .*$/, "$1"),
                  edits: [{ find: "one", replace: "ONE" }], request_id: "replay-1" };
  let step = "a keyed edit replays after zz-core is restarted";
  // Restarted without the address a client dials, so the upload's refusal is asked of it too.
  const address = process.env.GATEWAY_PUBLIC_URL;
  delete process.env.GATEWAY_PUBLIC_URL;
  await c.restart();
  process.env.GATEWAY_PUBLIC_URL = address;
  const again = await c.ok(step, "document_edit", keyed);
  if (first(again) !== `${first(firstReply)} (replayed)` || receipt(again)[1] !== receipt(firstReply)[1]) {
    c.fail(step, `first:\n${firstReply}\nagain:\n${again}`);
  }
  c.pass(step);

  step = "upload_start refuses on a deployment with no GATEWAY_PUBLIC_URL, naming the key";
  await c.refused(step, "upload_start", { filename: "notes.md" }, /^ERROR: .*GATEWAY_PUBLIC_URL/);
  c.pass(step);

  // Last: the seeded principal is in no team afterwards. The restart empties the
  // short cache zz-core keeps of who is in which team, so the removal is what it reads.
  step = "a caller whose membership was removed is refused, not replayed";
  await c.sql.query("delete from zz.membership where principal_id = (select id from zz.principal where email = $1)", [c.email]);
  await c.restart();
  await c.refused(step, "document_edit", keyed, /^ERROR: you are not in a team/);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: concurrent changes never overwrite each other, keyed requests replay once, a failed commit leaves nothing, and an upload is consumed once, in its write: ok`,
  async (c) => {
    const second = c.client();
    await races(c, second);
    const replayed = await requests(c, second);
    await injected(c);
    await uploads(c, second);
    await sourceRequests(c, second);
    await afterRestart(c, replayed);
  });
