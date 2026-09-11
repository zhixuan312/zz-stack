/**
 * The platform database, and the two questions zz-core asks it: which team a person acts
 * for, and what version a subject tag names.
 *
 * ONE POOL, LAZILY MADE. zz-core runs with TEAM_DB_URL unset in local development and every
 * one of these answers has a defined shape without a database — a person with no membership
 * row gets their own store — so the connection is made on first use rather than at import,
 * and `db()` returning null is an ordinary answer rather than a failure.
 */
import pg from "pg";

import { actingTeam } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { Refusal } from "./refusal.js";

export const ARTIFACTS_DIR = "/artifacts";
const TEAM_DB_URL = (process.env.TEAM_DB_URL ?? "").trim();
let pool: pg.Pool | undefined;
/** The platform database, connected on first use, or null when this deployment has none.
 *
 * `pool ??= new pg.Pool({ connectionString: TEAM_DB_URL, max: 4 })` was written out at five
 * call sites, and three more functions READ `pool` and treated `undefined` as "there is no
 * database". Those are two different questions — is there one configured, and has anybody
 * connected yet — and answering the first with the second is a race with whatever the caller
 * happened to do first.
 *
 * reindexAllTeams already hit it: the boot rebuild returned 0 scanned, 0 indexed, 0 removed
 * for every team because nothing had served a request yet, and the fix was to write the
 * construction out a fifth time rather than to stop asking the wrong question. indexDoc and
 * reindexTeam still asked it, so a write arriving before any pool existed went to disk and
 * silently never reached the index — invisible to search_knowledge until the next reindex.
 *
 * One accessor, so "is there a database" has one answer and connecting is not something a
 * caller can forget to do. The size lives here too: four connections spelled in five places
 * is four connections until somebody changes one of them. */
export function db(): pg.Pool | null {
  if (!TEAM_DB_URL) return null;
  pool ??= new pg.Pool({ connectionString: TEAM_DB_URL, max: 4 });
  return pool;
}
const teamCache = new Map<string, { team: string | null; all: string[]; expires: number }>();
/** Which team's store a person writes into.
 *
 * The platform's own membership decides it — zz.principal + zz.membership — and
 * nothing else does. There used to be a fallback here that read the front end's own
 * groups for anyone with no membership row, kept as a migration path. It is gone: a
 * live check found it matched no user, and while it existed the front end was still a
 * source of platform truth, which is the one thing "the interface is replaceable"
 * cannot be true alongside. A person with no membership now gets their own store. */
export async function teamFor(email: string): Promise<string | null> {
  return (await teamsFor(email)).active;
}
/** Every team a person belongs to, and the ONE whose store their tools act on.
 *
 * The store is per team and the tools take no team argument, so a person in two teams reads
 * and writes exactly one of them — chosen here, admin role first and then alphabetically.
 * That choice was invisible: get_my_info reported a single `team` and nothing said the other
 * existed, so work could land in the wrong store with the conversation looking normal.
 * get_my_info now names the others and how to pick one. */
export async function teamsFor(email: string): Promise<{ active: string | null; all: string[] }> {
  const p = db();
  if (!p || !email) return { active: null, all: [] };
  // A team-bound token acts inside that team, here too.
  //
  // The gateway narrows an identity to the bound team and stamps x-zz-pat-team on the
  // request; the /core proxy forwards it. zz-core queried the database by email and ignored
  // it, so a token that said "team X" on its face read team Y's store — the same binding
  // holding on one side of the proxy and not the other.
  const boundRaw = requestHeaders()["x-zz-pat-team"];
  const bound = (Array.isArray(boundRaw) ? boundRaw[0] : boundRaw ?? "").trim();
  const now = Date.now();
  const key = bound ? `${email}\u0000${bound}` : email;
  const hit = teamCache.get(key);
  if (hit && hit.expires > now) return { active: hit.team, all: hit.all };
  try {
    // `slug` is NULL for a membership of an archived team, and those rows are dropped two
    // lines below — the row is still returned so `active_slug`, a scalar about the person
    // rather than about any one membership, is readable even when every team they belong to
    // has been archived. The ORDER BY is what `all` is listed in for get_my_info: live teams
    // first, then the ones they administer, then by name.
    //
    // This comment described a `known` column and a fallback that depended on telling it
    // apart from `slug`. Neither has existed since actingTeam took the choice over.
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
    // WHICH TEAM they are acting as: `actingTeam` in @zz/contracts, which the gateway calls
    // too. The bound-token rule, the chosen team and the fallback ordering all live there —
    // the gateway needed the same answer for credential resolution and was taking the first
    // row of a differently ordered query, so a person in two teams could have documents land
    // in one team's store while the block call spent another team's quota.
    const active = actingTeam(
      platform.rows.filter((r) => !!r.slug).map((r) => ({ slug: r.slug as string, role: r.role })),
      platform.rows[0]?.active_slug ?? null,
      bound || null,
    );
    // SECONDS, not a minute. This cached a fact that could not change — the team was derived
    // from membership, so a minute of staleness cost nothing. The active team is now a
    // choice a person makes, and a switch that takes up to a minute to apply is not a
    // switch: they move team, keep working, and their next few writes land where they just
    // left. Verified exactly that before shortening it.
    //
    // The entry is still kept after it expires: the catch below falls back to a stale one
    // rather than failing every tool on a database hiccup, and that is worth more than the
    // freshness it trades away in the one case where the database is already down.
    teamCache.set(key, { team: active, all: every, expires: now + 3_000 });
    return { active, all: every };
  } catch (err) {
    if (hit) return { active: hit.team, all: hit.all }; // stale cache beats failing every tool on a DB hiccup
    // The CAUSE, not a guess at it. This asserted "platform database unreachable" and threw
    // the real error away — but the query can fail for reasons that are not a network: a
    // half-migrated schema, a role without select on zz.membership, a connection string
    // pointing at the wrong database. Every one of those then reached an operator as
    // "unreachable", which is the wrong thing to go and check. db.ts states the rule for
    // exactly this case: a platform that answers wrongly is worse than one that admits it
    // cannot answer.
    //
    // A `Refusal`, not a plain `Error` — this is THE reason that type exists. teamFor() is
    // called bare (no try/catch) from userRoot() and from most tools directly, so a plain
    // throw here used to reach the tool boundary as a raw, un-housestyled message. The
    // registerTool wrapper turns a `Refusal` into `text(message)`; every write this failure
    // could interrupt happens after this resolves, so "nothing was written" is true whenever
    // it fires.
    throw new Refusal(
      `ERROR: the platform database did not answer while resolving your team: ` +
      `${(err as Error).message}. Nothing was written. Tell an administrator if it persists.`);
  }
}
/** The version behind a subject tag, and why the three kinds it can name are not answered
 *  the same way.
 *
 *  `block:<name>` — the standard says the version is the one in `serverInfo` at the MCP
 *  handshake, and the platform records it on every call, so the newest row in
 *  zz.block_version IS what the block last told us it was.
 *
 *  `flow:<name>` — resolved from zz.flow_install, scoped to the caller's team: an install is
 *  team-scoped by its own primary key (team_id, flow), so the same flow name can carry a
 *  different version per team and there is no team-less answer to give.
 *
 *  `provider:` and `interface:` — there is NO backing table for either kind. zz.block_version
 *  tracks blocks and zz.flow_install tracks flows; nothing records a version for a provider
 *  or an interface. Their "unresolved" is therefore PERMANENT rather than a lookup that is
 *  merely failing today — there is no query that could ever make it resolve, unlike the other
 *  two kinds' "unresolved", which means only that this particular lookup did not find a row.
 *
 *  Returns null when none of the four kinds is present — a node not about any of them — and
 *  the field is then written empty rather than guessed. Never null once a subject tag IS
 *  present: an infra hiccup at write time must not be indistinguishable from "no subject
 *  involved", or it would permanently produce a claim that can never be retired. */
export async function blockVersionFor(tags: string[] | undefined, team: string | null): Promise<string | null> {
  const all = tags ?? [];
  const blockTag = all.find((t) => t.startsWith("block:"));
  const flowTag = all.find((t) => t.startsWith("flow:"));
  const otherTag = all.find((t) => t.startsWith("provider:") || t.startsWith("interface:"));
  if (blockTag) {
    try {
      const p = db();
      // `unresolved`, NOT null. A `block:` tag is present, so the subject exists and only the
      // lookup failed — which is precisely the distinction the docstring above promises and
      // this branch was quietly breaking. Returning null here wrote the field empty, and empty
      // is this function's word for "no subject involved": a node about a block, filed on a
      // deployment with no database, became indistinguishable from a node about nothing.
      // Found in review, in the same initiative that added the `flow:` branch two lines below
      // with this case already handled correctly.
      if (!p) return "unresolved";
      const r = await p.query<{ version: string }>(
        `select bv.version from zz.block_version bv join zz.block b on b.id = bv.block_id
          where b.name = $1 order by bv.first_seen_at desc limit 1`, [blockTag.slice(6)]);
      return r.rows[0]?.version ?? "unresolved";
    } catch {
      return "unresolved";
    }
  }
  if (flowTag) {
    try {
      const p = db();
      if (!p || !team) return "unresolved";
      const r = await p.query<{ version: string }>(
        `select f.version from zz.flow_install f join zz.team t on t.id = f.team_id
          where t.slug = $1 and f.flow = $2`, [team, flowTag.slice(5)]);
      return r.rows[0]?.version || "unresolved";
    } catch {
      return "unresolved";
    }
  }
  if (otherTag) return "unresolved"; // no backing table for provider:/interface: — see docstring
  return null;
}
