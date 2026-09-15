/**
 * The access door: the tools a person uses on their own account.
 *
 * Their keys, their access tokens, which team they act for, and the client package that
 * installs the platform into their terminal. It is a door of its own rather than part of
 * /core because every tool here acts on the CALLER rather than on a team's work — and
 * because an agent that never needs to change anybody's credentials should not be carrying
 * tools that can.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mask } from "@zz/contracts";
import { ARTIFACTS_DIR, reindexAllTeams, reindexTeam, type TeamReindex } from "@zz/indexing";
import { serviceVersion, text } from "@zz/mcp-http";
import { z } from "zod";

import { registerAdminTools } from "./admin.js";
import { beginAuthorization, disconnectBlock } from "./block-oauth.js";
import { PLATFORMS } from "./blocks.js";
import { caller, deleteMyCredentialFor, implausibleKey, myCredentialsFor, operatorOnly, setMyCredentialFor, withCredentials } from "./credentials.js";
import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";
import { callerIdentity, isSuper } from "./identity.js";
import { myTeamsSummary } from "./settings.js";
import { registerBugAdminTools } from "./admin/bugs.js";
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
    "block_connect",
    {
      description:
        "WHEN somebody wants to use a building block as themselves rather than through a " +
        "shared key. RETURNS a single-use consent link: they sign in at the block, choose " +
        "what to grant, and come back — afterwards their calls to that block carry their own " +
        "access, with no key to create, copy or keep. REFUSES a block this platform does not " +
        "know, and a block with no sign-in configured, naming it either way; for those, a " +
        "key stored with credential_set is the only route.",
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
    "block_disconnect",
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
        "WHEN someone says they want to revoke a block, or before re-connecting as a " +
        "different account: deletes YOUR OWN delegated access, so the platform can no longer " +
        "act as you there. RETURNS whether there was a connection to remove — the front " +
        "end's own Revoke button does NOT do this, it only clears the front end's copy. " +
        "REFUSES a block this platform does not know, and it never touches anybody else's " +
        "connection or a stored key. Reconnect any time with block_connect.",
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
          "settings in the front end, or with block_connect."
        : `You had no connection to ${block} to remove. If calls to it are working, they are ` +
          "using a stored key rather than your own sign-in.");
    },
  );

  server.registerTool(
    "platform_list",
    {
      description:
        "WHEN you need to know what to name in credential_set or block_connect. RETURNS " +
        "every building-block platform this gateway knows, id to display name. Takes no " +
        "arguments and REFUSES nothing — it reads the gateway's own configuration and says " +
        "nothing about which of them your team has been granted.",
      inputSchema: {},
    },
    async () =>
      text(JSON.stringify(Object.fromEntries(Object.entries(PLATFORMS).map(([id, p]) => [id, p.name])))),
  );

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
    "credential_set",
    {
      description:
        "WHEN a building block needs a key and it should be YOURS rather than a shared one — " +
        "the route for blocks that cannot do block_connect. RETURNS the key masked, and says " +
        "so when it REPLACED one you already had, because that one is then gone. REFUSES a " +
        "platform this gateway does not know (see platform_list) and a key too short or too " +
        "plain to be real; it never reads back a stored key and never touches anybody " +
        "else's.",
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
    "credential_list",
    {
      description:
        "WHEN you need to know whether a block will authenticate as you before calling it. " +
        "RETURNS which platforms you have stored a personal key for, every key masked. " +
        "REFUSES to show a key's value — masked is all there is, here or anywhere — and it " +
        "answers only about you, never about another person's keys.",
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
            : { status: "no credentials stored yet — use credential_set" },
        ),
      );
    },
  );

  server.registerTool(
    "credential_delete",
    {
      description:
        "WHEN a key of yours has leaked, or you no longer want this platform authenticating " +
        "as you. RETURNS whether there was a key to remove. REFUSES a request it cannot " +
        "identify, and it reaches only your own keys: removing somebody else's is " +
        "credential_admin_delete, which needs an operator.",
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

  if (sup) server.registerTool(
    "credential_admin_set",
    {
      description:
        "WHEN onboarding somebody, or a batch of people, who cannot store their own key yet. " +
        "RETURNS the key masked, and says loudly when it REPLACED that person's working key, " +
        "because on a batch run that line scrolls past. REFUSES anyone but an operator, an " +
        "unknown platform, a key too short or too plain to be real, and — the one that bit — " +
        "an address that is not an active principal, since a key filed under an address " +
        "nobody has can never be injected for anyone.",
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
          return text(`ERROR: '${addr}' is not an active platform member — person_add first. ` +
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
      // Whether it replaced one, for the same reason credential_set says it — and more
      // sharply here, because this is the batch path and the key being overwritten is
      // somebody else's working credential, on a run of many where one line scrolls past.
      return text(`stored ${platform} key for ${addr} (${mask(key)})` +
                  (replaced ? ` — REPLACED their previous key (${replaced}), which is gone` : ""));
    },
  );

  if (sup) server.registerTool(
    "credential_admin_delete",
    {
      description:
        "WHEN someone leaves, or a key has leaked and must stop working now. RETURNS whether " +
        "that person had a key to remove; if they did, their calls to that block stop " +
        "authenticating immediately. REFUSES anyone but an operator. Deactivating a " +
        "principal does NOT do this — it stops them authenticating while the platform goes " +
        "on injecting the key on their behalf.",
      inputSchema: { user_email: z.string(), platform: z.string() },
    },
    // The other half of credential_admin_set, which had none. An operator could put a key
    // into the store on someone's behalf and nothing could ever take it out again: only the
    // person themselves could, through credential_delete, which is no use once they have
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

  // ── the bugs people report ─────────────────────────────────────────────────────────────
  //
  // Moved to ./admin/bugs.ts when `bug_delete` joined them and this file reached the 700-line
  // ceiling. A tracker is its own subject: filing is everyone's and lives on /core, while
  // reading, closing and removing a report are operator acts and live here.
  registerBugAdminTools(server, sup);


  // ── rebuilding a team's knowledge index ────────────────────────────────────────────────
  //
  // THIS TOOL USED TO BE ON /core, and it was on the wrong door. Every other tool on /core is
  // a step somebody takes inside their own team's work; this one repairs a derived table, for
  // a team the caller need not be in, and the cases it exists for — a store restored from a
  // backup, a deployment whose indexer changed what a row means — are an operator's morning,
  // not a flow's stage. On /core it was also team-scoped by construction: it rebuilt the
  // CALLER's team and there was no way to reach anyone else's, so the one situation that
  // actually produces it, a restore across the whole deployment, had to be done by asking one
  // person from each team to run it.
  //
  // It could not move until Task I-38, because the indexer lived inside zz-core and the
  // gateway cannot import a service. `@zz/indexing` is that extraction; both services import
  // the same `reindexTeam`, and there is no second copy to drift.
  //
  // READ-ONLY ON THE STORE is why this works from here at all: the gateway mounts /artifacts
  // `:ro` (deploy/docker-compose.yml), and a rebuild only READS files and WRITES rows.
  if (sup) server.registerTool(
    "knowledge_reindex",
    {
      description:
        "Rebuild a team's knowledge index from its files, which are the source of truth. WHEN " +
        "a store has been restored from a backup, edited outside the platform's tools, or a " +
        "search returns a document whose file is gone — and after a release that changes what " +
        "an index row means, with force. RETURNS one line per team: files scanned, rows " +
        "re-indexed, stale rows removed. Omit `team` and it walks EVERY team on the " +
        "deployment, which is what a restore needs. REFUSES anyone but a superadmin, and " +
        "refuses a team slug no team on this deployment carries — naming the slug it was " +
        "given, because an unknown team is a typo and rebuilding nothing would look " +
        "identical to rebuilding a team that had nothing to do. Cheap: unchanged files are " +
        "skipped by content hash, so a walk over a settled corpus costs one SELECT per file.",
      inputSchema: {
        team: z.string().optional().describe(
          "The team slug to rebuild. Omit to rebuild every team on the deployment."),
        force: z.boolean().optional().describe(
          "Re-derive every row even where the stored hash says nothing changed. Needed when " +
          "the DERIVATION changed and left rows the current logic would not produce."),
      },
    },
    async ({ team, force }) => {
      if (!platformDbReady()) return text("ERROR: knowledge index unavailable (no platform db)");
      // THE STORE HAS TO BE MOUNTED, and this gateway is the half of the deployment where it
      // might not be. The indexer treats a missing teams/ directory as "the volume is not
      // mounted, touch nothing" — deliberately, because the alternative is one boot emptying
      // the whole index — and returns the same shape it returns for a team that had nothing
      // to do. Without this line those two answers are the same sentence to the person
      // asking: "nothing had changed", on a gateway that could not see a single file.
      if (!existsSync(join(ARTIFACTS_DIR, "teams"))) {
        return text(`ERROR: the artifact store is not mounted at ${ARTIFACTS_DIR} on this ` +
                    "gateway, so there are no files to rebuild the index from and NOTHING WAS " +
                    "REBUILT. deploy/docker-compose.yml mounts it read-only on this service; " +
                    "a deployment that dropped that volume has to put it back.");
      }
      const line = (r: TeamReindex) =>
        (r.error
          ? `${r.team}: FAILED — ${r.error}`
          : `${r.team}: ${r.scanned} files scanned, ${r.indexed} re-indexed, ${r.removed} stale row(s) removed` +
            (r.indexed === 0 && r.removed === 0 ? " (nothing had changed)" : ""));
      // NO `team` MEANS EVERY TEAM, and the walk that finds them is the package's, not one
      // spelled again here: the list is the union of the store directories and the slugs the
      // index already believes in, and a team whose store was deleted appears only in the
      // second. Rebuilding from the directories alone would silently never visit the one team
      // that needs its rows cleaned.
      if (team === undefined) {
        const all = await reindexAllTeams(force === true);
        if (!all.length) return text("no team has a store on this deployment — nothing to rebuild");
        return text(`knowledge index rebuilt for ${all.length} team(s):\n` +
                    all.map(line).join("\n"));
      }
      // A SLUG THAT NAMES NO TEAM IS REFUSED BY NAME, and this is the guard that makes the
      // named form safe to run. reindexTeam's contract for a team with no store directory is
      // to DELETE that team's rows — correct for a team that was archived, and catastrophic
      // for a typo, which has no directory either. Without this the two are the same call.
      const slug = team.trim();
      const known = await platformDb().query<{ slug: string }>(
        "select slug from team where slug = $1", [slug]);
      if (!known.rowCount) {
        return text(`ERROR: no team on this deployment is called '${slug}' — ` +
                    "team_list shows the slugs. Omit `team` to rebuild every one of them.");
      }
      const r = await reindexTeam(slug, force === true);
      return text(`knowledge index rebuilt for ${line({ team: slug, ...r })}`);
    },
  );

  // People, teams, tokens, the registry and the projections — registered by role, guarded
  // per call. admin.ts owns both halves of that; this is the only place it is mounted.
  registerAdminTools(server, id);

  return server;
}
