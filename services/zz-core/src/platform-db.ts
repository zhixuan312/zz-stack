/**
 * The platform database, and the two questions zz-core asks it: which team a person acts for, and
 * what version a subject tag names.
 *
 * One pool, lazily made. zz-core runs with TEAM_DB_URL unset in local development and every answer
 * here has a defined shape without a database — a person with no membership row gets their own
 * store — so the connection is made on first use and `db()` returning null is an ordinary answer.
 */
import pg from "pg";

import { pluginName } from "@zz/catalog";
import { actingTeam } from "@zz/contracts";
import { configureIndexing } from "@zz/indexing";
import { requestHeaders } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";
import { currentVersionOf } from "./release-head.js";

const TEAM_DB_URL = (process.env.TEAM_DB_URL ?? "").trim();
let pool: pg.Pool | undefined;
/** The platform database, connected on first use, or null when this deployment has none.
 *
 * One accessor, so "is there a database configured" and "has anybody connected yet" are not
 * answered with each other. Reading `pool` directly and treating `undefined` as "there is no
 * database" makes a write arriving before any pool exists go to disk and never reach the index,
 * invisible to knowledge_search until the next reindex. The pool size lives here for the same
 * reason.
 *
 * Every wait here is bounded, and with four connections that is not a refinement: a statement with
 * no timeout holds its connection for as long as the server will let it, and four of those leave
 * the service with none while `/health` goes on answering 200, because it touches no database.
 *
 * `statement_timeout` is the server-side bound and the one that actually releases the connection,
 * so it is set on the connection rather than left to a client-side race. Thirty seconds is far
 * above anything here, so it can only fire on something already wrong.
 * `connectionTimeoutMillis` bounds the wait for a connection to become free, so a caller arriving
 * during a pile-up is refused rather than joining it. `idleTimeoutMillis` returns connections the
 * deployment is not using. All three are overridable. */
export function db(): pg.Pool | null {
  if (!TEAM_DB_URL) return null;
  pool ??= new pg.Pool({
    connectionString: TEAM_DB_URL,
    max: Number(process.env.ZZ_DB_POOL_MAX || 4),
    statement_timeout: Number(process.env.ZZ_DB_STATEMENT_TIMEOUT_MS || 30_000),
    connectionTimeoutMillis: Number(process.env.ZZ_DB_CONNECT_TIMEOUT_MS || 10_000),
    idleTimeoutMillis: 30_000,
  });
  return pool;
}
// The indexer is told how to reach the database here, at import time, because this module owns the
// pool. The package takes an accessor, because the pool is built lazily.
//
// At module level and not in server.ts: every path that indexes a document reaches teamFor() or
// userRoot() first, so this module is loaded before any of them can run. A call in the entry point
// is one an eval door, a test harness or a second entry point can forget, and forgetting it does
// not fail loudly — it writes documents nothing can find.
configureIndexing(db);
const teamCache = new Map<string, { team: string | null; all: string[]; expires: number }>();
/** Which team's store a person writes into.
 *
 * The platform's own membership decides it — zz.principal + zz.membership — and nothing else does.
 * A person with no membership gets their own store. */
export async function teamFor(email: string): Promise<string | null> {
  return (await teamsFor(email)).active;
}
/** Every team a person belongs to, and the one whose store their tools act on.
 *
 * The store is per team and the tools take no team argument, so a person in two teams reads and
 * writes exactly one of them — chosen here, admin role first and then alphabetically. COUPLED:
 * session_whoami names the others and how to pick one. */
export async function teamsFor(email: string): Promise<{ active: string | null; all: string[] }> {
  const p = db();
  if (!p || !email) return { active: null, all: [] };
  // A team-bound token acts inside that team, here too. The gateway narrows an identity to the
  // bound team and stamps x-zz-pat-team on the request, and the /core proxy forwards it; querying
  // by email alone makes a token that says "team X" read team Y's store.
  const boundRaw = requestHeaders()["x-zz-pat-team"];
  const bound = (Array.isArray(boundRaw) ? boundRaw[0] : boundRaw ?? "").trim();
  const now = Date.now();
  const key = bound ? `${email}\u0000${bound}` : email;
  const hit = teamCache.get(key);
  if (hit && hit.expires > now) return { active: hit.team, all: hit.all };
  try {
    // `slug` is NULL for a membership of an archived team, and those rows are dropped two lines
    // below — the row is still returned so `active_slug`, a scalar about the person rather than
    // about any one membership, is readable even when every team they belong to has been archived.
    // The ORDER BY is what `all` is listed in for session_whoami: live teams first, then the ones
    // they administer, then by name.
    const platform = await p.query<{ slug: string | null; role: "admin" | "member"; active_slug: string | null }>(
      `SELECT CASE WHEN t.status = 'active' THEN t.slug END AS slug,
              m.role                                          AS role,
              (SELECT at.slug FROM zz.team at WHERE at.id = p.active_team_id
                 AND at.status = 'active')                     AS active_slug
         FROM zz.membership m
         JOIN zz.team t ON t.id = m.team_id
         JOIN zz.principal p ON p.id = m.principal_id
        WHERE lower(p.email) = $1 AND p.status = 'active'
        ORDER BY (t.status = 'active') DESC, m.role = 'admin' DESC, t.slug`,
      [email],
    );
    const every = platform.rows.map((r) => r.slug).filter((s): s is string => !!s);
    // COUPLED: which team they are acting as is `actingTeam` in @zz/contracts, which the gateway
    // calls too. The bound-token rule, the chosen team and the fallback ordering all live there, so
    // a person's documents and their gateway calls cannot resolve to two different teams.
    const active = actingTeam(
      platform.rows.filter((r) => !!r.slug).map((r) => ({ slug: r.slug as string, role: r.role })),
      platform.rows[0]?.active_slug ?? null,
      bound || null,
    );
    // Seconds, not a minute. The active team is a choice a person makes, and a switch that takes up
    // to a minute to apply is not a switch.
    //
    // The entry is kept after it expires: the catch below falls back to a stale one rather than
    // failing every tool on a database hiccup.
    teamCache.set(key, { team: active, all: every, expires: now + 3_000 });
    return { active, all: every };
  } catch (err) {
    if (hit) return { active: hit.team, all: hit.all }; // stale cache beats failing every tool on a DB hiccup
    // The cause, not a guess at it. The query can fail for reasons that are not a network — a
    // half-migrated schema, a role without select on zz.membership, a connection string pointing at
    // the wrong database — and reporting every one of them as "unreachable" sends an operator to
    // the wrong thing to check.
    //
    // A `Refusal`, not a plain `Error`: teamFor() is called bare from userRoot() and from most
    // tools, and the registerTool wrapper turns a `Refusal` into `text(message)`. Every write this
    // failure could interrupt happens after this resolves, so "nothing was written" is true
    // whenever it fires.
    throw new Refusal(
      `ERROR: the platform database did not answer while resolving your team: ` +
      `${(err as Error).message}. Nothing was written. Tell an administrator if it persists.`);
  }
}
/** The version behind a subject tag.
 *
 *  `plugin:<name>` and `flow:<name>` — the plugin's current version, read by `currentVersionOf`
 *  (release-head.ts), the same reader plugin_locate's head uses: a catalog plugin's is the
 *  version the running deployment declares, never a higher legacy row. A flow is a plugin,
 *  registered at release under `pluginName` of its directory (`flow:sdlc-flow` is the plugin
 *  `sdlc`), so the two tags resolve the same way.
 *
 *  `provider:` and `interface:` — no backing table for either, so their "unresolved" is permanent
 *  rather than a lookup that is merely failing today.
 *
 *  Null when no subject tag is present, and the field is then written empty rather than guessed.
 *  Never null once a subject tag is present: an infra hiccup at write time must not be
 *  indistinguishable from "no subject involved", or it produces a claim that can never be
 *  retired. */
export async function subjectVersionFor(
  tags: string[] | undefined, p: Pick<pg.Pool, "query"> | null = db(),
): Promise<string | null> {
  const all = tags ?? [];
  const pluginTag = all.find((t) => t.startsWith("plugin:") || t.startsWith("flow:"));
  const otherTag = all.find((t) => t.startsWith("provider:") || t.startsWith("interface:"));
  if (pluginTag) {
    try {
      // `unresolved`, not null: a tag is present, so the subject exists and only the lookup
      // failed. Empty is this function's word for "no subject involved". A catalog version with
      // no row refuses inside currentVersionOf, and lands here as `unresolved` too.
      if (!p) return "unresolved";
      const id = (await p.query<{ id: string }>(
        "select id::text as id from zz.plugin where name = $1",
        [pluginName(pluginTag.slice(pluginTag.indexOf(":") + 1))])).rows[0]?.id;
      if (!id) return "unresolved";
      return (await currentVersionOf(p, id)) ?? "unresolved";
    } catch {
      return "unresolved";
    }
  }
  if (otherTag) return "unresolved"; // no backing table for provider:/interface: — see docstring
  return null;
}
