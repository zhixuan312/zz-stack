#!/usr/bin/env node
/**
 * envelope-backfill — the fields a document carries that no column of its own can hold, carried
 * off the file store and onto `doc_revision.fields`, before Task I-41 retires that store
 * (Task I-43, ← AC-3.3, AC-8.1).
 *
 * `doc_revision` is the authority for a revision's bytes, and `fields` is the envelope's open
 * payload: `stakeholder`, a flow's own fields (sdlc's `blocks`, zz-plugin-eval's `eval_run_id`), a
 * source's `stage`/`audits_version`, and `contributed_by`, `added_at` and `date`. The writer that
 * came with the column (`saveDocument` in `services/zz-core/src/versions.ts`) stores the residual
 * on every write from here on, so this script exists for the revisions the CARRY wrote — and the
 * store is the only place their payloads live, which is why this runs before I-41 and not after it.
 *
 * The residual rule is not restated here. `envelopePayload` is imported from the writer's own
 * built module, so the two cannot drift: what this script computes is what every later write
 * computes, and what `documentText` reads back filters through the same list of column keys.
 *
 * A revision's store copy is read the way `scripts/store-migration.ts` reads it — the working tree
 * when its envelope's own `version` is this revision, otherwise `_versions/<stem>.v<N>.md`,
 * otherwise the newest history blob carrying that version. THE BYTES ARE THEN VERIFIED AGAINST
 * THE ROW THAT NAMES THEM: `sha256(bytes)` must be the revision's `content_hash`, which the carry
 * wrote from the same bytes. A revision whose store copy cannot be read, or whose bytes are not the
 * ones the row was written from, is reported BY NAME and left alone — never filled from a
 * neighbour, because a payload taken from the wrong revision is worse than a payload that is
 * missing and named.
 *
 * DELIBERATE: only a row whose `fields` is null is written, so a second run is a no-op and a row
 * the writer has already answered is never overwritten by this script. A revision whose envelope
 * carries nothing outside the columns keeps null — see `envelopePayload` for why that is a fact
 * and not a gap.
 *
 * DELIBERATE: it re-reads the store and the rows AFTER writing them and compares the two, and it
 * exits non-zero on any disagreement. A row is not evidence that the bytes behind it landed: a
 * payload that jsonb reordered, a write that hit another revision, or a `content_hash` that named
 * different bytes all pass a report and fail this pass.
 *
 *   node scripts/envelope-backfill.ts --store /artifacts --database-url "$TEAM_DB_URL"
 *   node scripts/envelope-backfill.ts --store /artifacts --database-url "$TEAM_DB_URL" --dry-run
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { parseEnvelope } from "@zz/contracts";

import { envelopePayload } from "../services/zz-core/dist/versions.js";

const SNAPSHOT_DIR = "_versions";
const DOC_SUFFIX = ".md";

/** One `zz.doc` row, as this script addresses it: which team's store holds it, and where inside
 *  that store its current revision is. */
interface DocRow {
  id: string;
  team_slug: string;
  initiative: string;
  path: string;
  current_revision: number | null;
}

/** One `zz.doc_revision` row this script may fill. */
interface RevisionRow {
  doc_id: string;
  revision: number;
  content_hash: string | null;
}

/** What the run did, one line each — the plan's `run:` evidence. */
export interface Report {
  documents: number;
  /** Revisions selected because their `fields` is null and their bytes are retained. */
  candidates: number;
  /** Revisions that gained a payload, and the fields they carried, by name. */
  gained: number;
  fieldNames: Map<string, number>;
  /** Revisions whose envelope carried nothing outside the columns, so they keep null. */
  noExtraField: number;
  /** Revisions whose `fields` was already set — not touched, counted so the skip is visible. */
  alreadySet: number;
  /** Revisions with no retained bytes at all: there is no envelope to read, ever. */
  noBytes: number;
  /** A revision whose store copy could not be read, or was not the bytes the row was written
   *  from. Named, never filled from a neighbour. */
  unresolved: string[];
  /** Revisions written but not compared, because the run was a dry one. */
  unverified: number;
  refusals: string[];
}

function emptyReport(): Report {
  return {
    documents: 0, candidates: 0, gained: 0, fieldNames: new Map(), noExtraField: 0,
    alreadySet: 0, noBytes: 0, unresolved: [], unverified: 0, refusals: [],
  };
}

/* ---------------------------------------------------------------------------------- the store */

/** The sha256 of the exact bytes a revision was written from — the same claim the carry made, so
 *  the two describe one fact. */
function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/** The envelope's own `version:`, which is the number the store filed the revision under.
 *  `scripts/store-migration.ts`'s own reader, so the two agree on what the working tree is. */
function envelopeVersion(env: Record<string, string>): number {
  const declared = (env.version ?? "").trim();
  return /^\d+$/.test(declared) ? Number(declared) : 1;
}

/** `<stem>.v<N>.md`, the filename the store files a revision under. */
function snapshotName(docPath: string, revision: number): string {
  const stem = docPath.endsWith(DOC_SUFFIX) ? docPath.slice(0, -DOC_SUFFIX.length) : docPath;
  return `${stem}.v${revision}.md`;
}

/** Every commit that touched `relPath`, newest first; none when the store is not a repository.
 *  Cached per (store, path): the write pass and the verification pass ask the same question. */
const TOUCHING = new Map<string, string[]>();

function commitsTouching(teamDir: string, relPath: string): string[] {
  const key = `${teamDir}\u0000${relPath}`;
  const held = TOUCHING.get(key);
  if (held) return held;
  let found: string[] = [];
  if (existsSync(join(teamDir, ".git"))) {
    try {
      found = execFileSync("git", ["-C", teamDir, "rev-list", "--all", "--", relPath],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
        .split("\n").map((l) => l.trim()).filter(Boolean);
    } catch { found = []; }
  }
  TOUCHING.set(key, found);
  return found;
}

/** The revisions the history recovers, keyed by the envelope version each blob declares. Newest
 *  commit first and the FIRST blob seen for a version wins — a draft patched several times without
 *  its version moving keeps the content it had before the next version appeared. */
const RECOVERED = new Map<string, Map<number, string>>();

function gitRevisions(teamDir: string, relPath: string): Map<number, string> {
  const key = `${teamDir}\u0000${relPath}`;
  const held = RECOVERED.get(key);
  if (held) return held;
  const found = new Map<number, string>();
  for (const sha of commitsTouching(teamDir, relPath)) {
    let bytes: string;
    try {
      bytes = execFileSync("git", ["-C", teamDir, "show", `${sha}:${relPath}`],
        { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch { continue; }
    const n = envelopeVersion(parseEnvelope(bytes));
    if (!found.has(n)) found.set(n, bytes);
  }
  RECOVERED.set(key, found);
  return found;
}

/** One revision's bytes, re-read from the store the way the carry read them — the same resolution
 *  `scripts/store-migration.ts:475`'s `revisionBytes` makes, because a locator that disagreed with
 *  the carry's would back-fill a revision from another revision's envelope. */
function revisionBytes(teamDir: string, doc: DocRow, revision: number): string | null {
  const relPath = `${doc.initiative}/${doc.path}`;
  const current = join(teamDir, relPath);
  if (existsSync(current)) {
    const bytes = readFileSync(current, "utf8");
    if (envelopeVersion(parseEnvelope(bytes)) === revision) return bytes;
  }
  const snapshot = join(teamDir, doc.initiative, SNAPSHOT_DIR, snapshotName(doc.path, revision));
  if (existsSync(snapshot)) return readFileSync(snapshot, "utf8");
  return gitRevisions(teamDir, relPath).get(revision) ?? null;
}

/* ------------------------------------------------------------------------------- the database */

/** A real `pg.Client` satisfies this structurally, so the CLI is the only thing that opens a
 *  connection. */
interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]):
    Promise<{ rows: T[] }>;
}

/** Whether two payloads say the same thing. Compared by key and value, NOT by `JSON.stringify`:
 *  jsonb does not retain key order, so a round-trip through the column may hand the same map back
 *  with its keys sorted, and a byte comparison would report the column working as a disagreement. */
function samePayload(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (a === null || b === null) return a === b;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** The payload a revision's own store copy carries, or why it could not be read. `content_hash`
 *  is checked FIRST and the payload only taken after it agrees: a store copy that is not the bytes
 *  the row was written from is a different revision's envelope, and reading a field off it would
 *  attach one revision's fact to another's row. */
function payloadFor(teamDir: string, doc: DocRow, rev: RevisionRow):
    { ok: true; payload: Record<string, string> | null } | { ok: false; why: string } {
  const bytes = revisionBytes(teamDir, doc, rev.revision);
  if (bytes === null) {
    return { ok: false, why: "the store holds no copy of these bytes (the working tree and the history both answer none)" };
  }
  const hash = hashBytes(bytes);
  if (rev.content_hash !== hash) {
    return { ok: false, why: `the store's copy hashes ${hash} and the row was written from ${rev.content_hash ?? "no bytes"} — this is a different revision's envelope` };
  }
  return { ok: true, payload: envelopePayload(parseEnvelope(bytes)) };
}

/** The whole run: select, fill, verify. Returns the report and the lines of disagreement.
 *
 * EXPORTED, and taking an already-connected client rather than opening one, for the same reason
 * `scripts/store-migration.ts`'s `carryStore` is: a rehearsal has a throwaway database open with
 * the store unpacked beside it, and the plan's `run:` clause is exactly that run. The CLI below is
 * the other caller, and the only one that opens a connection. */
export async function backfill(
  db: Queryable, storeRoot: string, dryRun: boolean,
): Promise<{ report: Report; problems: string[] }> {
  const report = emptyReport();
  const problems: string[] = [];
  const teamsDir = join(storeRoot, "teams");
  if (!existsSync(teamsDir)) {
    report.refusals.push(`no store at ${teamsDir} — nothing to read a payload from`);
    return { report, problems };
  }

  const docs = (await db.query<DocRow>(
    `select d.id::text as id, t.slug as team_slug, i.slug as initiative, d.path, d.current_revision
       from zz.doc d
       join zz.initiative i on i.id = d.initiative_id
       join zz.team t on t.id = i.team_id
      order by t.slug, i.slug, d.path`)).rows;
  report.documents = docs.length;
  const byId = new Map(docs.map((d) => [d.id, d]));

  // The two populations that are NOT candidates, counted so the script's silence about them is a
  // fact rather than an omission: a row the writer already answered, and a revision whose bytes the
  // store never held (there is no envelope to take a field from, and an invented payload would be
  // the same defect as an invented body).
  report.alreadySet = Number((await db.query<{ n: string }>(
    `select count(*)::text as n from zz.doc_revision where fields is not null`)).rows[0]?.n ?? 0);
  report.noBytes = Number((await db.query<{ n: string }>(
    `select count(*)::text as n from zz.doc_revision where content_state <> 'retained'`)).rows[0]?.n ?? 0);

  const rows = (await db.query<RevisionRow>(
    `select doc_id::text as doc_id, revision, content_hash
       from zz.doc_revision
      where content_state = 'retained' and fields is null
      order by doc_id, revision`)).rows;
  report.candidates = rows.length;

  // Only what the verification pass needs to find each row again: the document, the revision, and
  // the store dir its bytes are read back from. The payload is deliberately NOT held here — the
  // verification re-reads the store rather than comparing the write against its own memory.
  const written: { doc: DocRow; rev: RevisionRow }[] = [];
  await db.query("begin");
  try {
    for (const rev of rows) {
      const doc = byId.get(rev.doc_id);
      if (!doc) {
        report.unresolved.push(`revision ${rev.doc_id}/${rev.revision}: no zz.doc row names it`);
        continue;
      }
      const where = `${doc.team_slug}/${doc.initiative}/${doc.path} v${rev.revision}`;
      const teamDir = join(teamsDir, doc.team_slug);
      if (!existsSync(teamDir)) {
        report.unresolved.push(`${where}: no store for team ${doc.team_slug} at ${teamDir}`);
        continue;
      }
      const got = payloadFor(teamDir, doc, rev);
      if (!got.ok) {
        report.unresolved.push(`${where}: ${got.why}`);
        continue;
      }
      if (got.payload === null) {
        report.noExtraField++;
        continue;
      }
      await db.query(
        `update zz.doc_revision set fields = $3::jsonb
          where doc_id = $1::uuid and revision = $2 and fields is null`,
        [rev.doc_id, rev.revision, got.payload]);
      report.gained++;
      for (const key of Object.keys(got.payload)) {
        report.fieldNames.set(key, (report.fieldNames.get(key) ?? 0) + 1);
      }
      written.push({ doc, rev });
    }
    if (dryRun) {
      await db.query("rollback");
      report.unverified = written.length;
      return { report, problems };
    }
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    report.refusals.push(`the run was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    return { report, problems };
  }

  // The verification pass, and the reason this script exits non-zero rather than reporting success.
  // Every row it wrote is re-read from the database and compared with the store's own envelope for
  // that revision — the store re-read, not the payload held in memory, so a write that landed on
  // the wrong revision or a jsonb value that did not survive the round trip is caught here.
  if (!written.length) return { report, problems };
  const ids = [...new Set(written.map((w) => w.rev.doc_id))];
  const after = new Map<string, Record<string, string> | null>();
  for (const id of ids) {
    const held = (await db.query<{ revision: number; fields: Record<string, string> | null }>(
      `select revision, fields from zz.doc_revision where doc_id = $1::uuid`, [id])).rows;
    for (const r of held) after.set(`${id}\u0000${r.revision}`, r.fields);
  }
  for (const w of written) {
    const where = `${w.doc.team_slug}/${w.doc.initiative}/${w.doc.path} v${w.rev.revision}`;
    const teamDir = join(teamsDir, w.doc.team_slug);
    const store = payloadFor(teamDir, w.doc, w.rev);
    const row = after.get(`${w.rev.doc_id}\u0000${w.rev.revision}`) ?? null;
    if (!store.ok) {
      problems.push(`${where}: written, and the store can no longer be read back (${store.why})`);
      continue;
    }
    if (!samePayload(store.payload, row)) {
      problems.push(`${where}: the row holds ${JSON.stringify(row)} and the envelope it came from carries ${JSON.stringify(store.payload)}`);
    }
  }
  return { report, problems };
}

/* --------------------------------------------------------------------------------------- CLI */

/** The report, one line each — what the plan's `run:` clause asks this backfill to state. */
export function formatReport(r: Report, dryRun: boolean): string[] {
  const fields = [...r.fieldNames.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`).join(", ");
  const lines = [
    `envelope-backfill: ${r.documents} document(s) in the index`,
    `envelope-backfill: ${r.candidates} revision(s) with no payload to answer from`,
    `envelope-backfill: ${dryRun ? "would gain" : "gained"} a payload ${r.gained}` +
      (fields ? ` — fields carried: ${fields}` : " — no field outside the columns"),
    `envelope-backfill: carried nothing outside the columns, left null ${r.noExtraField}`,
    `envelope-backfill: already set by the writer, not touched ${r.alreadySet}`,
    `envelope-backfill: no retained bytes at all, left null ${r.noBytes}`,
    `envelope-backfill: store copy unreadable, reported and left alone ${r.unresolved.length}`,
  ];
  if (dryRun) lines.push(`envelope-backfill: dry run — no row was written, ${r.unverified} payload(s) not verified`);
  for (const u of r.unresolved) lines.push(`envelope-backfill: LEFT ALONE — ${u}`);
  for (const refusal of r.refusals) lines.push(`envelope-backfill: REFUSED — ${refusal}`);
  return lines;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  if (flag("--psql")) {
    console.error("envelope-backfill REFUSED — this backfill reaches the database over a " +
      "connection, not through psql; pass --database-url");
    process.exit(2);
  }
  const store = flag("--store") ?? process.env.ZZ_STORE_DIR;
  const url = flag("--database-url") || process.env.TEAM_DB_URL || process.env.PLATFORM_DB_URL;
  const dryRun = argv.includes("--dry-run");
  if (!store || !url) {
    console.error("usage: node scripts/envelope-backfill.ts --store <dir> " +
      "--database-url <url> [--dry-run]");
    process.exit(2);
  }
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("set search_path = ''");
    const { report, problems } = await backfill(client, store, dryRun);
    for (const line of formatReport(report, dryRun)) console.log(line);
    for (const p of problems) console.error(`envelope-backfill: DISAGREES — ${p}`);
    if (problems.length || report.refusals.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("envelope-backfill.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
