/**
 * The spec's eight-step restore/cutover procedure, as code.
 *
 * COUPLED: `validateBackupManifest` stays in `deployment.ts` because
 * `checks/backup-covers-the-undisposable.ts` is frozen at that import path. Everything else the
 * rehearsal needs lives here, as a sibling module that is not itself a suite
 * (`availableSuiteNames()` filters by `SUITE_NAMES`).
 *
 * The split that matters is inside this file: the top half is pure decision functions over plain
 * records, the bottom half is the only code that opens a socket. Keeping the eight steps'
 * judgements pure is what lets them be tested without standing up a deployment.
 *
 * The live halves read their environment, find it absent, and report `not_run` naming exactly
 * what is missing — a real rehearsal needs a second host, protected backup bytes and an operator
 * with authority over both. `deploy/RESTORE-AND-CUTOVER.md` carries the commands.
 *
 * A `not_run` is the difference between "we did not verify this" and "we verified this", written
 * where a reader of `acceptance.json` cannot mistake one for the other.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { connectIsolated } from "../../packages/indexing/dist/tenant-projections.js";

// ═══════════════════════════ the pure half: what the procedure decides ═══════════════════

export interface Verdict {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Step 3 — "Enter maintenance on every mutation path, including background work and old
 * clients; drain in-flight writes and record final file-commit watermark and platform-DB
 * snapshot boundary. Verify no active writer remains."
 *
 * The three kinds are required by name, not counted: a drain that put the request path into
 * maintenance and left background jobs running is invisible to a check that asks only whether
 * the declared paths are quiet. A deployment that grows a fourth mutation path adds it here.
 */
const REQUIRED_MUTATION_PATHS = ["request", "background", "legacy_client"] as const;

export function evaluateDrain(observation: unknown): Verdict {
  if (!isRecord(observation)) return { ok: false, issues: ["drain observation must be an object"] };
  const issues: string[] = [];

  const paths = observation.mutation_paths;
  if (!Array.isArray(paths)) {
    issues.push("mutation_paths must be an array, one entry per mutation path");
  } else {
    const seen = new Set<string>();
    for (const entry of paths) {
      if (!isRecord(entry) || typeof entry.kind !== "string") {
        issues.push("every mutation_paths entry must be an object carrying a string kind");
        continue;
      }
      seen.add(entry.kind);
      if (entry.maintenance !== true) {
        issues.push(`mutation path ${entry.kind} is not in maintenance`);
      }
      // In-flight is counted, not asserted absent: `undefined` is not zero, and a probe that
      // failed to report would otherwise read as a successful drain.
      if (typeof entry.in_flight !== "number" || !Number.isInteger(entry.in_flight)) {
        issues.push(`mutation path ${entry.kind} did not report an integer in_flight count`);
      } else if (entry.in_flight !== 0) {
        issues.push(`mutation path ${entry.kind} still has in-flight writes`);
      }
    }
    for (const required of REQUIRED_MUTATION_PATHS) {
      if (!seen.has(required)) issues.push(`no drain observation for the ${required} mutation path`);
    }
  }

  if (observation.active_writers !== 0) {
    issues.push("active_writers must be observed as exactly 0 — 'no active writer remains' is a measurement, not an assumption");
  }

  // The two boundaries step 3 requires be recorded. Without them step 8 has nothing to recover
  // forward from, and step 6 has no snapshot to be after.
  if (typeof observation.file_commit_watermark !== "string" || !COMMIT_RE.test(observation.file_commit_watermark)) {
    issues.push("file_commit_watermark must be a 40-character commit hash");
  }
  if (typeof observation.platform_snapshot_boundary !== "string" || observation.platform_snapshot_boundary.trim() === "") {
    issues.push("platform_snapshot_boundary must be a non-empty database snapshot boundary");
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Step 7 — "Switch traffic as one matched application image + database + artifact-volume unit",
 * step 5's "a separate new artifact volume", and the contract's "no hardcoded
 * deploy_zz-artifacts volume name or in-place PG16 data-directory reuse".
 *
 * All three identities must differ from the old unit's. A new application image pointed at the
 * old artifact volume is an in-place upgrade, and it destroys the intact old unit step 8's
 * rollback needs.
 */
export function evaluateMatchedUnit(observation: unknown): Verdict {
  if (!isRecord(observation)) return { ok: false, issues: ["matched-unit observation must be an object"] };
  const issues: string[] = [];
  const oldUnit = observation.old_unit;
  const newUnit = observation.new_unit;
  if (!isRecord(oldUnit) || !isRecord(newUnit)) {
    return { ok: false, issues: ["both old_unit and new_unit must be objects"] };
  }

  for (const field of ["app_image_digest", "database_identity", "artifact_volume"] as const) {
    const before = oldUnit[field];
    const after = newUnit[field];
    if (typeof before !== "string" || before.trim() === "") { issues.push(`old_unit.${field} is missing`); continue; }
    if (typeof after !== "string" || after.trim() === "") { issues.push(`new_unit.${field} is missing`); continue; }
    if (before === after) issues.push(`new_unit.${field} is the old unit's — a matched switch replaces all three together`);
  }

  // "Resolve volume IDs from the actual Compose project, never hardcode deploy_zz-artifacts."
  // Both halves: the literal name is refused wherever it appears, and the observation has to say
  // the name was resolved rather than typed.
  for (const [label, unit] of [["old_unit", oldUnit], ["new_unit", newUnit]] as const) {
    if (typeof unit.artifact_volume === "string" && unit.artifact_volume.includes("deploy_zz-artifacts")) {
      issues.push(`${label}.artifact_volume is the hardcoded deploy_zz-artifacts name`);
    }
  }
  if (observation.volumes_resolved_from_compose_project !== true) {
    issues.push("volume IDs must be resolved from the actual Compose project, and the observation does not say they were");
  }

  // "Use logical dump/restore into a new PG17 cluster, never mount a PG16 data directory
  // into another major."
  if (newUnit.postgres_major !== 17) issues.push("new_unit.postgres_major must be 17");
  if (newUnit.data_directory_reused !== false) {
    issues.push("new_unit must not reuse an existing data directory — the restore is logical, into a new cluster");
  }

  // "Keep old deployment/volumes isolated read-only."
  if (oldUnit.read_only !== true) issues.push("old_unit must remain isolated read-only after the switch");

  // "Rehearse ... with outbound integrations disabled."
  if (observation.outbound_integrations_disabled !== true) {
    issues.push("outbound integrations must be disabled for a rehearsal");
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Step 8 — "Before any new write, rollback can return to the matched old app/DB/volume
 * snapshot. After writes resume, rollback means forward recovery: freeze, preserve all new file
 * commits and platform DB changes, repair/restore a compatible PG17 deployment and replay.
 * Never drop new writes by returning to stale PG16."
 *
 * `post_resume_write_ref` must appear in `recovered_write_refs`. Everything else here is the
 * operator describing their own plan; that one field is the plan's outcome, and the live case
 * below reads the row back out of the recovered database rather than taking their word.
 */
export function evaluateForwardRecovery(observation: unknown): Verdict {
  if (!isRecord(observation)) return { ok: false, issues: ["forward-recovery observation must be an object"] };
  const issues: string[] = [];

  if (observation.strategy !== "forward_recovery") {
    issues.push("once writes have resumed the only permitted rollback is forward_recovery — returning to the old snapshot drops every resumed write");
  }
  if (observation.target_postgres_major !== 17) {
    issues.push("forward recovery replays onto a compatible PG17 deployment, never back onto stale PG16");
  }

  // The moment writes were resumed. Without it "the write survived" is unfalsifiable: any
  // surviving write at all would do, including one made before the freeze.
  if (typeof observation.resume_boundary_at !== "string" || Number.isNaN(Date.parse(observation.resume_boundary_at))) {
    issues.push("resume_boundary_at must be a parseable timestamp marking when writes resumed");
  }

  const ref = observation.post_resume_write_ref;
  if (typeof ref !== "string" || ref.trim() === "") {
    issues.push("post_resume_write_ref must name the transaction of the first acknowledged write after the resume boundary");
  } else {
    const recovered = observation.recovered_write_refs;
    if (!Array.isArray(recovered)) issues.push("recovered_write_refs must be an array");
    else if (!recovered.includes(ref)) issues.push("the first acknowledged post-resume write did not survive forward recovery");
  }

  // "preserve all new file commits AND platform database changes" — both halves, because a
  // recovery that kept the database and lost the git commits has lost a team's history, and
  // one that kept the files and lost the platform rows has lost every grant and credential.
  const commits = observation.new_file_commits;
  const recoveredCommits = observation.recovered_file_commits;
  if (!Array.isArray(commits) || !Array.isArray(recoveredCommits)) {
    issues.push("new_file_commits and recovered_file_commits must both be arrays");
  } else {
    const have = new Set(recoveredCommits);
    const lost = commits.filter((c) => !have.has(c));
    if (lost.length > 0) issues.push(`${lost.length} new file commit(s) were not preserved by forward recovery`);
  }
  if (observation.platform_db_changes_preserved !== true) {
    issues.push("platform database changes made after the resume boundary must be preserved");
  }
  return { ok: issues.length === 0, issues };
}

// ═════════════════════ where the isolated copy may and may not point ═════════════════════

const ISOLATED_DB_ENV = "ZZ_TENANT_INFO_ISOLATED_DB_URL";
const BACKUP_MANIFEST_ENV = "ZZ_TENANT_INFO_BACKUP_MANIFEST";
const CUTOVER_OBSERVATIONS_ENV = "ZZ_TENANT_INFO_CUTOVER_OBSERVATIONS";

/**
 * The one variable that names a database, and everything it may not be.
 *
 * COUPLED: `rebuild.ts` and `isolation.ts` read this same name for the same requirement. A reason
 * is returned rather than a boolean because every caller reports `not_run` with it and a reader
 * needs to know which of the three refusals fired.
 *
 * `TEAM_DB_URL` and `PLATFORM_DB_URL` are never inferred from, though they are set on every
 * machine that runs this platform, including one holding live data. An operator who wants this
 * to run sets this variable at the isolated copy on purpose.
 */
export function isolatedDatabaseRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = (env[ISOLATED_DB_ENV] ?? "").trim();
  if (url === "") {
    return `${ISOLATED_DB_ENV} is not set. This case runs only against an operator-provided isolated `
      + "PostgreSQL 17 copy with pg_textsearch and the schema applied, restored from a protected "
      + "off-host backup. deploy/RESTORE-AND-CUTOVER.md is the procedure that produces one.";
  }
  for (const forbidden of ["TEAM_DB_URL", "PLATFORM_DB_URL"] as const) {
    if (url === (env[forbidden] ?? "").trim() && url !== "") {
      return `${ISOLATED_DB_ENV} is set to the same database as ${forbidden}. The isolated copy is never `
        + "the live cluster and is never inferred from either of those variables — point it at the "
        + "restored copy, or leave it unset and let this case report not_run.";
    }
  }
  return null;
}

// ═══════════════════════════ the live half: the only sockets here ════════════════════════

export interface CaseResult {
  readonly status: "passed" | "failed" | "not_run";
  readonly reason?: string;
}

function notRun(reason: string): CaseResult {
  return { status: "not_run", reason };
}

function failed(err: unknown): CaseResult {
  return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
}

/** Every zz table whose loss cannot be reconstructed from a team's Markdown, which is the
 *  whole reason step 5 says to restore identity/grants/credentials/platform records "from
 *  their own protected backups, not tenant Markdown". */
const SECURITY_TABLES = ["principal", "team", "membership", "pat"] as const;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * `restore` — step 1 and step 4's "verify integrity and restoration", against real bytes.
 *
 * Resolves every component the manifest declares, hashes the actual file, compares it to the
 * declared hash, then asks the restored database what came back. `validateBackupManifest` proves
 * only that a manifest is well-formed, which is not restoration evidence.
 */
export async function caseProtectedBackupRestoresIntoACleanTarget(
  // DELIBERATE: the validator arrives as an argument, so this module imports nothing from
  // `deployment.ts`. `validateBackupManifest` must live there — a frozen check pins it to that
  // path — and `deployment.ts` imports the cases from here, so importing back would close a
  // cycle between two modules a dynamic `import()` loads at suite time.
  validate: (report: unknown) => Verdict,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaseResult> {
  const dbRefusal = isolatedDatabaseRefusal(env);
  if (dbRefusal !== null) return notRun(dbRefusal);
  const manifestPath = (env[BACKUP_MANIFEST_ENV] ?? "").trim();
  if (manifestPath === "") {
    return notRun(
      `${BACKUP_MANIFEST_ENV} is not set. This case hashes the real backup bytes the manifest names, `
      + "so it needs the manifest deploy/backup-manifest.sh wrote beside an off-host copy of a "
      + "completed backup set. See deploy/RESTORE-AND-CUTOVER.md step 2.");
  }

  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    const validation = validate(manifest);
    assert.equal(validation.ok, true, `the backup manifest is not valid: ${validation.issues.join("; ")}`);

    // A locator is `protected:<basename>`, resolved against the directory the manifest sits in.
    // It carries no path and no credential — `validateBackupManifest` refuses anything else —
    // which keeps a backup report from printing a connection string on its way to reporting a
    // hash mismatch.
    const dir = dirname(manifestPath);
    const components = (manifest as { components: readonly { kind: string; locator: string; sha256: string }[] }).components;
    for (const component of components) {
      const file = join(dir, basename(component.locator.slice("protected:".length)));
      assert.equal(statSync(file).isFile(), true, `the ${component.kind} component is not a file`);
      assert.equal(sha256File(file), component.sha256,
        `the ${component.kind} component's bytes do not hash to the manifest's value — an incomplete or altered dump is fatal, never a warning`);
    }

    const client = await connectIsolated((env[ISOLATED_DB_ENV] ?? "").trim());
    try {
      // "verify full database row counts/FKs/representative hashes and functional
      // identity/credential recovery without exposing secrets"
      for (const table of SECURITY_TABLES) {
        const rows = await client.query<{ n: string }>(
          `select count(*)::text as n from zz.${table}`);
        assert.equal(Number(rows.rows[0]?.n) > 0, true,
          `zz.${table} restored empty — identity truth is not reconstructible from tenant Markdown`);
      }
      // The FKs `001_init.sql` declares on zz.membership, asked as data rather than as
      // catalog metadata: a dump restored with constraints disabled reports every constraint
      // present and can still carry a membership whose principal never came back.
      const orphans = await client.query<{ n: string }>(
        `select count(*)::text as n from zz.membership m
          where not exists (select 1 from zz.principal p where p.id = m.principal_id)
             or not exists (select 1 from zz.team t where t.id = m.team_id)`);
      assert.equal(orphans.rows[0]?.n, "0", "zz.membership carries rows whose principal or team did not restore");

      // Functional, not present: a `pat` row that restored as bytes but whose hash column is
      // null authenticates nobody. The value is never selected — only whether it is usable.
      const usablePats = await client.query<{ n: string }>(
        "select count(*)::text as n from zz.pat where token_hash is not null and length(token_hash) > 0");
      assert.equal(Number(usablePats.rows[0]?.n) > 0, true,
        "no restored PAT carries a usable token hash — credentials restored as rows but not as credentials");

      // "Record/verify locale, provider, version and collation-dependent uniqueness and
      // comparisons for security/platform as well as tenant tables."
      const locale = await client.query<{ datcollate: string; datctype: string; provider: string }>(
        `select datcollate, datctype, datlocprovider::text as provider
           from pg_database where datname = current_database()`);
      assert.equal(typeof locale.rows[0]?.datcollate, "string", "the restored database reports no collation");
      // Collation-dependent uniqueness, asked of a security table. `zz.principal.email` is
      // `citext`, so its uniqueness is decided by the target's ctype, and `zz.team.slug` carries
      // a plain unique index whose ordering is decided by the target's collation. `zz.team.name`
      // is not unique and is not checked.
      const duplicateEmails = await client.query<{ n: string }>(
        "select count(*)::text as n from (select email::text from zz.principal group by 1 having count(*) > 1) d");
      assert.equal(duplicateEmails.rows[0]?.n, "0",
        "zz.principal.email holds duplicates under the restored ctype — a citext uniqueness that held on the source and not on the target");
      const duplicateSlugs = await client.query<{ n: string }>(
        "select count(*)::text as n from (select slug from zz.team group by slug having count(*) > 1) d");
      assert.equal(duplicateSlugs.rows[0]?.n, "0",
        "zz.team.slug holds duplicates under the restored collation");
      return { status: "passed" };
    } finally {
      await client.close();
    }
  } catch (err) {
    return failed(err);
  }
}

/**
 * `cutover` — steps 3, 7 and 8 against an operator's real observations, plus the one fact this
 * suite verifies for itself: it reads the post-resume write back out of the recovered database.
 * An observation file claiming that write survived is a sentence the operator typed.
 */
export async function caseDrainedMatchedSwitchPreservesTheFirstResumedWrite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaseResult> {
  const dbRefusal = isolatedDatabaseRefusal(env);
  if (dbRefusal !== null) return notRun(dbRefusal);
  const observationsPath = (env[CUTOVER_OBSERVATIONS_ENV] ?? "").trim();
  if (observationsPath === "") {
    return notRun(
      `${CUTOVER_OBSERVATIONS_ENV} is not set. This case judges a real drain, a real matched switch and a `
      + "real forward recovery, so it needs the observation file an operator writes while running the "
      + "eight steps. deploy/RESTORE-AND-CUTOVER.md step 5 gives its shape and the commands that fill it.");
  }

  try {
    const observations: unknown = JSON.parse(readFileSync(observationsPath, "utf8"));
    assert.equal(isRecord(observations), true, "the cutover observation file must be a JSON object");
    const record = observations as Record<string, unknown>;

    for (const [label, verdict] of [
      ["drain", evaluateDrain(record.drain)],
      ["matched_unit", evaluateMatchedUnit(record.matched_unit)],
      ["forward_recovery", evaluateForwardRecovery(record.forward_recovery)],
    ] as const) {
      assert.equal(verdict.ok, true, `${label}: ${verdict.issues.join("; ")}`);
    }

    // `post_resume_write_ref` is a transaction id, because that is the identity a write has in
    // this schema: `zz.artifact_event.transaction_id` is what one accepted mutation stamps on
    // every row it wrote, and `artifact_event_transaction` indexes exactly that column.
    // `zz.artifact_revision` is keyed `(owner_id, artifact_id, revision)` and carries no
    // timestamp, so the event's `at` is the only recorded time a write happened.
    const forward = record.forward_recovery as Record<string, unknown>;
    const ref = String(forward.post_resume_write_ref);
    const resumeBoundaryAt = forward.resume_boundary_at;
    assert.equal(typeof resumeBoundaryAt === "string" && resumeBoundaryAt.trim() !== "", true,
      "forward_recovery.resume_boundary_at must record when writes were resumed, or 'after the boundary' means nothing");

    const client = await connectIsolated((env[ISOLATED_DB_ENV] ?? "").trim());
    try {
      const survived = await client.query<{ n: string }>(
        "select count(*)::text as n from zz.artifact_event where transaction_id = $1", [ref]);
      assert.equal(Number(survived.rows[0]?.n) > 0, true,
        "the first acknowledged post-resume write is not in the recovered database — forward recovery dropped it");

      // "No post-snapshot mutation may be missing" — and the write must be on the correct
      // side of the boundary. A transaction that survived because it was written before
      // writes resumed proves nothing at all about forward recovery.
      const after = await client.query<{ n: string }>(
        "select count(*)::text as n from zz.artifact_event where transaction_id = $1 and at > $2::timestamptz",
        [ref, String(resumeBoundaryAt)]);
      assert.equal(after.rows[0]?.n, survived.rows[0]?.n,
        "the surviving write is not after the resume boundary — it is not evidence about forward recovery");
      return { status: "passed" };
    } finally {
      await client.close();
    }
  } catch (err) {
    return failed(err);
  }
}
