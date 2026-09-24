/**
 * The PostgreSQL 17 / pg_textsearch v1.4.0 pin, and the restore/cutover rehearsal's offline
 * half. Three exports.
 *
 * `validateImageInputs` is offline: no docker, no network, no live database. It checks
 * `deploy/postgres/versions.lock.json`'s shape and that the lock, `deploy/postgres/Dockerfile`
 * and `deploy/postgres/postgresql.conf` name the same pins. A `true` is necessary and not
 * sufficient — nothing offline can tell a real digest from a well-formed fake one.
 *
 * `validateBackupManifest` is the second offline half: which components a protected backup
 * must carry before a restore may begin.
 *
 * COUPLED: both symbols are pinned by name and import path by frozen checks —
 * `checks/postgres-image-pinned.ts` and `checks/backup-covers-the-undisposable.ts` — which
 * cannot be edited to follow a move.
 *
 * COUPLED: `scripts/tenant-info/suites.ts` reserves the suite name "deployment" at this exact
 * path, so `verify --suite deployment` and `--finalize` dynamic-import this module and call
 * `run`. A module here without that export crashes them.
 *
 * `run` is fail-closed: it spawns nothing until every `*_verified` flag in versions.lock.json
 * is true. Once they are, it builds the pinned image, starts it, and checks the running
 * major/patch, the loaded extension's exact version and shared_preload_libraries membership.
 * BM25 parameters, explicit-index queries and per-corpus statistics need the extension's own
 * verified DDL, which this checkout does not have, so they report `not_run`.
 *
 * The eight-step restore/cutover procedure is in `deployment-cutover.ts`; its pure predicates
 * run here on every invocation as the `offline` group. `deploy/RESTORE-AND-CUTOVER.md` is
 * what an operator runs to make the two live cases execute for real.
 */
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  caseDrainedMatchedSwitchPreservesTheFirstResumedWrite,
  caseProtectedBackupRestoresIntoACleanTarget,
  evaluateDrain, evaluateForwardRecovery, evaluateMatchedUnit, isolatedDatabaseRefusal,
} from "./deployment-cutover.ts";

interface ImageInputs {
  readonly lock: unknown;
  readonly dockerfile: string;
  readonly config: string;
}

interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

const POSTGRES_VERSION_RE = /^17\.\d+$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;
const ALLOWED_ARCHITECTURES = new Set(["linux/amd64", "linux/arm64"]);
const REQUIRED_PRELOAD = "pg_textsearch";

/** spec.md's "PostgreSQL image and dependency lock" reference settings, verbatim.
 *  `enable_seqscan` is checked separately below: it has no correct value to require, only a
 *  forbidden one. */
const REQUIRED_SETTINGS: Readonly<Record<string, string>> = {
  shared_buffers: "8GB",
  work_mem: "16MB",
  maintenance_work_mem: "512MB",
  max_parallel_maintenance_workers: "2",
  autovacuum: "on",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** postgresql.conf's own grammar: `name = value` (value optionally single-quoted), one
 *  setting per line, `#` starts a comment running to end of line.
 *
 *  DELIBERATE: not a general parser — it covers the settings this file pins. */
function parseConf(config: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of config.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].replace(/^'(.*)'$/, "$1"));
  }
  return out;
}

/** Actual list membership, not presence of the setting name — an empty or absent value is
 *  zero members, never a false "it's set" pass. */
function preloadMembers(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function validateImageInputs(input: ImageInputs): ValidationResult {
  const { lock, dockerfile, config } = input;
  if (!isRecord(lock)) return { ok: false, issues: ["lock must be an object"] };

  const issues: string[] = [];

  // PostgreSQL major/patch: the lock and the Dockerfile that pulls it must agree.
  const postgresVersion = lock.postgres_version;
  if (typeof postgresVersion !== "string" || !POSTGRES_VERSION_RE.test(postgresVersion)) {
    issues.push(`postgres_version must be an exact PostgreSQL 17 patch ("17.<n>"), got ${JSON.stringify(postgresVersion)}`);
  } else if (!dockerfile.includes(postgresVersion)) {
    issues.push("Dockerfile does not reference the lock's postgres_version");
  }

  // Base image: pinned by digest, and the same digest in both, not merely the same shape.
  const baseDigest = lock.base_image_digest;
  if (typeof baseDigest !== "string" || !SHA256_DIGEST_RE.test(baseDigest)) {
    issues.push(`base_image_digest must be "sha256:" plus 64 hex characters, got ${JSON.stringify(baseDigest)}`);
  } else {
    const fromDigests = [...dockerfile.matchAll(/FROM\s+\S+@(sha256:[0-9a-f]{64})/g)].map((m) => m[1]);
    if (fromDigests.length === 0) issues.push("Dockerfile's FROM does not pin a sha256 digest");
    else if (fromDigests.at(-1) !== baseDigest) {
      issues.push("Dockerfile's runtime FROM digest does not match versions.lock.json's base_image_digest");
    }
  }
  if (/FROM\s+\S+:(latest|main|master)\b/.test(dockerfile)) {
    issues.push("Dockerfile pins a floating tag (latest/main/master) — no substitution for a resolved release");
  }

  // pg_textsearch: an exact release tag, its resolved commit, and its source hash.
  const tag = lock.pg_textsearch_tag;
  if (typeof tag !== "string" || !RELEASE_TAG_RE.test(tag)) {
    issues.push(`pg_textsearch_tag must be an exact release tag ("vX.Y.Z"), got ${JSON.stringify(tag)}`);
  } else if (!dockerfile.includes(tag)) {
    issues.push("Dockerfile does not reference the lock's pg_textsearch_tag");
  }

  const commit = lock.pg_textsearch_commit;
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) {
    issues.push(`pg_textsearch_commit must be a 40-character commit hash, got ${JSON.stringify(commit)}`);
  } else if (!dockerfile.includes(commit)) {
    issues.push("Dockerfile does not reference the lock's pg_textsearch_commit");
  }

  const sourceSha = lock.pg_textsearch_source_sha256;
  if (typeof sourceSha !== "string" || !SHA256_HEX_RE.test(sourceSha)) {
    issues.push(`pg_textsearch_source_sha256 must be 64 hex characters, got ${JSON.stringify(sourceSha)}`);
  } else if (!dockerfile.includes(sourceSha)) {
    issues.push("Dockerfile does not verify the lock's pg_textsearch_source_sha256");
  }

  // Evidence only the actual build or inspection can produce: shape-checked, never trusted.
  const builtDigest = lock.built_image_digest;
  if (typeof builtDigest !== "string" || !SHA256_DIGEST_RE.test(builtDigest)) {
    issues.push(`built_image_digest must be "sha256:" plus 64 hex characters, got ${JSON.stringify(builtDigest)}`);
  }
  const textConfigFingerprint = lock.text_configuration_fingerprint;
  if (typeof textConfigFingerprint !== "string" || !SHA256_DIGEST_RE.test(textConfigFingerprint)) {
    issues.push(`text_configuration_fingerprint must be "sha256:" plus 64 hex characters, got ${JSON.stringify(textConfigFingerprint)}`);
  }
  const okfDigest = lock.okf_reference_digest;
  if (typeof okfDigest !== "string" || !SHA256_DIGEST_RE.test(okfDigest)) {
    issues.push(`okf_reference_digest must be "sha256:" plus 64 hex characters, got ${JSON.stringify(okfDigest)}`);
  }

  const architecture = lock.architecture;
  if (typeof architecture !== "string" || !ALLOWED_ARCHITECTURES.has(architecture)) {
    issues.push(`architecture must be one of ${[...ALLOWED_ARCHITECTURES].join(", ")}, got ${JSON.stringify(architecture)}`);
  }

  // Preload membership: the lock's declared list and the shipped config must be the same
  // set, and that set must contain pg_textsearch, not merely exist.
  const declaredPreload = lock.shared_preload_libraries;
  const declaredSet = Array.isArray(declaredPreload)
    ? new Set(declaredPreload.filter((s): s is string => typeof s === "string"))
    : undefined;
  if (!declaredSet || !declaredSet.has(REQUIRED_PRELOAD)) {
    issues.push(`versions.lock.json's shared_preload_libraries must list "${REQUIRED_PRELOAD}"`);
  }

  const settings = parseConf(config);
  const actualPreload = preloadMembers(settings.get("shared_preload_libraries"));
  if (!actualPreload.has(REQUIRED_PRELOAD)) {
    issues.push(`postgresql.conf's shared_preload_libraries does not actually list "${REQUIRED_PRELOAD}" as a member`);
  } else if (declaredSet && !setsEqual(actualPreload, declaredSet)) {
    issues.push("postgresql.conf's shared_preload_libraries does not match versions.lock.json's declared list");
  }

  // Reference memory settings and autovacuum: exactly the spec's values.
  for (const [key, expected] of Object.entries(REQUIRED_SETTINGS)) {
    const actual = settings.get(key);
    if (actual !== expected) {
      issues.push(`postgresql.conf's ${key} must be "${expected}" (the spec's reference setting), got ${JSON.stringify(actual)}`);
    }
  }

  // enable_seqscan=off is never shipped, whatever else is true.
  const seqscan = settings.get("enable_seqscan");
  if (seqscan !== undefined && seqscan.toLowerCase() === "off") {
    issues.push("postgresql.conf ships enable_seqscan=off, which the contract never permits");
  }

  return { ok: issues.length === 0, issues };
}

// The protected backup manifest.

/** The five component kinds the contract names, and the whole of what "undisposable" means
 *  here. Losing any one loses something no restart brings back:
 *
 *    database            identity truth — principals, teams, PATs, installs, grants, events
 *    artifacts           every team's documents and knowledge, including the canonical .zz record
 *    git                 the portable per-team history, which is what a team keeps if they leave
 *    credentials         the gateway's own data volume
 *    configuration_keys  the encrypted configuration and key material the rest is useless without
 *
 *  COUPLED: `deploy/backup.sh` writes four of them, `deploy/backup-manifest.sh` derives the
 *  fifth and the manifest. A manifest short one kind is refused below. */
const BACKUP_COMPONENT_KINDS = [
  "database", "artifacts", "git", "credentials", "configuration_keys",
] as const;

interface ManifestResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** A locator is `protected:` plus a bare name — no directory, no host, no userinfo, no query.
 *
 *  DELIBERATE: this is a secrecy rule, not a tidiness one. A "locator" that is really a
 *  connection string is how a credential reaches a backup report. Refusing the shape here
 *  means `@`, `:` and `/` cannot appear, so nothing downstream has to redact. */
const LOCATOR_RE = /^protected:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a backup manifest describes something that can actually be restored — the gate
 * `caseProtectedBackupRestoresIntoACleanTarget` passes before it touches a byte, and what
 * `checks/backup-covers-the-undisposable.ts` (frozen) drives.
 *
 * A `true` means a well-formed manifest: five kinds, a protected locator and a syntactically
 * valid SHA-256 each, the canonical record declared present, a compose project named. It is
 * not restoration evidence — only the live case, which re-hashes the bytes and interrogates
 * the restored database, proves a backup exists.
 *
 * DELIBERATE: no issue below ever echoes a value, unlike `validateImageInputs`, which reports
 * `JSON.stringify(value)`. A malformed manifest is where a credential shows up, and an issue
 * string gets pasted into a ticket. Every issue names the field and the kind and stops.
 */
export function validateBackupManifest(report: unknown): ManifestResult {
  if (!isRecord(report)) return { ok: false, issues: ["the manifest must be an object"] };
  const issues: string[] = [];

  // This validator only ever blesses a rehearsal: a manifest aimed at the live deployment
  // cannot pass through the rehearsal's gate.
  if (report.scope !== "isolated-rehearsal") {
    issues.push('scope must be "isolated-rehearsal" — this validator admits no other scope');
  }

  if (typeof report.compose_project !== "string" || report.compose_project.trim() === "") {
    issues.push("compose_project must name the Compose project the volume IDs were resolved from");
  }

  // DELIBERATE: declared explicitly rather than inferred from the artifacts component being
  // present. That component is a volume archive, and whether the canonical .zz record is
  // inside it is a separate fact somebody has to have checked.
  if (report.artifacts_include_canonical_record !== true) {
    issues.push("artifacts_include_canonical_record must be true — the canonical .zz record is protected backup material, not disposable telemetry");
  }

  const components = report.components;
  if (!Array.isArray(components)) {
    return { ok: false, issues: [...issues, "components must be an array"] };
  }

  const seen = new Set<string>();
  components.forEach((component, index) => {
    if (!isRecord(component)) { issues.push(`component ${index} must be an object`); return; }
    const kind = component.kind;
    if (typeof kind !== "string" || !(BACKUP_COMPONENT_KINDS as readonly string[]).includes(kind)) {
      issues.push(`component ${index} declares no recognised kind`);
      return;
    }
    if (seen.has(kind)) issues.push(`the ${kind} component is declared more than once`);
    seen.add(kind);

    if (typeof component.locator !== "string" || !LOCATOR_RE.test(component.locator)) {
      issues.push(`the ${kind} component's locator must be "protected:" plus a bare name carrying no path, host or credential`);
    } else if (component.locator.includes("deploy_zz-artifacts")) {
      // No hardcoded deploy_zz-artifacts volume name: a volume ID that was typed rather than
      // resolved is silently wrong on every host whose Compose project is not `deploy`.
      issues.push(`the ${kind} component's locator hardcodes the deploy_zz-artifacts volume name instead of resolving it from the Compose project`);
    }

    if (typeof component.sha256 !== "string" || !SHA256_HEX_RE.test(component.sha256)) {
      issues.push(`the ${kind} component's sha256 must be 64 lowercase hex characters`);
    }
  });

  for (const kind of BACKUP_COMPONENT_KINDS) {
    if (!seen.has(kind)) issues.push(`the manifest declares no ${kind} component`);
  }

  return { ok: issues.length === 0, issues };
}

// The "deployment" suite.

interface CaseResult {
  readonly status: "passed" | "failed" | "not_run";
  readonly reason?: string;
}

interface SuiteDetail {
  readonly status: "blocked" | "ran";
  readonly issues?: readonly string[];
  readonly unverified?: readonly string[];
  readonly cases?: Readonly<Record<string, CaseResult>>;
}

interface SuiteOutcome {
  readonly passed: boolean;
  readonly detail: SuiteDetail;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_DIR = join(repoRoot, "deploy", "postgres");

/** The dependency-proof case group the technical AC names. `restore` and `cutover` are the
 *  two groups below. */
const EXTENSION_CASES = [
  "extension_load", "bm25_parameters", "explicit_index_queries",
  "per_corpus_statistics", "update_delete", "restart",
] as const;

/**
 * The offline group: the half of the eight-step procedure that is judgement rather than
 * infrastructure — whether a backup covers the undisposable, whether a drain drained, whether
 * a switch was one matched unit, whether a resumed write survived.
 *
 * DELIBERATE: these run always, at either profile, pins or no pins. They are decidable from
 * a checkout alone, so the unverified-pin gate below must not block them.
 */
const OFFLINE_CASES: Readonly<Record<string, () => void>> = {
  backup_manifest_covers_every_undisposable_component: () => {
    const kinds = [...BACKUP_COMPONENT_KINDS];
    const good = {
      scope: "isolated-rehearsal",
      components: kinds.map((kind, i) => ({ kind, locator: `protected:set-${i}.tar.gz`, sha256: "b".repeat(64) })),
      artifacts_include_canonical_record: true,
      compose_project: "zz",
    };
    assert.equal(validateBackupManifest(good).ok, true, "a complete manifest must validate");
    for (const kind of kinds) {
      const short = { ...good, components: good.components.filter((c) => c.kind !== kind) };
      assert.equal(validateBackupManifest(short).ok, false, `a manifest missing ${kind} must be refused`);
    }
    assert.equal(validateBackupManifest({ ...good, artifacts_include_canonical_record: false }).ok, false);
    assert.equal(validateBackupManifest({ ...good, scope: "production" }).ok, false,
      "this validator admits only an isolated rehearsal");
  },
  backup_manifest_refuses_a_locator_that_could_carry_a_secret: () => {
    const base = {
      scope: "isolated-rehearsal",
      artifacts_include_canonical_record: true,
      compose_project: "zz",
    };
    const withLocator = (locator: string) => ({
      ...base,
      components: BACKUP_COMPONENT_KINDS.map((kind, i) => ({
        kind, locator: kind === "database" ? locator : `protected:set-${i}.tar.gz`, sha256: "c".repeat(64),
      })),
    });
    const secret = "protected:postgres://zz:s3cr3t-value@db.example.com/zz";
    const result = validateBackupManifest(withLocator(secret));
    assert.equal(result.ok, false, "a locator carrying a connection string must be refused");
    // And the refusal must not repeat it: an issue string is the validator's own output, and
    // it gets pasted into tickets.
    for (const issue of result.issues) {
      assert.equal(issue.includes("s3cr3t-value"), false, "an issue echoed the credential it was refusing");
    }
    assert.equal(validateBackupManifest(withLocator("protected:deploy_zz-artifacts.tar.gz")).ok, false,
      "a locator hardcoding the deploy_zz-artifacts volume name must be refused");
  },
  drain_refuses_a_writer_that_never_stopped: () => {
    const drained = {
      mutation_paths: [
        { kind: "request", maintenance: true, in_flight: 0 },
        { kind: "background", maintenance: true, in_flight: 0 },
        { kind: "legacy_client", maintenance: true, in_flight: 0 },
      ],
      active_writers: 0,
      file_commit_watermark: "f".repeat(40),
      platform_snapshot_boundary: "0/3A2F1C8",
    };
    assert.equal(evaluateDrain(drained).ok, true, "a complete drain must be accepted");
    assert.equal(evaluateDrain({ ...drained, active_writers: 1 }).ok, false);
    assert.equal(
      evaluateDrain({ ...drained, mutation_paths: drained.mutation_paths.filter((p) => p.kind !== "background") }).ok,
      false, "a drain that never looked at background work has not drained every mutation path");
    assert.equal(
      evaluateDrain({
        ...drained,
        mutation_paths: drained.mutation_paths.map((p) => p.kind === "legacy_client" ? { ...p, in_flight: 2 } : p),
      }).ok, false, "an old client with writes in flight blocks the freeze");
    assert.equal(evaluateDrain({ ...drained, file_commit_watermark: "not-a-commit" }).ok, false);
  },
  matched_unit_refuses_a_reused_volume_or_an_in_place_major_upgrade: () => {
    const matched = {
      old_unit: {
        app_image_digest: `sha256:${"1".repeat(64)}`, database_identity: "zz-pg16-old",
        artifact_volume: "zz_zz-artifacts", read_only: true,
      },
      new_unit: {
        app_image_digest: `sha256:${"2".repeat(64)}`, database_identity: "zz-pg17-new",
        artifact_volume: "zz_zz-artifacts-v4", postgres_major: 17, data_directory_reused: false,
      },
      volumes_resolved_from_compose_project: true,
      outbound_integrations_disabled: true,
    };
    assert.equal(evaluateMatchedUnit(matched).ok, true, "a genuinely matched unit must be accepted");
    assert.equal(evaluateMatchedUnit({
      ...matched, new_unit: { ...matched.new_unit, artifact_volume: matched.old_unit.artifact_volume },
    }).ok, false, "reusing the old artifact volume is not a cutover");
    assert.equal(evaluateMatchedUnit({
      ...matched, new_unit: { ...matched.new_unit, data_directory_reused: true },
    }).ok, false, "mounting an existing data directory into a new major is never a restore");
    assert.equal(evaluateMatchedUnit({
      ...matched, new_unit: { ...matched.new_unit, postgres_major: 16 },
    }).ok, false);
    assert.equal(evaluateMatchedUnit({
      ...matched, old_unit: { ...matched.old_unit, read_only: false },
    }).ok, false, "the old deployment must stay isolated read-only");
    assert.equal(evaluateMatchedUnit({ ...matched, volumes_resolved_from_compose_project: false }).ok, false);
    assert.equal(evaluateMatchedUnit({
      ...matched, new_unit: { ...matched.new_unit, artifact_volume: "deploy_zz-artifacts" },
    }).ok, false, "the hardcoded volume name is refused wherever it appears");
  },
  forward_recovery_refuses_a_lost_post_resume_write: () => {
    const recovered = {
      strategy: "forward_recovery",
      target_postgres_major: 17,
      resume_boundary_at: "2026-09-20T03:17:00Z",
      post_resume_write_ref: "tx-first-after-resume",
      recovered_write_refs: ["tx-first-after-resume", "tx-second"],
      new_file_commits: ["a".repeat(40)],
      recovered_file_commits: ["a".repeat(40)],
      platform_db_changes_preserved: true,
    };
    assert.equal(evaluateForwardRecovery(recovered).ok, true);
    assert.equal(evaluateForwardRecovery({ ...recovered, recovered_write_refs: ["tx-second"] }).ok, false,
      "a recovery that dropped the first resumed write is the failure the rehearsal exists to find");
    assert.equal(evaluateForwardRecovery({ ...recovered, strategy: "rollback_to_old_snapshot" }).ok, false,
      "returning to the old snapshot after writes resumed drops every resumed write");
    assert.equal(evaluateForwardRecovery({ ...recovered, target_postgres_major: 16 }).ok, false);
    assert.equal(evaluateForwardRecovery({ ...recovered, recovered_file_commits: [] }).ok, false,
      "preserving the database and losing the git commits loses a team's history");
    assert.equal(evaluateForwardRecovery({ ...recovered, platform_db_changes_preserved: false }).ok, false);
  },
  the_isolated_database_url_is_never_the_live_cluster: () => {
    const live = "postgres://zz@platform/zz";
    assert.notEqual(isolatedDatabaseRefusal({}), null, "an unset URL must refuse, not default");
    assert.notEqual(
      isolatedDatabaseRefusal({ ZZ_TENANT_INFO_ISOLATED_DB_URL: live, TEAM_DB_URL: live }), null,
      "the isolated copy is never TEAM_DB_URL");
    assert.notEqual(
      isolatedDatabaseRefusal({ ZZ_TENANT_INFO_ISOLATED_DB_URL: live, PLATFORM_DB_URL: live }), null,
      "the isolated copy is never PLATFORM_DB_URL");
    assert.equal(
      isolatedDatabaseRefusal({ ZZ_TENANT_INFO_ISOLATED_DB_URL: "postgres://zz@isolated/zz_rehearsal", TEAM_DB_URL: live }),
      null, "a genuinely separate copy is accepted");
  },
};

function readDeployFiles(): ImageInputs {
  return {
    lock: JSON.parse(readFileSync(join(DEPLOY_DIR, "versions.lock.json"), "utf8")),
    dockerfile: readFileSync(join(DEPLOY_DIR, "Dockerfile"), "utf8"),
    config: readFileSync(join(DEPLOY_DIR, "postgresql.conf"), "utf8"),
  };
}

/** Every `<field>_verified` flag in the lock that is not `true`, read structurally rather
 *  than from versions.lock.json's own "unverified_fields" prose. */
function unverifiedFields(lock: Record<string, unknown>): string[] {
  const suffix = "_verified";
  return Object.keys(lock)
    .filter((k) => k.endsWith(suffix) && lock[k] !== true)
    .map((k) => k.slice(0, -suffix.length));
}

function notRun(reason: string): CaseResult {
  return { status: "not_run", reason };
}

/** The four case groups `--cases` selects from, as a comma-separated list.
 *
 *  COUPLED: cli.ts rejects `--cases` outright under the acceptance profile, which is what
 *  stops partial cases passing a whole business AC. */
const GROUP_NAMES = ["offline", "extension", "restore", "cutover"] as const;

/**
 * `verify --suite deployment`'s entry point.
 *
 * DELIBERATE: the order of the three verdicts is load-bearing. The offline group runs first
 * and a real failure outranks the block, so a failing offline case reports `ran` (the CLI
 * renders it FAILED) while an unresolved image pin with nothing failing reports `blocked`.
 * Collapsing them makes a broken rule and an unbuilt image the same word in the receipt.
 *
 * Missing information is a blocked result, never a pass: no docker is spawned while a pin is
 * unverified, and no database is touched without an operator setting the variable naming one.
 */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  const inputs = readDeployFiles();
  const validation = validateImageInputs(inputs);
  if (!validation.ok) {
    return { passed: false, detail: { status: "blocked", issues: validation.issues } };
  }

  const selected = cases === undefined
    ? [...GROUP_NAMES]
    : cases.split(",").map((c) => c.trim()).filter((c) => c !== "");
  const unknown = selected.filter((c) => !(GROUP_NAMES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    const everyCase = [
      ...Object.keys(OFFLINE_CASES), ...EXTENSION_CASES, "restore", "cutover",
    ];
    return {
      passed: false,
      detail: {
        status: "blocked",
        cases: Object.fromEntries(everyCase.map((name) => [
          name, notRun(`only the "${GROUP_NAMES.join('", "')}" case groups exist`),
        ])),
      },
    };
  }

  const results: Record<string, CaseResult> = {};

  // Offline: always executed, pins or no pins.
  if (selected.includes("offline")) {
    for (const [name, body] of Object.entries(OFFLINE_CASES)) {
      try {
        body();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  // Restore and cutover: real bytes and a real isolated database, or an honest not_run.
  if (selected.includes("restore")) {
    results.restore = await caseProtectedBackupRestoresIntoACleanTarget(validateBackupManifest);
  }
  if (selected.includes("cutover")) {
    results.cutover = await caseDrainedMatchedSwitchPreservesTheFirstResumedWrite();
  }

  const lock = inputs.lock as Record<string, unknown>;
  const unverified = unverifiedFields(lock);
  const wantsExtension = selected.includes("extension");

  if (wantsExtension && unverified.length > 0) {
    // Every missing precondition at once: naming only the next blocker makes an operator
    // discover the list one rerun at a time.
    for (const c of EXTENSION_CASES) {
      results[c] = notRun(
        `versions.lock.json still carries unverified pins (${unverified.join(", ")}) — no image is built `
        + "and no container is started while any pin is a placeholder");
    }
  }

  const anyFailed = Object.values(results).some((r) => r.status === "failed");
  if (!wantsExtension || unverified.length > 0) {
    // A real failure outranks a block: blocked means nothing was looked at, and something
    // that was looked at and went red is what the receipt has to say.
    const status = anyFailed ? "ran" as const : "blocked" as const;
    const detail: SuiteDetail = status === "blocked"
      ? { status, unverified, cases: results }
      : { status, cases: results };
    return { passed: false, detail };
  }

  // DELIBERATE: unreachable while any `*_verified` flag in the lock is false — the block
  // above returns first. It becomes reachable once an operator resolves every field and flips
  // the matching flag to true.
  for (const c of EXTENSION_CASES) {
    results[c] = c === "extension_load"
      ? notRun("pending build")
      : notRun("requires the extension's verified DDL from the feature report, not guessed here");
  }

  const tag = `zz-postgres-dependency-proof:${process.pid}`;
  const container = `zz-postgres-dependency-proof-${process.pid}`;
  try {
    execFileSync("docker",
      ["build", "--platform", String(lock.architecture), "-f", join(DEPLOY_DIR, "Dockerfile"), "-t", tag, repoRoot],
      { stdio: "inherit" });
    execFileSync("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=dependency-proof", tag]);
    for (let i = 0; ; i++) {
      try { execFileSync("docker", ["exec", container, "pg_isready"]); break; } catch {
        if (i > 60) throw new Error("the built image never became ready");
        execSync("sleep 1");
      }
    }
    const psql = (sql: string): string =>
      execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-tAc", sql], { encoding: "utf8" }).trim();

    const version = psql("SELECT version()");
    const versionOk = version.includes(String(lock.postgres_version));
    const extVersion = psql("SELECT extversion FROM pg_extension WHERE extname='pg_textsearch'");
    const extOk = `v${extVersion}` === lock.pg_textsearch_tag;
    const preload = psql("SHOW shared_preload_libraries").split(",").map((s) => s.trim());
    const preloadOk = preload.includes("pg_textsearch");

    results.extension_load = (versionOk && extOk && preloadOk)
      ? { status: "passed" }
      : { status: "failed", reason: `version=${version} extversion=${extVersion} preload=${preload.join(",")}` };
  } catch (err) {
    results.extension_load = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try { execFileSync("docker", ["rm", "-f", container]); } catch { /* already gone, or never started */ }
  }

  const passed = Object.values(results).every((r) => r.status !== "failed");
  return { passed, detail: { status: "ran", cases: results } };
}
