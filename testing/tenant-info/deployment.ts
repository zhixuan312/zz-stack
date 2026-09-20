/**
 * deployment.ts — I-5's PostgreSQL 17 / pg_textsearch v1.4.0 pin, in two halves.
 *
 * `validateImageInputs` is the pure, offline half: no docker, no network, no live database.
 * It is what the dependency suite checks BEFORE it ever touches a built image — the shape and
 * cross-file agreement a coding worker can supply from a checkout alone, not the network-
 * verified truth of a digest. A `true` result here is necessary, not sufficient: the
 * contract's own words are that a placeholder-looking but syntactically valid hash is not
 * release evidence, and nothing offline can tell a real digest from a well-formed fake one.
 * So this checks exactly what it CAN see without a network: `deploy/postgres/
 * versions.lock.json`'s own shape, and that the lock, `deploy/postgres/Dockerfile` and
 * `deploy/postgres/postgresql.conf` all name the SAME pins rather than three separately-
 * plausible stories. `checks/postgres-image-pinned.ts` (frozen) is its only tracked caller.
 *
 * `run` below is this file's OTHER job: `scripts/tenant-info/suites.ts` reserves the name
 * "deployment" at exactly this path, so the moment this file exists, `verify --suite
 * deployment` and `--finalize` dynamic-import it and call `run` — a module at this path with
 * no such export would turn "not yet built" into a crash. `run` stays fail-closed on THIS
 * checkout by construction: every pin in versions.lock.json still carries a `*_verified:
 * false` placeholder (see that file's own header), and `run` refuses to spawn anything —
 * no docker, no network — until every one of those flags is true. Nothing in this file
 * changes that; only an operator who has actually resolved and rebuilt the pins does. Once
 * they have, `run` builds the pinned image, starts it, and checks the three things the spec
 * literally names: the running major/patch, the loaded extension's exact version, and actual
 * shared_preload_libraries membership. BM25 parameters, explicit-index queries and per-corpus
 * statistics need the extension's own verified DDL, which does not exist in this checkout —
 * inventing plausible-looking SQL for them would be the same fabrication as a fake digest, so
 * they are reported `not_run` rather than guessed. Restore and cutover are I-21's, always
 * `not_run` here regardless of profile.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** spec.md's "PostgreSQL image and dependency lock" reference settings, verbatim — not
 *  guessed configuration names, the exact values agreed there. `enable_seqscan` is checked
 *  separately below: it has no correct value to require, only a forbidden one. */
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
 *  setting per line, `#` starts a comment running to end of line. Good enough for the
 *  settings this task pins — not a general parser, and not asked to be one. */
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

  // ── PostgreSQL major/patch: the lock, and the Dockerfile that pulls it, must agree ────────
  const postgresVersion = lock.postgres_version;
  if (typeof postgresVersion !== "string" || !POSTGRES_VERSION_RE.test(postgresVersion)) {
    issues.push(`postgres_version must be an exact PostgreSQL 17 patch ("17.<n>"), got ${JSON.stringify(postgresVersion)}`);
  } else if (!dockerfile.includes(postgresVersion)) {
    issues.push("Dockerfile does not reference the lock's postgres_version");
  }

  // ── base image: pinned by digest, and the SAME digest in both, not merely same shape ─────
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

  // ── pg_textsearch: an exact release tag, its resolved commit, and its source hash ────────
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

  // ── evidence only the actual build/inspection can produce — shape-checked, never trusted ──
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

  // ── preload membership: the lock's declared list and the shipped config must be the SAME
  //    set, and that set must actually contain pg_textsearch — not just a setting that exists
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

  // ── reference memory settings and autovacuum: exactly the spec's values, nothing guessed ──
  for (const [key, expected] of Object.entries(REQUIRED_SETTINGS)) {
    const actual = settings.get(key);
    if (actual !== expected) {
      issues.push(`postgresql.conf's ${key} must be "${expected}" (the spec's reference setting), got ${JSON.stringify(actual)}`);
    }
  }

  // ── enable_seqscan=off is never shipped, whatever else is true ────────────────────────────
  const seqscan = settings.get("enable_seqscan");
  if (seqscan !== undefined && seqscan.toLowerCase() === "off") {
    issues.push("postgresql.conf ships enable_seqscan=off, which the contract never permits");
  }

  return { ok: issues.length === 0, issues };
}

// ─────────────────────────────────── the "deployment" suite ───────────────────────────────

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

/** The dependency-proof case group the technical AC names, minus restore/cutover — those
 *  are I-21's, always `not_run` from this module regardless of `cases`. */
const EXTENSION_CASES = [
  "extension_load", "bm25_parameters", "explicit_index_queries",
  "per_corpus_statistics", "update_delete", "restart",
] as const;
const DEFERRED_CASES = ["restore", "cutover"] as const;

function readDeployFiles(): ImageInputs {
  return {
    lock: JSON.parse(readFileSync(join(DEPLOY_DIR, "versions.lock.json"), "utf8")),
    dockerfile: readFileSync(join(DEPLOY_DIR, "Dockerfile"), "utf8"),
    config: readFileSync(join(DEPLOY_DIR, "postgresql.conf"), "utf8"),
  };
}

/** Every `<field>_verified` flag in the lock that is not `true` — the exact fields
 *  versions.lock.json's own "unverified_fields" names in prose, read back structurally so
 *  `run` can refuse to proceed without re-parsing that prose. */
function unverifiedFields(lock: Record<string, unknown>): string[] {
  const suffix = "_verified";
  return Object.keys(lock)
    .filter((k) => k.endsWith(suffix) && lock[k] !== true)
    .map((k) => k.slice(0, -suffix.length));
}

function notRun(reason: string): CaseResult {
  return { status: "not_run", reason };
}

/**
 * `verify --suite deployment`'s entry point. Blocks before touching docker whenever the lock
 * still carries an unresolved pin — "missing information is a blocked result, not an
 * invitation to invent a value" is the contract's own sentence, and this is what makes that
 * true in code rather than only in prose. Only past that gate does it build the pinned image,
 * start it, and check the three things the spec names by name.
 */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  const inputs = readDeployFiles();
  const validation = validateImageInputs(inputs);
  if (!validation.ok) {
    return { passed: false, detail: { status: "blocked", issues: validation.issues } };
  }

  const lock = inputs.lock as Record<string, unknown>;
  const unverified = unverifiedFields(lock);
  const allCaseNames = [...EXTENSION_CASES, ...DEFERRED_CASES];
  if (unverified.length > 0) {
    return {
      passed: false,
      detail: {
        status: "blocked",
        unverified,
        cases: Object.fromEntries(
          allCaseNames.map((c) => [c, notRun("versions.lock.json still carries an unverified pin")]),
        ),
      },
    };
  }

  // UNREACHABLE FROM THIS CHECKOUT TODAY: every `*_verified` flag above is false, so the
  // block above always returns first here. It becomes reachable once an operator has
  // resolved every field versions.lock.json's "unverified_fields" lists and flipped its
  // matching `*_verified` flag to true — never by this task, which ran none of it.
  const results: Record<string, CaseResult> = {};
  for (const c of DEFERRED_CASES) results[c] = notRun("restore/cutover rehearsal is I-21's, not this dependency proof");
  for (const c of EXTENSION_CASES) {
    results[c] = c === "extension_load"
      ? notRun("pending build")
      : notRun("requires the extension's verified DDL from the feature report, not guessed here");
  }

  if (cases !== undefined && cases !== "extension") {
    return { passed: false, detail: { status: "blocked", cases: results } };
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
