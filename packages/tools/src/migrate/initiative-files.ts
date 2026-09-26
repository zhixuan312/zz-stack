/**
 * migrate/initiative-files — one-shot backfill of `zz.initiative`'s lifecycle columns (Task
 * I-8, ← AC-3.1) from the file-only record of them, which is the sole authority for lifecycle
 * until Phase 6 folds this migration into `001_init.sql`.
 *
 *   zz-tool migrate-initiative-files --store /artifacts
 *   zz-tool migrate-initiative-files --store /artifacts --psql '<command>' --dry-run
 *
 * For every `teams/<team>/<initiative>/` folder: the top-level document whose envelope carries
 * an `outcome` is the closing envelope (an initiative closes once, so there is at most one).
 * Its `outcome`, `closed_by`, `accepted_by`/`no_signoff_reason` are carried onto the matching
 * `zz.initiative` row, and `closed_at` is the `ts` of that team and slug's successful
 * `initiative_close` event, or — when no event was recorded — the closing document's own
 * `updated_at` in `zz.doc`. An initiative abandoned before it held any document at all (an
 * empty freeform open, undone) carries no closing document; its `_open.json` record of
 * `abandoned_at`/`abandoned_by` is the only evidence and is read the same way.
 *
 * `_open.json` (only present where `initiative_open` wrote one) additionally fills
 * `opened_by`, `opened_at` (kept at the earlier of the two dates) and `flow`.
 *
 * Only null columns are ever written, and the closing envelope's five columns are set together
 * or not at all — guarded by `where outcome is null` so a second run of this tool changes
 * nothing. An email that names no `zz.principal` is reported and left null; for `closed_by`
 * this means the row cannot be closed at all (its CHECK ties `closed_by` to `closed_at` and
 * `outcome` moving together), so that case is reported rather than attempted.
 *
 * Read via `--psql` (`packages/tools/src/lib/psql.js`, the convention every tool here follows)
 * for the one-shot run through `deploy/zz-tool`, and via a plain `{ query }` object — a real
 * `pg.Client` satisfies it without this file importing `pg` — for `scripts/rehearse/expect.ts`,
 * which runs this in-process against the throwaway database a rehearsal already has open.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OUTCOMES, parseEnvelope } from "@zz/contracts";

import { die, parseArgs, required } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlText, psqlTry } from "../lib/psql.js";

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const nlit = (s: string | null): string => (s === null ? "null" : lit(s));

// -- The store, read as plain files -----------------------------------------------------------

interface OpenRecord {
  opened_by?: string;
  opened_at?: string;
  flow?: string | null;
  abandoned_by?: string;
  abandoned_at?: string;
}

interface ClosingDoc {
  path: string;
  outcome: string;
  closedByEmail: string;
  acceptedBy: string | null;
  noSignoffReason: string | null;
}

interface Folder {
  team: string;
  slug: string;
  open: OpenRecord | null;
  closingCandidates: ClosingDoc[];
  hasDocument: boolean;
}

function readOpenRecord(dir: string): OpenRecord | null {
  const file = join(dir, "_open.json");
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as OpenRecord) : null;
  } catch {
    return null;
  }
}

/** Every top-level `.md` file's envelope that carries an `outcome` — ignoring `_versions/` and
 *  `sources/`, which are never walked because this reads direct entries only. */
function findClosingDocs(dir: string): { candidates: ClosingDoc[]; hasDocument: boolean } {
  let hasDocument = false;
  const candidates: ClosingDoc[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    hasDocument = true;
    const env = parseEnvelope(readFileSync(join(dir, e.name), "utf8"));
    if (!env.outcome) continue;
    candidates.push({
      path: e.name,
      outcome: env.outcome,
      closedByEmail: env.closed_by ?? "",
      acceptedBy: env.accepted_by || null,
      noSignoffReason: env.no_signoff_reason || null,
    });
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));
  return { candidates, hasDocument };
}

/** `<store>/teams/<team>/<initiative>/` for every team and every initiative — the same shape
 *  `deploy/backup.sh` tars up and `manifest-audit` reads one team of, generalised to all of
 *  them since this backfill runs once over the whole platform. Underscore- and dot-prefixed
 *  entries are the store's own reserved names (`_knowledge`, `.git`), never an initiative. */
function scanStore(storeRoot: string): Folder[] {
  const teamsDir = join(storeRoot, "teams");
  const out: Folder[] = [];
  if (!existsSync(teamsDir)) return out;
  for (const teamEnt of readdirSync(teamsDir, { withFileTypes: true })) {
    if (!teamEnt.isDirectory()) continue;
    const teamDir = join(teamsDir, teamEnt.name);
    for (const initEnt of readdirSync(teamDir, { withFileTypes: true })) {
      if (!initEnt.isDirectory() || initEnt.name.startsWith("_") || initEnt.name.startsWith(".")) continue;
      const dir = join(teamDir, initEnt.name);
      const { candidates, hasDocument } = findClosingDocs(dir);
      out.push({ team: teamEnt.name, slug: initEnt.name, open: readOpenRecord(dir), closingCandidates: candidates, hasDocument });
    }
  }
  return out;
}

// -- The database, read and written through one small interface -------------------------------

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface Db {
  teamId(slug: string): Promise<string | null>;
  principalId(email: string): Promise<string | null>;
  initiativeOutcome(teamId: string, slug: string): Promise<{ exists: boolean; outcome: string | null }>;
  closeEventAt(teamSlug: string, initiative: string): Promise<string | null>;
  docUpdatedAt(teamSlug: string, initiative: string, path: string): Promise<string | null>;
  fillOpenFields(teamId: string, slug: string, openedById: string | null,
                 openedAt: string | null, flow: string | null): Promise<number>;
  closeInitiative(teamId: string, slug: string, outcome: string, closedById: string, closedAt: string,
                  acceptedBy: string | null, noSignoffReason: string | null):
    Promise<{ ok: true; changed: number } | { ok: false; error: string }>;
}

/** A real `pg.Client` (or `pg.Pool`) satisfies this structurally — nothing here imports `pg`,
 *  so `scripts/rehearse/expect.ts` can hand its already-connected client straight in. */
export function pgClientDb(client: Queryable): Db {
  return {
    async teamId(slug) {
      const { rows } = await client.query<{ id: string }>(`select id from zz.team where slug = $1`, [slug]);
      return rows[0]?.id ?? null;
    },
    async principalId(email) {
      const { rows } = await client.query<{ id: string }>(`select id from zz.principal where email = $1`, [email]);
      return rows[0]?.id ?? null;
    },
    async initiativeOutcome(teamId, slug) {
      const { rows } = await client.query<{ outcome: string | null }>(
        `select outcome from zz.initiative where team_id = $1 and slug = $2`, [teamId, slug]);
      return rows.length ? { exists: true, outcome: rows[0].outcome } : { exists: false, outcome: null };
    },
    async closeEventAt(teamSlug, initiative) {
      const { rows } = await client.query<{ ts: string | null }>(
        `select min(ts) as ts from zz.event
          where team_slug = $1 and initiative = $2 and ok
            and coalesce(tool_key, subject) = 'core:initiative_close'`,
        [teamSlug, initiative]);
      return rows[0]?.ts ?? null;
    },
    async docUpdatedAt(teamSlug, initiative, path) {
      const { rows } = await client.query<{ updated_at: string | null }>(
        `select updated_at from zz.doc where team_slug = $1 and initiative = $2 and path = $3 limit 1`,
        [teamSlug, initiative, path]);
      return rows[0]?.updated_at ?? null;
    },
    async fillOpenFields(teamId, slug, openedById, openedAt, flow) {
      const { rows } = await client.query<{ n: number }>(
        `with upd as (
           update zz.initiative
              set opened_by = coalesce(opened_by, $3),
                  opened_at = least(opened_at, coalesce($4::timestamptz, opened_at)),
                  flow = coalesce(flow, $5)
            where team_id = $1 and slug = $2
              and (opened_by is distinct from coalesce(opened_by, $3)
                or opened_at is distinct from least(opened_at, coalesce($4::timestamptz, opened_at))
                or flow is distinct from coalesce(flow, $5))
           returning id
         )
         select count(*)::int as n from upd`,
        [teamId, slug, openedById, openedAt, flow]);
      return rows[0]?.n ?? 0;
    },
    async closeInitiative(teamId, slug, outcome, closedById, closedAt, acceptedBy, noSignoffReason) {
      try {
        const { rows } = await client.query<{ n: number }>(
          `with upd as (
             update zz.initiative
                set outcome = $3,
                    closed_by = $4,
                    closed_at = coalesce(closed_at, $5::timestamptz),
                    accepted_by = coalesce(accepted_by, $6),
                    no_signoff_reason = coalesce(no_signoff_reason, $7)
              where team_id = $1 and slug = $2 and outcome is null
             returning id
           )
           select count(*)::int as n from upd`,
          [teamId, slug, outcome, closedById, closedAt, acceptedBy, noSignoffReason]);
        return { ok: true, changed: rows[0]?.n ?? 0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** The same `Db`, reached the way every other tool here reaches the deployment's database: a
 *  `psql` command, one statement at a time, values escaped rather than bound — `psqlText` for a
 *  read that cannot fail, `psqlTry` for the two writes, which can hit a CHECK. */
function psqlDb(psql: string): Db {
  return {
    async teamId(slug) {
      return psqlText(psql, `select id from zz.team where slug = ${lit(slug)};`).trim() || null;
    },
    async principalId(email) {
      return psqlText(psql, `select id from zz.principal where email = ${lit(email)};`).trim() || null;
    },
    async initiativeOutcome(teamId, slug) {
      // Prefixed with a marker so an empty (null) outcome on a real row cannot be mistaken for
      // no row at all — both would otherwise print as the empty string under `-tA`.
      const out = psqlText(psql,
        `select '1|' || coalesce(outcome, '') from zz.initiative
          where team_id = ${lit(teamId)} and slug = ${lit(slug)};`);
      if (!out) return { exists: false, outcome: null };
      return { exists: true, outcome: out.slice(2) || null };
    },
    async closeEventAt(teamSlug, initiative) {
      const out = psqlText(psql,
        `select coalesce(min(ts)::text, '') from zz.event
          where team_slug = ${lit(teamSlug)} and initiative = ${lit(initiative)} and ok
            and coalesce(tool_key, subject) = 'core:initiative_close';`);
      return out || null;
    },
    async docUpdatedAt(teamSlug, initiative, path) {
      const out = psqlText(psql,
        `select coalesce(updated_at::text, '') from zz.doc
          where team_slug = ${lit(teamSlug)} and initiative = ${lit(initiative)} and path = ${lit(path)}
          limit 1;`);
      return out || null;
    },
    async fillOpenFields(teamId, slug, openedById, openedAt, flow) {
      const openedAtSql = openedAt === null ? "null" : `${lit(openedAt)}::timestamptz`;
      const res = psqlTry(psql, `
        with upd as (
          update zz.initiative
             set opened_by = coalesce(opened_by, ${nlit(openedById)}),
                 opened_at = least(opened_at, coalesce(${openedAtSql}, opened_at)),
                 flow = coalesce(flow, ${nlit(flow)})
           where team_id = ${lit(teamId)} and slug = ${lit(slug)}
             and (opened_by is distinct from coalesce(opened_by, ${nlit(openedById)})
               or opened_at is distinct from least(opened_at, coalesce(${openedAtSql}, opened_at))
               or flow is distinct from coalesce(flow, ${nlit(flow)}))
          returning id
        )
        select count(*)::int from upd;`);
      if (!res.ok) throw new Error(res.error);
      return Number.parseInt(res.text.trim(), 10) || 0;
    },
    async closeInitiative(teamId, slug, outcome, closedById, closedAt, acceptedBy, noSignoffReason) {
      const res = psqlTry(psql, `
        with upd as (
          update zz.initiative
             set outcome = ${lit(outcome)},
                 closed_by = ${lit(closedById)},
                 closed_at = coalesce(closed_at, ${lit(closedAt)}::timestamptz),
                 accepted_by = coalesce(accepted_by, ${nlit(acceptedBy)}),
                 no_signoff_reason = coalesce(no_signoff_reason, ${nlit(noSignoffReason)})
           where team_id = ${lit(teamId)} and slug = ${lit(slug)} and outcome is null
          returning id
        )
        select count(*)::int from upd;`);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, changed: Number.parseInt(res.text.trim(), 10) || 0 };
    },
  };
}

// -- The backfill itself, shared by the CLI and the rehearsal step -----------------------------

export interface Report {
  /** Rows this run actually flipped from open to closed. */
  closedNow: number;
  closedNowByOutcome: Record<string, number>;
  /** Rows a previous run (or the live platform, once Phase 6 lands) had already closed. */
  alreadyClosed: number;
  /** Folders that carried a closing outcome — envelope or doc-less abandon — of some kind,
   *  whether this run closed them, found them already closed, or could not close them. The
   *  declared join: this must equal `closedNow + alreadyClosed + blocked.length`. */
  closeAttempts: number;
  /** `_open.json` present and at least one of its fields changed a row. */
  openFieldsFilled: number;
  /** A folder with no matching `zz.team`/`zz.initiative` row — nothing to write onto. */
  unmatchedFolders: string[];
  /** An email — `opened_by` or `closed_by` — naming no `zz.principal`. Every one of these also
   *  counts toward `blocked` when it was `closed_by`, since that row cannot close at all. */
  unmatchedEmails: string[];
  /** A close attempt refused: bad data (outcome not one of the three, `accepted` with no
   *  acceptor, both `accepted_by` and `no_signoff_reason`) or a CHECK the database itself
   *  refused. */
  violations: string[];
  /** `unmatchedEmails` naming a `closed_by`, plus `violations` — the closing attempts that
   *  could not be applied. Kept apart from `violations` because the join has to count both. */
  blocked: number;
}

function emptyReport(): Report {
  return { closedNow: 0, closedNowByOutcome: {}, alreadyClosed: 0, closeAttempts: 0,
           openFieldsFilled: 0, unmatchedFolders: [], unmatchedEmails: [], violations: [], blocked: 0 };
}

/** The one closing outcome a folder carries, if any: its document's envelope, or — for an
 *  initiative that never held one — `_open.json`'s own record of having been abandoned.
 *  `initiative_close` only ever writes that record when the folder holds no `.md` file at all
 *  (an empty freeform open, undone), so the two sources never both apply. */
function effectiveClose(folder: Folder, violations: string[]):
    { outcome: string; closedByEmail: string; acceptedBy: string | null; noSignoffReason: string | null;
      path: string | null; closedAtOverride: string | null } | null {
  if (folder.closingCandidates.length > 1) {
    violations.push(`${folder.team}/${folder.slug}: ${folder.closingCandidates.length} top-level documents ` +
      `carry an outcome (${folder.closingCandidates.map((c) => c.path).join(", ")}) — an initiative closes ` +
      "once, so this cannot be resolved automatically, skipped");
    return null;
  }
  const doc = folder.closingCandidates[0];
  if (doc) {
    return { outcome: doc.outcome, closedByEmail: doc.closedByEmail, acceptedBy: doc.acceptedBy,
             noSignoffReason: doc.noSignoffReason, path: doc.path, closedAtOverride: null };
  }
  if (!folder.hasDocument && folder.open?.abandoned_at) {
    return { outcome: "abandoned", closedByEmail: folder.open.abandoned_by ?? "", acceptedBy: null,
             noSignoffReason: null, path: null, closedAtOverride: folder.open.abandoned_at };
  }
  return null;
}

export async function backfill(db: Db, storeRoot: string, opts: { dryRun?: boolean } = {}): Promise<Report> {
  const report = emptyReport();
  const teamIds = new Map<string, string | null>();
  const principalIds = new Map<string, string | null>();
  const teamIdFor = async (slug: string): Promise<string | null> => {
    if (!teamIds.has(slug)) teamIds.set(slug, await db.teamId(slug));
    return teamIds.get(slug) ?? null;
  };
  const principalIdFor = async (email: string): Promise<string | null> => {
    const key = email.trim().toLowerCase();
    if (!principalIds.has(key)) principalIds.set(key, await db.principalId(email));
    return principalIds.get(key) ?? null;
  };

  for (const folder of scanStore(storeRoot)) {
    const teamId = await teamIdFor(folder.team);
    if (!teamId) {
      report.unmatchedFolders.push(`${folder.team}/${folder.slug}: no zz.team row for '${folder.team}'`);
      continue;
    }
    const existing = await db.initiativeOutcome(teamId, folder.slug);
    if (!existing.exists) {
      report.unmatchedFolders.push(`${folder.team}/${folder.slug}: no zz.initiative row`);
      continue;
    }

    if (folder.open && !opts.dryRun) {
      const openedByEmail = folder.open.opened_by ?? "";
      const openedById = openedByEmail ? await principalIdFor(openedByEmail) : null;
      if (openedByEmail && !openedById) {
        report.unmatchedEmails.push(`${folder.team}/${folder.slug}: opened_by ${openedByEmail} has no principal — left null`);
      }
      const n = await db.fillOpenFields(teamId, folder.slug, openedById, folder.open.opened_at || null, folder.open.flow || null);
      if (n > 0) report.openFieldsFilled++;
    }

    const effective = effectiveClose(folder, report.violations);
    if (!effective) continue;
    report.closeAttempts++;
    if (existing.outcome) {
      report.alreadyClosed++;
      continue;
    }

    if (!(OUTCOMES as readonly string[]).includes(effective.outcome)) {
      report.violations.push(`${folder.team}/${folder.slug}: outcome '${effective.outcome}' is not one this platform records — skipped`);
      report.blocked++;
      continue;
    }
    if (effective.outcome === "accepted" && !effective.acceptedBy) {
      report.violations.push(`${folder.team}/${folder.slug}: outcome accepted with no accepted_by — skipped`);
      report.blocked++;
      continue;
    }
    if (effective.acceptedBy && effective.noSignoffReason) {
      report.violations.push(`${folder.team}/${folder.slug}: both accepted_by and no_signoff_reason set — skipped`);
      report.blocked++;
      continue;
    }
    if (!effective.closedByEmail) {
      report.violations.push(`${folder.team}/${folder.slug}: closing envelope names no closed_by — skipped`);
      report.blocked++;
      continue;
    }
    const closedById = await principalIdFor(effective.closedByEmail);
    if (!closedById) {
      report.unmatchedEmails.push(`${folder.team}/${folder.slug}: closed_by ${effective.closedByEmail} has no ` +
        "principal — cannot close (its CHECK ties closed_by to closed_at/outcome), left open");
      report.blocked++;
      continue;
    }
    const closedAt = effective.closedAtOverride
      ?? await db.closeEventAt(folder.team, folder.slug)
      ?? (effective.path ? await db.docUpdatedAt(folder.team, folder.slug, effective.path) : null);
    if (!closedAt) {
      report.violations.push(`${folder.team}/${folder.slug}: no successful initiative_close event and no ` +
        `zz.doc row for ${effective.path ?? "(no document)"} — cannot derive closed_at, skipped`);
      report.blocked++;
      continue;
    }

    if (opts.dryRun) {
      report.closedNow++;
      report.closedNowByOutcome[effective.outcome] = (report.closedNowByOutcome[effective.outcome] ?? 0) + 1;
      continue;
    }
    const applied = await db.closeInitiative(teamId, folder.slug, effective.outcome, closedById, closedAt,
      effective.acceptedBy, effective.noSignoffReason);
    if (!applied.ok) {
      report.violations.push(`${folder.team}/${folder.slug}: ${applied.error}`);
      report.blocked++;
      continue;
    }
    if (applied.changed > 0) {
      report.closedNow++;
      report.closedNowByOutcome[effective.outcome] = (report.closedNowByOutcome[effective.outcome] ?? 0) + 1;
    } else {
      // Raced with something else that closed it between the read above and this write — not a
      // defect, just counted where the state actually landed.
      report.alreadyClosed++;
    }
  }
  return report;
}

// -- CLI ----------------------------------------------------------------------------------------

function printReport(report: Report, dryRun: boolean): void {
  const verb = dryRun ? "would close" : "closed";
  console.log(`\n  ${verb} ${report.closedNow} initiative(s)${dryRun ? "" : " this run"}, ` +
              `${report.alreadyClosed} already closed, ${report.openFieldsFilled} initiative(s) gained ` +
              "opened_by/opened_at/flow\n");
  for (const [outcome, n] of Object.entries(report.closedNowByOutcome).sort()) console.log(`    ${outcome.padEnd(12)} ${n}`);
  if (report.unmatchedFolders.length) {
    console.log(`\n  ${report.unmatchedFolders.length} folder(s) with no matching database row:`);
    for (const line of report.unmatchedFolders) console.log(`    ${line}`);
  }
  if (report.unmatchedEmails.length) {
    console.log(`\n  ${report.unmatchedEmails.length} email(s) with no principal:`);
    for (const line of report.unmatchedEmails) console.log(`    ${line}`);
  }
  if (report.violations.length) {
    console.log(`\n  ${report.violations.length} closing attempt(s) could not be applied:`);
    for (const line of report.violations) console.log(`    ${line}`);
  }
  console.log(`\n  join: ${report.closeAttempts} closing outcome(s) found in the store = ` +
              `${report.closedNow} closed + ${report.alreadyClosed} already closed + ${report.blocked} blocked\n`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, ["dry-run"]);
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const store = required(args, "store", "the artifacts root containing teams/<team>/<initiative>/…");
  if (!existsSync(store)) die(`--store ${store} does not exist`);
  const dryRun = args.flags.has("dry-run");

  const report = await backfill(psqlDb(psql), store, { dryRun });
  printReport(report, dryRun);
  const held = report.closeAttempts === report.closedNow + report.alreadyClosed + report.blocked;
  if (!held) {
    console.error("  join violated: accounted for fewer closing outcomes than the store carries\n");
    return 1;
  }
  return 0;
}

// Guarded, not the bare `process.exit(main(...))` every other tool here ends with: this module
// is also imported in-process, by `scripts/rehearse/expect.ts`, and an unconditional call would
// exit that process the moment it loaded this file.
if (process.argv[1]?.endsWith("initiative-files.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(String((err as Error)?.message ?? err));
      process.exit(2);
    });
}
