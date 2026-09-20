/**
 * deployment-cutover.ts — the spec's eight-step restore/cutover procedure, as code.
 *
 * `deployment.ts` keeps `validateBackupManifest` because `checks/backup-covers-the-
 * undisposable.ts` is frozen at that import path. Everything else the rehearsal needs lives
 * here, the same way `rebuild-generation.ts` sits beside `rebuild.ts`: a sibling module in
 * `testing/tenant-info/` that is not itself a suite (`availableSuiteNames()` filters by
 * `SUITE_NAMES`, so nothing tries to run it).
 *
 * THE SPLIT THAT MATTERS IS NOT THE FILE SPLIT. It is the one inside this file: the top half
 * is pure decision functions over plain records, and the bottom half is the only code that
 * opens a socket. The procedure in the spec is eight steps of operational judgement — has
 * every writer drained, is this one matched unit, did the first resumed write survive — and
 * each of those judgements is a predicate that can be wrong in a way a checkout can prove.
 * Keeping them pure is what lets this task test them at all, given that it may not stand up a
 * deployment: a rule nobody can execute is a rule nobody can break on purpose.
 *
 * WHAT THIS FILE DOES NOT DO, and the reason is not modesty. The rehearsal is a real restore
 * into a real isolated target and a real traffic switch. It needs a second host, protected
 * backup bytes and an operator with authority over both. The task that wrote this file had
 * none of the three and was forbidden all of them, because the laptop it ran on is known to
 * carry a container pointed at the PRODUCTION database — the live 527 documents. So the live
 * halves below read their environment, find it absent, and report `not_run` naming exactly
 * what is missing. `deploy/RESTORE-AND-CUTOVER.md` is the other half of that answer: the
 * commands an operator runs, on a machine that may run them, to make these cases execute.
 *
 * A `not_run` here is not a placeholder for work somebody skipped. It is the difference
 * between "we did not verify this" and "we verified this", written down where a reader of
 * `acceptance.json` cannot mistake one for the other.
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
 * THE THREE KINDS ARE REQUIRED BY NAME, not counted. A drain that put the request path into
 * maintenance and left the background jobs running is the failure this step exists to
 * prevent, and it is invisible to any check that asks only "are all the declared paths
 * quiet?" — because the path nobody declared is the one still writing. The spec names
 * background work and old clients explicitly, so those two are named here; a deployment that
 * grows a fourth mutation path adds it to this set, and until it does, this check cannot
 * claim to have drained it.
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
      // IN-FLIGHT IS COUNTED, NOT ASSERTED ABSENT. `undefined` is not zero: a probe that
      // failed to report leaves this field missing, and reading that as "nothing in flight"
      // would turn a broken probe into a successful drain.
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

  // The two boundaries step 3 requires be RECORDED. Without them step 8 has nothing to
  // recover forward from, and step 6's "no post-snapshot mutation may be missing" has no
  // snapshot to be after.
  if (typeof observation.file_commit_watermark !== "string" || !COMMIT_RE.test(observation.file_commit_watermark)) {
    issues.push("file_commit_watermark must be a 40-character commit hash");
  }
  if (typeof observation.platform_snapshot_boundary !== "string" || observation.platform_snapshot_boundary.trim() === "") {
    issues.push("platform_snapshot_boundary must be a non-empty database snapshot boundary");
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Step 7 — "Switch traffic as one matched application image + database + artifact-volume
 * unit", and step 5's "a SEPARATE new artifact volume", and the contract's "no hardcoded
 * deploy_zz-artifacts volume name or in-place PG16 data-directory reuse".
 *
 * THE THREE IDENTITIES MUST ALL DIFFER FROM THE OLD UNIT'S. A "switch" that points a new
 * application image at the old artifact volume is not a cutover, it is an in-place upgrade
 * wearing a cutover's clothes — and it destroys the one thing that makes step 8's rollback
 * possible, which is an old unit that is still intact. This is the single most expensive
 * mistake available in the whole procedure, because it is unrecoverable and it looks like
 * success while it happens.
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
  // Both halves are checked: the literal name is refused wherever it appears, AND the
  // observation has to say the name was resolved rather than typed. A correct-looking volume
  // name that nobody asked compose about is the same defect with a different spelling.
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
 * snapshot. After writes resume, rollback means forward recovery: freeze, preserve all new
 * file commits and platform DB changes, repair/restore a compatible PG17 deployment and
 * replay. Never drop new writes by returning to stale PG16."
 *
 * WHAT MAKES THIS A REAL CHECK RATHER THAN A SPELLING CHECK is `post_resume_write_ref` having
 * to appear in `recovered_write_refs`. Everything else here is the operator describing their
 * own plan; that one field is the plan's outcome, and the live case below does not take the
 * operator's word for it — it goes and reads the row back out of the recovered database.
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
 * `rebuild.ts` and `isolation.ts` already read this exact name for the same requirement, and
 * this is the shared statement of what the name is allowed to mean. Returning a REASON rather
 * than a boolean is deliberate: every caller reports `not_run` with it, and a reader of the
 * receipt needs to know which of the three refusals fired.
 *
 * THE TWO NEGATIVE CASES ARE NOT PARANOIA. `TEAM_DB_URL` and `PLATFORM_DB_URL` are set on
 * every machine that runs this platform, including the one that holds the live 527 documents,
 * and "the suite needs a database and there is one right there" is precisely how an isolated
 * rehearsal becomes a production incident. There is no inference from them — an operator who
 * wants this to run sets this variable at the isolated copy on purpose.
 */
export function isolatedDatabaseRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = (env[ISOLATED_DB_ENV] ?? "").trim();
  if (url === "") {
    return `${ISOLATED_DB_ENV} is not set. This case runs only against an operator-provided isolated `
      + "PostgreSQL 17 copy with pg_textsearch and migration 070 applied, restored from a protected "
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
 * It resolves every component the manifest declares, hashes the ACTUAL FILE and compares it
 * to the declared hash, then goes to the restored database and asks it what came back. The
 * manifest's own validation is not restoration evidence — `validateBackupManifest` proves a
 * manifest is well-formed, and a well-formed manifest describing a backup nobody restored is
 * exactly the fabrication this suite exists to refuse.
 */
export async function caseProtectedBackupRestoresIntoACleanTarget(
  // THE VALIDATOR ARRIVES AS AN ARGUMENT, and that is the whole reason this module imports
  // nothing from `deployment.ts`. `validateBackupManifest` must live there — the frozen check
  // pins it to that path by name — and `deployment.ts` has to import the cases from here to
  // run them. Importing back would close a cycle between two modules a dynamic `import()`
  // loads at suite time, for no gain: the case needs one function, not a module.
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

    // ── the bytes, not the claim ──────────────────────────────────────────────────────────
    //
    // A locator is `protected:<basename>`, resolved against the directory the manifest itself
    // sits in. It carries no path and no credential BY CONSTRUCTION (`validateBackupManifest`
    // refuses anything else), which is what keeps a backup report from printing a connection
    // string on its way to reporting a hash mismatch.
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
      // ── "verify full database row counts/FKs/representative hashes and functional
      //    identity/credential recovery without exposing secrets" ─────────────────────────
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

      // FUNCTIONAL, NOT PRESENT. A `pat` row that restored as bytes but whose hash column is
      // null authenticates nobody, and the restore would still have "recovered credentials".
      // The VALUE is never selected — only whether it is usable.
      const usablePats = await client.query<{ n: string }>(
        "select count(*)::text as n from zz.pat where token_hash is not null and length(token_hash) > 0");
      assert.equal(Number(usablePats.rows[0]?.n) > 0, true,
        "no restored PAT carries a usable token hash — credentials restored as rows but not as credentials");

      // ── "Record/verify locale, provider, version and collation-dependent uniqueness and
      //    comparisons for security/platform as well as tenant tables." ───────────────────
      const locale = await client.query<{ datcollate: string; datctype: string; provider: string }>(
        `select datcollate, datctype, datlocprovider::text as provider
           from pg_database where datname = current_database()`);
      assert.equal(typeof locale.rows[0]?.datcollate, "string", "the restored database reports no collation");
      // COLLATION-DEPENDENT UNIQUENESS, ASKED OF A SECURITY TABLE. "Rebuilding only tenant
      // search indexes is not a general collation remedy" is the spec's own sentence, and
      // these are the two places on this platform where a changed provider actually bites:
      // `zz.principal.email` is `citext` (001_init.sql), so its uniqueness is decided by the
      // target's ctype, and `zz.team.slug` carries a plain unique index whose ordering is
      // decided by the target's collation. `zz.team.name` is NOT unique and is not checked —
      // asserting it were would be a rule this schema never had.
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
 * `cutover` — steps 3, 7 and 8 against an operator's real observations, plus the one fact
 * this suite verifies for itself.
 *
 * The operator runs the procedure and writes down what happened; the three predicates above
 * judge that record. Then this case does the part a record cannot be trusted for: it reads
 * the post-resume write back out of the recovered database. "The first acknowledged write
 * after the resume boundary survived forward recovery" is the whole point of the rehearsal,
 * and an observation file claiming it is a sentence the operator typed.
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

    // ── the fact nobody gets to assert ────────────────────────────────────────────────────
    //
    // `post_resume_write_ref` IS A TRANSACTION ID, because that is the identity a write
    // actually has in this schema. 070's `zz.artifact_event.transaction_id` is what one
    // accepted mutation stamps on every row it wrote, and `artifact_event_transaction` is an
    // index over exactly that column. There is no `revision_ref` and no `committed_at` here —
    // `zz.artifact_revision` is keyed `(owner_id, artifact_id, revision)` and carries no
    // timestamp of its own, so the event's `at` is the only recorded time a write happened.
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
      // side of the boundary. A transaction that survived because it was written BEFORE
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
