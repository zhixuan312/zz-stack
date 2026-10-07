#!/usr/bin/env node
/**
 * checks/eval-profile-record.ts — `plugin_profile`'s document `record`, read on a real database.
 *
 *   node checks/eval-profile-record.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated from this tree (`withThrowawayDb`), seeds one
 * initiative's documents and door events with SQL, and runs the built `pluginTraces` on it as
 * zz-core's own door. What it establishes:
 *
 *   - a document is `revised` when it has a second PUBLIC version, not a second snapshot: a new
 *     snapshot filed in the same version (an edit after a presentation, a metadata change to an
 *     approved document) opens no version, so it neither counts as revised nor, through the cites
 *     links carried onto it, as revised with evidence;
 *   - `edits_without_cause` and `edits_with_cause` count the same population as the rest of the
 *     record: this plugin's own door, evaluation traffic excluded — a `document_edit` recorded on
 *     another door, or made by an evaluation flow's skill, is not counted.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held. Exit 1: a case failed — what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type pg from "pg";

import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "eval-profile-record";
const PLUGIN = "zz-core";
const VERSION = "0.0.0-check";
const { pluginTraces } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/plugin-profile.js")).href);

/** A document of `initiative` with one snapshot per entry of `versions` (revision numbers from 1,
 *  the last current), each citing `cites` when given. */
async function document(db: pg.Client, by: string, initiative: string, path: string, versions: number[],
                        cites: string | null = null): Promise<string> {
  await db.query("BEGIN");
  await db.query("SET CONSTRAINTS ALL DEFERRED");
  const d = await db.query<{ id: string }>(
    `INSERT INTO zz.doc (initiative_id, path, status, updated_at, current_revision, current_version)
     VALUES ($1, $2, 'draft', now(), $3, $4) RETURNING id`, [initiative, path, versions.length, versions.at(-1)]);
  const id = d.rows[0]!.id;
  for (const [i, version] of versions.entries()) {
    await db.query(
      `INSERT INTO zz.doc_revision (doc_id, revision, version, content_state, title, body, tags, content_hash,
                                    written_by, written_at, fields)
       VALUES ($1, $2, $3, 'retained', $4, 'body', '{}', $5, $6, now(), '{}')`,
      [id, i + 1, version, path, `h${i + 1}`, by]);
    if (cites) {
      await db.query("INSERT INTO zz.doc_link (from_doc_id, from_revision, to_doc_id, to_revision, kind) VALUES ($1, $2, $3, 1, 'cites')",
                     [id, i + 1, cites]);
    }
  }
  await db.query("COMMIT");
  return id;
}

async function run(db: pg.Client): Promise<string[]> {
  const fail: string[] = [];
  const p = await db.query<{ id: string }>(
    "INSERT INTO zz.principal (email, display_name, role) VALUES ('check@example.test', 'Check', 'member') RETURNING id");
  const t = await db.query<{ id: string }>(
    "INSERT INTO zz.team (slug, name, created_by) VALUES ('check-team', 'Check', $1) RETURNING id", [p.rows[0]!.id]);
  const team = t.rows[0]!.id;
  const by = p.rows[0]!.id;
  const i = await db.query<{ id: string }>(
    "INSERT INTO zz.initiative (team_id, slug, flow) VALUES ($1, '2026-10-07-record', 'sdlc-flow') RETURNING id", [team]);
  const initiative = i.rows[0]!.id;
  const s = await db.query<{ id: string }>("INSERT INTO zz.skill (name, flow) VALUES ('zz-plugin-observe', 'zz-plugin-eval') RETURNING id");
  const ev = await db.query<{ id: string }>("INSERT INTO zz.skill_version (skill_id, version, content_hash) VALUES ($1, '1.0.0', repeat('a', 64)) RETURNING id",
                                            [s.rows[0]!.id]);

  const source = await document(db, by, initiative, "sources/finding.md", [1]);
  // Two snapshots of one public version: no version change, cites links carried onto the second.
  await document(db, by, initiative, "spec.md", [1, 1], source);
  // A second public version: revised, with evidence.
  await document(db, by, initiative, "plan.md", [1, 2], source);

  const call = (plugin: string, tool: string, args: string[], skillVersion: string | null = null) => db.query(
    `INSERT INTO zz.event (kind, subject, detail, ok, team_id, initiative_id, plugin, plugin_version, tool_key, skill_version_id)
     VALUES ('tool_call', $1, $2, true, $3, $4, $5, $6, $1, $7)`,
    [tool, JSON.stringify({ args }), team, initiative, plugin, VERSION, skillVersion]);
  await call(PLUGIN, "core:document_write", ["content", "path"]);
  await call(PLUGIN, "core:document_edit", ["edits", "path", "sources"]);
  await call(PLUGIN, "core:document_edit", ["edits", "path"]);
  // Neither is this door's own traffic: another door's record, and an evaluation skill's call.
  await call("zz-other", "other:document_edit", ["edits", "path"]);
  await call(PLUGIN, "core:document_edit", ["edits", "path"], ev.rows[0]!.id);

  const traces = await pluginTraces(db, PLUGIN, VERSION, ["document_edit", "document_write"], [], true,
                                    { from: "-infinity", to: "infinity" });
  const rec = traces.record as Record<string, number> | null;
  const want = { documents: 3, revised: 1, revised_with_evidence: 1, edits_without_cause: 1, edits_with_cause: 1 };
  if (JSON.stringify(rec) !== JSON.stringify(want)) {
    fail.push(`the record is ${JSON.stringify(rec)}, not ${JSON.stringify(want)}`);
  }
  return fail;
}

async function main(): Promise<number> {
  let fail: string[];
  try {
    fail = await withThrowawayDb(run);
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(`${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  if (fail.length) {
    for (const f of fail) console.error(`${NAME}: ${f}`);
    return 1;
  }
  console.log(`${NAME}: revised counts public versions, and edits count this door's own traffic: ok`);
  return 0;
}

process.exitCode = await main();
