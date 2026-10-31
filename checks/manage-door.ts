#!/usr/bin/env node
/**
 * checks/manage-door.ts — the /manage door's tools keep to the authority they were given and say
 * what actually happened.
 *
 *   node checks/manage-door.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`) and the gateway's
 * own built routes in this process (`listenGateway`), the seeded person a superadmin. What it
 * establishes:
 *
 *   - a team admin's token authority reaches no further than the team: a lead may not mint a token
 *     for the superadmin, may not replace a member's token outside the team by reusing its label,
 *     and a token bound to a team revokes only tokens bound to it; one who names a team they do not
 *     administer is refused alike whether it exists, the refusal naming the teams they do;
 *   - member_add and member_remove say what changed and keep a team's last admin.
 *
 * The only database this touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { insertPat, listenGateway, manageCall, type Gateway } from "../scripts/schema/throwaway-gateway.ts";

const NAME = "manage-door";
const DONE = "manage-door: a team admin's authority stays in the team, and membership changes say what changed: ok";

/** A team admin's token authority reaches no further than the team: a lead may not mint a token
 *  for the superadmin, may not replace a member's token outside the team by reusing its label, and
 *  a token bound to a team revokes only tokens bound to it. */
async function leadActs(c: Core, g: Gateway): Promise<void> {
  const step = "a team admin's token acts stay inside the team";
  const pat = (email: string, label: string, team: string | null) => insertPat(c, email, label, team);
  const ask = (token: string, name: string, args: Record<string, unknown>) => manageCall(g, token, name, args);
  await c.sql.query(
    `with p as (insert into zz.principal (email, display_name) values ('lead@example.test', 'Lead'), ('mate@example.test', 'Mate')
                returning id, email),
          t as (insert into zz.team (slug, name, created_by) select 'lead-team', 'Lead team', id from p where email = 'lead@example.test'
                returning id)
     insert into zz.membership (team_id, principal_id, role, added_by)
     select t.id, p.id, case when p.email = 'lead@example.test' then 'admin' else 'member' end, p.id from t, p`);
  const lead = await pat("lead@example.test", "lead", null);
  const laptop = await pat("mate@example.test", "laptop", null);
  const live = async (id: string): Promise<boolean> =>
    (await c.sql.query("select 1 from zz.pat where id = $1 and revoked_at is null", [id])).rowCount === 1;

  await ask(lead.token, "member_add", { team: "lead-team", email: c.email });
  const forSuper = await ask(lead.token, "pat_issue", { email: c.email, team: "lead-team", label: "as-super" });
  if (!/^ERROR: .*superadmin/.test(forSuper)) c.fail(step, `a lead minting the superadmin's token answered: ${forSuper.slice(0, 200)}`);

  const reused = await ask(lead.token, "pat_issue", { email: "mate@example.test", team: "lead-team", label: "laptop" });
  if (!/^ERROR: .*laptop/.test(reused) || !(await live(laptop.id))) {
    c.fail(step, `a lead reusing a member's label answered "${reused.slice(0, 200)}", the member's token ${await live(laptop.id) ? "live" : "REVOKED"}`);
  }

  const bound = await pat("lead@example.test", "bound", "lead-team");
  const crossed = await ask(bound.token, "pat_revoke", { pat_id: lead.id, confirm: lead.id });
  if (!/^ERROR: .*bound to team 'lead-team'/.test(crossed) || !(await live(lead.id))) {
    c.fail(step, `a bound token revoking its owner's unbound token answered "${crossed.slice(0, 200)}"`);
  }
  const own = await pat("lead@example.test", "bound-2", "lead-team");
  if (!/ revoked$/.test(await ask(bound.token, "pat_revoke", { pat_id: own.id, confirm: own.id }))) {
    c.fail(step, "a bound token could not revoke a token bound to its own team");
  }
  c.pass(step);

  // member_add says what happened, keeps a role nobody named, and names a missing team as missing;
  // member_remove keeps the team's last admin.
  const roles = "member_add and member_remove say what changed and keep a team's last admin";
  const said = [
    [await ask(lead.token, "member_add", { team: "lead-team", email: "Mate@Example.test", role: "admin" }),
     /^mate@example\.test is now admin of lead-team \(was member\)$/],
    [await ask(lead.token, "member_add", { team: "lead-team", email: "mate@example.test" }),
     /^mate@example\.test is already admin of lead-team — nothing changed$/],
    [await ask(lead.token, "member_add", { team: "lead-tem", email: "mate@example.test" }), /^ERROR: team admin or superadmin required for lead-tem — you administer lead-team$/],
    [await ask(lead.token, "member_add", { team: "lead-team", email: "mate@example.test", role: "member" }),
     /^mate@example\.test is now member of lead-team \(was admin\)$/],
    [await ask(lead.token, "member_remove", { team: "lead-team", email: "lead@example.test", confirm: "lead-team" }),
     /^ERROR: lead@example\.test is the only admin of lead-team/],
  ] as const;
  for (const [reply, want] of said) if (!want.test(reply)) c.fail(roles, `answered "${reply.slice(0, 200)}", expected ${want}`);
  c.pass(roles);
}

async function run(c: Core): Promise<void> {
  // A superadmin, so every tier of /manage is registered.
  await c.sql.query("update zz.principal set role = 'superadmin' where email = $1", [c.email]);
  const g = await listenGateway(c);
  try {
    await leadActs(c, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
