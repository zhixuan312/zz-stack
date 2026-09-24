/**
 * Reserved teams for a replay run: one team per run, created to hold exactly that run's own
 * credential and nothing else, torn down when the run ends.
 *
 * Team creation and PAT issuance are the gateway's authority, but `replay_start` and
 * `replay_close` run inside zz-core — a separate service, deployed and built on its own.
 * Neither service imports the other's package; only `packages/*` cross that boundary, the same
 * way `mintPat` and `actingTeam` already do for identity. There is also no internal HTTP
 * endpoint either service calls the other through — the gateway only ever proxies requests
 * *to* zz-core, never the reverse, and nothing in this repository has zz-core making an HTTP
 * call to the gateway. Both services already hold their own direct connection to the same
 * physical `zz` schema (TEAM_DB_URL / PLATFORM_DB_URL), which is exactly what `@zz/contracts`
 * is for: a function here, called with whichever pool the caller already has, is the narrowest
 * path consistent with how this codebase already crosses the service boundary — not a new
 * HTTP surface invented for this one feature.
 *
 * COUPLED: `issuePat`/`revokePat` in pat.ts are the same write path `pat_issue` and
 * `pat_revoke` use — this does not mint, hash or revoke a token any other way.
 */
import { issuePat, revokePat, type Db } from "./pat.js";
import { sha256 } from "./identity.js";

/** The prefix `team_create` refuses for everyone, superadmin included — what makes a
 *  `replay-` slug mean "provisioned by provisionReplayTeam", never "typed by a person". */
export const REPLAY_TEAM_PREFIX = "replay-";

/** The refusal a team-bound caller gets from provisionReplayTeam, named so a caller matches on
 *  the code rather than parses prose. A run's own credential has to be able to act for the
 *  team it is about to create; a token already confined to another team cannot. */
export const REPLAY_REQUIRES_UNBOUND_CREDENTIAL = "replay_requires_unbound_credential";

/** A slug segment: lowercase, digits, `_`/`-`, starting alphanumeric — the same character set
 *  `TEAM_SLUG` (services/gateway/src/identity.ts) allows for a whole slug, applied here to one
 *  piece of it. A plugin name that fails this is a caller error, refused rather than mangled
 *  into something that silently means a different plugin. */
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

/** Postgres's own code for "unique_violation" — the signal that the slug this attempt built
 *  already names a live row, not a generic failure. Named the same way the rest of this
 *  repository names it (services/zz-core/src/eval/idempotency.ts and others). */
const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (err: unknown): boolean =>
  !!err && typeof err === "object" && (err as { code?: string }).code === UNIQUE_VIOLATION;

/** The slug's own 8-character suffix — deterministic per seed, so the same run id asked for
 *  twice collides on purpose rather than by accident. That collision is `provisionReplayTeam`'s
 *  retry signal: a stale team left over from an earlier attempt at the same run is never handed
 *  back silently, because reusing it would mean skipping the insert (and the unique check)
 *  entirely.
 *
 *  sha256 rather than a slice of the run id itself: a run id is a uuid, and a raw slice of one
 *  carries hyphens wherever they fall inside the window. */
const run8 = (seed: string): string => sha256(seed).slice(0, 8);

/** Create a `replay-<plugin>-<run8>` team, make the caller its only member, and return a PAT
 *  scoped to it — through the same `issuePat` every other issuer uses.
 *
 *  Refuses a caller whose own credential is already team-bound: such a token cannot act for a
 *  team it does not yet belong to, so it could never use the team it is about to create. */
export async function provisionReplayTeam(db: Db, args: {
  principal: string;
  principalPatTeam: string | null;
  plugin: string;
  runId: string;
  expiresAt: string;
}): Promise<{ teamSlug: string; patId: string; token: string }> {
  if (args.principalPatTeam) {
    throw new Error(
      `${REPLAY_REQUIRES_UNBOUND_CREDENTIAL}: this credential is bound to team ` +
      `'${args.principalPatTeam}', so it cannot create and act for a new one. Call ` +
      "replay_start with an unbound PAT — pat_issue with no `team` argument.");
  }
  if (!SLUG_SEGMENT.test(args.plugin)) {
    throw new Error(`provisionReplayTeam: '${args.plugin}' is not a usable slug segment for a plugin name`);
  }

  const principal = await db.query<{ id: string }>(
    "select id from zz.principal where email = $1 and status = 'active'", [args.principal]);
  const principalId = principal.rows[0]?.id;
  if (!principalId) throw new Error(`provisionReplayTeam: no active principal '${args.principal}'`);

  for (const seed of [args.runId, `${args.runId}\u0000retry`]) {
    const slug = `${REPLAY_TEAM_PREFIX}${args.plugin}-${run8(seed)}`;
    try {
      const team = await db.query<{ id: string }>(
        "insert into zz.team (slug, name, created_by) values ($1, $2, $3) returning id",
        [slug, `replay: ${args.plugin} ${args.runId}`, principalId],
      );
      const teamId = team.rows[0].id;
      await db.query(
        "insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)",
        [teamId, principalId],
      );
      const { token, patId } = await issuePat(db, {
        principalId, teamId, label: `replay:${args.runId}`, expiresAt: args.expiresAt,
      });
      return { teamSlug: slug, patId, token };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The salted seed is tried next; if that collides too the loop ends and falls through.
    }
  }
  throw new Error(
    `provisionReplayTeam: slug collision for plugin '${args.plugin}', run '${args.runId}' — ` +
    "retried once and still collided");
}

/** Archive the team and revoke the PAT `provisionReplayTeam` returned. Both halves are
 *  idempotent — an already-archived team and an already-revoked token are answered `false`
 *  rather than an error — so a second call is a no-op, not a failure. */
export async function teardownReplayTeam(db: Db, args: {
  teamSlug: string; patId: string;
}): Promise<{ archived: boolean; revoked: boolean }> {
  if (!args.teamSlug.startsWith(REPLAY_TEAM_PREFIX)) {
    throw new Error(`teardownReplayTeam: '${args.teamSlug}' is not a replay team — refusing to archive it`);
  }
  const team = await db.query<{ id: string }>("select id from zz.team where slug = $1", [args.teamSlug]);
  const teamId = team.rows[0]?.id;
  if (!teamId) throw new Error(`teardownReplayTeam: no team '${args.teamSlug}' — nothing to tear down`);
  // The PAT has to be this team's own. teardownReplayTeam has no caller identity to check an
  // ownership the way pat_revoke does — the team it is tearing down is the only authority it
  // has — so a mismatched id must be refused here, or a caller passing the wrong patId would
  // revoke a stranger's credential. A PAT already gone (nothing here deletes one, but a future
  // caller might pass a stale id) is left to the no-op path below rather than refused here: the
  // second call of an idempotent teardown must succeed exactly like the first.
  const pat = await db.query<{ team_id: string | null }>("select team_id from zz.pat where id = $1", [args.patId]);
  if (pat.rows[0] && pat.rows[0].team_id !== teamId) {
    throw new Error(
      `teardownReplayTeam: PAT '${args.patId}' is not scoped to '${args.teamSlug}' — refusing ` +
      "to revoke a credential that belongs to a different team");
  }
  const r = await db.query(
    "update zz.team set status = 'archived' where slug = $1 and status = 'active'", [args.teamSlug]);
  const archived = (r.rowCount ?? 0) > 0;
  const revoked = await revokePat(db, args.patId);
  return { archived, revoked };
}
