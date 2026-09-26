/**
 * Agentic platform management: the administrative half of /manage/mcp. There is no separate
 * admin door.
 *
 * `registerAdminTools` reads the caller's role once and registers only the tools that role
 * carries, so a member sees their tools rather than a list of refusals.
 *
 * DELIBERATE: that filter is ergonomics, not the boundary. Every handler resolves the
 * caller's authority from the platform db — never from headers — audits into the event
 * stream, and demands a confirm parameter repeating the target when destructive. Nothing
 * here writes into a front end's own tables: the registry is the truth and clients read it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { issuePat, revokePat } from "@zz/contracts";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { principalId, superOnly, teamAuthority, teamId } from "./admin/authority.js";
import { addPerson, deactivatePerson, issueEnrolmentLink, listPeople } from "./admin/people.js";
import { addMember, archiveTeam, createTeam, removeMember } from "./admin/teams.js";
import { platformDb } from "./db.js";
import { auditAdmin, callerIdentity as caller, isSuper, isTeamAdmin, type Identity, TEAM_SLUG } from "./identity.js";
/** The administrative tools, registered onto /manage/mcp according to what the caller's role
 *  can execute.
 *
 * COUPLED: the filter uses `isSuper` and `isTeamAdmin`, the same functions the guarded
 * handlers call, not a second reading of `platformRole`. A superadmin holding a member-scope
 * or team-bound PAT is not super for this request, so visibility stays the same set as
 * executability.
 *
 * DELIBERATE: the filter is not the authorisation. `lead` means "administers some team"
 * while every act is about one named team, so each handler still resolves the caller and
 * refuses with its own reason. */
export function registerAdminTools(server: McpServer, id: Identity | null, everything = false): void {
  // `everything`: the boot-time surface record (access-surface.ts), never a served door.
  const sup = everything || (!!id && isSuper(id));
  const lead = sup || (!!id && id.teams.some((t) => isTeamAdmin(id, t.slug)));

  server.registerTool("whoami", {
    // What only this tool says, against session_whoami on /core and team_mine beside it: how
    // the caller authenticated and what their token is scoped to. That is the answer to "why
    // was I refused" and to "why is that tool not in my list", since this door registers only
    // the tools a caller's role can execute.
    description:
      "WHEN you were refused and need to know why — including a tool that is not in your " +
      "list at all, which means your role does not carry it. RETURNS how the platform " +
      "resolved YOU: your platform role, how this request authenticated (a token, or " +
      "forwarded headers), and what that token is scoped to. REFUSES nothing and is " +
      "registered for everyone, deliberately — the question \"why can I not see it\" has to " +
      "have a tool. For your teams use team_mine; for your identity while working use " +
      "session_whoami on /core.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    return text(JSON.stringify(id ?? { error: "no platform identity" }));
  });

  if (sup) server.registerTool("person_list", {
    description:
      "WHEN an access review asks who has access to what. RETURNS all principals with " +
      "platform role and status, each with the teams they are in, their role there, and who " +
      "added them and when — that last part is the half an access review actually needs. " +
      "REFUSES anyone but a superadmin, and is not registered at all for anyone else.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    const r = await listPeople(id);
    if (!r.ok) return text(`ERROR: ${r.error}`);
    return text(JSON.stringify(r.rows));
  });

  if (sup) server.registerTool("person_add", {
    description:
      "WHEN somebody new needs to exist on this platform at all — the first step of " +
      "onboarding, before any team, token or key. RETURNS confirmation that the principal " +
      "exists. REFUSES anyone but a superadmin, and refuses to create a browser account: " +
      "that is made separately by an operator, and this links to it by email.",
    inputSchema: { email: z.string().email(), display_name: z.string().optional() },
  }, async ({ email, display_name }) => {
    const id = await caller();
    const r = await addPerson(id, email, display_name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("enrolment_issue", {
    description:
      "WHEN an existing principal needs to sign in to the console for the first time. " +
      "RETURNS a one-time link letting them register a passkey — returned ONCE and never " +
      "readable again, because only its hash is stored. REFUSES anyone but a superadmin, " +
      "and refuses an address with no principal behind it: a passkey attaches to an " +
      "account, it cannot create one, so person_add comes first.",
    inputSchema: { email: z.string().email() },
  }, async ({ email }) => {
    const id = await caller();
    const r = await issueEnrolmentLink(id, email);
    return text(r.ok ? `${r.message}\n\n${r.url}` : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("person_deactivate", {
    description:
      "WHEN somebody leaves, or their access must stop. RETURNS confirmation that they can " +
      "no longer authenticate, with their live tokens revoked. " +
      "REFUSES anyone but a superadmin, and refuses unless confirm repeats the same email.",
    inputSchema: { email: z.string().email(), confirm: z.string() },
  }, async ({ email, confirm }) => {
    const id = await caller();
    const r = await deactivatePerson(id, email, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("team_create", {
    description:
      "WHEN a new tenant needs somewhere for its work to live, or an archived team is being " +
      "brought back — the same slug restores it with its installs and grants. RETURNS the " +
      "team, its slug being the stable identity used everywhere, in the database and in the " +
      "artifact store. REFUSES anyone but a superadmin, a slug the platform's own rule " +
      "rejects, and the platform's reserved slug, which no tenant may claim.",
    inputSchema: { slug: z.string().regex(TEAM_SLUG), name: z.string().min(1) },
  }, async ({ slug, name }) => {
    const id = await caller();
    const r = await createTeam(id, slug, name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("team_archive", {
    description:
      "WHEN a team is finished and should stop granting anyone anything. RETURNS " +
      "confirmation: its members lose it from their access, while its memberships and its " +
      "store are KEPT, so team_create on the same slug brings it back whole. REFUSES anyone but a superadmin, and refuses unless " +
      "confirm repeats the team slug.",
    inputSchema: { team: z.string(), confirm: z.string() },
  }, async ({ team, confirm }) => {
    const id = await caller();
    const r = await archiveTeam(id, team, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("member_add", {
    description:
      "WHEN somebody needs access to a team's work — the step between person_add and their " +
      "first token. RETURNS the membership and the role it carries: member by default, or " +
      "admin, which is who may add the next one. REFUSES anyone who does not administer " +
      "THIS team — being a lead somewhere else is not authority here — and refuses an " +
      "address with no principal behind it, or a team that is not active.",
    inputSchema: { team: z.string(), email: z.string().email(), role: z.enum(["member", "admin"]).optional() },
  }, async ({ team, email, role }) => {
    const id = await caller();
    const r = await addMember(id, team, email, role);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("member_remove", {
    description:
      "WHEN somebody should no longer reach a team's documents, knowledge store or agents. " +
      "RETURNS confirmation, and says plainly when there was nothing to remove rather than " +
      "reporting a removal that did not happen. REFUSES anyone who does not administer THIS " +
      "team, and refuses unless confirm repeats the team slug. It does not revoke their " +
      "tokens: one bound to this team stops working, an unbound one keeps their other teams.",
    inputSchema: { team: z.string(), email: z.string().email(), confirm: z.string() },
  }, async ({ team, email, confirm }) => {
    const id = await caller();
    const r = await removeMember(id, team, email, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  server.registerTool("pat_issue", {
    description:
      "WHEN somebody needs to connect an MCP client to this platform, or an automation needs " +
      "its own credential. RETURNS the token plaintext EXACTLY ONCE: it cannot be read back, so " +
      "it has to be stored now. The token carries whatever its holder may do — there is no lesser kind. REPLACES any " +
      "earlier one with the same label, because a purpose has one current credential. REFUSES " +
      "issuing for anybody but yourself without superadmin or team-admin authority, and " +
      "refuses to bind a token to a team its holder is not in — that token would " +
      "authenticate nowhere.",
    inputSchema: {
      email: z.string().email().optional(),
      team: z.string().optional().describe(
        "CONFINE this token to one team — for automation that should never touch another, " +
        "not for a person who works in several. A person needs ONE token: they pick the " +
        "team with team_switch, and a bound token would take that choice away " +
        "and refuse every other team they are in."),
      label: z.string().optional(),
      expires_in_days: z.number().int().positive().max(3650).optional().describe(
        "Let this token stop working on its own. Worth using for automation and for anything " +
        "issued to somebody else; a person's everyday token is usually left open-ended and " +
        "revoked when it is no longer wanted."),
    },
  }, async ({ email, team, label, expires_in_days }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    const target = (email ?? id.email).toLowerCase();
    if (target !== id.email && !superOnly(id)) {
      if (!team || !teamAuthority(id, team)) return text("ERROR: issuing for others needs superadmin, or team admin with team specified");
    }
    const db = platformDb();
    // A bound token cannot issue a wider one. `pat_issue` with no arguments is the ordinary
    // self-issue path, so without this a token confined to one team mints an unbound token
    // carrying its holder's whole membership.
    if (id.patTeam && team !== id.patTeam) {
      return text(
        `ERROR: this token is bound to team '${id.patTeam}', so it cannot issue a token that ` +
        `reaches further than it does. Pass \`team: "${id.patTeam}"\` to issue another bound ` +
        "token, or use an unbound token — a binding is only worth something if it cannot be " +
        "traded away by the token it binds.");
    }
    const pid = await principalId(db, target);
    if (!pid) return text(`ERROR: no principal '${target}'`);
    const tid = team ? await teamId(db, team) : null;
    if (team && !tid) return text(`ERROR: no active team '${team}' — team_create on the same slug restores an archived one`);
    // And the holder has to be in it. Identity refuses a bound token whose holder is not a
    // member of the named team, so issuing one for somebody outside it returns a token that
    // authenticates nowhere.
    if (tid) {
      const inTeam = await db.query(
        "select 1 from membership where team_id = $1 and principal_id = $2", [tid, pid]);
      if (!inTeam.rowCount) {
        return text(`ERROR: ${target} is not a member of '${team}', and a token bound to a ` +
                    "team its holder is not in is refused the first time it is used. " +
                    `member_add ${team} ${target} first, or issue the token unbound.`);
      }
    }
    // COUPLED: resolvePat refuses a token past `expires_at`. Without this write the column
    // stays null, every token lives for ever, and that check can never fire.
    const expiry = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86_400_000).toISOString()
      : null;
    // One live token per person per label: a label names a purpose, and a purpose has one
    // current credential. Otherwise a provisioner that mints on every run leaves a pile of
    // indistinguishable tokens, and revoking that person's access means finding all of them.
    // issuePat is the one mint-and-store path — provisionReplayTeam (packages/contracts)
    // goes through the same function rather than a second copy of it.
    const { token, replaced } = await issuePat(db, { principalId: pid, teamId: tid, label, expiresAt: expiry });
    auditAdmin(id, "issue_pat", target,
               { team: team ?? null, label: label ?? "", expires_at: expiry,
                 ...(replaced ? { replaced } : {}) },
               team ?? null);
    return text(
      `PAT for ${target} (${team ? "team " + team : "all your teams"}` +
      `${expiry ? `, expires ${expiry.slice(0, 10)}` : ", no expiry"}):\n\n${token}\n\n` +
      "Shown once — store it now. Use as:  Authorization: Bearer <token>" +
      (replaced ? `\n\nThis REPLACED ${replaced} earlier token(s) labelled '${label}' — those no longer work.` : ""),
    );
  });

  server.registerTool("pat_revoke", {
    description:
      "WHEN a token has leaked, or its holder no longer needs it — the first call after " +
      "somebody says a credential is exposed. RETURNS confirmation; it takes effect " +
      "immediately and is recorded against the team the token was bound to, so a team admin " +
      "sees the withdrawal as well as the issue. REFUSES anyone but the token's own owner or " +
      "a superadmin, refuses an id no token has, and refuses unless confirm repeats the pat " +
      "id exactly. Find the id with pat_list.",
    inputSchema: { pat_id: z.string().uuid(), confirm: z.string() },
  }, async ({ pat_id, confirm }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    if (confirm !== pat_id) return text("ERROR: confirm must repeat the pat id exactly");
    const db = platformDb();
    // COUPLED: the bound team is selected here so the revocation records it, as pat_issue
    // does. Every paired act here — create/archive team, add/remove member, issue/revoke
    // token — records the team on both halves.
    const r = await db.query<{ email: string; team: string | null }>(
      `select p.email, t.slug as team from pat
         join principal p on p.id = pat.principal_id
         left join team t on t.id = pat.team_id
        where pat.id = $1`, [pat_id]);
    const owner = r.rows[0]?.email;
    if (!owner) return text("ERROR: no such PAT");
    if (owner !== id.email && !superOnly(id)) return text("ERROR: only the owner or superadmin can revoke");
    // revokePat is the one revoke path — teardownReplayTeam (packages/contracts) goes through
    // the same function rather than a second copy of it.
    await revokePat(db, pat_id);
    auditAdmin(id, "revoke_pat", pat_id, { owner, team: r.rows[0].team }, r.rows[0].team);
    return text(`PAT ${pat_id} revoked`);
  });

  server.registerTool("pat_list", {
    description:
      "WHEN you need a token's id in order to revoke it, or need to know what is outstanding " +
      "for somebody. RETURNS the token rows masked — label, scope, bound team, issued, last " +
      "used, revoked — your own by default, or everyone's for a superadmin. REFUSES another " +
      "person's tokens to anyone but a superadmin, and never returns a token's value: no " +
      "tool does, once it has been issued.",
    inputSchema: { email: z.string().email().optional() },
  }, async ({ email }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    const target = (email ?? id.email).toLowerCase();
    if (target !== id.email && !superOnly(id)) return text("ERROR: superadmin required for others");
    const r = await platformDb().query(
      `select pat.id, p.email, pat.label, t.slug as team, pat.created_at, pat.last_used_at, pat.revoked_at
       from pat join principal p on p.id = pat.principal_id left join team t on t.id = pat.team_id
       where $1 = '*' or p.email = $1 order by pat.created_at desc`,
      [superOnly(id) && !email ? "*" : target],
    );
    return text(JSON.stringify(r.rows));
  });

  server.registerTool("team_list", {
    description:
      "WHEN you need the teams themselves — how big each is and who set it up — rather than " +
      "which one you are acting for, which is team_mine. RETURNS each team with its member " +
      "count, who created it and when, and your own role in it. REFUSES to widen past your " +
      "access: a member sees the teams they belong to and a superadmin sees all of them, " +
      "and a token bound to one team is read as that token rather than as its holder.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    // A member sees the teams they belong to; a superadmin sees all of them.
    const mine = id.teams.map((t) => t.slug);
    // Who made it, and when: `created_by` is written on every team, and this is the query
    // that reads it back.
    const columns =
      `select t.slug, t.name, t.status, t.created_at, c.email as created_by,
              count(m.principal_id)::int as members
         from team t left join membership m on m.team_id = t.id
         left join principal c on c.id = t.created_by`;
    // isSuper, not platformRole: only isSuper can see a token's team binding, so a token
    // stamped with one team does not list them all.
    const r = isSuper(id)
      ? await platformDb().query(`${columns} group by t.id, c.email order by t.slug`)
      : await platformDb().query(
          `${columns} where t.slug = any($1) group by t.id, c.email order by t.slug`, [mine]);
    return text(JSON.stringify(r.rows.map((row) => ({
      ...row, your_role: id.teams.find((x) => x.slug === row.slug)?.role ?? null,
    }))));
  });

  // Rendering someone else's setup is client_setup's optional `email`, superadmin-only for
  // anyone but yourself. There is no second tool for it.
}
