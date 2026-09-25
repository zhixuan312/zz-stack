/**
 * Who speaks for a release's owners (FR-48, FR-49): the one answer `document_approve` (for
 * `improvement.md`) and the release tools on the /eval door all check against.
 *
 * On the core side, not under `eval/`, because `document_approve` needs it and the core door
 * must not reach into the evaluation modules (checks/eval-tools-moved.ts); the eval side imports
 * it from here, the direction that rule allows.
 *
 * Authority is MEMBERSHIP of a required owner team — `zz.principal` + `zz.membership`, every
 * active team a person belongs to — never `teamFor`, which answers the ONE team a person's tools
 * act on today (their active team, or a token's bound one). A person who owns the plugin through
 * their second team is still an owner; nobody becomes one by acting for a team they are not in.
 * Owner teams are `zz.release_attempt.required_owners`, which `release_prepare` resolved live
 * from `zz.plugin.release_owners`.
 */
import type pg from "pg";

import { db } from "./platform-db.js";

interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Every active team `email` is an active member of. Empty for an unknown or deactivated person. */
export async function memberTeams(runner: Queryable, email: string): Promise<string[]> {
  if (!email.trim()) return [];
  return (await runner.query<{ slug: string }>(`
    select t.slug
      from zz.membership m
      join zz.team t on t.id = m.team_id
      join zz.principal p on p.id = m.principal_id
     where p.email = $1 and p.status = 'active' and t.status = 'active'`, [email.trim()])).rows
    .map((r) => r.slug);
}

export async function ownerMember(runner: Queryable, email: string, owners: readonly string[]): Promise<boolean> {
  const teams = await memberTeams(runner, email);
  return owners.some((owner) => teams.includes(owner));
}

/** The one release attempt an `improvement.md` body cites — `improvement-doc.ts` renders
 *  "release_attempt_id: `<id>`" — or null when it cites none, or more than one. Read from the
 *  body, like the digest it quotes: the body is what an approver reads and signs. */
export function citedReleaseAttempt(body: string): string | null {
  // A real UUID only (8-4-4-4-12 hex), lowercased: a 36-character run of hyphens would otherwise
  // be "cited" and reach a `::uuid` cast as a raw database error rather than a named refusal.
  const ids = new Set([...body.matchAll(
    /release_attempt_id: `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/gi)].map((m) => m[1].toLowerCase()));
  return ids.size === 1 ? [...ids][0] : null;
}

/** `document_approve` on an `improvement.md` that cites a release attempt (one that cites none
 *  can never satisfy `release_apply`, so there is nothing to protect): the name stamped into
 *  `approved_by` must be a member of an owner team, and so must the session that records it when
 *  that is somebody else (`on_behalf_of`). Otherwise anyone could sign an owner's name onto the
 *  one document that authorizes a release. Null means allowed. `runner` defaults to the platform
 *  database; a check passes its own. */
export async function improvementApprovalRefusal(
  body: string, signer: string, recorder: string | null, runner: Queryable | null = db(),
): Promise<string | null> {
  const attemptId = citedReleaseAttempt(body);
  if (!attemptId) return null;
  const p = runner;
  if (!p) return "ERROR: this deployment has no platform database, so improvement.md's owner teams cannot be checked";
  const row = (await p.query<{ required_owners: string[] }>(
    "select required_owners from zz.release_attempt where id = $1::uuid", [attemptId])).rows[0];
  const owners = row?.required_owners ?? [];
  if (!owners.length) return `ERROR: release_attempt ${attemptId} records no owner teams, so nobody can approve its improvement.md`;
  if (!(await ownerMember(p, signer, owners))) {
    return `ERROR: not_owner — ${signer} is not a member of an owner team of this release ` +
      `(${owners.join(", ")}), so their approval does not authorize it`;
  }
  if (recorder && !(await ownerMember(p, recorder, owners))) {
    return `ERROR: not_owner — ${recorder} may not record an approval of improvement.md on another ` +
      `person's behalf without being a member of an owner team (${owners.join(", ")}) themselves`;
  }
  return null;
}
