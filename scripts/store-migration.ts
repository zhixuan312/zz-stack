#!/usr/bin/env node
/**
 * store-migration — the carry that turns every team's store into `doc_revision` and `doc_link`
 * rows (Task I-38, ← AC-3.3, AC-3.4, AC-6.7, AC-8.1).
 *
 * A document's revisions are read from the three records the store keeps them in:
 *
 *   the working tree   the file itself, which is its current revision
 *   `_versions/`       `<initiative>/_versions/<stem>.v<N>.md`, the frozen copy filed on each
 *                      draft -> approved flip. The stem is matched WHOLE, because `spec.md` and
 *                      `spec-review.md` share a prefix and a `startsWith` would file one
 *                      document's approvals under its neighbour's history.
 *   the git history    every write was committed — `commitStore` runs `add -A` and
 *                      `commit --allow-empty` with the actor as the author — so a revision the
 *                      working tree overwrote is still in `.git` beside the file that replaced
 *                      it, and the release's backup carries the repository whole.
 *
 * A revision's KNOWN set is every integer `1..V`, where `V` is the current body's own `version:`
 * envelope field (defaulting to 1), together with every snapshot number the store holds and every
 * number the history recovers. A number in that set that none of the three holds is
 * `missing_legacy`: the store genuinely never preserved those bytes, and the row that says so
 * carries no title, body, tags or hash rather than an invented one (CS-9). The store names that
 * population itself — a write whose commit failed left a `git_failed` entry in the team's
 * `_activity.jsonl`, and a revision written before the repository existed has no commit at all —
 * and the report counts it by which of those two records named it.
 *
 * `doc_link` carries the two grains the spec fixes (FR-13): a document's own `evidence` is a list
 * of paths inside its initiative and becomes `cites` links pinned to exact revisions at both ends,
 * and a source's single `supports` value names the document it bears on and becomes a `supports`
 * link pinned to the source's revision at one end and left null at the other, because a source
 * bears on the document identity across its later revisions rather than on one historical target
 * revision.
 *
 * The two legacy pins of AC-6.7 are resolved here, because the evidence they need exists only in
 * the store:
 *
 *   eval_protocol_version.approved_doc_revision   a protocol body quotes the `content_digest` of
 *                                                 the version it affirmed, so the revision whose
 *                                                 bytes carry that digest is the revision affirmed
 *   eval_assessment.doc_revision                  a document subject is pinned only where the store
 *                                                 proves which revision was judged: a document the
 *                                                 store holds exactly one revision of. A document
 *                                                 with a history is left null and reported, because
 *                                                 no rule here may pick one by timestamp (AC-6.7).
 *
 * DELIBERATE: this module never writes through a store path. It reads the store and writes rows; a
 * document whose file cannot be read is a named refusal in the report, its own rows are skipped,
 * and the run continues to the end, so the refusal count is a fact about the store rather than a
 * run that never finished.
 *
 * COUPLED: this file is the entry point, and it holds the subject that names it — the store's
 * on-disk reading (the working tree, `_versions/`, the git history, the revision set), the revision
 * rows and the two `doc` keys, the file-for-row verification, and the CLI. What a carry of this
 * size is about besides that lives beside it under `scripts/store-migration/`: `model.ts` for the
 * shapes they share, `report.ts` for what the run says, `records.ts` for the store's other
 * records, `links.ts` for `doc_link`, and `pins.ts` for the two legacy pins. Each imports from this
 * file nothing; the reading they need is handed to them.
 *
 *   node scripts/store-migration.ts --store /artifacts --database-url "$TEAM_DB_URL"
 *   node scripts/store-migration.ts --store /artifacts --database-url "$TEAM_DB_URL" --dry-run
 *
 * The rehearsal hands this module its own already-connected client instead — see
 * `scripts/rehearse/expect.ts`, whose `withArtifacts` step runs `carryStore` and then `verifyStore`
 * against the throwaway database a rehearsal already has open.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { documentBody, parseEnvelope } from "@zz/contracts";

import { writeLinks, type Link } from "./store-migration/links.ts";
import { hashBytes, type DocRow, type Placed, type Queryable, type Revision } from "./store-migration/model.ts";
import { pinLegacy } from "./store-migration/pins.ts";
import { countStoreRecords } from "./store-migration/records.ts";
import { emptyReport, formatReport, type StoreReport } from "./store-migration/report.ts";

const SNAPSHOT_DIR = "_versions";
const DOC_SUFFIX = ".md";

/* ---------------------------------------------------------------------------------- the store */

/** The filename shape a snapshot has, anchored on the whole stem. */
function snapshotShape(docPath: string): RegExp {
  const stem = docPath.endsWith(DOC_SUFFIX) ? docPath.slice(0, -DOC_SUFFIX.length) : docPath;
  return new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.v(\\d+)\\.md$`);
}

/** `<stem>.v<N>.md`, the filename the store files a revision under. */
function snapshotName(docPath: string, revision: number): string {
  const stem = docPath.endsWith(DOC_SUFFIX) ? docPath.slice(0, -DOC_SUFFIX.length) : docPath;
  return `${stem}.v${revision}.md`;
}

/** The envelope's own `version:`, which is the number the store filed the revision under.
 *  A document that carries none is revision 1: `snapshotOnApproval` defaults the same way. */
function envelopeVersion(env: Record<string, string>): number {
  const declared = (env.version ?? "").trim();
  return /^\d+$/.test(declared) ? Number(declared) : 1;
}

/** `indexDoc`'s own title derivation, so a revision's title is the one the `doc` row carries. */
function revisionTitle(env: Record<string, string>, docPath: string): string {
  return (env.title ?? "").replace(/^["']|["']$/g, "").trim()
    || docPath.replace(/\.md$/, "");
}

/** `indexDoc`'s own list reader: one frontmatter line, comma-separated, quotes stripped. */
function envelopeList(value: string | undefined): string[] {
  return (value ?? "").replace(/^\[|\]$/g, "").split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** A frontmatter date, as `timestamptz`. Anything that is not a date is no stamp at all. */
function envelopeStamp(value: string | undefined): string | null {
  const v = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null;
}

function unquote(v: string | undefined): string {
  return (v ?? "").replace(/^["']|["']$/g, "").trim();
}


/** Every commit that touched `relPath`, newest first. A store with no repository, or a path it
 *  never carried, answers none — and that is the answer rather than an error.
 *
 *  Cached per (store, path) for the life of the process: the store is read-only here, the carry
 *  and the verification pass ask the same question of the same path, and a `git rev-list` per
 *  document per pass is two thousand processes over a store this size. */
const TOUCHING = new Map<string, string[]>();

function commitsTouching(teamDir: string, relPath: string): string[] {
  const key = `${teamDir}\u0000${relPath}`;
  const held = TOUCHING.get(key);
  if (held) return held;
  const found = readCommits(teamDir, relPath);
  TOUCHING.set(key, found);
  return found;
}

function readCommits(teamDir: string, relPath: string): string[] {
  if (!existsSync(join(teamDir, ".git"))) return [];
  try {
    return execFileSync("git", ["-C", teamDir, "rev-list", "--all", "--", relPath],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function blobAt(teamDir: string, sha: string, relPath: string): string | null {
  try {
    return execFileSync("git", ["-C", teamDir, "show", `${sha}:${relPath}`],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

/**
 * The revisions the history recovers, keyed by the envelope version each blob declares.
 *
 * Newest commit first, and the FIRST blob seen for a version wins: a draft can be patched several
 * times without its version moving, so a revision's content is the last version-N content before
 * version N+1 appeared, which is the newest commit carrying version N.
 *
 * Cached for the same reason `commitsTouching` is: the carry and the verification pass ask the
 * same question of every document.
 */
const RECOVERED = new Map<string, Map<number, string>>();

function gitRevisions(teamDir: string, relPath: string): Map<number, string> {
  const key = `${teamDir}\u0000${relPath}`;
  const held = RECOVERED.get(key);
  if (held) return held;
  const found = new Map<number, string>();
  for (const sha of commitsTouching(teamDir, relPath)) {
    const bytes = blobAt(teamDir, sha, relPath);
    if (bytes === null) continue;
    const n = envelopeVersion(parseEnvelope(bytes));
    if (!found.has(n)) found.set(n, bytes);
  }
  RECOVERED.set(key, found);
  return found;
}

/** `git_failed` entries in a team's own activity log — `commitStore` writes one when a commit
 *  fails, and they are the store's record of a write git never kept. */
function gitFailedEntries(teamDir: string): string[] {
  const file = join(teamDir, "_activity.jsonl");
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("git_failed")) continue;
    try {
      const entry = JSON.parse(line) as { action?: string; detail?: string };
      if (entry.action === "git_failed") out.push(entry.detail ?? "");
    } catch { /* a half-written line is not a record */ }
  }
  return out;
}

/** A document's known revision set, and for each one either its bytes or why there are none.
 *
 * `current` is the working tree's own envelope version, returned rather than re-derived: it is the
 * revision the `doc` row must name, and taking the largest number in the set instead would let a
 * stray snapshot outrank the live document. */
function revisionsFor(teamDir: string, initiative: string, docPath: string):
    { current: number; revisions: Revision[] } {
  const relPath = `${initiative}/${docPath}`;
  const current = readFileSync(join(teamDir, relPath), "utf8");
  const currentVersion = envelopeVersion(parseEnvelope(current));

  const snapshots = new Map<number, string>();
  const dir = join(teamDir, initiative, SNAPSHOT_DIR);
  const shape = snapshotShape(docPath);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const f of readdirSync(dir)) {
      const m = shape.exec(f);
      if (m) snapshots.set(Number(m[1]), readFileSync(join(dir, f), "utf8"));
    }
  }

  // The history is read only when a number the store knows is not already in hand. The working
  // tree holds the current revision and `_versions/` holds the approved ones, so a document whose
  // whole `1..V` is covered by those two — most of the store, every source among them — needs no
  // `git` process at all. The numbers a history could add beyond `1..V` are snapshot numbers, and
  // those are already in the set from the directory.
  const covered = ((): boolean => {
    for (let n = 1; n < currentVersion; n++) if (!snapshots.has(n)) return false;
    return true;
  })();
  const needed = (n: number): boolean => n !== currentVersion && !snapshots.has(n);
  const git = new Map<number, string>();
  if (!covered) {
    for (const [n, bytes] of gitRevisions(teamDir, relPath)) {
      if (needed(n)) git.set(n, bytes);
    }
  }

  const known = new Set<number>();
  for (let n = 1; n <= currentVersion; n++) known.add(n);
  for (const n of snapshots.keys()) known.add(n);
  for (const n of git.keys()) known.add(n);

  const failures = gitFailedEntries(teamDir);
  const rows: Revision[] = [];
  for (const n of [...known].sort((a, b) => a - b)) {
    if (n === currentVersion) {
      const frozen = snapshots.get(n);
      rows.push({
        number: n, state: "retained", held: { bytes: current, from: "working_tree" }, missing: null,
        frozen: frozen !== undefined && frozen !== current
          ? { bodyDiffers: documentBody(frozen) !== documentBody(current) }
          : null,
      });
      continue;
    }
    const snapshot = snapshots.get(n);
    if (snapshot !== undefined) {
      rows.push({ number: n, state: "retained", held: { bytes: snapshot, from: "snapshot" }, missing: null, frozen: null });
      continue;
    }
    const blob = git.get(n);
    if (blob !== undefined) {
      rows.push({ number: n, state: "retained", held: { bytes: blob, from: "git" }, missing: null, frozen: null });
      continue;
    }
    const named = failures.filter((d) => d.includes(relPath));
    rows.push({
      number: n, state: "missing_legacy", held: null, frozen: null,
      missing: named.length
        ? `git_failed: ${named[0].slice(0, 160)}`
        : (!existsSync(join(teamDir, ".git"))
          ? "predates the repository: this store was never a git repository"
          : `uncommitted: the repository holds no blob of ${relPath} carrying version ${n}`),
    });
  }
  return { current: currentVersion, revisions: rows };
}

/* --------------------------------------------------------------------------------- the carry */

function isSnapshotPath(docPath: string): boolean {
  return docPath.split("/").includes(SNAPSHOT_DIR);
}

/** The parent document a `_versions/` row is a revision of, and the number it is filed under. */
function snapshotParent(docs: DocRow[], doc: DocRow):
    { parent: DocRow | null; revision: number } {
  const parts = doc.path.split("/");
  const file = parts[parts.length - 1];
  const stem = file.replace(/\.v\d+\.md$/, DOC_SUFFIX);
  const parent = docs.find((d) => d.initiative === doc.initiative && d.path === stem) ?? null;
  const m = /\.v(\d+)\.md$/.exec(file);
  return { parent, revision: m ? Number(m[1]) : 0 };
}

/** A citation target: the document a path names inside the same initiative.
 *
 *  The store writes these both ways — `sources/x.md`, and the initiative-qualified
 *  `<initiative>/sources/x.md` an audit round's own evidence carries — so an exact match is tried
 *  first and the initiative prefix is stripped second. A path that resolves to neither is reported
 *  rather than guessed at.
 */
function resolvePath(docs: DocRow[], initiative: string, path: string): DocRow | null {
  const raw = path.trim();
  const exact = docs.find((d) => d.initiative === initiative && d.path === raw);
  if (exact) return exact;
  const prefix = `${initiative}/`;
  if (!raw.startsWith(prefix)) return null;
  const bare = raw.slice(prefix.length);
  return docs.find((d) => d.initiative === initiative && d.path === bare) ?? null;
}

/**
 * Every team's store becomes rows. Reads the store and writes `doc_revision`, `doc_link`, the two
 * legacy pins and the two revision keys on `doc`; returns what it did and could not do.
 */
export async function carryStore(db: Queryable, storeRoot: string): Promise<StoreReport> {
  const report = emptyReport();
  const teamsDir = join(storeRoot, "teams");
  if (!existsSync(teamsDir)) {
    report.refusals.push(`no store at ${teamsDir} — nothing to carry`);
    return report;
  }

  const teamRows = (await db.query<{ id: string; slug: string }>("select id, slug from zz.team")).rows;
  const teamBySlug = new Map(teamRows.map((t) => [t.slug, t.id]));
  const principals = (await db.query<{ id: string; email: string }>(
    "select id, email from zz.principal")).rows;
  const principalByEmail = new Map(principals.map((p) => [p.email, p.id]));
  const docs = (await db.query<DocRow>(
    "select id, team_slug, initiative, path, status, evidence, supports from zz.doc")).rows;
  const byTeam = new Map<string, DocRow[]>();
  for (const d of docs) byTeam.set(d.team_slug, [...byTeam.get(d.team_slug) ?? [], d]);

  // Each document placed, by row id, so the links and the pins can name exact revisions.
  const placed = new Map<string, Placed>();

  for (const team of readdirSync(teamsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const teamDir = join(teamsDir, team);
    // A store the platform does not know is not carried, and that is a refusal before any row is
    // written for it: there is no team to hang the rows on, and writing none of them is the whole
    // of what can be done with it.
    if (!teamBySlug.has(team)) {
      report.teamsNotCarried.push(team);
      report.refusals.push(`teams/${team}: names no zz.team, so nothing was carried for it`);
      continue;
    }
    report.teams.push(team);

    for (const doc of byTeam.get(team) ?? []) {
      if (isSnapshotPath(doc.path)) continue; // a revision of its parent, not a document of its own
      const relPath = `${doc.initiative}/${doc.path}`;
      if (!existsSync(join(teamDir, relPath))) {
        report.refusals.push(`${team}/${relPath}: no such file in the store`);
        continue;
      }
      let derived: { current: number; revisions: Revision[] };
      try {
        derived = revisionsFor(teamDir, doc.initiative, doc.path);
      } catch (err) {
        report.refusals.push(`${team}/${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const { revisions, current } = derived;
      report.documentsRead++;
      const numbers = revisions.map((r) => r.number);

      for (const rev of revisions) {
        // A frozen approval copy of the current revision that the live file does not match: the
        // close-time envelope stamp, on real data. Counted, because "the store kept two things
        // under one number" is a fact about the store, not something to leave unobservable.
        if (rev.frozen) {
          report.frozenCopies.bytes++;
          if (rev.frozen.bodyDiffers) report.frozenCopies.bodyDiffers++;
        }
        if (rev.state === "missing_legacy") {
          report.revisionsMissingLegacy++;
          const bucket = rev.missing?.split(":")[0] ?? "unknown";
          report.missingReasons[bucket] = (report.missingReasons[bucket] ?? 0) + 1;
          await db.query(
            `insert into zz.doc_revision (doc_id, revision, content_state)
             values ($1,$2,'missing_legacy') on conflict do nothing`,
            [doc.id, rev.number]);
          continue;
        }
        const bytes = rev.held!.bytes;
        const env = parseEnvelope(bytes);
        const approver = principalByEmail.get(unquote(env.approved_by)) ?? null;
        // The seal only where the revision's own bytes say it was approved AND the approver is a
        // real principal: `approved_by` is a uuid here, and the pair must move together.
        const sealed = env.status === "approved" && approver !== null;
        await db.query(
          `insert into zz.doc_revision
             (doc_id, revision, content_state, title, body, tags, content_hash,
              written_at, approved_by, approved_at)
           values ($1,$2,'retained',$3,$4,$5::text[],$6,$7::timestamptz,$8,$9::timestamptz)
           on conflict do nothing`,
          [doc.id, rev.number, revisionTitle(env, doc.path),
           documentBody(bytes).slice(0, 200_000), envelopeList(env.tags), hashBytes(bytes),
           envelopeStamp(env.updated_at), sealed ? approver : null,
           sealed ? envelopeStamp(env.approved_at) : null]);
        report.revisionsRetained++;
      }

      // The approved revision is the current one when the document is approved, and otherwise the
      // highest snapshot below it: a document revised after an approval is draft again while its
      // last approved revision stays recorded, which is the state the spec's item 13 fixes.
      const approved = doc.status === "approved"
        ? current
        : (numbers.filter((n) => n !== current).length ? Math.max(...numbers.filter((n) => n !== current)) : null);
      placed.set(doc.id, { doc, numbers, current, approved });
    }
  }

  // The revision rows exist by now, so the `doc` keys can name them. `current_revision` is not
  // deferrable and the rows are already in, so one pass is enough; a second run is a no-op
  // because both columns are written to the same values.
  for (const { doc, current, approved } of placed.values()) {
    await db.query("update zz.doc set current_revision = $2, approved_revision = $3 where id = $1",
      [doc.id, current, approved]);
  }

  // `doc_link`: what each document cites, and what each source supports. Both ends are resolved
  // here — a frozen copy cites from its parent's revision, at the number it was filed under — and
  // `writeLinks` writes the rows and reports the citations nothing answers.
  const index = new Map([...placed.values()].map((p) => [p.doc.id, p]));
  const links: Link[] = [];
  for (const doc of docs) {
    const teamDocs = byTeam.get(doc.team_slug) ?? [];
    let fromId = doc.id;
    let fromRevision = placed.get(doc.id)?.current;
    if (isSnapshotPath(doc.path)) {
      const { parent, revision } = snapshotParent(teamDocs, doc);
      if (!parent) {
        report.refusals.push(`${doc.team_slug}/${doc.initiative}/${doc.path}: no parent document in the index`);
        continue;
      }
      fromId = parent.id;
      fromRevision = placed.get(parent.id)?.numbers.includes(revision) ? revision : undefined;
    }
    if (fromRevision === undefined) continue;
    const where = `${doc.team_slug}/${doc.initiative}/${doc.path}`;
    for (const citedPath of doc.evidence ?? []) {
      const target = resolvePath(teamDocs, doc.initiative, citedPath);
      const held = target ? index.get(target.id) : undefined;
      links.push({ where, fromId, fromRevision, cited: citedPath, kind: "cites",
                   to: held ? { id: held.doc.id, revision: held.current } : null });
    }
    // A source names the documents it bears on, and the real store's `supports` holds more than one
    // — the flow writes `spec.md, plan.md` into the single frontmatter field — so it is read with
    // the same list reader `indexDoc` uses and becomes one link per named document.
    for (const supported of envelopeList(doc.supports ?? "")) {
      const target = resolvePath(teamDocs, doc.initiative, supported);
      const held = target ? index.get(target.id) : undefined;
      links.push({ where, fromId, fromRevision, cited: supported, kind: "supports",
                   to: held ? { id: held.doc.id, revision: null } : null });
    }
  }
  await writeLinks(db, links, report);

  await pinLegacy(db, placed, report,
    (doc, n) => revisionBytes(join(storeRoot, "teams", doc.team_slug), doc, n));
  await countStoreRecords(db, storeRoot, teamBySlug, report);
  return report;
}

/** One revision's bytes, re-read from the store the way the carry reads them. Null when the store
 *  does not hold them — which is exactly what `missing_legacy` means. */
function revisionBytes(teamDir: string, doc: DocRow, revision: number): string | null {
  const relPath = `${doc.initiative}/${doc.path}`;
  const current = join(teamDir, relPath);
  if (!existsSync(current)) return null;
  const bytes = readFileSync(current, "utf8");
  if (envelopeVersion(parseEnvelope(bytes)) === revision) return bytes;
  const snapshot = join(teamDir, doc.initiative, SNAPSHOT_DIR, snapshotName(doc.path, revision));
  if (existsSync(snapshot)) return readFileSync(snapshot, "utf8");
  return gitRevisions(teamDir, relPath).get(revision) ?? null;
}

/* ------------------------------------------------------------------------------- verification */

/**
 * The carry, verified by content hash, file for row — the `withArtifacts` step of
 * `scripts/rehearse/expect.ts`, and the only hook a pending migration has for the store.
 *
 * Returns one line for every disagreement and nothing at all when the store and the rows agree.
 * Deliberately re-reads BOTH sides rather than comparing against what `carryStore` returned, so a
 * carry that wrote the wrong bytes is caught by the bytes rather than by its own report.
 */
export async function verifyStore(db: Queryable, storeRoot: string): Promise<string[]> {
  const problems: string[] = [];
  const teamsDir = join(storeRoot, "teams");
  if (!existsSync(teamsDir)) return [`no store at ${teamsDir} — nothing was carried`];

  const known = new Set((await db.query<{ slug: string }>("select slug from zz.team")).rows.map((t) => t.slug));
  const docs = (await db.query<DocRow>(
    "select id, team_slug, initiative, path, status, evidence, supports from zz.doc")).rows;

  for (const team of readdirSync(teamsDir).sort()) {
    if (!known.has(team)) continue;
    const teamDir = join(teamsDir, team);
    for (const doc of docs.filter((d) => d.team_slug === team)) {
      if (isSnapshotPath(doc.path)) continue;
      const relPath = `${doc.initiative}/${doc.path}`;
      if (!existsSync(join(teamDir, relPath))) {
        problems.push(`${team}/${relPath}: the store has no such file, so its rows cannot be verified`);
        continue;
      }
      let derived: { current: number; revisions: Revision[] };
      try {
        derived = revisionsFor(teamDir, doc.initiative, doc.path);
      } catch (err) {
        problems.push(`${team}/${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const rows = (await db.query<{ revision: number; content_state: string; content_hash: string | null }>(
        "select revision, content_state, content_hash from zz.doc_revision where doc_id = $1", [doc.id])).rows;
      const byNumber = new Map(rows.map((r) => [r.revision, r]));
      for (const rev of derived.revisions) {
        const key = `${team}/${relPath} v${rev.number}`;
        // The frozen approval copy of the current revision diverging in its BODY is the one case
        // where a byte the store retained is not in the database at all: the divergence the store
        // really has — the close-time envelope stamp — is counted in the report instead.
        if (rev.frozen?.bodyDiffers) {
          problems.push(`${key}: a frozen approval copy of this revision holds a body the live file does not, and the working tree is what this revision stores`);
        }
        const row = byNumber.get(rev.number);
        if (!row) {
          problems.push(`${key}: the store holds this revision and no doc_revision row does`);
          continue;
        }
        byNumber.delete(rev.number);
        if (row.content_state !== rev.state) {
          problems.push(`${key}: the row says ${row.content_state} and the store says ${rev.state}`);
          continue;
        }
        if (rev.state === "retained") {
          const want = hashBytes(rev.held!.bytes);
          if (row.content_hash !== want) {
            problems.push(`${key}: content_hash ${row.content_hash} is not the hash of the bytes it came from (${want})`);
          }
        } else if (row.content_hash !== null) {
          problems.push(`${key}: a missing_legacy row carries content`);
        }
      }
      for (const orphan of byNumber.values()) {
        problems.push(`${team}/${relPath} v${orphan.revision}: a doc_revision row the store does not hold`);
      }
    }
  }

  const badKeys = (await db.query<{ n: string }>(
    `select count(*)::text as n from zz.doc d
      where (d.current_revision is not null
               and not exists (select 1 from zz.doc_revision r
                                where r.doc_id = d.id and r.revision = d.current_revision))
         or (d.approved_revision is not null
               and not exists (select 1 from zz.doc_revision r
                                where r.doc_id = d.id and r.revision = d.approved_revision))`)).rows;
  if (Number(badKeys[0]?.n ?? 0) > 0) {
    problems.push(`${badKeys[0].n} doc row(s) name a revision that has no doc_revision row`);
  }
  const dangling = (await db.query<{ n: string }>(
    `select count(*)::text as n from zz.doc_link l
      where not exists (select 1 from zz.doc_revision r
                         where r.doc_id = l.from_doc_id and r.revision = l.from_revision)`)).rows;
  if (Number(dangling[0]?.n ?? 0) > 0) {
    problems.push(`${dangling[0].n} doc_link row(s) name a from_revision that does not exist`);
  }
  return problems;
}

/* --------------------------------------------------------------------------------------- CLI */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  if (flag("--psql")) {
    console.error("store-migration REFUSED — this carry reaches the database over a connection, " +
      "not through psql; pass --database-url");
    process.exit(2);
  }
  const store = flag("--store") ?? process.env.ZZ_STORE_DIR;
  const url = flag("--database-url") || process.env.TEAM_DB_URL || process.env.PLATFORM_DB_URL;
  if (!store || !url) {
    console.error("usage: node scripts/store-migration.ts --store <dir> --database-url <url> [--dry-run]");
    process.exit(2);
  }
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("set search_path = ''");
    if (argv.includes("--dry-run")) {
      // The whole carry, run and thrown away: the report it prints is the one a real run would
      // write, so an operator can read it before anything lands.
      await client.query("begin");
      const preview = await carryStore(client, store);
      await client.query("rollback");
      for (const line of formatReport(preview)) console.log(line);
      console.log("store-migration: dry run — no row was written");
      return;
    }
    const report = await carryStore(client, store);
    for (const line of formatReport(report)) console.log(line);
    const problems = await verifyStore(client, store);
    for (const p of problems) console.error(`store-migration: DISAGREES — ${p}`);
    if (problems.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("store-migration.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}