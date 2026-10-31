#!/usr/bin/env node
/**
 * checks/console-change-hints.ts — presenting or approving a revision of a document tells the console's tabs that
 * its team's documents and initiatives moved, changing anything else on a revision tells them nothing, and recording
 * an initiative's branch fact tells them its team's initiatives moved (services/gateway/migrations/018_change_hints.sql).
 *
 *   node checks/console-change-hints.ts   # needs Docker
 *
 * A presentation writes `zz.doc_revision.presented_at` and a branch fact is a `zz.initiative_fact` row, and neither
 * write touches another table the console watches (`recordPresented`, services/zz-core/src/attest.ts; `writeFacts`,
 * services/zz-core/src/initiative-record.ts), so without a trigger on each table a tab's waiting approvals and the kept
 * Initiatives answer stay as they were until something else moves them. What it establishes, listening on the
 * console's change channel from a connection of its own, as the gateway's stream does:
 *
 *   - setting a revision's `presented_at` raises `document` and `initiatives` for its document's team, and nothing for
 *     any other team;
 *   - setting its `approved_by` and `approved_at` raises the same two;
 *   - rewriting its `revision_note` alone raises nothing;
 *   - inserting a branch fact raises `initiatives` for its initiative's team, and nothing else.
 *
 * Each write is judged against a positive control: an event of another team written after it, whose `activity` and
 * `runs` are heard. Postgres delivers notifications in commit order, so once the control's are heard, any hint the
 * write raised has been heard before them, and hearing nothing proves nothing was raised.
 *
 * DELIBERATE: the writes are the SQL a writer sends, on the revision row itself, and the collection names are written
 * here rather than read from the migration: a check that read them from the code under test would agree with whatever
 * it said.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`) and seeds a person, two teams, an
 * initiative and one document with SQL directly. The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import pg from "pg";

import { deferred, failing, withThrowawayDbCheck, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "console-change-hints";
const DONE = "console-change-hints: presenting or approving a revision raises document and initiatives for its " +
  "team alone, rewriting its note raises nothing, and recording a branch fact raises initiatives for its team alone: ok";

/** The channel the console's change triggers notify on. COUPLED: `zz.console_hint` in
 *  services/gateway/migrations/003_console_live.sql. */
const CHANNEL = "zz_console_change";

const TEAM = "revision-team";
const CONTROL = "revision-control";
const WRITER = "writer@revision.example.test";

const fail: Fail = failing(NAME);
const pass = (line: string): void => console.log(`ok ${line}`);

type Hint = { t: string; c: string };

async function seed(sql: pg.Client): Promise<{ doc: string; writer: string; control: string; initiative: string }> {
  const writer = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [WRITER, WRITER])).rows[0].id;
  const team = async (slug: string): Promise<string> => (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $1, $2) returning id", [slug, writer])).rows[0].id;
  const own = await team(TEAM);
  const control = await team(CONTROL);
  const initiative = (await sql.query<{ id: string }>(
    "insert into zz.initiative (team_id, slug, opened_by, opened_at) values ($1, '2026-10-01-revision-work', $2, now()) returning id", [own, writer])).rows[0].id;
  const doc = await deferred(sql, async () => {
    const id = (await sql.query<{ id: string }>(
      `insert into zz.doc (initiative_id, path, status, updated_at, current_revision, current_version)
       values ($1, 'spec.md', 'draft', now(), 1, 1) returning id::text as id`, [initiative])).rows[0].id;
    await sql.query(
      `insert into zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                    written_by, written_at, fields)
       values ($1, 1, 1, 'retained', 'Spec', '# Spec\n', '{}', 'h1', $2, now(), '{}')`, [id, writer]);
    return id;
  });
  return { doc, writer, control, initiative };
}

async function run(sql: pg.Client, url: string): Promise<void> {
  const ids = await seed(sql);

  // A connection of its own, as the gateway's stream has: a session that listens hears what other sessions commit.
  // Listening starts after the seed, so the hints the seed's own inserts raised are not heard.
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  const heard: Hint[] = [];
  listener.on("notification", (m) => {
    if (m.channel === CHANNEL) heard.push(JSON.parse(m.payload ?? "{}") as Hint);
  });
  await listener.query(`listen ${CHANNEL}`);

  /** What `write` raised: every hint heard from before it up to the control event's two, the control's left out. */
  const raised = async (step: string, write: () => Promise<unknown>): Promise<string> => {
    const from = heard.length;
    await write();
    await sql.query("insert into zz.event (kind, subject, team_id) values ('knowledge.add', 'control', $1)", [ids.control]);
    const until = Date.now() + 5000;
    const control = () => heard.slice(from).filter((h) => h.t === CONTROL).map((h) => h.c).sort().join(",");
    while (control() !== "activity,runs") {
      if (Date.now() > until) fail(step, `the control event raised [${control()}], not activity and runs: a listener that hears nothing cannot say what the write raised`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return heard.slice(from).filter((h) => h.t !== CONTROL).map((h) => `${h.t}:${h.c}`).sort().join(",");
  };
  const BOTH = `${TEAM}:document,${TEAM}:initiatives`;

  try {
    let step = "a revision presented raises document and initiatives for its team";
    let got = await raised(step, () => sql.query(
      "update zz.doc_revision set presented_at = now() where doc_id = $1 and revision = 1", [ids.doc]));
    if (got !== BOTH) fail(step, `heard [${got}], not [${BOTH}]`);
    pass(step);

    step = "a revision approved raises document and initiatives for its team";
    got = await raised(step, () => sql.query(
      "update zz.doc_revision set approved_by = $2, approved_at = now() where doc_id = $1 and revision = 1", [ids.doc, ids.writer]));
    if (got !== BOTH) fail(step, `heard [${got}], not [${BOTH}]`);
    pass(step);

    step = "a revision whose note alone is rewritten raises nothing";
    got = await raised(step, () => sql.query(
      "update zz.doc_revision set revision_note = 'typo' where doc_id = $1 and revision = 1", [ids.doc]));
    if (got !== "") fail(step, `heard [${got}], not nothing`);
    pass(`${step}, while an event of another team written after it raises activity and runs`);

    step = "a branch fact recorded raises initiatives for its team";
    got = await raised(step, () => sql.query(
      "insert into zz.initiative_fact (initiative_id, fact, value) values ($1, 'release_mode', 'promotable')", [ids.initiative]));
    if (got !== `${TEAM}:initiatives`) fail(step, `heard [${got}], not [${TEAM}:initiatives]`);
    pass(step);
  } finally {
    await listener.end().catch(() => undefined);
  }
}

process.exitCode = await withThrowawayDbCheck(NAME, DONE, run);
