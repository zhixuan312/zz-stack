/**
 * Agentic platform management: the administrative half of /manage/mcp.
 *
 * There is no separate admin door. There used to be — /admin/mcp — and it authorised
 * nothing: any member could open it, see every tool on it, and be refused by each one in
 * turn. A door that admits everyone is not a boundary, it is a second URL. So the tools
 * moved onto the door every person already has, and what changed is only which of them are
 * REGISTERED for a given caller: `registerAdminTools` below reads the caller's role once
 * and offers a member the tools their role carries rather than a list of refusals.
 *
 * That filter is ergonomics. The boundary is unchanged and is where it always was — in the
 * handlers, each of which resolves authority from the platform db on its own.
 *
 * Every tool resolves the caller's authority from the platform db (never
 * from headers), audits into the event stream, and destructive operations
 * demand a confirm parameter that repeats the target. Nothing here writes into
 * a front end's own tables: the registry is the truth, and clients read it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogManifest } from "@zz/catalog";
import { type CatalogManifest, mintPat } from "@zz/contracts";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { principalId, superOnly, teamAuthority, teamId } from "./admin/authority.js";
import { autoFlows, canonicalJson, installFlow, uninstallFlow } from "./admin/flows.js";
import { addPerson, deactivatePerson, grantTool, issueEnrolmentLink, listPeople, revokeTool } from "./admin/people.js";
import { addMember, archiveTeam, createTeam, removeMember } from "./admin/teams.js";
import { platformDb } from "./db.js";
import { auditAdmin, callerIdentity as caller, isSuper, isTeamAdmin, sha256, type Identity, TEAM_SLUG } from "./identity.js";





// ── flow catalog + client projection helpers ─────────────────────────────























/** The administrative tools, registered onto /manage/mcp according to what the caller's role
 *  can actually execute.
 *
 * TWO PREDICATES, AND THEY ARE THE HANDLERS' OWN. `isSuper` and `isTeamAdmin` are the exact
 * functions the guarded bodies call, not a second reading of `platformRole` — which matters
 * most for tokens. A superadmin holding a member-scope or team-bound PAT is NOT super for
 * this request (`isSuper` says so), so they cannot execute the platform tools and must not
 * be offered them either. Visibility has to be the same set as executability; deriving both
 * from one function is how it stays that way rather than drifting into a list that lies.
 *
 * And the filter is NOT the authorisation. Every handler below still resolves the caller and
 * checks for itself, because `lead` is "administers SOME team" while the act is always about
 * ONE named team — flow_install for a team you do not lead is a refusal a visible tool must
 * still make, with its reason. */
export function registerAdminTools(server: McpServer, id: Identity | null): void {
  const sup = !!id && isSuper(id);
  const lead = sup || (!!id && id.teams.some((t) => isTeamAdmin(id, t.slug)));

  server.registerTool("whoami", {
    // What ONLY this tool says. Three tools answer some form of "who am I" — session_whoami on
    // /core for an agent doing work, team_mine beside this one for a person managing their own
    // access — and this one described itself as "role and team memberships", which is what
    // team_mine already returns. Described that way it reads as a third copy, and a model
    // choosing between them has no reason to prefer any.
    //
    // It has a second job now: it is the answer to "why is that tool not in my list?". This
    // door registers only the tools a caller's role can execute, so a missing tool is a
    // statement about the caller, and this is the tool that reads that statement back.
    //
    // It is the only one that says HOW the caller authenticated and what their token is
    // scoped to, which is the answer to "why was I refused" and is answered by nothing else.
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
    // The caveat is on the RETURN too, and it needs to be here as well: an agent chooses a
    // tool by its description and reads the return only after calling it. "What this does
    // not do" is not a footnote when the thing it does not do is leave live credentials at
    // a third party for somebody who has left.
    description:
      "WHEN somebody leaves, or their access must stop. RETURNS confirmation that they can " +
      "no longer authenticate. What it does NOT do is the part that matters: it never " +
      "touches the building-block keys stored under their address, which the platform goes " +
      "on injecting on their behalf — remove those separately with credential_admin_delete. " +
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
      "confirmation: its members lose it from their access and its block grants stop " +
      "counting, while its flow installs and grants are KEPT, so team_create on the same " +
      "slug brings it back whole. REFUSES anyone but a superadmin, and refuses unless " +
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
      "WHEN somebody needs to connect an MCP client — Claude Code, Codex, Hermes — to this " +
      "platform, or an automation needs its own credential. RETURNS the token plaintext " +
      "EXACTLY ONCE: it cannot be read back, so it has to be stored now. A labelled token " +
      "REPLACES any earlier one with the same label, because a purpose has one current " +
      "credential. REFUSES issuing for anybody but yourself without superadmin or team-admin " +
      "authority, refuses admin scope on the same rule, and refuses to bind a token to a " +
      "team its holder is not in — that token would authenticate nowhere.",
    inputSchema: {
      email: z.string().email().optional(),
      scope: z.enum(["member", "admin"]).optional(),
      team: z.string().optional().describe(
        "CONFINE this token to one team — for automation that should never touch another, " +
        "not for a person who works in several. A person needs ONE token: they pick the " +
        "team by picking that team's agent, and a bound token would take that choice away " +
        "and refuse every other team they are in."),
      label: z.string().optional(),
      expires_in_days: z.number().int().positive().max(3650).optional().describe(
        "Let this token stop working on its own. Worth using for automation and for anything " +
        "issued to somebody else; a person's everyday token is usually left open-ended and " +
        "revoked when it is no longer wanted."),
    },
  }, async ({ email, scope, team, label, expires_in_days }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    const target = (email ?? id.email).toLowerCase();
    const wantScope = scope ?? "member";
    if (target !== id.email && !superOnly(id)) {
      if (!team || !teamAuthority(id, team)) return text("ERROR: issuing for others needs superadmin, or team admin with team specified");
    }
    if (wantScope === "admin" && !superOnly(id) && !(team && teamAuthority(id, team)))
      return text("ERROR: admin-scope PATs need superadmin or team-admin authority");
    const db = platformDb();
    const pid = await principalId(db, target);
    if (!pid) return text(`ERROR: no principal '${target}'`);
    const tid = team ? await teamId(db, team) : null;
    if (team && !tid) return text(`ERROR: no active team '${team}' — team_create on the same slug restores an archived one`);
    // AND THE HOLDER HAS TO BE IN IT. A bound token names the one team it may act in, and
    // identity refuses one whose holder is not a member — so issuing it for somebody outside
    // the team produced a token that authenticated nowhere, handed over with "store it now".
    // A tool that reports success and returns something dead is the shape member_remove was
    // fixed for six tools up.
    if (tid) {
      const inTeam = await db.query(
        "select 1 from membership where team_id = $1 and principal_id = $2", [tid, pid]);
      if (!inTeam.rowCount) {
        return text(`ERROR: ${target} is not a member of '${team}', and a token bound to a ` +
                    "team its holder is not in is refused the first time it is used. " +
                    `member_add ${team} ${target} first, or issue the token unbound.`);
      }
    }
    const token = mintPat();
    // `expires_at` was ENFORCED and never written: resolvePat has always refused a token
    // past its expiry, and nothing could issue one, so every token on the platform lived
    // for ever and the check could not fire. Half a feature is the shape this repository
    // has learned to distrust — the dropped platform_credential table was the same thing in
    // the other direction, a column implying a property nobody provided.
    const expiry = expires_in_days
      ? new Date(Date.now() + expires_in_days * 86_400_000).toISOString()
      : null;
    // ONE LIVE TOKEN PER PERSON PER LABEL. A label names a PURPOSE — "librechat — someone@…"
    // — and a purpose has one current credential, not a pile of them.
    //
    // Nothing replaced anything before, and the provisioner mints on every run: production
    // held 34 live tokens labelled `librechat — sam@example.com`, 28 for
    // test_user_1, seven for each smoke account. Every one of them opens every door that
    // person can open, and none of them is distinguishable from the current one — so
    // "revoke their access" meant finding all 34, and missing one meant not having revoked
    // it. A credential nobody can enumerate is a credential nobody can withdraw.
    //
    // An UNLABELLED token is exempt: "" is not a purpose, so two of them are two tokens
    // rather than one replaced twice, and a caller who wants a second deliberate token can
    // still have one by leaving the label off or naming it differently.
    const replaced = label
      ? (await db.query("delete from pat where principal_id = $1 and label = $2", [pid, label])).rowCount ?? 0
      : 0;
    await db.query(
      "insert into pat (principal_id, token_hash, label, scope, team_id, expires_at) values ($1,$2,$3,$4,$5,$6)",
      [pid, sha256(token), label ?? "", wantScope, tid, expiry],
    );
    auditAdmin(id, "issue_pat", target,
               { scope: wantScope, team: team ?? null, label: label ?? "", expires_at: expiry,
                 ...(replaced ? { replaced } : {}) },
               team ?? null);
    return text(
      `PAT for ${target} (scope ${wantScope}${team ? ", team " + team : ""}` +
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
    // The bound team comes back with the owner, in the query that was already being made.
    // pat_issue records it and this did not, so a team admin watching their team's activity
    // saw a token appear for their team and never saw it withdrawn — the asymmetry falling on
    // the half that matters more, since a revocation is what somebody checks after a leak.
    // Every other paired act here — create/archive team, add/remove member, install/uninstall
    // flow, grant/revoke tool — records the team on both halves.
    const r = await db.query<{ email: string; team: string | null }>(
      `select p.email, t.slug as team from pat
         join principal p on p.id = pat.principal_id
         left join team t on t.id = pat.team_id
        where pat.id = $1`, [pat_id]);
    const owner = r.rows[0]?.email;
    if (!owner) return text("ERROR: no such PAT");
    if (owner !== id.email && !superOnly(id)) return text("ERROR: only the owner or superadmin can revoke");
    await db.query("update pat set revoked_at = now() where id = $1", [pat_id]);
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
      `select pat.id, p.email, pat.label, pat.scope, t.slug as team, pat.created_at, pat.last_used_at, pat.revoked_at
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
    // A member sees the teams they belong to; a superadmin sees all of them. This listed
    // every team and its member count to anyone with an identity, while person_list — the
    // same kind of question about the same people — required superadmin.
    const mine = id.teams.map((t) => t.slug);
    // WHO MADE IT, and when. `created_by` has been written on every team since the schema
    // was created and read by nothing, so "who set this team up" was a question only the
    // database could answer. A `not null` provenance column that no query selects is a fact
    // recorded where nobody can reach it.
    const columns =
      `select t.slug, t.name, t.status, t.created_at, c.email as created_by,
              count(m.principal_id)::int as members
         from team t left join membership m on m.team_id = t.id
         left join principal c on c.id = t.created_by`;
    // isSuper, not platformRole. A superadmin IS every team — that is the rule and it is
    // right — but the rule was written here a second time, in a form that cannot see a
    // token's team binding, so a token stamped with one team listed all of them.
    const r = isSuper(id)
      ? await platformDb().query(`${columns} group by t.id, c.email order by t.slug`)
      : await platformDb().query(
          `${columns} where t.slug = any($1) group by t.id, c.email order by t.slug`, [mine]);
    return text(JSON.stringify(r.rows.map((row) => ({
      ...row, your_role: id.teams.find((x) => x.slug === row.slug)?.role ?? null,
    }))));
  });

  if (lead) server.registerTool("flow_install", {
    description:
      "WHEN a team should start running one of the catalog's flows — browse them with " +
      "catalog_list first. RETURNS the install, pinning the flow's manifest as the single " +
      "place that says what this team runs; clients read it rather than being written into, " +
      "and the shelf a person installs from is generated from it. agent_name is what the " +
      "team sees. REFUSES anyone who does not administer THIS team, a flow the catalog does " +
      "not have, and a team that is not active.",
    inputSchema: {
      team: z.string(), flow: z.string(), version: z.string().optional(),
      agent_name: z.string().optional(),
    },
  }, async ({ team, flow, version, agent_name }) => {
    const id = await caller();
    const r = await installFlow(id, team, flow, version, agent_name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("flow_uninstall", {
    description:
      "WHEN a team should stop running a flow it chose. RETURNS confirmation, and says " +
      "plainly when the team never had that flow rather than reporting a removal that did " +
      "not happen. REFUSES anyone who does not administer THIS team, and refuses unless " +
      "confirm repeats the flow name. It cannot remove an automatic flow: those are the " +
      "platform's own and every team has them without installing them.",
    inputSchema: { team: z.string(), flow: z.string(), confirm: z.string() },
  }, async ({ team, flow, confirm }) => {
    const id = await caller();
    const r = await uninstallFlow(id, team, flow, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("tool_grant", {
    description:
      "WHEN a team has been refused a building block, or a flow it just installed declares " +
      "blocks nobody granted yet. RETURNS the grant. The rule to know before calling: once a " +
      "team has ANY grants the gateway enforces them on /p/<block>, so the first grant a " +
      "team is given is also the moment every other block starts being refused. REFUSES " +
      "anyone but a superadmin, and an unknown block id.",
    inputSchema: { team: z.string(), block: z.string() },
  }, async ({ team, block }) => {
    const id = await caller();
    const r = await grantTool(id, team, block);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("tool_revoke", {
    description:
      "WHEN a team should no longer reach a building block. RETURNS confirmation, and says " +
      "plainly when the team never had that grant rather than reporting a revocation that " +
      "did not happen — install_list shows what they actually have. REFUSES anyone but a " +
      "superadmin, and refuses unless confirm repeats the block id.",
    inputSchema: { team: z.string(), block: z.string(), confirm: z.string() },
  }, async ({ team, block, confirm }) => {
    const id = await caller();
    const r = await revokeTool(id, team, block, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  server.registerTool("install_list", {
    description:
      "WHEN you need to know what a team actually runs and what it has been trusted with — " +
      "before granting, revoking or debugging a refusal. RETURNS the registry view: every " +
      "team's flows and block grants, each with who put it there and when, automatic flows " +
      "included rather than only the ones the team chose, and a flag on any install whose " +
      "pinned manifest has drifted from the catalog. REFUSES to widen past your access: a " +
      "superadmin sees the registry, everyone else sees their own teams.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    // The third listing that answered about teams the caller has nothing to do with — which
    // flows they run and which blocks they were trusted with is a description of another
    // team's work. A superadmin sees the registry; everyone else sees their own teams.
    const all = isSuper(id);
    const mine = id.teams.map((t) => t.slug);
    const db = platformDb();
    // WHO DID IT, and when. `installed_by` and `granted_by` have been written on every row
    // since the schema was created and read by nothing — provenance recorded and then
    // unreadable, which answers the audit question no better than not recording it. This is
    // the registry view; "who gave this team casebox, and when" belongs here or nowhere.
    const flows = await db.query<{
      team: string; flow: string; version: string; manifest: CatalogManifest | null;
      installed_by: string | null; created_at: string;
    }>(
      `select t.slug as team, f.flow, f.version, f.manifest, p.email as installed_by, f.created_at
         from flow_install f join team t on t.id = f.team_id
         left join principal p on p.id = f.installed_by
       where $1 or t.slug = any($2) order by t.slug, f.flow`, [all, mine]);
    const grants = await db.query(
      `select t.slug as team, g.block, p.email as granted_by, g.created_at
         from tool_grant g join team t on t.id = g.team_id
         left join principal p on p.id = g.granted_by
       where $1 or t.slug = any($2) order by t.slug, g.block`, [all, mine]);
    // An install PINS the manifest it was made from, deliberately — that is what a version
    // means. But a manifest can change without its version moving, and then the pin and the
    // catalog differ silently, at the same version number, with nothing anywhere saying so.
    // It has already happened: sdlc-flow's pinned 0.1.0 predates `agentName`, so the team's
    // agent is called "Sdlc Agent" — titleCase of the directory — while the catalog has said
    // "SDLC Agent" for some time. Nothing was wrong with the pin. What was missing was any
    // way to find out.
    interface InstallRow {
      team: string; flow: string; version: string; install: string;
      installed_by?: string; installed_at?: string;
      pinned_manifest_differs_from_catalog?: boolean;
    }
    const rows: InstallRow[] = flows.rows.map((r) => {
      const current = catalogManifest(r.flow, true);
      const stale = current !== null && canonicalJson(current) !== canonicalJson(r.manifest);
      return { team: r.team, flow: r.flow, version: r.version, install: "opt-in",
               installed_by: r.installed_by ?? "unknown", installed_at: r.created_at,
               ...(stale ? { pinned_manifest_differs_from_catalog: true } : {}) };
    });
    // The flows a team has WITHOUT installing them. This listed flow_install alone, so a
    // team's automatic flows were absent — while render_agent_definition's own refusal
    // pointed the reader here with "install_list shows what they do have". It did not show
    // what they have; it showed what they chose. An answer that is silently partial is worse
    // than one that refuses, because the reader has no reason to look further.
    //
    // No pin to compare for these: an automatic flow is read from the catalog every time, so
    // there is nothing that can go stale.
    // EVERY ACTIVE TEAM, not every team that happens to have an opt-in install. Deriving the
    // list from flow_install rows meant a team that installed nothing never appeared at all —
    // so a newly created team, which HAS the automatic flows, was absent from the registry
    // view entirely. That is the same silently partial answer the paragraph above describes,
    // one level up: it fixed the auto flows missing for teams with installs, and left the
    // teams with none.
    const teams = all
      ? (await db.query<{ slug: string }>(
          "select slug from team where status = 'active' order by slug")).rows.map((r) => r.slug)
      : mine;
    for (const t of teams) {
      const chosen = new Set(flows.rows.filter((r) => r.team === t).map((r) => r.flow));
      for (const a of autoFlows()) {
        if (!chosen.has(a.flow)) {
          // No installer and no date: nobody installed an automatic flow, and inventing
          // either would make a fact out of the absence of one.
          rows.push({ team: t, flow: a.flow, version: a.manifest.version ?? "", install: "automatic" });
        }
      }
    }
    rows.sort((x, y) => x.team.localeCompare(y.team) || x.flow.localeCompare(y.flow));
    return text(JSON.stringify({
      scope: all ? "platform" : mine,
      flows: rows,
      grants: grants.rows,
      ...(rows.some((r) => r.pinned_manifest_differs_from_catalog)
        ? { note: "A flow marked pinned_manifest_differs_from_catalog is running an older manifest than the catalog ships. Re-run flow_install for that team to take the current one." }
        : {}),
    }));
  });

  // render_harness_config USED TO BE HERE, and the door split was the only thing keeping it
  // alive. Its own description said so: "for your OWN setup use client_setup on /manage;
  // this door is for rendering someone else's." Two tools, one job, told apart by which URL
  // you reached them at. With one door there is one tool — client_setup now takes an
  // optional `email`, superadmin-only for anyone but yourself, which is the whole of what
  // this added.
}
