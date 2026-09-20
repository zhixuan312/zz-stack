/**
 * Platform database ("zz") — creation, migration and access.
 *
 * The gateway owns the `zz` SCHEMA inside the existing database (default:
 * the same DB as TEAM_DB_URL). On boot: ensure the schema, run the SQL
 * files in ./migrations in name order, record each in zz.schema_migration.
 *
 * ONLY ./migrations. `../migrations-next/` holds migrations that are written and tested and
 * deliberately not applied — one today, waiting on the read paths that must move with it. It is
 * not scanned, and its own README says what has to land alongside each file. Named here because
 * nothing else in the repository named it at all, so the only way to find it was to list the
 * directory.
 * No framework — migrations are plain SQL. Connections pin
 * search_path=zz,public so platform tables resolve to zz.* while extensions,
 * which install into public, stay resolvable. `public` used to hold the old
 * front end's own tables; it holds nothing of ours now.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { configureIndexing } from "@zz/indexing";

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
// THE INDEXER IS TOLD HOW TO REACH THE DATABASE HERE, at import time, because this module is
// the one that owns the pool. `@zz/indexing` is shared with zz-core, which builds its pool
// lazily and answers "is there a database" a different way, so the package takes an accessor
// rather than picking one service's shape and making the other wrong.
//
// `null` WHERE THIS THROWS. platformDb() throws before initPlatformDb has run, which is right
// for a caller that cannot proceed without a database; the indexer's null means "this
// deployment has none", which is an ordinary answer it already handles. Handing it the
// throwing accessor would turn a local dev boot into a stack trace on the first document
// written.
configureIndexing(() => (platformDbReady() ? platformDb() : null));

export async function initPlatformDb(): Promise<void> {
  const serverUrl = (process.env.PLATFORM_DB_URL || process.env.TEAM_DB_URL || "").trim();
  if (!serverUrl) {
    console.log("PLATFORM_DB_URL/TEAM_DB_URL not set — platform db features disabled (local dev)");
    return;
  }
  // platform tables live in the `zz` SCHEMA of the existing database —
  // one Postgres, clean separation, zero new infrastructure
  //
  // BOUNDED WAITS, AND NO `statement_timeout` — the omission is deliberate.
  //
  // zz-core's pool sets one, because every statement it runs is a tool query that returns in
  // milliseconds. THIS pool runs the migrations, twenty lines below, and a migration that
  // rewrites a table legitimately takes as long as it takes. A server-side timeout here would
  // abort one partway on the first deployment whose data outgrew it, which is a worse failure
  // than the one it prevents: a half-applied migration is not something a retry fixes.
  //
  // The other two bounds carry no such risk and are set. `connectionTimeoutMillis` stops a
  // caller queueing forever behind six busy connections — it is refused in ten seconds and says
  // so — and `idleTimeoutMillis` returns what the deployment is not using.
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
  // WHICH EXTENSIONS THIS CLUSTER COULD EVEN INSTALL, read once. A migration that needs one the
  // server does not ship must not be attempted here — see the deferral below for what it costs
  // when it is.
  const available = new Set(
    (await pool.query<{ name: string }>("select name from pg_available_extensions")).rows.map((r) => r.name),
  );

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // A MIGRATION MAY DECLARE AN EXTENSION IT CANNOT RUN WITHOUT, and if this cluster cannot
    // supply it the migration is DEFERRED — skipped, and deliberately NOT recorded as applied.
    //
    // WHAT THIS PREVENTS, precisely. The tenant-information migration needs pg_textsearch. The
    // deployed platform database is PostgreSQL 16 with citext and plpgsql and nothing else, and
    // the PostgreSQL 17 image that carries the extension arrives in a later, separately
    // rehearsed cutover. Without this guard the first boot after that migration merged would
    // fail `create extension`, roll back, un-set the pool and rethrow — and the caller logs and
    // starts the server anyway, by a deliberate choice made elsewhere in this file. The result
    // is not a crash anybody notices. It is the whole platform running with no database while
    // reporting itself up, against a deployment holding 527 live documents.
    //
    // NOT RECORDED IS THE LOAD-BEARING HALF. Making the extension conditional inside the SQL
    // would let the migration mark itself applied on a cluster where it did nothing, and
    // `zz.schema_migration` travels with the logical restore into the new cluster — so it would
    // never run there either, and the objects would simply never exist. Deferral leaves the
    // ledger honest: the migration is still owed, and the first boot on a cluster that can
    // supply the extension applies it.
    //
    // AND IT STOPS THE LOOP. A later migration may build on a deferred one's objects, so
    // applying past a gap trades a loud, correct failure for a confusing one.
    const needs = /^--\s*requires-extension:\s*([a-z0-9_]+)\s*$/im.exec(sql)?.[1];
    if (needs && !available.has(needs)) {
      console.warn(`migration DEFERRED: ${file} requires the "${needs}" extension, which this ` +
        `server does not offer. It is not recorded as applied and will run on a cluster that ` +
        `can supply it. Migrations after it are deferred too.`);
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
      // Withdraw the pool before rethrowing. The caller logs and starts the server
      // anyway — deliberately, so a database problem does not take the platform down —
      // but `pool` was assigned before migrations ran, so platformDbReady() would keep
      // saying yes and every feature would go on querying a HALF-MIGRATED schema. A
      // platform that answers wrongly is worse than one that admits it cannot answer.
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
 * This used to import principals and teams out of Open WebUI's own tables — "user",
 * "group", group_member — because Open WebUI was where people already existed. It is
 * gone, and with it the last path where a front end was a source of platform truth.
 *
 * What replaced it answers the question a fresh install actually asks: who is the
 * superadmin, and which team do they belong to? A deployment with a superadmin and no
 * team is not usable — `teamFor()` returns null and every document lands in a per-user
 * store instead of the team's. So the first team is seeded here from BOOTSTRAP_TEAM and
 * the superadmin is made its admin. Both steps are idempotent, and neither depends on
 * another product's schema. */
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

  // THE PLATFORM IS ALSO A TENANT, and this is the team it is.
  //
  // BEFORE the tenant team, because it does not depend on one. This sat below the
  // BOOTSTRAP_TEAM block and inside its early return, so an install that set a superadmin
  // and left BOOTSTRAP_TEAM empty — which deploy/README.md warns against and nothing
  // prevents — reserved this slug and never created it. The gate's own words for that
  // state: "reserved but never seeded means the home is a name with nothing behind it."
  //
  // Every day this platform learns things that are not about anybody's delivery: that a
  // block returns a bare 422 and still has not been fixed, that most of a block's tools describe
  // themselves by restating their own name, that a section rule we wrote was strict enough
  // that six of six real documents broke it. None of that belongs to a tenant, and until
  // now it had nowhere to live — so it lived in a hand-written appendix, in STATE.md
  // paragraphs, and in commit messages, which is to say it was not queryable at all.
  //
  // Zero new mechanism, deliberately. This is an ordinary team with an ordinary store and
  // the same `_knowledge/` every tenant has: the same journal nodes, the same type enum,
  // the same supersession, the same refusal to record an opinion with no evidence behind
  // it. The only new thing is that its nodes are keyed to a REGISTRY ENTRY — `block:casebox`,
  // `flow:sdlc-flow`, `provider:…`, `interface:…` — which is a vocabulary the platform
  // already closed.
  //
  // Seeded rather than created through team_create, and reserved there, because a tenant
  // taking this slug would be writing into the platform's own record.
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

  // SAID EVEN WHEN THERE IS NO FIRST TEAM. The platform team is seeded above this line
  // deliberately — it does not depend on a tenant — and the only line reporting any of it sat
  // BELOW the early return, so an install that set a superadmin and left BOOTSTRAP_TEAM empty
  // did the work and said nothing at all. Work done in silence is indistinguishable from work
  // skipped, which is the state this block's own comment was written about.
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
