/**
 * baseline.ts — the `baseline` verb: a read-only capture of the checkout, the runtime, the store
 * and the database, validated and written before anything downstream compares against it.
 *
 * Six environment inputs. The contract names two: `ZZ_TENANT_INFO_BASELINE_DATABASE_URL` (a
 * restricted, read-only principal) and `ZZ_TENANT_INFO_STORE_ROOT` (a read-only snapshot,
 * expected to be the store's `teams/` directory — see `ledger.ts`'s `walkStore`). Three more
 * carry "operator-provided runtime inspection access", which the contract names as a category
 * without naming variables: `ZZ_TENANT_INFO_RUNTIME_IMAGE_DIGEST`,
 * `ZZ_TENANT_INFO_COMPOSE_PROJECT` and `ZZ_TENANT_INFO_VOLUME_IDS` (a JSON object).
 *
 * DELIBERATE: the operator inspects the running deployment themselves and hands the answers in.
 * This collector never shells out to an inspection tool, so it never has to run as whatever
 * principal that inspection needs.
 *
 * Fails closed: every measurement is attempted independently and failures accumulate into
 * `blocked` diagnostics rather than aborting on the first. An operator fixing one blocked mount
 * should not have to run the whole command five times to discover the other four.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { safeWritePath } from "./workspace.ts";
import {
  buildEditSurface, fileManifestHash, ownerInventory, unlistedChanges, walkStore,
  type EditSurfaceEntry,
} from "./ledger.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Report shape.

interface MeasurementEvidence { readonly kind: string; readonly locator: string }
interface CountEntry { readonly name: string; readonly value: number; readonly query: string }
interface ExtensionEntry { readonly name: string; readonly version: string }

const REQUIRED_FIELDS = [
  "captured_at", "review_reference_sha", "checkout_sha", "runtime_image_digest",
  "tool_schema_sha256", "migration_head", "postgres_version", "extensions", "database_locale",
  "collation_provider", "collation_version", "compose_project", "volume_ids", "owner_inventory",
  "file_manifest_hash", "counts", "edit_surface",
] as const;
type RequiredField = typeof REQUIRED_FIELDS[number];

interface BaselineReport {
  readonly status: "complete";
  readonly captured_at: string;
  readonly review_reference_sha: string;
  readonly checkout_sha: string;
  readonly runtime_image_digest: string;
  readonly tool_schema_sha256: string;
  readonly migration_head: string;
  readonly postgres_version: string;
  readonly extensions: readonly ExtensionEntry[];
  readonly database_locale: string;
  readonly collation_provider: string;
  readonly collation_version: string | null;
  readonly compose_project: string;
  readonly volume_ids: Readonly<Record<string, string>>;
  readonly owner_inventory: readonly { owner_id: string; files: number }[];
  readonly file_manifest_hash: string;
  readonly counts: readonly CountEntry[];
  readonly edit_surface: readonly EditSurfaceEntry[];
  readonly measurement_evidence: Readonly<Record<RequiredField, MeasurementEvidence>>;
}

interface BlockedDiagnostic { readonly field: string; readonly reason: string }
interface BlockedReport {
  readonly status: "blocked";
  readonly captured_at: string;
  readonly blocked: readonly BlockedDiagnostic[];
  readonly partial: Readonly<Record<string, unknown>>;
}

// Validator.

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Any embedded credential — a URL of the form `scheme://user:pass@host` anywhere in the
 *  report, or a `database_url` key at any depth — blocks validation outright. I-2's contract:
 *  "Never invent a replacement path or put credentials/DB URLs in the report." */
function leaksCredentials(value: unknown): boolean {
  if (isPlainObject(value)) {
    return Object.entries(value).some(
      ([k, v]) => k.toLowerCase() === "database_url" || leaksCredentials(v),
    );
  }
  if (Array.isArray(value)) return value.some(leaksCredentials);
  return typeof value === "string" && /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
}

/**
 * `{ok, issues}` — the collector's own gate before it will call anything a "complete" receipt,
 * and the frozen check's subject. Permissive about extra keys, since a real capture may carry
 * more than the fixture does, and strict field-by-field about the required ones.
 */
export function validateBaseline(report: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(report)) return { ok: false, issues: ["report is not an object"] };

  if (leaksCredentials(report)) issues.push("report embeds a credential or database URL");
  if (report.status !== "complete") issues.push('status must be "complete"');

  for (const field of REQUIRED_FIELDS) {
    if (!(field in report)) issues.push(`missing ${field}`);
  }
  if (!("measurement_evidence" in report)) issues.push("missing measurement_evidence");
  if (issues.length > 0) return { ok: false, issues }; // shape checks below assume presence

  const r = report as Record<RequiredField | "measurement_evidence", unknown>;
  if (!isNonEmptyString(r.captured_at) || Number.isNaN(Date.parse(r.captured_at))) {
    issues.push("captured_at must be a parseable ISO timestamp");
  }
  if (!/^[0-9a-f]{40}$/i.test(String(r.review_reference_sha))) issues.push("review_reference_sha must be a git sha");
  if (!/^[0-9a-f]{40}$/i.test(String(r.checkout_sha))) issues.push("checkout_sha must be a git sha");
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(r.runtime_image_digest))) {
    issues.push("runtime_image_digest must be sha256:<64 hex>");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(r.tool_schema_sha256))) issues.push("tool_schema_sha256 must be 64 hex chars");
  if (!isNonEmptyString(r.migration_head)) issues.push("migration_head must be a non-empty string");
  if (!isNonEmptyString(r.postgres_version)) issues.push("postgres_version must be a non-empty string");
  if (!Array.isArray(r.extensions) || r.extensions.some((e) =>
    !isPlainObject(e) || !isNonEmptyString(e.name) || !isNonEmptyString(e.version))) {
    issues.push("extensions must be a list of {name, version}");
  }
  if (!isNonEmptyString(r.database_locale)) issues.push("database_locale must be a non-empty string");
  if (!isNonEmptyString(r.collation_provider)) issues.push("collation_provider must be a non-empty string");
  if (r.collation_version !== null && !isNonEmptyString(r.collation_version)) {
    issues.push("collation_version must be a string or null");
  }
  if (!isNonEmptyString(r.compose_project)) issues.push("compose_project must be a non-empty string");
  if (!isPlainObject(r.volume_ids) || Object.values(r.volume_ids).some((v) => !isNonEmptyString(v))) {
    issues.push("volume_ids must be an object of non-empty strings");
  }
  if (!Array.isArray(r.owner_inventory) || r.owner_inventory.some((o) =>
    !isPlainObject(o) || !isNonEmptyString(o.owner_id) || typeof o.files !== "number" || o.files < 0)) {
    issues.push("owner_inventory must be a list of {owner_id, files >= 0}");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(r.file_manifest_hash))) issues.push("file_manifest_hash must be 64 hex chars");
  if (!Array.isArray(r.counts) || r.counts.length === 0 || r.counts.some((c) =>
    !isPlainObject(c) || !isNonEmptyString(c.name) || typeof c.value !== "number" || c.value < 0
    || !isNonEmptyString(c.query))) {
    issues.push("counts must be a non-empty list of {name, value >= 0, query} with no absent query");
  }
  if (!Array.isArray(r.edit_surface) || r.edit_surface.length === 0 || r.edit_surface.some((e) =>
    !isPlainObject(e) || !isNonEmptyString(e.path) || !isNonEmptyString(e.task)
    || !["created", "modified", "pending", "missing"].includes(String(e.change))
    || typeof e.exists !== "boolean" || !isNonEmptyString(e.coverage) || !isNonEmptyString(e.evidence))) {
    issues.push("edit_surface must be a non-empty list of {path, task, change, exists, coverage, evidence}");
  }
  if (!isPlainObject(r.measurement_evidence)
    || REQUIRED_FIELDS.some((f) => {
      const ev = (r.measurement_evidence as Record<string, unknown>)[f];
      return !isPlainObject(ev) || !isNonEmptyString(ev.kind) || !isNonEmptyString(ev.locator);
    })) {
    issues.push("measurement_evidence must carry {kind, locator} for every required field");
  }
  return { ok: issues.length === 0, issues };
}

// Measurement helpers.

const git = (args: string[]): string => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

/**
 * DELIBERATE: no fallback to this checkout's root commit. That would make `reviewRef..HEAD` the
 * entire history, and `buildEditSurface` exists to restrict the "is this task done" scan to this
 * initiative's own commits — task numbers have been reused across earlier initiatives, so
 * widening the range credits one of those to this plan. A missing `origin/master` blocks
 * `review_reference_sha` and everything downstream of it.
 */
function reviewReferenceSha(): string {
  return git(["merge-base", "HEAD", "origin/master"]);
}

/** The checkout's own idea of the migration ledger's head, read from
 *  `services/gateway/src/db.ts`'s `MIGRATIONS_DIR` — never assumed as `zz.schema_migration`
 *  without having read that runner, which creates the table itself. */
function checkoutMigrationHead(): string {
  const dir = join(repoRoot, "services/gateway/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const last = files.at(-1);
  if (!last) throw new Error(`no .sql files in ${dir}`);
  const head = /^(\d+)_/.exec(last)?.[1];
  if (!head) throw new Error(`"${last}" does not start with a migration number`);
  return head;
}

/** Every ledger name a checkout migration's `-- absorbs:` lines say it replaced.
 *
 *  COUPLED: the same directive `scripts/doctor/layers/data.ts` reads. A deployment that ran the
 *  absorbed files keeps their rows in `zz.schema_migration`, and those names can sort after the
 *  file that absorbed them (`076_…` after `002_…`), so the ledger's head is its newest name that
 *  is NOT one of these — otherwise every squashed deployment reads as ahead of its own checkout. */
function absorbedMigrations(): Set<string> {
  const dir = join(repoRoot, "services/gateway/migrations");
  return new Set(readdirSync(dir).filter((f) => f.endsWith(".sql")).flatMap((f) =>
    [...readFileSync(join(dir, f), "utf8").matchAll(/^--\s*absorbs:\s*(\S+)\s*$/gm)].map((m) => m[1])));
}

function toolSchemaSha256(): string {
  const dir = join(repoRoot, "packages/contracts/src");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
  const hash = createHash("sha256");
  for (const f of files) { hash.update(`${JSON.stringify(f)}:`); hash.update(readFileSync(join(dir, f))); }
  return hash.digest("hex");
}

const sqlLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

interface DbFacts {
  migration_head: string;
  postgres_version: string;
  extensions: ExtensionEntry[];
  database_locale: string;
  collation_provider: string;
  collation_version: string | null;
  counts: CountEntry[];
}

/** Everything the database measures, inside one `REPEATABLE READ READ ONLY` transaction so every
 *  fact — the migration ledger, the extension catalog, every count — comes from the same snapshot
 *  boundary. No mutating probe runs here; the transaction is rolled back at the end purely
 *  because there is never anything to commit. */
async function readDatabaseFacts(databaseUrl: string, absorbed: Set<string>): Promise<DbFacts> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const migrationRows = await client.query<{ name: string }>(
      "select name from zz.schema_migration order by name desc");
    if (!migrationRows.rows.length) throw new Error("zz.schema_migration has no rows");
    const migrationName = migrationRows.rows.find((r) => !absorbed.has(r.name))?.name;
    if (!migrationName) throw new Error("every zz.schema_migration row names a migration this checkout absorbed");
    const migration_head = /^(\d+)_/.exec(migrationName)?.[1] ?? migrationName;

    const version = await client.query<{ server_version: string }>("show server_version");
    const postgres_version = version.rows[0]?.server_version ?? "";

    const ext = await client.query<{ name: string; version: string }>(
      "select extname as name, extversion as version from pg_extension order by extname");
    const extensions = ext.rows;

    const db = await client.query<{ datcollate: string; datlocprovider: string; datcollversion: string | null }>(
      "select datcollate, datlocprovider, datcollversion from pg_database where datname = current_database()");
    const provider: Record<string, string> = { c: "libc", i: "icu", b: "builtin" };
    const database_locale = db.rows[0]?.datcollate ?? "";
    const collation_provider = provider[db.rows[0]?.datlocprovider ?? "c"] ?? db.rows[0]?.datlocprovider ?? "";
    const collation_version = db.rows[0]?.datcollversion ?? null;

    const runCount = async (name: string, query: string): Promise<CountEntry> => {
      const res = await client.query(query);
      // No absent count becomes zero (I-2's contract, verbatim): a query that returns no row
      // is a measurement failure, not a zero, and blocks like any other failed measurement.
      if (res.rows[0] === undefined) throw new Error(`count "${name}" returned no row: ${query}`);
      const value = Number(Object.values(res.rows[0])[0]);
      return { name, value, query };
    };
    const counts: CountEntry[] = [
      await runCount("tenants", "select count(*) as tenants from zz.team where status = 'active'"),
      await runCount("initiatives", "select count(*) as initiatives from zz.initiative"),
      await runCount("documents", "select count(*) as documents from zz.doc"),
      await runCount("knowledge_nodes", "select count(*) as knowledge_nodes from zz.knowledge_node"),
      await runCount("knowledge_nodes_adopted",
        "select count(*) as knowledge_nodes_adopted from zz.knowledge_node where lifecycle = 'adopted'"),
    ];
    const teams = await client.query<{ slug: string }>("select slug from zz.team where status = 'active' order by slug");
    for (const { slug } of teams.rows) {
      const lit = sqlLiteral(slug);
      counts.push(await runCount(`documents:${slug}`, `select count(*) as documents from zz.doc where team_slug = ${lit}`));
      counts.push(await runCount(`knowledge_nodes:${slug}`,
        `select count(*) as knowledge_nodes from zz.knowledge_node where team_slug = ${lit}`));
    }
    await client.query("ROLLBACK");
    return { migration_head, postgres_version, extensions, database_locale, collation_provider, collation_version, counts };
  } finally {
    await client.end();
  }
}

// Collector.

function evidence(kind: string, locator: string): MeasurementEvidence { return { kind, locator }; }

export async function runBaseline(workspaceReal: string): Promise<{ report: BaselineReport | BlockedReport; ok: boolean }> {
  const captured_at = new Date().toISOString();
  const blocked: BlockedDiagnostic[] = [];
  const partial: Record<string, unknown> = {};
  const measurement_evidence: Partial<Record<RequiredField, MeasurementEvidence>> = {};
  const set = <K extends RequiredField>(field: K, value: BaselineReport[K], ev: MeasurementEvidence): void => {
    partial[field] = value;
    measurement_evidence[field] = ev;
  };

  let reviewRef: string | undefined;
  try {
    reviewRef = reviewReferenceSha();
    set("review_reference_sha", reviewRef, evidence("git", "merge-base HEAD origin/master"));
  } catch (err) {
    blocked.push({ field: "review_reference_sha", reason: String(err) });
  }
  try {
    const sha = git(["rev-parse", "HEAD"]);
    set("checkout_sha", sha, evidence("git", "rev-parse HEAD"));
  } catch (err) {
    blocked.push({ field: "checkout_sha", reason: String(err) });
  }
  try {
    set("tool_schema_sha256", toolSchemaSha256(), evidence("file-hash", "packages/contracts/src/*.ts"));
  } catch (err) {
    blocked.push({ field: "tool_schema_sha256", reason: String(err) });
  }

  const digest = process.env.ZZ_TENANT_INFO_RUNTIME_IMAGE_DIGEST;
  if (digest) set("runtime_image_digest", digest, evidence("operator-provided", "ZZ_TENANT_INFO_RUNTIME_IMAGE_DIGEST"));
  else blocked.push({ field: "runtime_image_digest", reason: "ZZ_TENANT_INFO_RUNTIME_IMAGE_DIGEST is not set" });

  const composeProject = process.env.ZZ_TENANT_INFO_COMPOSE_PROJECT;
  if (composeProject) set("compose_project", composeProject, evidence("operator-provided", "ZZ_TENANT_INFO_COMPOSE_PROJECT"));
  else blocked.push({ field: "compose_project", reason: "ZZ_TENANT_INFO_COMPOSE_PROJECT is not set" });

  const volumeIdsRaw = process.env.ZZ_TENANT_INFO_VOLUME_IDS;
  if (volumeIdsRaw) {
    try {
      const parsed: unknown = JSON.parse(volumeIdsRaw);
      if (!isPlainObject(parsed)) throw new Error("not a JSON object");
      set("volume_ids", parsed as Record<string, string>, evidence("operator-provided", "ZZ_TENANT_INFO_VOLUME_IDS"));
    } catch (err) {
      blocked.push({ field: "volume_ids", reason: `ZZ_TENANT_INFO_VOLUME_IDS: ${String(err)}` });
    }
  } else {
    blocked.push({ field: "volume_ids", reason: "ZZ_TENANT_INFO_VOLUME_IDS is not set" });
  }

  let checkoutHead: string | undefined;
  try {
    checkoutHead = checkoutMigrationHead();
  } catch (err) {
    blocked.push({ field: "migration_head", reason: `checkout: ${String(err)}` });
  }

  const databaseUrl = process.env.ZZ_TENANT_INFO_BASELINE_DATABASE_URL;
  if (!databaseUrl) {
    for (const f of ["migration_head", "postgres_version", "extensions", "database_locale",
      "collation_provider", "collation_version", "counts"] as const) {
      blocked.push({ field: f, reason: "ZZ_TENANT_INFO_BASELINE_DATABASE_URL is not set" });
    }
  } else {
    try {
      const db = await readDatabaseFacts(databaseUrl, absorbedMigrations());
      if (checkoutHead !== undefined && checkoutHead !== db.migration_head) {
        blocked.push({
          field: "migration_head",
          reason: `contradictory fingerprints: checkout's newest migration is ${checkoutHead}, ` +
            `zz.schema_migration's is ${db.migration_head}`,
        });
      } else {
        set("migration_head", db.migration_head, evidence("sql", "select name from zz.schema_migration order by name desc, skipping every name a checkout migration absorbs"));
      }
      set("postgres_version", db.postgres_version, evidence("sql", "show server_version"));
      set("extensions", db.extensions, evidence("sql", "select extname, extversion from pg_extension"));
      set("database_locale", db.database_locale, evidence("sql", "select datcollate from pg_database"));
      set("collation_provider", db.collation_provider, evidence("sql", "select datlocprovider from pg_database"));
      set("collation_version", db.collation_version, evidence("sql", "select datcollversion from pg_database"));
      set("counts", db.counts, evidence("sql", "see each count's own query"));
    } catch (err) {
      for (const f of ["migration_head", "postgres_version", "extensions", "database_locale",
        "collation_provider", "collation_version", "counts"] as const) {
        blocked.push({ field: f, reason: `database read failed: ${String(err)}` });
      }
    }
  }

  const storeRoot = process.env.ZZ_TENANT_INFO_STORE_ROOT;
  if (!storeRoot) {
    blocked.push({ field: "owner_inventory", reason: "ZZ_TENANT_INFO_STORE_ROOT is not set" });
    blocked.push({ field: "file_manifest_hash", reason: "ZZ_TENANT_INFO_STORE_ROOT is not set" });
  } else {
    try {
      const rows = walkStore(storeRoot);
      set("owner_inventory", ownerInventory(rows), evidence("filesystem", `${storeRoot} (per top-level team directory)`));
      set("file_manifest_hash", fileManifestHash(rows), evidence("file-hash", `${rows.length} files under ${storeRoot}`));
    } catch (err) {
      blocked.push({ field: "owner_inventory", reason: String(err) });
      blocked.push({ field: "file_manifest_hash", reason: String(err) });
    }
  }

  if (reviewRef !== undefined) {
    try {
      set("edit_surface", buildEditSurface(repoRoot, reviewRef), evidence("git+filesystem", `${reviewRef.slice(0, 12)}..HEAD`));
      const unlisted = unlistedChanges(repoRoot, reviewRef);
      if (unlisted.length > 0) {
        blocked.push({ field: "edit_surface", reason: `unlisted required edit(s): ${unlisted.join(", ")}` });
      }
    } catch (err) {
      blocked.push({ field: "edit_surface", reason: String(err) });
    }
  } else {
    blocked.push({ field: "edit_surface", reason: "review_reference_sha unavailable" });
  }

  if (blocked.length > 0) {
    const report: BlockedReport = { status: "blocked", captured_at, blocked, partial };
    writeFileSync(safeWritePath(workspaceReal, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
    return { report, ok: false };
  }

  const report: BaselineReport = {
    status: "complete", captured_at, ...partial,
    measurement_evidence: measurement_evidence as Record<RequiredField, MeasurementEvidence>,
  } as BaselineReport;
  const { ok, issues } = validateBaseline(report);
  if (!ok) {
    const failed: BlockedReport = {
      status: "blocked", captured_at,
      blocked: issues.map((reason) => ({ field: "validateBaseline", reason })),
      partial,
    };
    writeFileSync(safeWritePath(workspaceReal, "baseline.json"), `${JSON.stringify(failed, null, 2)}\n`);
    return { report: failed, ok: false };
  }
  writeFileSync(safeWritePath(workspaceReal, "baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { report, ok: true };
}
