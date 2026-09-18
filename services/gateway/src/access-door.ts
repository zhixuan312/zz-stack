/**
 * The access door: the tools a person uses on their own account.
 *
 * Their keys, their access tokens, which team they act for, and the client package that
 * installs the platform into their terminal. It is a door of its own rather than part of
 * /core because every tool here acts on the CALLER rather than on a team's work — and
 * because an agent that never needs to change anybody's credentials should not be carrying
 * tools that can.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serviceVersion, text } from "@zz/mcp-http";
import { z } from "zod";

import { registerAdminTools } from "./admin.js";
import { caller } from "./credentials.js";
import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";
import { callerIdentity, isSuper } from "./identity.js";
import { myTeamsSummary } from "./settings.js";
import { registerShelf, renderClientSetup } from "./admin/flows.js";

/** What this door says about itself at `initialize`, before any tool is called.
 *
 * The same field, and the same reasoning, as services/zz-core/src/orientation.ts: one
 * paragraph handed to a client at connect time, for the client that reads nothing else. It is
 * an ADDITION and never a replacement — Claude Desktop parses the field without showing it to
 * the model — so nothing load-bearing lives only here.
 *
 * Two lengths are real and checks/orientation.ts asserts both: Claude Code truncates near
 * 2KB, and Codex advises the first 512 characters be self-contained, so the purpose and the
 * skill to read come first.
 *
 * NO TOOL NAMES BELOW, deliberately, and it is the one place this text differs in shape from
 * zz-core's. That door is noun-first and its paragraph names every prefix it serves, checked
 * both ways. This one is not, and the reason survived the rename that gave it noun-first
 * names: this door's list is CUT BY ROLE, so a member and a superadmin read the same
 * paragraph against different lists. A paragraph naming every prefix would name several this
 * reader has not been offered — which reads as a missing feature rather than as a fact about
 * their access. So this says what the door is FOR, a capability to a line, and lets the tool
 * list speak for itself. `whoami` is named because it is the tool that explains the cut. */
const ACCESS_INSTRUCTIONS =
  "This is /manage: your own access to the ZZ platform — and, if your role carries them, the " +
  "people and teams behind it. Every tool here acts on YOU, the caller, rather " +
  "than on a team's work.\n\n" +
  "START HERE: `whoami`. It says how the platform resolved you, what your platform role is, " +
  "and what your token is scoped to. THE TOOL LIST IS YOUR ROLE — this door registers only " +
  "what your role can execute, so a tool you cannot find is a fact about your access rather " +
  "than a missing feature. Load the zz-access skill for the rest of it.\n\n" +
  "What is here, a line each:\n" +
  "  your identity        which team you are acting for, and switching between them\n" +
  "  your platform token  issue one, list them masked, revoke one — shown ONCE, never again\n" +
  "  your client setup    which marketplace, which plugins, and where the token goes\n" +
  "  the shelf            the optional plugins you may install, in your own client\n" +
  "  administration       people, teams and tokens — only if your role " +
  "carries them, and every one still refuses per call\n\n" +
  "NOT FOR: doing any work. Documents, the knowledge store, the skills library and today's " +
  "date are the /core door. This one changes who may do things, not what gets done.";

/** /manage/mcp — the ONE door a person speaks to, built per request for the person speaking.
 *
 * There were two: /manage for your own access and /admin for administering the platform.
 * The second authorised nothing — its own entry in the door index said "any member; each
 * tool authorises per call" — so a member could open it, list every tool on it, and be
 * refused by every one. The split bought a shorter tool list and nothing else, and it leaked:
 * `credential_admin_set` is an operator tool and it lives here, on the member door, because
 * that is where the credential store is.
 *
 * So there is one door, and the list is shortened by the thing that was doing the work all
 * along — the caller's role. `registerAdminTools` reads it once and registers what that role
 * can execute: a member is offered only tools a member can use, and every extra tool a lead
 * or a superadmin sees is one their role can actually execute. No count is written here —
 * checks/manage-surface.ts holds the numbers, where they are measured rather than restated.
 *
 * This is why the builder is async, and why `serveMcp` awaits it: resolving who is calling
 * is a database read, and it has to finish before the first tool is registered.
 *
 * WHAT A MEMBER LOSES, stated plainly: calling `person_list` used to answer "ERROR:
 * superadmin required", and now answers "tool not found", which explains less. Two things
 * carry that explanation instead — `whoami`, registered for everyone precisely so the
 * question "why can I not see it" has a tool, and the zz-access skill, which says a tool
 * missing from your list is a fact about your role. */
export async function buildAccessServer(): Promise<McpServer> {
  // SECOND ARGUMENT. `instructions` is `ServerOptions`; the first argument is
  // `Implementation` and carries only name/version/title.
  const server = new McpServer({ name: "zz-access", version: serviceVersion(import.meta.url) },
                               { instructions: ACCESS_INSTRUCTIONS });
  const id = await callerIdentity();
  // Operator tools on this door take the same reading of "operator" the handlers do. See the
  // note over registerAdminTools: visibility must never be wider than executability.
  const sup = !!id && isSuper(id);

  // The shelf. It lives with the registry code that answers it, and is mounted here because
  // this is the door a person has: /manage is a person's own access, and "what may I install"
  // is a question about that, not about administering anybody.
  registerShelf(server);




  server.registerTool(
    "team_mine",
    {
      // What ONLY this tool says. Three tools answer some form of "who am I" and they are
      // deliberately not merged — see the note over `whoami` in admin.ts, which was written
      // first and is the model this follows. This one described itself as "the teams you
      // belong to, and which one you are acting for", which `session_whoami` also returns:
      // read that way it is a third copy, and a model choosing between the three had no
      // reason to prefer any.
      //
      // It is the only one that lists the teams you are NOT acting for, which is the answer
      // to "why can I not see that team's documents" and the call that has to come before
      // team_switch.
      description:
        "WHEN you need to know which teams are open to you before moving between them — the " +
        "call that comes before team_switch. RETURNS EVERY team you belong to and which one " +
        "you are ACTING FOR right now; it is the only tool that names the others, and " +
        "everything you do — documents, gates, the knowledge store, every agent — happens " +
        "inside the team you are acting for. REFUSES a request it cannot identify, and it " +
        "never invents a team you are not in: a bound token naming a team its owner has left " +
        "comes back as acting for no team rather than as that team. For your platform role, " +
        "how this request authenticated, or why a tool is missing from your list, call " +
        "whoami; for today's date and the team you are acting for while doing work, call " +
        "session_whoami on /core.",
      inputSchema: {},
    },
    async () => {
      // THE SAME RULE THAT DECIDES IT, not a second query that agrees most of the time.
      // `myTeamsSummary` (settings.ts, shared with Task I-13's browser route) applies
      // `actingTeam`'s own fallback — admin-role first, then alphabetically — rather than a
      // second `order by t.slug` that agrees with it most of the time. It is also the one
      // place that reads a bound token naming a team its owner is not in as "acts for no
      // team", which a fallback here would quietly paper over.
      if (!id) return text("ERROR: no user identity on this request");
      const result = myTeamsSummary(id);
      if (!result.ok) return text(`ERROR: ${result.error}`);
      return text(JSON.stringify({
        acting_for: result.actingFor, teams: result.teams,
        ...(result.note ? { note: result.note } : {}),
      }, null, 2));
    },
  );

  server.registerTool(
    "team_switch",
    {
      description:
        "WHEN the work belongs to a different team than the one you are acting for. RETURNS " +
        "confirmation that you now act for that team: your documents, knowledge store and " +
        "agents are that team's everywhere from here, and work you left unfinished stays " +
        "with the team you left it in, where its members can pick it up. REFUSES any team " +
        "you are not a member of and any archived team, and names the ones you do have " +
        "instead — call team_mine first if you are not sure.",
      inputSchema: { team: z.string() },
    },
    async ({ team }) => {
      const email = caller().email;
      if (!email) return text("ERROR: no user identity on this request");
      // A BOUND TOKEN CANNOT MOVE ANYBODY, INCLUDING ITSELF. `actingTeam` reads a bound token's
      // own team whatever this column says, so the caller saw "you are now acting for X" and
      // nothing changed for it — while `active_team_id` is where every OTHER credential that
      // person holds reads their team from. A left-running automation could silently move its
      // owner's browser session and every unbound agent token to a different team. The console
      // route beside this one has refused it since it was written.
      const bound = (await callerIdentity())?.patTeam;
      if (bound) {
        return text(
          `ERROR: this token is bound to team '${bound}', so it cannot switch teams — not its ` +
          "own (it always acts for that team) and not yours, which is what this would actually " +
          "change: `active_team_id` is read by every other credential you hold. Switch from an " +
          "unbound session.");
      }
      const slug = team.trim();
      const db = platformDb();
      // Only a team they are actually in, and only a live one. Checked in the same statement
      // that writes, so there is no window between deciding and doing.
      const done = await db.query<{ slug: string }>(
        `update zz.principal p
            set active_team_id = t.id, updated_at = now()
           from zz.team t
          where lower(p.email) = $1
            and t.slug = $2 and t.status = 'active'
            and exists (select 1 from zz.membership m
                         where m.team_id = t.id and m.principal_id = p.id)
          returning t.slug`, [email, slug]);
      if (!done.rowCount) {
        const mine = (await db.query<{ slug: string }>(
          `select t.slug from zz.membership m
             join zz.team t on t.id = m.team_id
             join zz.principal p on p.id = m.principal_id
            where lower(p.email) = $1 and t.status = 'active'
            order by t.slug`, [email])).rows.map((r) => r.slug);
        return text(`ERROR: you are not in an active team called '${slug}'. ` +
                    (mine.length ? `Yours: ${mine.join(", ")}.` : "You are not in any team yet."));
      }
      // Recorded like any other act. For a platform whose whole point is who approved what
      // and when, who was ACTING FOR WHICH TEAM and when belongs in the same record.
      logEvent({ actor: email, kind: "team.switch", subject: slug, teamSlug: slug });
      return text(
        `you are now acting for ${slug}.\n` +
        `Everything follows this: your documents, your knowledge store, and the agents you ` +
        `see. A client that is already open may take a few seconds to catch up, and one ` +
        `holding a stale agent list needs a refresh.`);
    },
  );




  server.registerTool(
    "client_setup",
    {
      // `email` came from render_harness_config, which was this tool on the other door and
      // existed only because there was another door. Onboarding somebody means rendering
      // THEIR setup, so the capability had to survive the merge; it is the same superadmin
      // check that tool made.
      description:
        "WHEN somebody is connecting Claude Code to this platform for the first time, or " +
        "being onboarded. RETURNS their setup: which marketplace to add, which plugins to " +
        "install, and where the token goes — carrying only the blocks their team's installed " +
        "flows declare. Yours by default; pair it with pat_issue, since the setup needs a " +
        "token and that token is shown once. REFUSES another person's setup unless you are " +
        "superadmin, and refuses a request it cannot identify.",
      inputSchema: {
        email: z.string().email().optional().describe("Whose setup. Omit for your own; anyone else needs superadmin."),
      },
    },
    async ({ email }) => {
      const me = caller().email;
      if (!me) return text("ERROR: no identity on this request");
      if (!platformDbReady()) return text("ERROR: platform db unavailable");
      const target = (email ?? me).toLowerCase();
      // `sup` is this request's caller: the server is built per request, so the closure holds
      // the same identity the handler is acting for. No second lookup, no chance of the two
      // disagreeing.
      if (target !== me.toLowerCase() && !sup) {
        return text("ERROR: superadmin required to render another person's setup");
      }
      return text(await renderClientSetup(target));
    },
  );



  // ── the bugs people report ─────────────────────────────────────────────────────────────
  //
  // Moved to ./admin/bugs.ts when `bug_delete` joined them and this file reached the 700-line
  // ceiling. A tracker is its own subject: filing is everyone's and lives on /core, while
  // reading, closing and removing a report are operator acts and live here.



  // People, teams, tokens, the registry and the projections — registered by role, guarded
  // per call. admin.ts owns both halves of that; this is the only place it is mounted.
  registerAdminTools(server, id);

  return server;
}
