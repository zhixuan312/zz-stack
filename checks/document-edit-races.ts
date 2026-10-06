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
 *     nothing committed, and the same keyed change lands once the failure is gone.
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
import { documentBody } from "@zz/contracts";
import type { Mcp } from "@zz/mcp-client";

import { type Core, withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "document-edit-races";

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

async function afterRestart(c: Core, firstReply: string): Promise<void> {
  const keyed = { path: firstReply.split("\n")[0].replace(/^edited: (\S+) — .*$/, "$1"),
                  edits: [{ find: "one", replace: "ONE" }], request_id: "replay-1" };
  let step = "a keyed edit replays after zz-core is restarted";
  await c.restart();
  const again = await c.ok(step, "document_edit", keyed);
  if (first(again) !== `${first(firstReply)} (replayed)` || receipt(again)[1] !== receipt(firstReply)[1]) {
    c.fail(step, `first:\n${firstReply}\nagain:\n${again}`);
  }
  c.pass(step);

  // Last: the one principal this database holds is in no team afterwards. The restart empties the
  // short cache zz-core keeps of who is in which team, so the removal is what it reads.
  step = "a caller whose membership was removed is refused, not replayed";
  await c.sql.query("delete from zz.membership where principal_id = (select id from zz.principal where email = $1)", [c.email]);
  await c.restart();
  await c.refused(step, "document_edit", keyed, /^ERROR: you are not in a team/);
  c.pass(step);
}

process.exitCode = await withThrowawayCore(NAME,
  `${NAME}: concurrent changes never overwrite each other, keyed requests replay once, and a failed commit leaves nothing: ok`,
  async (c) => {
    const second = c.client();
    await races(c, second);
    const replayed = await requests(c, second);
    await injected(c);
    await afterRestart(c, replayed);
  });
