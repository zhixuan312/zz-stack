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
import { mask } from "@zz/contracts";
import { serviceVersion, text } from "@zz/mcp-http";
import { z } from "zod";

import { registerAdminTools } from "./admin.js";
import { beginAuthorization, disconnectBlock } from "./block-oauth.js";
import { PLATFORMS } from "./blocks.js";
import { caller, deleteMyCredentialFor, implausibleKey, issueMyAccessTokenFor, myAccessTokensFor, myCredentialsFor, operatorOnly, revokeMyAccessTokenFor, setMyCredentialFor, withCredentials } from "./credentials.js";
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
 * Two lengths are real and checks/orientation.mjs asserts both: Claude Code truncates near
 * 2KB, and Codex advises the first 512 characters be self-contained, so the purpose and the
 * skill to read come first.
 *
 * NO TOOL NAMES BELOW, deliberately, and it is the one place this text differs in shape from
 * zz-core's. That door is noun-first and its paragraph names every prefix it serves, checked
 * both ways. This one is not: it serves list_catalog, connect_block, set_my_credential and a
 * dozen more verb-first names that Task I-22 renames. Naming them here would put a second
 * copy of that vocabulary in I-22's path and would rot silently in the meantime, so this says
 * what the door is FOR, a capability to a line, and lets the tool list speak for itself. */
const ACCESS_INSTRUCTIONS =
  "This is /manage: your own access to the ZZ platform — and, if your role carries them, the " +
  "people, teams and installs behind it. Every tool here acts on YOU, the caller, rather " +
  "than on a team's work.\n\n" +
  "START HERE: `whoami`. It says how the platform resolved you, what your platform role is, " +
  "and what your token is scoped to. THE TOOL LIST IS YOUR ROLE — this door registers only " +
  "what your role can execute, so a tool you cannot find is a fact about your access rather " +
  "than a missing feature. Load the zz-access skill for the rest of it.\n\n" +
  "What is here, a line each:\n" +
  "  your identity        which team you are acting for, and switching between them\n" +
  "  your platform token  issue one, list them masked, revoke one — shown ONCE, never again\n" +
  "  your block keys      store, list and delete your own key for a building block\n" +
  "  connecting a block   sign in as yourself, so it records you and there is no key to keep\n" +
  "  your client setup    which marketplace, which plugins, and where the token goes\n" +
  "  the shelf            what your team may install\n" +
  "  administration       people, teams, tokens, installs and grants — only if your role " +
  "carries them, and every one still refuses per call\n\n" +
  "NOT FOR: doing any work. Documents, the knowledge store, the skills library and today's " +
  "date are the /core door. This one changes who may do things, not what gets done.";

/** /manage/mcp — the ONE door a person speaks to, built per request for the person speaking.
 *
 * There were two: /manage for your own access and /admin for administering the platform.
 * The second authorised nothing — its own entry in the door index said "any member; each
 * tool authorises per call" — so a member could open it, list twenty tools, and be refused
 * by every one. The split bought a shorter tool list and nothing else, and it leaked:
 * `admin_set_credential` is an operator tool and it lives here, on the member door, because
 * that is where the credential store is.
 *
 * So there is one door, and the list is shortened by the thing that was doing the work all
 * along — the caller's role. `registerAdminTools` reads it once and registers what that role
 * can execute. A member sees twenty tools they can all use; a superadmin sees thirty-four.
 *
 * This is why the builder is async, and why `serveMcp` awaits it: resolving who is calling
 * is a database read, and it has to finish before the first tool is registered.
 *
 * WHAT A MEMBER LOSES, stated plainly: calling `list_people` used to answer "ERROR:
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
    "connect_block",
    {
      description:
        "Start signing in to a building block AS YOURSELF, so that block records you rather " +
        "than the platform. Returns a link to open: you sign in there, choose which " +
        "permissions to grant, and come back. Afterwards your calls to that block use your " +
        "own access — no key to create, copy or keep. Only for blocks that support it; the " +
        "rest still need a key stored with set_credential.",
      inputSchema: { block: z.string().describe("which building block, e.g. bookit") },
    },
    async ({ block }) => {
      if (!id) return text("ERROR: no user identity on this request");
      const url = PLATFORMS[block]?.url;
      if (!url) {
        return text(`ERROR: no such block '${block}'. Known: ${Object.keys(PLATFORMS).join(", ")}`);
      }
      const got = await beginAuthorization(id.email, block, url);
      if ("error" in got) return text(`ERROR: ${got.error}`);
      return text([
        `Open this to connect your ${block} access:`, "", got.url, "",
        "You will sign in there and choose what to allow. The link is single-use and expires",
        "in ten minutes. Nothing is stored against your account until you approve it.",
      ].join("\n"));
    },
  );

  server.registerTool(
    "disconnect_block",
    {
      // THE OTHER HALF, and it had no agent-facing door until now.
      //
      // The front end's Revoke button clears the FRONT END's token — it has no way to reach
      // the delegated token this platform holds for the block, which lives in the platform
      // database. So without this, "revoke" cleared a cache: the block's grant stayed exactly
      // as live as before, and the platform could still act as that person at the block.
      //
      // Pressing Connect again re-runs the block's own sign-in whichever way this goes (see
      // mcp-oauth.ts), so this is not needed to RECONNECT. It is needed to actually stop
      // being connected.
      description:
        "Stop being connected to a building block: deletes YOUR OWN delegated access to it, " +
        "so the platform can no longer act as you there. Use it when someone says they want " +
        "to revoke a block, or before re-connecting as a different account. The front end's " +
        "own Revoke button does not do this — it only clears the front end's copy. " +
        "Reconnect any time with connect_block.",
      inputSchema: { block: z.string().describe("which building block, e.g. casebox") },
    },
    async ({ block }) => {
      if (!id) return text("ERROR: no user identity on this request");
      if (!PLATFORMS[block]) {
        return text(`ERROR: no such block '${block}'. Known: ${Object.keys(PLATFORMS).join(", ")}`);
      }
      if (!platformDbReady()) return text("ERROR: platform database unavailable");
      const removed = await disconnectBlock(id.email, block);
      return text(removed
        ? `Disconnected from ${block}. The platform no longer holds any access to it as you, ` +
          "and calls to that block will refuse until you connect again — from the MCP " +
          "settings in the front end, or with connect_block."
        : `You had no connection to ${block} to remove. If calls to it are working, they are ` +
          "using a stored key rather than your own sign-in.");
    },
  );

  server.registerTool(
    "list_platforms",
    {
      description: "The building-block platforms a personal API key can be stored for.",
      inputSchema: {},
    },
    async () =>
      text(JSON.stringify(Object.fromEntries(Object.entries(PLATFORMS).map(([id, p]) => [id, p.name])))),
  );

  server.registerTool(
    "my_teams",
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
      // switch_team.
      description:
        "EVERY team you belong to, and which one you are ACTING FOR right now — the only " +
        "tool that names the others, and the one to call before switch_team. Everything you " +
        "do — documents, gates, the knowledge store, every agent — happens inside the team " +
        "you are acting for. For your platform role, how this request authenticated, or why " +
        "a tool is missing from your list, call whoami; for today's date and the team you " +
        "are acting for while doing work, call session_whoami on /core.",
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
    "switch_team",
    {
      description:
        "Change which team you are ACTING FOR. You work in one team at a time: after this, " +
        "your documents, knowledge store and agents are that team's, everywhere. Work you " +
        "left unfinished stays with the team you left it in, where its members can pick it up.",
      inputSchema: { team: z.string() },
    },
    async ({ team }) => {
      const email = caller().email;
      if (!email) return text("ERROR: no user identity on this request");
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
    "set_my_credential",
    {
      description:
        "Store YOUR personal API key for a platform (see list_platforms). " +
        "From then on, your calls to that platform authenticate as you.",
      inputSchema: { platform: z.string(), api_key: z.string() },
    },
    async ({ platform, api_key }) => {
      const email = caller().email;
      if (!email) return text("ERROR: no user identity on this request");
      const result = await setMyCredentialFor(email, platform, api_key);
      if (!result.ok) return text(`ERROR: ${result.error}`);
      return text(
        `Stored your ${result.platformName} key (${result.masked}). Your ${platform} calls now authenticate as you.` +
        (result.replacedMasked ? ` This REPLACED the key you had stored (${result.replacedMasked}) — that one is gone.` : ""),
      );
    },
  );

  server.registerTool(
    "my_credentials",
    {
      description: "Which platforms you have stored a personal key for (keys are masked).",
      inputSchema: {},
    },
    async () => {
      const email = caller().email;
      if (!email) return text("ERROR: no user identity on this request");
      const mine = myCredentialsFor(email);
      const masked = Object.fromEntries(Object.entries(mine).map(([p, k]) => [p, mask(k)]));
      return text(
        JSON.stringify(
          Object.keys(masked).length
            ? masked
            : { status: "no credentials stored yet — use set_my_credential" },
        ),
      );
    },
  );

  server.registerTool(
    "delete_my_credential",
    {
      description: "Remove your stored key for a platform.",
      inputSchema: { platform: z.string() },
    },
    async ({ platform }) => {
      const email = caller().email;
      // Every other tool here refuses an unidentified caller; this one did not, and would
      // have gone on to look up the empty-string user.
      if (!email) return text("ERROR: no user identity on this request");
      const had = await deleteMyCredentialFor(email, platform);
      return text(had ? `deleted your ${platform} credential` : `you had no ${platform} credential stored`);
    },
  );

  // Your own platform access belongs beside your own platform keys. Getting
  // a token must not require the admin surface: every delivery agent has
  // /manage, so anyone can self-serve from the chat they are already in.
  server.registerTool(
    "issue_my_access_token",
    {
      description:
        "Issue YOUR OWN personal access token for connecting Claude Code, Codex, Hermes or any " +
        "other MCP client to this platform. The token is shown ONCE and cannot be retrieved " +
        "again — tell the person to store it now. It carries their own identity and their own " +
        "team access, nothing more. Pair it with `my_client_setup` for the client's setup.",
      inputSchema: { label: z.string().optional().describe("What it is for, e.g. 'laptop — Claude Code'.") },
    },
    async ({ label }) => {
      const email = caller().email;
      if (!email) return text("ERROR: no identity on this request");
      if (!platformDbReady()) return text("ERROR: platform db unavailable");
      const result = await issueMyAccessTokenFor(email, label);
      if (!result.ok) return text(`ERROR: ${result.error}`);
      return text(
        `Personal access token for ${result.email}${result.label ? " (" + result.label + ")" : ""}:\n\n${result.token}\n\n` +
        "SHOWN ONCE — store it now; it cannot be shown again.\n" +
        "Use it as `Authorization: Bearer <token>`. It acts as you, with your team's access.\n" +
        "If it ever leaks, say so and it will be revoked immediately.",
      );
    },
  );

  server.registerTool(
    "my_access_tokens",
    {
      description: "Your own access tokens, masked — when each was issued, last used, and whether revoked.",
      inputSchema: {},
    },
    async () => {
      const email = caller().email;
      if (!email) return text("ERROR: no identity on this request");
      if (!platformDbReady()) return text("ERROR: platform db unavailable");
      return text(JSON.stringify(await myAccessTokensFor(email)));
    },
  );

  server.registerTool(
    "revoke_my_access_token",
    {
      description: "Revoke one of your own tokens (see my_access_tokens). Takes effect immediately.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const email = caller().email;
      // Every sibling refuses an unidentified caller. This one went on to look up the
      // empty-string principal, matched nothing, and answered "no such active token of
      // yours" — a claim about their tokens, to somebody the platform cannot identify.
      if (!email) return text("ERROR: no identity on this request");
      if (!platformDbReady()) return text("ERROR: platform db unavailable");
      const ok = await revokeMyAccessTokenFor(email, id);
      return ok ? text(`token ${id} revoked`) : text("ERROR: no such active token of yours");
    },
  );

  server.registerTool(
    "my_client_setup",
    {
      // `email` came from render_harness_config, which was this tool on the other door and
      // existed only because there was another door. Onboarding somebody means rendering
      // THEIR setup, so the capability had to survive the merge; it is the same superadmin
      // check that tool made.
      description:
        "The setup for connecting Claude Code to this platform: which marketplace to add, " +
        "which plugins to install, and where to put your token — carrying only the blocks " +
        "the team's installed flows declare. Yours by default — pair it with " +
        "issue_my_access_token, since the setup needs a token and it is shown " +
        "once. Pass email to render somebody else's, for onboarding them (superadmin only).",
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

  if (sup) server.registerTool(
    "admin_set_credential",
    {
      description:
        "Operators only (admin role): store a key on another user's behalf — " +
        "used for onboarding batches.",
      inputSchema: { user_email: z.string(), platform: z.string(), api_key: z.string() },
    },
    async ({ user_email, platform, api_key }) => {
      const denied = operatorOnly();
      if (denied) return text(denied);
      if (!PLATFORMS[platform]) return text(`ERROR: unknown platform '${platform}'`);
      const addr = user_email.trim().toLowerCase();
      if (!addr) return text("ERROR: user_email is required");
      // The store is keyed by email and injection looks the caller's own address up in it,
      // so a key filed under an address that is not a principal can never be reached by
      // anyone. A typo in an onboarding batch therefore stored a key nobody has, and both
      // this tool and the batch script reported success.
      if (platformDbReady()) {
        const known = await platformDb().query(
          "select 1 from principal where email = $1 and status = 'active'", [addr]);
        if (!known.rowCount) {
          return text(`ERROR: '${addr}' is not an active platform member — add_person first. ` +
                      "A key stored under an address nobody has cannot be injected for anyone.");
        }
      }
      // The ONBOARDING BATCH path — the one most likely to run several at once, and the
      // one where a lost write means a colleague quietly has no key.
      const key = api_key.trim();
      const weak = implausibleKey(key);
      if (weak) return text(weak);
      const replaced = await withCredentials((data) => {
        const had = data[addr]?.[platform];
        (data[addr] ??= {})[platform] = key;
        return had ? mask(had) : null;
      });
      logEvent({ actor: caller().email, kind: "credential.admin_set",
                 subject: `${addr}:${platform}`, detail: { replaced: !!replaced } });
      // Whether it replaced one, for the same reason set_my_credential says it — and more
      // sharply here, because this is the batch path and the key being overwritten is
      // somebody else's working credential, on a run of many where one line scrolls past.
      return text(`stored ${platform} key for ${addr} (${mask(key)})` +
                  (replaced ? ` — REPLACED their previous key (${replaced}), which is gone` : ""));
    },
  );

  if (sup) server.registerTool(
    "admin_delete_credential",
    {
      description:
        "Operators only: remove another person's stored key for a block. Use when someone " +
        "leaves, or when a key has leaked and must stop working now.",
      inputSchema: { user_email: z.string(), platform: z.string() },
    },
    // The other half of admin_set_credential, which had none. An operator could put a key
    // into the store on someone's behalf and nothing could ever take it out again: only the
    // person themselves could, through delete_my_credential, which is no use once they have
    // left — and deactivating a principal stops them authenticating without touching the key
    // the platform goes on injecting on their behalf.
    async ({ user_email, platform }) => {
      const denied = operatorOnly();
      if (denied) return text(denied);
      const addr = user_email.trim().toLowerCase();
      if (!addr) return text("ERROR: user_email is required");
      const had = await withCredentials((data) => {
        if (!data[addr]?.[platform]) return false;
        delete data[addr][platform];
        if (Object.keys(data[addr]).length === 0) delete data[addr];
        return true;
      });
      if (had) logEvent({ actor: caller().email, kind: "credential.admin_delete", subject: `${addr}:${platform}` });
      return text(had
        ? `removed ${addr}'s ${platform} key — their ${platform} calls stop authenticating immediately`
        : `${addr} had no ${platform} key stored`);
    },
  );

  // People, teams, tokens, the registry and the projections — registered by role, guarded
  // per call. admin.ts owns both halves of that; this is the only place it is mounted.
  registerAdminTools(server, id);

  return server;
}
