/**
 * zz-core — process-layer MCP server: the shared zz skills library and the team/per-user
 * artifact store. Skills are read from /skills (the platform's own skills), from every package
 * in /catalog, and from the team's own store, so a package synced today serves without a
 * restart. See allSkillRoots for the order, which decides which of two skills of one name
 * answers.
 *
 * When TEAM_DB_URL is set (the platform database), members of one team share one team artifact
 * store at /artifacts/teams/<group-name>. Membership is read live from the zz.membership table.
 * Unset -> per-user stores (local dev).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pluginForDoor } from "@zz/catalog";
import { addressResolver, parseCaller, peerAddress } from "@zz/contracts";
import { reindexAllTeams } from "@zz/indexing";
import { requestHeaders, serveMcp, serviceVersion } from "@zz/mcp-http";
import express from "express";

import { OWN_TOOLS, recordingDoor } from "./door.js";
import { buildEvalServer } from "./eval-door.js";
import { refuseIssuanceOnDoors, reviewedModuleHost,
         type ReviewedModuleHost } from "./host/index.js";
import { packagedModules } from "./reviewed-modules.js";

import { coreServer } from "./orientation.js";
import { db } from "./platform-db.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerAssessTool } from "./tools/assess.js";
import { registerBugAdminTools, registerBugTools } from "./tools/bugs.js";
import { registerInitiativeActTools } from "./tools/initiative-acts.js";
import { registerInitiativeStatusTools } from "./tools/initiative-status.js";
import { registerKnowledgeIndexTools } from "./tools/knowledge-index.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSkillTools } from "./tools/skills.js";
/** Records this service's own tool surface.
 *
 * The surface is declared by the registerTool calls themselves, on every door this service
 * serves: `recordingDoor` in door.ts is what both builders wrap their server in, and it adds
 * each name to OWN_TOOLS at the moment that tool is declared, so this is our surface rather
 * than an estimate of it.
 *
 * Both doors are built below before this runs, so the set of names is complete, and each name
 * carries the door that registered it. With names alone, a tool moving from one door to the
 * other leaves the recorded name set identical and a surface diff reports no change.
 * `zz-tool plugin-surface` is the reader.
 *
 * Recorded per service version: two releases leave two rows, and `zz-tool plugin-surface` diffs
 * the newest against the one before. DELIBERATE: a version already recorded is left alone
 * rather than rewritten — the row means "this is what that version served". */
async function recordOwnSurface(): Promise<void> {
  const p = db();
  if (!p) return;                       // no platform database: nothing to record into
  const version = serviceVersion(import.meta.url);
  try {
    // Per plugin, not per service: the evaluation tools belong to zz-plugin-eval and
    // arrive only with that plugin, so one registry row named `platform` would file them as the
    // platform's own. A door is a plugin's declared server, so the door each tool registered on
    // says whose it is.
    //
    // Attached to a version somebody else wrote. `register-plugins` creates zz.plugin_version
    // at release, from the lock, with the digest that vouches for the content. This only ever
    // attaches tools to a row that already exists: inventing the row here would put a version
    // in the registry with no digest behind it.
    const byDoor = new Map<string, string[]>();
    for (const [name, door] of OWN_TOOLS) {
      const plugin = pluginForDoor(door);
      if (!plugin) continue;            // a door no manifest claims: never guessed at
      (byDoor.get(plugin) ?? byDoor.set(plugin, []).get(plugin)!).push(name);
    }
    const recorded: string[] = [];
    for (const [plugin, names] of byDoor) {
      const { rows } = await p.query<{ id: string }>(
        `select pv.id::text as id from zz.plugin_version pv
           join zz.plugin pl on pl.id = pv.plugin_id
          where pl.name = $1 and pv.version = $2`, [plugin, version]);
      if (!rows[0]) {
        // Loud: this service must boot after the release registers the version. Boot before
        // that and the row is absent, this skips, and nothing runs again, so the release
        // records no surface at all.
        console.warn(`no zz.plugin_version row for ${plugin} ${version} — its tool surface was ` +
                     "not recorded. register-plugins creates that row at release; this service " +
                     "must boot after it, not before.");
        continue;
      }
      for (const name of names.sort()) {
        await p.query(
          `insert into zz.plugin_tool (plugin_version_id, name, door) values ($1::uuid, $2, $3)
           on conflict (plugin_version_id, name) do nothing`,
          [rows[0].id, name, OWN_TOOLS.get(name)]);
      }
      recorded.push(`${plugin}=${names.length}`);
    }
    if (recorded.length) console.log(`recorded our own surface at ${version}: ${recorded.join(" ")}`);
  } catch (err) {
    // Never fatal: this is the platform describing itself for a measurement nobody is waiting
    // on, so a failure here must not stop the service starting.
    console.error("could not record our own surface:", err instanceof Error ? err.message : err);
  }
}

/** `everything` builds every role's registrations, for boot recording of our own surface.
 *
 * The doors are stateless, so this builder runs once per request and reads the caller's role
 * from the request the way /manage does. At boot there is no request: the role reads as absent,
 * every role-gated tool goes unregistered, and the surface recorded is the one a member sees —
 * so a release that merely gated a tool would be reported as having deleted it. What a version
 * serves is its whole surface. */
function buildServer(everything = false): McpServer {
  // What this door says about itself, from orientation.ts — the `instructions` a client is
  // handed at `initialize`, before it has called anything. It is constructed there rather than
  // inline here so that a check can build the same server and read the handshake back through a
  // real client; this file cannot be imported, because it binds :8000 below.
  //
  // `recordingDoor` makes a thrown `Refusal` arrive in our refusal shape and fills OWN_TOOLS as
  // each tool is declared. COUPLED: eval-door.ts wraps its server in the same function.
  // "core" is the gateway's own name for this door — `doorSurface("/core/mcp")` — and it is
  // what lands in zz.plugin_tool.door beside every name registered below.
  const server = recordingDoor(coreServer(serviceVersion(import.meta.url)), "core");
  // The tool modules this door serves, in the order they are registered. The evaluation tools
  // are not among them: they are the zz-plugin-eval flow's own instrument, served by
  // eval-door.ts on the door that flow declares. This door is what every account on the
  // platform carries.
  //
  // Who is calling, resolved before the first tool is registered. The gateway forwards
  // `x-zz-user-role` on every proxied request and `parseCaller` reads it; `admin` is what
  // identity.ts sets for a superadmin.
  //
  // Role picks which tools you see; the door is picked by subject. A bug is one subject, so
  // filing one and answering one are on the same door.
  const sup = everything || parseCaller(requestHeaders()).role === "admin";
  registerSkillTools(server);
  // The version is handed in rather than read inside: the tool records which platform somebody
  // was talking to, and the one place that knows is the line above that built the server.
  registerBugTools(server, serviceVersion(import.meta.url));
  registerBugAdminTools(server, sup);
  registerArtifactTools(server);
  registerKnowledgeTools(server);
  registerKnowledgeIndexTools(server, sup);
  registerInitiativeStatusTools(server);
  registerInitiativeActTools(server);
  registerAssessTool(server);
  return server;
}

// zz-core serves one thing: the MCP endpoint. Every tool reads the caller from the forwarded
// identity headers and checks it.
//
// Those headers are claimed, not proved. What makes that safe is that exactly one peer may
// assert them: the gateway, which authenticates every caller by their own token and then
// overwrites these headers with the identity it resolved.

/** Who may assert an identity to this port.
 *
 * Every tool reads the caller from the forwarded identity header and trusts it, so the peer
 * itself is checked here: the one legitimate caller is the gateway, which overwrites that
 * header with the identity it authenticated.
 *
 * The mechanism is the gateway's own: the peer's address must be one the trusted hostnames
 * resolve to. No secret to distribute and nothing to keep in step. If DNS cannot answer, this
 * refuses rather than guessing. */
const TRUSTED_PEERS = (process.env.TRUSTED_PEERS || "cred-proxy")
  .split(",").map((h) => h.trim()).filter(Boolean);
// The resolver itself is @zz/contracts', cache, IPv4-mapped fold and all. What stays here is
// the policy — which hosts, and 403 on null.
const trustedPeerIps = addressResolver(TRUSTED_PEERS);

const app = express();
app.use((req, res, next) => {
  void (async () => {
    const addr = peerAddress(req.socket);
    const trusted = await trustedPeerIps();
    if (trusted && trusted.has(addr)) {
      next();
      return;
    }
    console.warn(`refused ${req.method} ${req.url} from ${addr || "an unknown peer"}`);
    res.status(403).json({ error: "not a trusted caller" });
  })();
});
app.use(express.json({ limit: "20mb" }));

serveMcp(app, "/mcp", buildServer);
// The second door, on the same port and in the same process. The gateway publishes it as
// /eval/mcp and forwards here; see eval-door.ts for why the evaluation tools are behind a
// door of their own rather than on the one every account carries.
serveMcp(app, "/eval-mcp", buildEvalServer);
// Reviewed modules are registered before the port opens, from the bodies this release packages
// and the allowlist that approves them. Registration is where an unapproved component, a
// caller-supplied body and an altered digest are refused, and this is the composition root: the
// one place that holds the catalogue.
//
// DELIBERATE: above `listen`, not inside its callback. A refusal here has to stop the process
// coming up; raised from the callback it would be thrown after the socket was already bound and
// accepting.
const reviewed: ReviewedModuleHost = reviewedModuleHost(packagedModules);
if (reviewed.registered.length) {
  console.log(`registered ${reviewed.registered.length} reviewed module(s): ` +
              reviewed.registered.map((e) => `${e.id}@${e.digest.slice(0, 12)}`).join(", "));
}

// One throwaway server per door, to learn our own surface. The doors are stateless, so a
// builder runs per request and nothing would have run one by the time the process is ready,
// leaving the set of registered names empty at the moment we want to record it. Building one of
// each fills it from the same code path every request uses.
//
// Both doors, not just the first: our recorded surface is the whole platform's, and building
// only the core door would record a platform that serves fewer tools than it does.
//
// `true` builds the widest surface, the one that includes the registrations a superadmin
// credential unlocks.
buildServer(true);
buildEvalServer();
// Above `listen`, for the reason the block before it gives. Grant issuance is reached from a
// trusted call after a stored controller decision and from nowhere else; a door that has
// registered it is reachable by a direct call from anybody that door admits, and no role,
// administrative ones included, confers the authority to mint authority. A process in that
// state must not come up.
refuseIssuanceOnDoors(OWN_TOOLS);

app.listen(8000, "0.0.0.0", () => {
  console.log("zz-core (TS) listening on :8000 (/mcp /eval-mcp)");
  // The files are the truth and this index is derived, so it is rebuilt from them at boot.
  // Not awaited: the service serves while it runs, and a partial index beats a dead port.
  void reindexAllTeams().catch((err: unknown) => console.error("boot reindex failed:", err));
  // The doors were built above, before the port opened, so OWN_TOOLS is already filled and
  // this only has to write it down. Recording stays here because it is a database write.
  void recordOwnSurface()
    .catch((err: unknown) => console.error("surface record failed:", err));
});
