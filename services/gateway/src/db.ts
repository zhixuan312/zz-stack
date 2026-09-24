/**
 * Platform database ("zz") — creation, migration and access.
 *
 * The gateway owns the `zz` schema inside the existing database (default:
 * the same DB as TEAM_DB_URL). On boot: ensure the schema, run the SQL
 * files in ./migrations in name order, record each in zz.schema_migration.
 *
 * DELIBERATE: ./migrations is the only migration directory; the runner reads nothing else.
 *
 * No framework — migrations are plain SQL. Connections pin search_path=zz,public so platform
 * tables resolve to zz.* while extensions, which install into public, stay resolvable.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { PLATFORM_TEAM, TEAM_SLUG, toTeamSlug } from "./identity.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let pool: pg.Pool | undefined;

export function platformDb(): pg.Pool {
  if (!pool) throw new Error("platform db not initialised");
  return pool;
}

export function platformDbReady(): boolean {
  return pool !== undefined;
}

/**
 * Every extension a migration declares it cannot run without.
 *
 * COUPLED: exported so `checks/migration-extension-declared.ts` drives this function rather
 * than asserting over this file's source text, and the runner below calls the same function.
 *
 * All the directives, not the first: a migration needing two extensions must have both
 * checked, or it is attempted with one missing.
 */
export function requiredExtensions(sql: string): string[] {
  return [...sql.matchAll(/^--\s*requires-extension:\s*([a-z0-9_]+)\s*$/gim)].map((m) => m[1]);
}

export async function initPlatformDb(): Promise<void> {
  const serverUrl = (process.env.PLATFORM_DB_URL || process.env.TEAM_DB_URL || "").trim();
  if (!serverUrl) {
    console.log("PLATFORM_DB_URL/TEAM_DB_URL not set — platform db features disabled (local dev)");
    return;
  }
  // Platform tables live in the `zz` schema of the existing database.
  //
  // DELIBERATE: no `statement_timeout`, unlike zz-core's pool. This pool runs the migrations
  // below, and a migration that rewrites a table takes as long as it takes; a server-side
  // timeout would abort one partway, which no retry fixes. The other two bounds carry no such
  // risk and are set.
  pool = new pg.Pool({
    connectionString: serverUrl,
    max: Number(process.env.ZZ_DB_POOL_MAX || 6),
    connectionTimeoutMillis: Number(process.env.ZZ_DB_CONNECT_TIMEOUT_MS || 10_000),
    idleTimeoutMillis: 30_000,
    options: "-csearch_path=zz,public",
  });
  await pool.query("create schema if not exists zz");

  await pool.query(`create table if not exists zz.schema_migration (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await pool.query<{ name: string }>("select name from zz.schema_migration")).rows.map((r) => r.name),
  );
  // Which extensions this cluster could install, read once: a migration needing one the server
  // does not ship is deferred rather than attempted.
  const available = new Set(
    (await pool.query<{ name: string }>("select name from pg_available_extensions")).rows.map((r) => r.name),
  );

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // A migration may declare an extension it cannot run without, and a cluster that cannot
    // supply it defers the migration: skipped, and not recorded as applied.
    //
    // DELIBERATE: not recording it is the load-bearing half. Making the extension conditional
    // inside the SQL would mark the migration applied on a cluster where it did nothing, and
    // `zz.schema_migration` travels with a logical restore, so the objects would never exist.
    // Deferral leaves the ledger honest and the first boot on a capable cluster applies it.
    //
    // The loop breaks rather than continuing, because a later migration may build on a
    // deferred one's objects.
    //
    // Attempting one instead fails `create extension`, rolls back, un-sets the pool and
    // rethrows — and the caller starts the server anyway, so the platform runs with no
    // database while reporting itself up.
    const missing = requiredExtensions(sql).filter((name) => !available.has(name));
    if (missing.length > 0) {
      console.warn(`migration DEFERRED: ${file} requires the ${missing.map((n) => `"${n}"`).join(" and ")} ` +
        `extension${missing.length > 1 ? "s" : ""}, which this server does not offer. It is not ` +
        `recorded as applied and will run on a cluster that can supply ${missing.length > 1 ? "them" : "it"}. ` +
        `Migrations after it are deferred too.`);
      break;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into zz.schema_migration (name) values ($1)", [file]);
      await client.query("commit");
      console.log("migration applied:", file);
    } catch (err) {
      await client.query("rollback");
      // Withdraw the pool before rethrowing: the caller starts the server anyway, and `pool`
      // was assigned before migrations ran, so platformDbReady() would otherwise keep saying
      // yes and every feature would query a half-migrated schema.
      pool = undefined;
      throw err;
    } finally {
      client.release();
    }
  }

  await seed();
}

/** Seed: the superadmin, and the first team, from configuration.
 *
 * A deployment with a superadmin and no team is not usable: `teamFor()` returns null and every
 * document lands in a per-user store instead of the team's. So the first team is seeded from
 * BOOTSTRAP_TEAM and the superadmin is made its admin. Both steps are idempotent. */
async function seed(): Promise<void> {
  const db = platformDb();
  const superadmin = (process.env.SUPERADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!superadmin) return;

  await db.query(
    `insert into principal (email, role) values ($1, 'superadmin')
     on conflict (email) do update set role = 'superadmin'`,
    [superadmin],
  );

  const actorId = (
    await db.query<{ id: string }>("select id from principal where email = $1", [superadmin])
  ).rows[0]?.id;
  if (!actorId) return;

  // The platform is also a tenant, and this is the team it is: an ordinary team with the same
  // store and `_knowledge/` every tenant has, holding what the platform learns about its own
  // registry entries. Seeded here rather than through team_create, which reserves the slug.
  //
  // DELIBERATE: before the tenant team and outside BOOTSTRAP_TEAM's early return, because it
  // does not depend on one — otherwise an install with no BOOTSTRAP_TEAM reserves the slug and
  // never creates the team.
  await db.query(
    `insert into team (slug, name, created_by) values ($1, $2, $3)
     on conflict (slug) do nothing`,
    [PLATFORM_TEAM, "ZZ Platform", actorId],
  );
  await db.query(
    `insert into membership (team_id, principal_id, role, added_by)
     select t.id, $2, 'admin', $2 from team t where t.slug = $1
     on conflict do nothing`,
    [PLATFORM_TEAM, actorId],
  );

  // Reported even when there is no first team: the platform team was seeded above, and work
  // done in silence is indistinguishable from work skipped.
  const raw = (process.env.BOOTSTRAP_TEAM ?? "").trim();
  if (!raw) {
    console.log(`platform db seeded: superadmin ${superadmin}, platform team ${PLATFORM_TEAM}; ` +
                "BOOTSTRAP_TEAM is unset, so no tenant team was created");
    return;
  }
  const slug = toTeamSlug(raw);
  if (!slug || !TEAM_SLUG.test(slug)) {
    console.warn(`BOOTSTRAP_TEAM "${raw}" has no usable team slug — skipped`);
    return;
  }

  await db.query(
    `insert into team (slug, name, created_by) values ($1, $2, $3)
     on conflict (slug) do nothing`,
    [slug, raw, actorId],
  );
  await db.query(
    `insert into membership (team_id, principal_id, role, added_by)
     select t.id, $2, 'admin', $2 from team t where t.slug = $1
     on conflict do nothing`,
    [slug, actorId],
  );
  console.log(`platform db seeded: superadmin ${superadmin}, platform team ${PLATFORM_TEAM}, first team ${slug}`);
}
