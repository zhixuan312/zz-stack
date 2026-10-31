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
 *   - a token an application obtained through OAuth answers on the door it was issued for and on
 *     `/upload/`, is refused on every other door, and cannot issue a token of its own;
 *   - a team admin's token authority reaches no further than the team: a lead may not mint a token
 *     for the superadmin, may not replace a member's token outside the team by reusing its label,
 *     and a token bound to a team revokes only tokens bound to it; one who names a team they do not
 *     administer is refused alike whether it exists, the refusal naming the teams they do;
 *   - member_add and member_remove say what changed and keep a team's last admin;
 *   - a deactivated person is issued no token, deactivating them again says nothing changed and
 *     records nothing, and a superadmin cannot deactivate themselves.
 *
 * The only database this touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash, randomBytes } from "node:crypto";

import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";
import { headersOf, insertPat, listenGateway, manageCall, type Gateway } from "../scripts/schema/throwaway-gateway.ts";

const NAME = "manage-door";
const DONE = "manage-door: an application's token stays on its door, a team admin's authority stays in the team, " +
  "membership changes say what changed, and a deactivated person stays out: ok";

const b64 = (b: Buffer): string => b.toString("base64url");

/** A token an OAuth client obtains for `door`, through register, authorize (the console session, a
 *  loopback redirect, so no consent page) and the form-encoded exchange. */
async function oauthToken(c: Core, g: Gateway, step: string, door: string): Promise<string> {
  const redirect = "http://127.0.0.1:9/callback";
  const reg = await fetch(`${g.url}/oauth/register`, { method: "POST", headers: headersOf(null, {}),
    body: JSON.stringify({ redirect_uris: [redirect], client_name: `Door probe ${door}` }) });
  const { client_id: clientId } = await reg.json() as { client_id?: string };
  if (!clientId) return c.fail(step, `register answered ${reg.status}`);
  const verifier = b64(randomBytes(32));
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
    code_challenge: b64(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    resource: `${g.url}${door}` });
  const authz = await fetch(`${g.url}/oauth/authorize?${query}`,
    { headers: { cookie: `zz_console=${g.session}` }, redirect: "manual" });
  const code = new URL(authz.headers.get("location") ?? "http://none/").searchParams.get("code")
    ?? c.fail(step, `authorize answered ${authz.status}: ${(await authz.text()).slice(0, 300)}`);
  const exchanged = await fetch(`${g.url}/oauth/token`, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier,
                                client_id: clientId, redirect_uri: redirect }).toString() });
  const { access_token: token } = await exchanged.json() as { access_token?: string };
  return token ?? c.fail(step, `token answered ${exchanged.status}`);
}

/** An application's token reaches the door it was issued for and nothing else. */
async function applicationActs(c: Core, g: Gateway): Promise<void> {
  const step = "a token an application obtained stays on its door and issues no token";
  const token = await oauthToken(c, g, step, "/manage/mcp");
  const door = (await c.sql.query<{ door: string | null }>(
    "select door from zz.pat where token_hash = $1", [createHash("sha256").update(token).digest("hex")])).rows[0]?.door;
  if (door !== "/manage/mcp") c.fail(step, `the token's row names door ${JSON.stringify(door)}, not /manage/mcp`);
  const who = await manageCall(g, token, "whoami", {});
  if (!who.includes(c.email)) c.fail(step, `on its own door whoami answered: ${who.slice(0, 200)}`);
  const minted = await manageCall(g, token, "pat_issue", { label: "from-an-application" });
  if (!/^ERROR: .*application/.test(minted)) c.fail(step, `pat_issue through it answered: ${minted.slice(0, 200)}`);

  // A token issued for /core, presented on /manage: refused, naming the door it belongs to.
  const { client_id: clientId } = (await c.sql.query<{ client_id: string }>(
    "select client_id from zz.mcp_oauth_client limit 1")).rows[0];
  const core = await insertPat(c, c.email, "core-app", null, { door: "/core/mcp", oauthClientId: clientId });
  const crossed = await fetch(`${g.url}/manage/mcp`, { method: "POST",
    headers: { ...headersOf(null, { authorization: `Bearer ${core.token}` }), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }) });
  const said = await crossed.text();
  if (crossed.status !== 401 || !said.includes("/core/mcp")) {
    c.fail(step, `a /core/mcp token on /manage/mcp answered ${crossed.status}: ${said.slice(0, 200)}`);
  }
  // /upload/ is every door's: a file staged for a call on /core arrives there with the same token.
  const upload = await fetch(`${g.url}/upload/00000000-0000-4000-8000-000000000000`,
    { method: "PUT", headers: { authorization: `Bearer ${core.token}` }, body: "x" });
  if (upload.status === 401) c.fail(step, `the /core/mcp token was refused on /upload/: ${(await upload.text()).slice(0, 200)}`);
  c.pass(step);
}

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

/** A deactivated person stays out: no token is minted for them, a second deactivation is not
 *  reported as a fresh one, and nobody retires themselves — on the last superadmin that would
 *  leave nobody able to bring anyone back. */
async function retireActs(c: Core, g: Gateway): Promise<void> {
  const step = "a deactivated person is issued nothing, twice is once, and nobody deactivates themselves";
  const ask = (name: string, args: Record<string, unknown>) => manageCall(g, g.token, name, args);
  const gone = "gone@example.test";
  await c.sql.query("insert into zz.principal (email, display_name) values ($1, 'Gone')", [gone]);
  const acts = async (): Promise<number> => Number((await c.sql.query<{ n: string }>(
    "select count(*) as n from zz.event where kind = 'admin.deactivate_person' and subject = $1", [gone])).rows[0].n);
  const first = await ask("person_deactivate", { email: gone, confirm: gone });
  if (!first.startsWith(`principal ${gone} deactivated`)) c.fail(step, `the first deactivation answered: ${first.slice(0, 200)}`);
  // The audit row is written after the answer; wait for the first one before counting.
  for (const until = Date.now() + 5000; (await acts()) < 1;) {
    if (Date.now() > until) c.fail(step, "the first deactivation recorded no event");
    await new Promise((r) => setTimeout(r, 100));
  }
  const second = await ask("person_deactivate", { email: gone, confirm: gone });
  if (second !== `${gone} is already deactivated — nothing changed`) c.fail(step, `the second deactivation answered: ${second.slice(0, 200)}`);
  const minted = await ask("pat_issue", { email: gone, label: "after" });
  const live = (await c.sql.query("select 1 from zz.pat p join zz.principal w on w.id = p.principal_id where w.email = $1",
    [gone])).rowCount;
  if (!/^ERROR: gone@example\.test is deactivated/.test(minted) || live) {
    c.fail(step, `pat_issue for a deactivated person answered "${minted.slice(0, 200)}", ${live} token row(s)`);
  }
  const self = await ask("person_deactivate", { email: c.email, confirm: c.email });
  const status = (await c.sql.query<{ status: string }>("select status from zz.principal where email = $1", [c.email])).rows[0].status;
  if (!/^ERROR: .*yourself/.test(self) || status !== "active") c.fail(step, `deactivating oneself answered "${self.slice(0, 200)}", now ${status}`);
  await new Promise((r) => setTimeout(r, 500));
  if ((await acts()) !== 1) c.fail(step, `${await acts()} deactivation events for ${gone}, where one deactivation happened`);
  c.pass(step);
}

async function run(c: Core): Promise<void> {
  // A superadmin, so every tier of /manage is registered.
  await c.sql.query("update zz.principal set role = 'superadmin' where email = $1", [c.email]);
  const g = await listenGateway(c);
  try {
    await applicationActs(c, g);
    await leadActs(c, g);
    await retireActs(c, g);
  } finally {
    await g.stop();
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
