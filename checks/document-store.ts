#!/usr/bin/env node
/**
 * checks/document-store.ts — the document write path and version reads, on a real database.
 *
 *   node checks/document-store.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL (`withThrowawayDb`), seeds one principal in one team with one
 * freeform initiative, and drives the built `saveDocument` (`services/zz-core/dist/document-save.js`)
 * and `loadDocument` (`dist/versions.js`) against it with `TEAM_DB_URL` pointed at the container.
 * What it establishes:
 *
 *   - the pin rule's three branches: a presented row, a row a `document.shown` event covers and an
 *     approved row each get a new row in the same public version, carrying the row's causes, and
 *     an unpinned row is rewritten in place;
 *   - the content generation moves on a change of body or editable metadata and not on an approval,
 *     and every row stores the generation it was last written at;
 *   - presented snapshots are immutable for every writer: a write without `change` that changes a
 *     pinned row's content files a new row in the same version, an approval stays in place;
 *   - snapshot reads by `content_revision`: a past snapshot carries its own token and is read by it,
 *     a current row written before generations were recorded takes the document's (nothing is
 *     written to it), and a rewritten working state or a foreign token is SNAPSHOT_UNAVAILABLE;
 *   - the state compare: a generation change, an approval and a close each send a change back
 *     (`retry`, or `BASE_CONFLICT` when the caller's base is stale), and nothing is written;
 *   - a second writer waits on the per-document lock, a create included;
 *   - a refusal rolls back a captured source with everything else;
 *   - request records replay, conflict on a different digest, and record a keyed no-change;
 *   - a cause linked by the platform is upgraded when the writer names it;
 *   - version reads: a public version's last retained state, an approved snapshot a later one
 *     superseded read by its content revision, and the refusal for a version that does not exist
 *     lists the versions that do;
 *   - the activity record: a change's `document.*` event row, carrying its details, commits with the
 *     change (and its captured source's row with it), is the change's only act row, and is absent
 *     after a refusal or a failed insert of it; and every act `saveDocument` can record names a
 *     kind `zz.event`'s own CHECK accepts (pure: read from the source and the schema target);
 *   - set-based causes: 200 causes are one insert, and a change citing 200 runs as many statements
 *     as one citing one — counted by wrapping `pg.Client.prototype.query`, as
 *     `checks/document-body-whole.ts` counts through its stub;
 *   - name reservation: two concurrent reserving creates of one taken stem file `-2` and `-3`.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { contentRevision, OUTCOMES } from "@zz/contracts";
import pg from "pg";

import { SCHEMA_TARGET } from "../schema-target.ts";
import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const EMAIL = "store@example.test";
const TEAM = "store-team";
const INIT = "2026-10-06-store";
const DOC = `${INIT}/notes.md`;
const SRC = `${INIT}/sources/s1.md`;

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`document-store: FAILED at "${step}": ${detail}`);
}
const ok = (step: string): void => console.log(`  ${step}: ok`);

/** Until `n` callers wait, ungranted, on the per-document lock `key` (polled in `pg_locks`, as
 *  `scripts/schema/throwaway-core.ts`'s `waiters` does) — refused when `done()` reports a writer
 *  finished first, which means it never queued, or after 20 seconds. */
async function queued(db: pg.Client, step: string, key: string, n: number, done: () => boolean): Promise<void> {
  const until = Date.now() + 20_000;
  for (;;) {
    const seen = (await db.query<{ n: number }>(
      `select count(*)::int as n from pg_catalog.pg_locks
        where locktype = 'advisory' and not granted
          and ((classid::bigint << 32) | objid::bigint) = pg_catalog.hashtext($1)::bigint`, [key])).rows[0].n;
    if (seen === n) return;
    if (done()) fail(step, `a write finished without waiting on ${key}, which another transaction holds`);
    if (Date.now() > until) fail(step, `expected ${n} write(s) waiting on ${key}, saw ${seen}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The text a write sends: a title envelope and a body. */
const doc = (body: string, extra = ""): string => `---\ntitle: Notes\n${extra}---\n\n${body}`;

type State = { generation: number; revision: number; writtenAt: string };
type Saved = { id: string; revision: number; version: number; generation: number; newVersion: boolean; newRow: boolean;
               reserved?: string };
type Save = (w: Record<string, unknown>) => Promise<Saved | { refusal: string } | { retry: true } | { replayed: Record<string, unknown> }>;

async function seed(db: pg.Client): Promise<string> {
  const p = await db.query<{ id: string }>(
    "INSERT INTO zz.principal (email, display_name, role) VALUES ($1, 'Store', 'member') RETURNING id", [EMAIL]);
  const principal = p.rows[0].id;
  const t = await db.query<{ id: string }>(
    "INSERT INTO zz.team (slug, name, created_by) VALUES ($1, 'Store team', $2) RETURNING id", [TEAM, principal]);
  await db.query(
    "INSERT INTO zz.membership (team_id, principal_id, role, added_by) VALUES ($1, $2, 'admin', $2)", [t.rows[0].id, principal]);
  await db.query("UPDATE zz.principal SET active_team_id = $1 WHERE id = $2", [t.rows[0].id, principal]);
  const i = await db.query<{ id: string }>(
    "INSERT INTO zz.initiative (team_id, slug, flow, opened_by) VALUES ($1, $2, null, $3) RETURNING id",
    [t.rows[0].id, INIT, principal]);
  return i.rows[0].id;
}

/** Every act `saveDocument` can record, as the `zz.event.kind` it becomes, held to the table's own
 *  CHECK — read from the target, not restated. An act recorded in the transaction fails the write
 *  when its kind is refused, so an act name the table refuses is a write that can never land. The
 *  acts are `saveDocument`'s defaults and every `act:` a caller under zz-core passes; a template
 *  this does not know how to expand fails the case rather than going unchecked. */
function actKinds(): void {
  const check = ((SCHEMA_TARGET.tables.event as { checks: string[] }).checks).find((c) => /\bkind ~ '/.test(c)) ?? "";
  const pattern = /kind ~ '([^']+)'::text/.exec(check)?.[1];
  if (!pattern) fail("act kinds", "zz.event's kind CHECK is not in the schema target");
  const KIND = new RegExp(pattern);
  const acts = new Set(["write", "revise", "source"]);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
  for (const file of walk(join(root, "services/zz-core/src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bact: "([^"]*)"/g)) acts.add(m[1]);
    for (const m of src.matchAll(/\bact: `([^`]*)`/g)) {
      if (m[1] !== "close_${record.outcome}") fail("act kinds", `${file} records an act this case cannot expand: ${m[1]}`);
      for (const o of OUTCOMES) acts.add(`close_${o}`);
    }
  }
  const refused = [...acts].filter((a) => !KIND.test(`document.${a}`));
  if (acts.size < 6 || refused.length) fail("act kinds", `of ${[...acts].join(", ")}, zz.event refuses ${refused.join(", ")}`);
  ok(`act kinds: all ${acts.size} acts saveDocument can record are kinds zz.event accepts`);
}

async function run(db: pg.Client, url: string): Promise<void> {
  actKinds();
  const initiativeId = await seed(db);
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_CATALOG_DIR = join(root, "catalog");
  const load = (p: string) => import(pathToFileURL(join(root, p)).href);
  const save = (await load("services/zz-core/dist/document-save.js")) as {
    saveDocument: Save; documentState: (p: unknown, team: string, rel: string) => Promise<State | null>;
  };
  const versions = await load("services/zz-core/dist/versions.js");
  const platform = await load("services/zz-core/dist/platform-db.js");
  const pool = platform.db() as pg.Pool;
  try {
    await cases(db, pool, save, versions, initiativeId);
  } finally {
    // The write's journal entry is fire-and-forget: let it land before the pool and the container go.
    await new Promise((r) => setTimeout(r, 300));
    await pool.end();
  }
}

async function cases(
  db: pg.Client, pool: pg.Pool,
  { saveDocument, documentState }: { saveDocument: Save; documentState: (p: unknown, team: string, rel: string) => Promise<State | null> },
  versions: { loadDocument: Function; loadSnapshot: Function; revisionsOf: Function; publicVersions: Function },
  initiativeId: string,
): Promise<void> {
  const base = { team: TEAM, initiative: INIT, by: EMAIL };
  const state = async (rel = DOC): Promise<State> => (await documentState(pool, TEAM, rel)) ?? fail("state", `${rel} has no state`);
  const saved = (step: string, r: Awaited<ReturnType<Save>>): Saved => {
    if (!("id" in r)) fail(step, `expected a write, got ${JSON.stringify(r)}`);
    return r;
  };
  const row = async (revision: number) => (await db.query<{ version: number; body: string; approved_by: string | null }>(
    `select r.version, r.body, r.approved_by::text from zz.doc_revision r join zz.doc d on d.id = r.doc_id
      where d.path = 'notes.md' and r.revision = $1`, [revision])).rows[0];
  const docRow = async () => (await db.query<{ id: string; current_revision: number; current_version: number; content_generation: string }>(
    "select id::text as id, current_revision, current_version, content_generation from zz.doc where path = 'notes.md'")).rows[0];
  const gen = async (revision: number, path = "notes.md") => (await db.query<{ g: string | null }>(
    `select r.content_generation::text as g from zz.doc_revision r join zz.doc d on d.id = r.doc_id
      where d.path = $1 and r.revision = $2`, [path, revision])).rows[0]?.g;
  const change = async (text: string, extra: Record<string, unknown> = {}) =>
    saveDocument({ ...base, relPath: DOC, text, mode: "rewrite", change: { nextVersion: false, expect: await state(), ...extra } });

  // ── create, and the generation ─────────────────────────────────────────────────────────────
  await saveDocument({ ...base, relPath: SRC, text: "---\ntitle: S1\n---\n\nsource one\n", type: "source", mode: "create" });
  const created = saved("create", await saveDocument({ ...base, relPath: DOC, text: doc("alpha\n"), mode: "create" }));
  if (created.revision !== 1 || created.version !== 1 || created.generation !== 0) fail("create", JSON.stringify(created));
  if ((await docRow()).current_version !== 1) fail("create", "doc.current_version is not 1");
  if (await gen(1) !== "0") fail("create", `r1 stores generation ${await gen(1)}, not 0`);
  ok("create: revision 1, version 1, generation 0");

  await saveDocument({ ...base, relPath: DOC, text: doc("beta\n"), mode: "rewrite" });
  if ((await docRow()).content_generation !== "1") fail("generation", "a body change without `change` did not move the generation");
  if (await gen(1) !== "1") fail("generation", `an in-place rewrite left r1 at generation ${await gen(1)}, not 1`);
  await saveDocument({ ...base, relPath: DOC, text: doc("beta\n"), mode: "rewrite" });
  if ((await docRow()).content_generation !== "1") fail("generation", "a rewrite of the same body and metadata moved the generation");
  ok("generation: moves on a body change, not on a re-stamp of the same content");

  // ── the pin rule ─────────────────────────────────────────────────────────────────────────────
  // Unpinned: rewritten in place, with a cause the platform linked.
  const inPlace = saved("unpinned", await change(doc("gamma\n"),
    { causes: [{ path: SRC, revision: 1, linked_by: "platform" }] }));
  if (inPlace.newRow || inPlace.revision !== 1 || inPlace.version !== 1 || inPlace.generation !== 2) {
    fail("unpinned", `expected an in-place rewrite at r1/v1/g2, got ${JSON.stringify(inPlace)}`);
  }
  ok("pin rule, unpinned: rewritten in place");

  // The writer names the same cause: platform is upgraded to agent on the same row.
  saved("upgrade", await change(doc("gamma 2\n"), { causes: [{ path: SRC, revision: 1, linked_by: "agent" }] }));
  const by = async (revision: number) => (await db.query<{ linked_by: string }>(
    `select l.linked_by from zz.doc_link l join zz.doc d on d.id = l.from_doc_id
      where d.path = 'notes.md' and l.from_revision = $1 and l.kind = 'cites'`, [revision])).rows.map((r) => r.linked_by);
  if ((await by(1)).join() !== "agent") fail("upgrade", `the cause reads ${JSON.stringify(await by(1))}, not one agent link`);
  ok("cause upgrade: platform -> agent on conflict");

  // Presented: a new row in the same version, carrying the row's causes.
  await db.query("update zz.doc_revision r set presented_at = now() from zz.doc d where d.id = r.doc_id and d.path = 'notes.md' and r.revision = 1");
  const presented = saved("presented", await change(doc("delta\n")));
  if (!presented.newRow || presented.revision !== 2 || presented.version !== 1 || presented.newVersion) {
    fail("presented", `expected a new row r2 in v1, got ${JSON.stringify(presented)}`);
  }
  if ((await row(1)).body !== "gamma 2\n") fail("presented", "the presented row was rewritten");
  if ((await by(2)).join() !== "agent") fail("presented", `the new row carries ${JSON.stringify(await by(2))}, not the presented row's cause`);
  ok("pin rule, presented: new row r2 in v1, causes carried");

  // Shown: a `document.shown` event at or after the row's write pins it.
  await db.query(
    "insert into zz.event (kind, subject, initiative_id, team_id) select 'document.shown', $1, i.id, i.team_id from zz.initiative i where i.id = $2",
    [DOC, initiativeId]);
  const shown = saved("shown", await change(doc("epsilon\n")));
  if (!shown.newRow || shown.revision !== 3 || shown.version !== 1) fail("shown", `expected r3 in v1, got ${JSON.stringify(shown)}`);
  ok("pin rule, shown event: new row r3 in v1");

  // Approved: sealed by a write without `change`, as document_approve writes it.
  const before = await state();
  await saveDocument({ ...base, relPath: DOC, text: doc("epsilon\n", "status: approved\n"), mode: "rewrite",
                       seal: { by: EMAIL, at: new Date().toISOString() } });
  const sealed = await docRow();
  if (sealed.content_generation !== String(before.generation)) fail("approval", "an approval moved the content generation");
  if (sealed.current_revision !== before.revision) fail("approval", "an identity-keeping approval filed a new row instead of sealing in place");
  const approvedRow = await row(3);
  if (!approvedRow.approved_by) fail("approval", "the seal did not land");
  const meta = saved("approved", await change(doc("epsilon\n", "status: draft\ntags: renamed\n")));
  if (!meta.newRow || meta.revision !== 4 || meta.version !== 1 || meta.generation !== before.generation + 1) {
    fail("approved", `expected a metadata change to make r4 in v1 at a new generation, got ${JSON.stringify(meta)}`);
  }
  if (!(await row(3)).approved_by || (await row(3)).body !== "epsilon\n") fail("approved", "the approved row was touched");
  ok("pin rule, approved: new row r4 in v1, the signed row untouched");

  // nextVersion: a new public version.
  const next = saved("nextVersion", await change(doc("zeta\n"), { nextVersion: true }));
  if (!next.newVersion || !next.newRow || next.revision !== 5 || next.version !== 2) fail("nextVersion", JSON.stringify(next));
  if ((await docRow()).current_version !== 2) fail("nextVersion", "doc.current_version did not follow");
  ok("nextVersion: r5 opens v2");
  {
    const want = [[1, 3], [2, presented.generation], [3, shown.generation], [4, meta.generation], [5, next.generation]];
    for (const [revision, g] of want) {
      if (await gen(revision) !== String(g)) fail("generation per row", `r${revision} stores ${await gen(revision)}, not ${g}`);
    }
    ok("generation per row: every row stores the generation it was last written at");
  }

  // ── the state compare ────────────────────────────────────────────────────────────────────────
  const unchanged = async (step: string, at: State): Promise<void> => {
    const now = await docRow();
    if (now.current_revision !== at.revision) fail(step, "a sent-back change wrote a row");
  };
  {
    const s = await state();
    await saveDocument({ ...base, relPath: DOC, text: doc("eta\n"), mode: "rewrite" });
    const moved = await state();
    const conflict = await saveDocument({ ...base, relPath: DOC, text: doc("theta\n"), mode: "rewrite",
                                          change: { nextVersion: false, expect: s, base: s.generation } });
    if (!("refusal" in conflict) || !/^ERROR: BASE_CONFLICT/.test(conflict.refusal)) fail("generation change", JSON.stringify(conflict));
    const retry = await saveDocument({ ...base, relPath: DOC, text: doc("theta\n"), mode: "rewrite",
                                       change: { nextVersion: false, expect: s } });
    if (!("retry" in retry)) fail("generation change", `without a base, expected retry, got ${JSON.stringify(retry)}`);
    await unchanged("generation change", moved);
    ok("state compare: a generation change is BASE_CONFLICT with a stale base, retry without one");
  }
  {
    const s = await state();
    await saveDocument({ ...base, relPath: DOC, text: doc("eta\n", "status: approved\n"), mode: "rewrite",
                         seal: { by: EMAIL, at: new Date().toISOString() } });
    const r = await saveDocument({ ...base, relPath: DOC, text: doc("iota\n"), mode: "rewrite",
                                   change: { nextVersion: false, expect: s, base: s.generation } });
    if (!("retry" in r)) fail("approval", `an approval mid-change was not detected: ${JSON.stringify(r)}`);
    ok("state compare: an approval sends the change back to retry");
  }
  {
    const s = await state();
    await saveDocument({ ...base, relPath: DOC, text: doc("eta\n", `status: approved\noutcome: delivered\nclosed_by: ${EMAIL}\n`),
                         mode: "rewrite" });
    if ((await docRow()).content_generation !== String(s.generation)) fail("closing", "closing the initiative moved the content generation");
    const r = await saveDocument({ ...base, relPath: DOC, text: doc("kappa\n"), mode: "rewrite",
                                   change: { nextVersion: false, expect: s } });
    if (!("retry" in r)) fail("closing", `closing the initiative mid-change was not detected: ${JSON.stringify(r)}`);
    ok("state compare: a close sends the change back to retry");
  }

  // ── the lock ─────────────────────────────────────────────────────────────────────────────────
  const waits = async (step: string, rel: string, write: () => Promise<unknown>): Promise<void> => {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`doc:${TEAM}/${rel}`]);
    let settled = false;
    const pending = write().then((r) => { settled = true; return r; });
    try {
      await queued(db, step, `doc:${TEAM}/${rel}`, 1, () => settled);
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
    await db.query("commit");
    const r = await pending as Record<string, unknown>;
    if ("refusal" in r) fail(step, `after the lock was released the write was refused: ${String(r.refusal)}`);
  };
  await waits("lock (create)", `${INIT}/second.md`,
    () => saveDocument({ ...base, relPath: `${INIT}/second.md`, text: doc("one\n"), mode: "create" }));
  await waits("lock (rewrite)", `${INIT}/second.md`,
    () => saveDocument({ ...base, relPath: `${INIT}/second.md`, text: doc("two\n"), mode: "rewrite" }));
  ok("lock: a second writer waits, a create included");

  // ── a refusal rolls back a captured source ───────────────────────────────────────────────────
  {
    const s = await state();
    const cap = `${INIT}/sources/captured.md`;
    const r = await saveDocument({ ...base, relPath: DOC, text: doc("lambda\n"), mode: "rewrite", change: {
      nextVersion: true, expect: s,
      captured: { relPath: cap, text: "---\ntitle: Captured\nsupports: notes.md\n---\n\ncaptured words\n" },
      causes: [{ path: cap, revision: 1, linked_by: "agent" }, { path: `${INIT}/sources/nowhere.md`, revision: 1, linked_by: "agent" }],
    } });
    if (!("refusal" in r)) fail("rollback", `a cause that does not exist was not refused: ${JSON.stringify(r)}`);
    const left = await db.query("select 1 from zz.doc where path = 'sources/captured.md'");
    if (left.rowCount) fail("rollback", "the captured source survived the refusal");
    await unchanged("rollback", s);
    ok("refusal: the captured source rolls back with the change");

    const good = saved("captured", await saveDocument({ ...base, relPath: DOC, text: doc("lambda\n"), mode: "rewrite", change: {
      nextVersion: true, expect: s,
      captured: { relPath: cap, text: "---\ntitle: Captured\nsupports: notes.md\n---\n\ncaptured words\n" },
      causes: [{ path: cap, revision: 1, linked_by: "agent" }],
    } }));
    const linked = await db.query(
      `select 1 from zz.doc_link l join zz.doc t on t.id = l.to_doc_id
        where t.path = 'sources/captured.md' and l.from_revision = $1 and l.kind = 'cites' and l.linked_by = 'agent'`, [good.revision]);
    if (!linked.rowCount) fail("captured", "the captured source is not a cause of the new row");
    ok("captured: the source and its cause link commit with the change");
  }

  // ── requests ─────────────────────────────────────────────────────────────────────────────────
  {
    const request = (digest: string, receipt: Record<string, unknown>) =>
      ({ principalEmail: EMAIL, canonicalPath: DOC, requestId: "req-1", digest, receipt });
    const first = saved("request", await change(doc("mu\n"), { request: request("d1", { line: "edited" }) }));
    const replay = await change(doc("nu\n"), { request: request("d1", { line: "other" }) });
    if (!("replayed" in replay) || replay.replayed.line !== "edited") fail("replay", JSON.stringify(replay));
    const conflict = await change(doc("nu\n"), { request: request("d2", {}) });
    if (!("refusal" in conflict) || conflict.refusal !== "ERROR: REQUEST_ID_CONFLICT — this request_id was used for a different request") {
      fail("conflict", JSON.stringify(conflict));
    }
    const s = await state();
    const noChange = saved("no change", await saveDocument({ ...base, relPath: DOC, text: doc("mu\n"), mode: "rewrite", change: {
      nextVersion: false, expect: s, request: { ...request("d3", { line: "no change" }), requestId: "req-2" },
      details: { ref: "dr_nochangenochangenochangeno", text: "no change: nothing differs" } } }));
    if (noChange.newRow || noChange.revision !== first.revision || (await state()).writtenAt !== s.writtenAt) {
      fail("no change", `a keyed no-change wrote the document: ${JSON.stringify(noChange)}`);
    }
    const kept = await db.query("select 1 from zz.doc_request where request_id = 'req-2'");
    if (!kept.rowCount) fail("no change", "a keyed no-change was not recorded");
    const noted = await db.query("select 1 from zz.event where detail->>'details_ref' = 'dr_nochangenochangenochangeno' and subject = $1", [DOC]);
    if (noted.rowCount !== 1) fail("no change", "a keyed no-change's details row did not commit with its request");
    ok("requests: replay, conflict, and a recorded keyed no-change with its details row");
  }

  // ── a read written back stores no rendered token ─────────────────────────────────────────────
  {
    const read = await versions.loadDocument(TEAM, DOC);
    if (!read.ok || !/^content_revision: cr_/m.test(read.text)) fail("read back", "the current read carries no content_revision");
    saved("read back", await saveDocument({ ...base, relPath: DOC, text: read.text, mode: "rewrite" }));
    const stored = await db.query<{ n: number }>(
      `select count(*)::int as n from zz.doc_revision r join zz.doc d on d.id = r.doc_id
        where d.path = 'notes.md' and r.fields ? 'content_revision'`);
    if (stored.rows[0].n !== 0) fail("read back", "a rewrite of what a read returned stored content_revision in fields");
    ok("read back: content_revision is rendered, never stored");
  }

  // ── an act without `change` refuses a state it did not read ──────────────────────────────────
  {
    const s = await state();
    await saveDocument({ ...base, relPath: DOC, text: doc("xi\n"), mode: "rewrite" });
    const stale = await saveDocument({ ...base, relPath: DOC, text: doc("xi\n", "status: approved\n"), mode: "rewrite",
                                       expect: s, seal: { by: EMAIL, at: new Date().toISOString() } });
    if (!("refusal" in stale) || !/^ERROR: STATE_CHANGED — /.test(stale.refusal)) fail("expect", JSON.stringify(stale));
    if ((await row((await docRow()).current_revision)).approved_by) fail("expect", "the refused approval sealed the row");
    saved("expect", await saveDocument({ ...base, relPath: DOC, text: doc("xi\n"), mode: "rewrite", expect: await state() }));
    ok("expect without change: a moved state is STATE_CHANGED, the read one commits");
  }

  // ── version reads ────────────────────────────────────────────────────────────────────────────
  {
    const v1 = await versions.loadDocument(TEAM, DOC, 1);
    if (!v1.ok || v1.rev.revision !== 4 || !/^version: 1$/m.test(v1.text)) {
      fail("read v1", `version 1 did not answer with its last snapshot r4: ${JSON.stringify(v1.ok ? v1.rev : v1)}`);
    }
    const cur = await versions.loadDocument(TEAM, DOC);
    const own = contentRevision(cur.doc.id, Number(await gen(3)));
    const current = (await docRow()).content_generation;
    // r3, the approved snapshot r4 superseded inside v1, is read by its content revision.
    const byToken = await versions.loadSnapshot(TEAM, DOC, own);
    if (!byToken.ok || byToken.rev.revision !== 3 || !byToken.text.includes(`content_revision: ${own}\n`)
        || own === contentRevision(cur.doc.id, Number(current))) {
      fail("read by content revision", `the token of r3 did not read r3 under its own content revision: ${JSON.stringify(byToken.ok ? byToken.rev : byToken)}`);
    }
    const want = contentRevision(cur.doc.id, Number(current));
    if (!/^cr_[a-z2-7]{26}$/.test(want)) fail("content revision", `malformed: ${want}`);
    const digest = createHash("sha256").update(`${cur.doc.id}:${current}`).digest();
    if (!cur.ok || !cur.text.includes(`content_revision: ${want}`) || want !== `cr_${base32(digest).slice(0, 26)}`) {
      fail("content revision", `the current read does not carry ${want}`);
    }
    if (!new RegExp(`^version: ${cur.rev.version}$`, "m").test(cur.text)) fail("read current", "the envelope's version is not the row's");
    const missing = await versions.loadDocument(TEAM, DOC, 9);
    if (missing.ok || !/\bv1\b/.test(missing.refusal) || !/\bv2\b/.test(missing.refusal) || /\bv2, v2\b/.test(missing.refusal)) {
      fail("read v9", `the refusal does not list each version once: ${missing.ok ? "ok" : missing.refusal}`);
    }
    const history = await versions.revisionsOf(pool, cur.doc.id);
    const listed = versions.publicVersions(history).map((r: { version: number; revision: number }) => `${r.version}:${r.revision}`);
    if (listed[0] !== "1:4") fail("public versions", `one entry per version, v1's last snapshot first: ${listed.join(", ")}`);
    if (new Set(listed.map((l: string) => l.split(":")[0])).size !== listed.length) fail("public versions", `repeated: ${listed}`);
    // A version of several snapshots, none approved, is read as its last too: a second document, its
    // r1 presented so the rewrite files r2 beside it in v1.
    const unsigned = `${INIT}/unsigned.md`;
    saved("read unapproved version", await saveDocument({ ...base, relPath: unsigned, text: doc("one\n"), mode: "create" }));
    await db.query("update zz.doc_revision r set presented_at = now() from zz.doc d where d.id = r.doc_id and d.path = 'unsigned.md' and r.revision = 1");
    const two = saved("read unapproved version", await saveDocument({ ...base, relPath: unsigned, text: doc("two\n"), mode: "rewrite" }));
    if (two.revision !== 2 || two.version !== 1) fail("read unapproved version", `the rewrite filed ${JSON.stringify(two)}, not r2 in v1`);
    const last = await versions.loadDocument(TEAM, unsigned, 1);
    if (!last.ok || last.rev.revision !== 2 || !last.text.endsWith("two\n")) {
      fail("read unapproved version", `v1 of two unapproved snapshots did not answer with r2: ${JSON.stringify(last.ok ? last.rev : last)}`);
    }
    ok("version reads: a version's last snapshot, distinct versions listed");
    ok("snapshot reads: a past snapshot carries its own content revision and is read by it");
  }

  // ── an approval whose person resolves to no principal still pins ─────────────────────────────
  // The seal's two columns stay null together, and `approved_revision` carries the approval.
  {
    await saveDocument({ ...base, relPath: DOC, text: doc("omicron\n", "status: approved\n"), mode: "rewrite",
                         seal: { by: "nobody@example.test", at: new Date().toISOString() } });
    const sealed = await docRow();
    if ((await row(sealed.current_revision)).approved_by) fail("unresolved seal", "a seal by nobody stamped approved_by");
    const r = saved("unresolved seal", await change(doc("pi\n")));
    if (!r.newRow || r.revision !== sealed.current_revision + 1) {
      fail("unresolved seal", `a change to an approved row with no sealing principal was not a new row: ${JSON.stringify(r)}`);
    }
    ok("pin rule, approved without a resolved principal: a new row");
  }

  await immutable(db, saveDocument, saved, row, gen);
  await legacy(db, saveDocument, versions, saved, gen);
  await activity(db, change, saved);
  await setBased(db, saveDocument, state, saved);
  await reservations(db, saveDocument, saved);
}

type Gen = (revision: number, path?: string) => Promise<string | null | undefined>;

/** A write without `change` — an evaluation document's — that changes a pinned row's content files
 *  a new row in the same version; on an unpinned row it rewrites in place. */
async function immutable(
  db: pg.Client, saveDocument: Save, saved: (step: string, r: Awaited<ReturnType<Save>>) => Saved,
  row: (revision: number) => Promise<{ version: number; body: string }>, gen: Gen,
): Promise<void> {
  const cur = (await db.query<{ r: number; g: string }>(
    "select current_revision as r, content_generation::text as g from zz.doc where path = 'notes.md'")).rows[0];
  const shown = await row(cur.r);
  await db.query("update zz.doc_revision r set presented_at = now() from zz.doc d where d.id = r.doc_id and d.path = 'notes.md' and r.revision = $1", [cur.r]);
  const filed = saved("immutable", await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: DOC,
                                                         text: doc("an evaluation's rewrite\n"), mode: "rewrite", act: "write" }));
  if (!filed.newRow || filed.revision !== cur.r + 1 || filed.version !== shown.version) {
    fail("immutable", `a non-change write over a presented row did not file r${cur.r + 1} in v${shown.version}: ${JSON.stringify(filed)}`);
  }
  if ((await row(cur.r)).body !== shown.body || await gen(cur.r) !== cur.g) fail("immutable", "the presented row was rewritten");
  if (await gen(filed.revision) !== String(Number(cur.g) + 1)) fail("immutable", `the new row stores generation ${await gen(filed.revision)}`);
  const again = saved("immutable", await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: DOC,
                                                        text: doc("an evaluation's second rewrite\n"), mode: "rewrite", act: "write" }));
  if (again.newRow || again.revision !== filed.revision) fail("immutable", `an unpinned row was not rewritten in place: ${JSON.stringify(again)}`);
  ok("immutable: a non-change write over a presented row files a new row in its version; an unpinned one rewrites in place");
}

/** A current row written before generations were recorded: its identity is the document's, read at
 *  read time and written nowhere; the first rewrite stamps it, and the token it had then names a
 *  working state that is not retained. */
async function legacy(
  db: pg.Client, saveDocument: Save, versions: { loadDocument: Function; loadSnapshot: Function },
  saved: (step: string, r: Awaited<ReturnType<Save>>) => Saved, gen: Gen,
): Promise<void> {
  const rel = `${INIT}/legacy.md`;
  const made = saved("legacy", await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: rel, text: doc("old\n"), mode: "create" }));
  await db.query("update zz.doc_revision set content_generation = null where doc_id = $1::uuid", [made.id]);
  await db.query("update zz.doc set content_generation = 4 where id = $1::uuid", [made.id]);
  const token = contentRevision(made.id, 4);
  const read = await versions.loadDocument(TEAM, rel);
  if (!read.ok || !read.text.includes(`content_revision: ${token}\n`)) fail("legacy", "the current row does not take the document's generation");
  const snap = await versions.loadSnapshot(TEAM, rel, token);
  if (!snap.ok || snap.rev.revision !== 1 || snap.text !== read.text) fail("legacy", `its token does not read it: ${JSON.stringify(snap)}`);
  if (await gen(1, "legacy.md") !== null) fail("legacy", "a read wrote a generation onto the legacy row");
  saved("legacy", await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: rel, text: doc("new\n"), mode: "rewrite" }));
  if (await gen(1, "legacy.md") !== "5") fail("legacy", `the first rewrite stamped ${await gen(1, "legacy.md")}, not 5`);
  ok("legacy: a current row with no generation is named by the document's, unwritten until its first rewrite stamps it");

  const gone = await versions.loadSnapshot(TEAM, rel, token);
  const goneText = `ERROR: SNAPSHOT_UNAVAILABLE — ${token} was a working state that is not retained; read the current one`;
  if (gone.ok || gone.refusal !== goneText) fail("unavailable", `a rewritten state answered ${JSON.stringify(gone)}`);
  const foreign = contentRevision(made.id, 99);
  const none = await versions.loadSnapshot(TEAM, rel, foreign);
  if (none.ok || none.refusal !== `ERROR: SNAPSHOT_UNAVAILABLE — ${foreign} names no snapshot of ${rel}`) {
    fail("unavailable", `a token of no generation answered ${JSON.stringify(none)}`);
  }
  ok("unavailable: a rewritten working state and a token of no snapshot are SNAPSHOT_UNAVAILABLE, each by its own text");
}

/** The `zz.event` rows that carry one details reference. */
const eventsOf = async (db: pg.Client, ref: string) => (await db.query<{ kind: string; subject: string; detail: Record<string, unknown> }>(
  "select kind, subject, detail from zz.event where detail->>'details_ref' = $1", [ref])).rows;

/** A change's own event row, written in its transaction: present the moment the write returns, with
 *  the captured source's row beside it, and absent when the change is refused. */
async function activity(
  db: pg.Client,
  change: (text: string, extra?: Record<string, unknown>) => ReturnType<Save>,
  saved: (step: string, r: Awaited<ReturnType<Save>>) => Saved,
): Promise<void> {
  const cap = `${INIT}/sources/detailed.md`;
  const sourceRows = async () => (await db.query("select 1 from zz.event where kind = 'document.source' and subject = $1", [cap])).rowCount;
  const refused = await change(doc("rho\n"), {
    details: { ref: "dr_refusedrefusedrefusedrefus", text: "complete details of a refused change" },
    captured: { relPath: cap, text: "---\ntitle: Detailed\n---\n\nwords\n" },
    causes: [{ path: cap, revision: 1, linked_by: "agent" }, { path: `${INIT}/sources/nowhere.md`, revision: 1, linked_by: "agent" }],
  });
  if (!("refusal" in refused)) fail("activity, refused", `a missing cause was not refused: ${JSON.stringify(refused)}`);
  if ((await eventsOf(db, "dr_refusedrefusedrefusedrefus")).length || await sourceRows()) {
    fail("activity, refused", "a refused change left its event rows behind");
  }
  ok("activity: a refused change leaves no event row");

  const text = "complete details: every changed section, every cause, every normalisation";
  const r = saved("activity", await change(doc("rho\n"), {
    details: { ref: "dr_committedcommittedcommitt", text },
    captured: { relPath: cap, text: "---\ntitle: Detailed\n---\n\nwords\n" },
    causes: [{ path: cap, revision: 1, linked_by: "agent" }],
  }));
  // No wait: the row is the transaction's, so it is there when the write returns.
  const rows = await eventsOf(db, "dr_committedcommittedcommitt");
  if (rows.length !== 1 || rows[0].subject !== DOC || !/^document\./.test(rows[0].kind)
      || rows[0].detail.details !== text || rows[0].detail.path !== DOC) {
    fail("activity", `expected one document.* row for ${DOC} carrying the details, got ${JSON.stringify(rows)}`);
  }
  if (await sourceRows() !== 1) fail("activity", "the captured source's own row did not commit with the change");
  // And it is the change's only act row: nothing records it a second time after the commit.
  await new Promise((done) => setTimeout(done, 300));
  const acts = (await db.query<{ n: number }>(
    `select count(*)::int as n from zz.event where subject = $1 and kind like 'document.%'
        and ts >= (select ts from zz.event where detail->>'details_ref' = $2)`, [DOC, "dr_committedcommittedcommitt"])).rows[0].n;
  if (acts !== 1) fail("activity", `the change left ${acts} act rows, not its one`);
  ok(`activity: the change's ${rows[0].kind} row carries its details, committed with r${r.revision}, and is its only act row`);

  // A failed insert of that row fails the change: a receipt would otherwise name a row that never landed.
  const before = (await db.query<{ g: string }>("select content_generation::text as g from zz.doc where path = 'notes.md'")).rows[0].g;
  await db.query(`create function zz.inject_failure() returns trigger language plpgsql as $$
                    begin raise exception 'injected at the event row'; end $$`);
  try {
    await db.query("create trigger inject_failure before insert on zz.event for each row when (new.detail ? 'details_ref') execute function zz.inject_failure()");
    const failed = await change(doc("upsilon\n"), { details: { ref: "dr_failedfailedfailedfailedfa", text } });
    if (!("refusal" in failed) || !/could not be written: injected at the event row/.test(failed.refusal)) {
      fail("activity, failed insert", `the change was not refused: ${JSON.stringify(failed)}`);
    }
  } finally {
    await db.query("drop trigger if exists inject_failure on zz.event");
    await db.query("drop function zz.inject_failure()");
  }
  const after = (await db.query<{ g: string }>("select content_generation::text as g from zz.doc where path = 'notes.md'")).rows[0].g;
  if (after !== before || (await eventsOf(db, "dr_failedfailedfailedfailedfa")).length) {
    fail("activity, failed insert", "the change committed though its event row failed");
  }
  ok("activity: a failed insert of the event row refuses the change, and nothing commits");
}

/** Every statement the pool runs while `fn` does, by wrapping the query every client goes through. */
async function counted<T>(fn: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const statements: string[] = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(this: pg.Client, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text ?? "";
    statements.push(text.replace(/\s+/g, " ").trim());
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    return { result: await fn(), statements };
  } finally {
    pg.Client.prototype.query = original;
  }
}

/** 200 causes are one insert, and a change citing 200 runs the statements a change citing one does. */
async function setBased(
  db: pg.Client, saveDocument: Save, state: () => Promise<State>,
  saved: (step: string, r: Awaited<ReturnType<Save>>) => Saved,
): Promise<void> {
  const MANY = 200;
  const rels = Array.from({ length: MANY }, (_, i) => `${INIT}/sources/many-${i}.md`);
  for (const rel of rels) {
    saved("set-based, seed", await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: rel,
      text: `---\ntitle: Many\n---\n\n${rel}\n`, type: "source", mode: "create" }));
  }
  const citing = async (n: number, body: string) => counted(async () => saved(`set-based, ${n}`,
    await saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: DOC, text: doc(body), mode: "rewrite",
      change: { nextVersion: true, expect: await state(),
                causes: rels.slice(0, n).map((path) => ({ path, revision: 1, linked_by: "platform" })) } })));
  const one = await citing(1, "sigma\n");
  const many = await citing(MANY, "tau\n");
  const inserts = (s: string[]) => s.filter((q) => /^insert into zz\.doc_link\b/.test(q)).length;
  if (inserts(many.statements) !== 1) fail("set-based", `${MANY} causes took ${inserts(many.statements)} inserts into zz.doc_link`);
  if (many.statements.length !== one.statements.length) {
    fail("set-based", `a change with ${MANY} causes ran ${many.statements.length} statements, one with 1 ran ${one.statements.length}`);
  }
  const filed = await db.query<{ n: number }>(
    `select count(*)::int as n from zz.doc_link l join zz.doc d on d.id = l.from_doc_id
      where d.path = 'notes.md' and l.from_revision = $1 and l.kind = 'cites' and l.linked_by = 'platform'`,
    [many.result.revision]);
  if (filed.rows[0].n !== MANY) fail("set-based", `${filed.rows[0].n} of ${MANY} causes were filed`);
  ok(`set-based: ${MANY} causes are one insert, ${many.statements.length} statements either way`);
}

/** Two reserving creates of one stem whose plain name is taken, released together: -2 and -3. */
async function reservations(
  db: pg.Client, saveDocument: Save, saved: (step: string, r: Awaited<ReturnType<Save>>) => Saved,
): Promise<void> {
  const stem = `${INIT}/sources/reserved`;
  const create = (words: string) => saveDocument({ team: TEAM, initiative: INIT, by: EMAIL, relPath: `${stem}.md`,
    text: `---\ntitle: Reserved\n---\n\n${words}\n`, type: "source", mode: "create", act: "source", reserveName: true });
  const plain = saved("reserve, plain", await create("first"));
  if (plain.reserved !== `${stem}.md`) fail("reserve, plain", `a free stem reserved ${plain.reserved}`);
  // Both queue behind the stem's lock, held here, and are let go together — only once both are seen
  // waiting, so the case cannot quietly become two creates in sequence.
  await db.query("begin");
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`doc:${TEAM}/${stem}`]);
  let settled = 0;
  const both = Promise.all([create("second"), create("third")].map((p) => p.then((r) => { settled++; return r; })));
  try {
    await queued(db, "reserve, concurrent", `doc:${TEAM}/${stem}`, 2, () => settled > 0);
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
  await db.query("commit");
  const got = (await both).map((r) => saved("reserve, concurrent", r).reserved).sort();
  if (got.join() !== `${stem}-2.md,${stem}-3.md`) fail("reserve, concurrent", `reserved ${JSON.stringify(got)}`);
  const rows = await db.query<{ path: string }>("select path from zz.doc where path like 'sources/reserved%' order by path");
  if (rows.rows.map((r) => r.path).join() !== "sources/reserved-2.md,sources/reserved-3.md,sources/reserved.md") {
    fail("reserve, concurrent", `filed ${rows.rows.map((r) => r.path).join(", ")}`);
  }
  ok("reserve: two concurrent reservations of a taken stem file -2 and -3");
}

/** RFC 4648 base32, lowercase, no padding — the content revision's alphabet. */
function base32(bytes: Buffer): string {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits > 0 ? out + A[(value << (5 - bits)) & 31] : out;
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (url) => { dbUrl = url; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error("document-store: Docker is not available — the check could not run, which is not a pass");
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `document-store: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log("document-store: pin rule, generation per row, immutable snapshots, state compare, lock, rollback, requests, " +
              "version and snapshot reads, activity, set-based causes and reservations: ok");
  return 0;
}

process.exitCode = await main();
