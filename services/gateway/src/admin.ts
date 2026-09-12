/**
 * Agentic platform management: the administrative half of /manage/mcp.
 *
 * There is no separate admin door. There used to be — /admin/mcp — and it authorised
 * nothing: any member could open it, see all twenty tools, and be refused by each one in
 * turn. A door that admits everyone is not a boundary, it is a second URL. So the tools
 * moved onto the door every person already has, and what changed is only which of them are
 * REGISTERED for a given caller: `registerAdminTools` below reads the caller's role once
 * and offers a member the eight tools their role carries rather than twenty-eight refusals.
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
 * ONE named team — install_flow for a team you do not lead is a refusal a visible tool must
 * still make, with its reason. */
export function registerAdminTools(server: McpServer, id: Identity | null): void {
  const sup = !!id && isSuper(id);
  const lead = sup || (!!id && id.teams.some((t) => isTeamAdmin(id, t.slug)));

  server.registerTool("whoami", {
    // What ONLY this tool says. Three tools answer some form of "who am I" — get_my_info on
    // /core for an agent doing work, my_teams beside this one for a person managing their own
    // access — and this one described itself as "role and team memberships", which is what
    // my_teams already returns. Described that way it reads as a third copy, and a model
    // choosing between them has no reason to prefer any.
    //
    // It has a second job now: it is the answer to "why is that tool not in my list?". This
    // door registers only the tools a caller's role can execute, so a missing tool is a
    // statement about the caller, and this is the tool that reads that statement back.
    //
    // It is the only one that says HOW the caller authenticated and what their token is
    // scoped to, which is the answer to "why was I refused" and is answered by nothing else.
    description:
      "How the platform resolved YOU, for diagnosing a refusal — including a tool that is " +
      "not in your list at all, which means your role does not carry it: your platform role, " +
      "how this request authenticated (a token, or forwarded headers), and what the token is " +
      "scoped to. For your teams use my_teams; for your identity while working use get_my_info.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    return text(JSON.stringify(id ?? { error: "no platform identity" }));
  });

  if (sup) server.registerTool("list_people", {
    description: "All principals with platform role and status, each with the teams they are in — their role there, who added them and when. That last part is what an access review asks for.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    const r = await listPeople(id);
    if (!r.ok) return text(`ERROR: ${r.error}`);
    return text(JSON.stringify(r.rows));
  });

  if (sup) server.registerTool("add_person", {
    description: "Create a principal (platform member). A browser account is made separately, by an operator; this links to it by email.",
    inputSchema: { email: z.string().email(), display_name: z.string().optional() },
  }, async ({ email, display_name }) => {
    const id = await caller();
    const r = await addPerson(id, email, display_name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("issue_enrolment", {
    description: "Mint a one-time link letting an existing principal register a passkey for the console. " +
      "The link is returned once and cannot be read back — only its hash is stored. " +
      "add_person first: a passkey attaches to an account, it cannot create one.",
    inputSchema: { email: z.string().email() },
  }, async ({ email }) => {
    const id = await caller();
    const r = await issueEnrolmentLink(id, email);
    return text(r.ok ? `${r.message}\n\n${r.url}` : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("deactivate_person", {
    // The caveat is on the RETURN too, and it needs to be here as well: an agent chooses a
    // tool by its description and reads the return only after calling it. "What this does
    // not do" is not a footnote when the thing it does not do is leave live credentials at
    // a third party for somebody who has left.
    description: "Deactivate a principal. Stops them authenticating; does NOT touch the " +
      "building-block keys stored under their address — remove those separately with " +
      "admin_delete_credential. Destructive: pass confirm = the same email.",
    inputSchema: { email: z.string().email(), confirm: z.string() },
  }, async ({ email, confirm }) => {
    const id = await caller();
    const r = await deactivatePerson(id, email, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("create_team", {
    description: "Create a team (slug is the stable identity used everywhere).",
    inputSchema: { slug: z.string().regex(TEAM_SLUG), name: z.string().min(1) },
  }, async ({ slug, name }) => {
    const id = await caller();
    const r = await createTeam(id, slug, name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("archive_team", {
    description:
      "Retire a team: its members lose it from their access and its block grants stop " +
      "counting. Reversible with create_team on the same slug. Destructive: confirm = the " +
      "team slug.",
    inputSchema: { team: z.string(), confirm: z.string() },
  }, async ({ team, confirm }) => {
    const id = await caller();
    const r = await archiveTeam(id, team, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("add_member", {
    description: "Add a principal to a team. role: member (default) or admin.",
    inputSchema: { team: z.string(), email: z.string().email(), role: z.enum(["member", "admin"]).optional() },
  }, async ({ team, email, role }) => {
    const id = await caller();
    const r = await addMember(id, team, email, role);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("remove_member", {
    description: "Remove a principal from a team. Destructive: pass confirm = the team slug.",
    inputSchema: { team: z.string(), email: z.string().email(), confirm: z.string() },
  }, async ({ team, email, confirm }) => {
    const id = await caller();
    const r = await removeMember(id, team, email, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  server.registerTool("issue_pat", {
    description:
      "Issue a personal access token. Plaintext is returned EXACTLY ONCE. " +
      "Self-issue is always allowed (scope member); issuing for others or scope admin needs authority.",
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
    if (team && !tid) return text(`ERROR: no active team '${team}' — create_team on the same slug restores an archived one`);
    // AND THE HOLDER HAS TO BE IN IT. A bound token names the one team it may act in, and
    // identity refuses one whose holder is not a member — so issuing it for somebody outside
    // the team produced a token that authenticated nowhere, handed over with "store it now".
    // A tool that reports success and returns something dead is the shape remove_member was
    // fixed for six tools up.
    if (tid) {
      const inTeam = await db.query(
        "select 1 from membership where team_id = $1 and principal_id = $2", [tid, pid]);
      if (!inTeam.rowCount) {
        return text(`ERROR: ${target} is not a member of '${team}', and a token bound to a ` +
                    "team its holder is not in is refused the first time it is used. " +
                    `add_member ${team} ${target} first, or issue the token unbound.`);
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

  server.registerTool("revoke_pat", {
    description: "Revoke a PAT by its id (see list_pats). Destructive: confirm = the pat id.",
    inputSchema: { pat_id: z.string().uuid(), confirm: z.string() },
  }, async ({ pat_id, confirm }) => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    if (confirm !== pat_id) return text("ERROR: confirm must repeat the pat id exactly");
    const db = platformDb();
    // The bound team comes back with the owner, in the query that was already being made.
    // issue_pat records it and this did not, so a team admin watching their team's activity
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

  server.registerTool("list_pats", {
    description: "List PATs (masked): your own, or everyone's for superadmin.",
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

  server.registerTool("list_teams", {
    description: "Teams with member counts, who created each and when, and your role in each.",
    inputSchema: {},
  }, async () => {
    const id = await caller();
    if (!id) return text("ERROR: no platform identity");
    // A member sees the teams they belong to; a superadmin sees all of them. This listed
    // every team and its member count to anyone with an identity, while list_people — the
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

  if (lead) server.registerTool("install_flow", {
    description:
      "Install a catalog flow for a team: records registry truth, with the flow's manifest, " +
      "as the single place that says what this team runs. Clients read it rather than being " +
      "written into — the shelf a person installs from is generated from it. agent_name is " +
      "what the team sees.",
    inputSchema: {
      team: z.string(), flow: z.string(), version: z.string().optional(),
      agent_name: z.string().optional(),
    },
  }, async ({ team, flow, version, agent_name }) => {
    const id = await caller();
    const r = await installFlow(id, team, flow, version, agent_name);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (lead) server.registerTool("uninstall_flow", {
    description: "Remove a team's flow install. Destructive: confirm = the flow name.",
    inputSchema: { team: z.string(), flow: z.string(), confirm: z.string() },
  }, async ({ team, flow, confirm }) => {
    const id = await caller();
    const r = await uninstallFlow(id, team, flow, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("grant_tool", {
    description:
      "Grant a team access to a building block (gateway platform id, e.g. 'casebox'). " +
      "Once a team has ANY grants, the gateway enforces them on /p/<block> — no grant, no access.",
    inputSchema: { team: z.string(), block: z.string() },
  }, async ({ team, block }) => {
    const id = await caller();
    const r = await grantTool(id, team, block);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  if (sup) server.registerTool("revoke_tool", {
    description: "Revoke a team's block access. Destructive: confirm = the block id.",
    inputSchema: { team: z.string(), block: z.string(), confirm: z.string() },
  }, async ({ team, block, confirm }) => {
    const id = await caller();
    const r = await revokeTool(id, team, block, confirm);
    return text(r.ok ? r.message : `ERROR: ${r.error}`);
  });

  server.registerTool("list_installs", {
    description: "Registry view: every team's flows and block grants, each with who put it there and when.",
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
    // pointed the reader here with "list_installs shows what they do have". It did not show
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
        ? { note: "A flow marked pinned_manifest_differs_from_catalog is running an older manifest than the catalog ships. Re-run install_flow for that team to take the current one." }
        : {}),
    }));
  });

  // render_harness_config USED TO BE HERE, and the door split was the only thing keeping it
  // alive. Its own description said so: "for your OWN setup use my_client_setup on /manage;
  // this door is for rendering someone else's." Two tools, one job, told apart by which URL
  // you reached them at. With one door there is one tool — my_client_setup now takes an
  // optional `email`, superadmin-only for anyone but yourself, which is the whole of what
  // this added.
}
