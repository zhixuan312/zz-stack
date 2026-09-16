/**
 * zz-core — process-layer MCP server: the shared zz skills library and the
 * team/per-user artifact store. Deliberately separate from the
 * building-block servers so their tool surfaces stay pure for profiling
 * during zz-select. Skills are read from /skills (the platform's own usage
 * skills), from every flow in /catalog that the caller's team has installed,
 * and from the team's own store — so a flow installed today serves without a
 * restart. See allSkillRoots for the order, which decides which of two skills
 * of one name answers.
 *
 * When TEAM_DB_URL is set (the platform database), members of one team share
 * ONE team artifact store at
 * /artifacts/teams/<group-name>. Membership is read live from the
 * zz.membership table, so an admin manages teams entirely through the platform
 * UI. Unset -> per-user stores (local dev).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pluginForDoor } from "@zz/catalog";
import { addressResolver, peerAddress } from "@zz/contracts";
import { reindexAllTeams } from "@zz/indexing";
import { serveMcp, serviceVersion } from "@zz/mcp-http";
import express from "express";

import { OWN_TOOLS, recordingDoor } from "./door.js";
import { buildEvalServer } from "./eval-door.js";

import { coreServer } from "./orientation.js";
import { db } from "./platform-db.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerBugTools } from "./tools/bugs.js";
import { registerInitiativeActTools } from "./tools/initiative-acts.js";
import { registerInitiativeStatusTools } from "./tools/initiative-status.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSkillTools } from "./tools/skills.js";
/** WE ARE A BLOCK TOO, and until now the only one that could not be measured.
 *
 * `zz.block` has carried a row for us since migration 024, which said why in as many words:
 * our MCP "is not a block in the zz-blocks sense and never will be — but it IS an MCP surface
 * like any other". What it did not do was record a VERSION, so a surface report about
 * `platform` answered "no recorded surface" and the one instrument this platform has for
 * judging a tool surface could be pointed at everybody except us.
 *
 * Every other block is measured by probing it, because its surface is somebody else's to
 * declare. Ours is declared by the registerTool calls themselves, on EVERY door this service
 * serves: `recordingDoor` in door.ts is what both builders wrap their server in, and it adds
 * each name to OWN_TOOLS at the moment that tool is declared. So this is not an estimate of
 * our surface, it IS our surface, and it cannot drift from what we serve.
 *
 * TWO DOORS, AND THE RECORD SAYS WHICH. Both doors are built below before this runs, so the set
 * of names is complete — and each name carries the door that registered it, because
 * `recordingDoor` is handed one. That is the whole of migration 052 and it closes a failure
 * worse than a gap: with names alone, ten tools moving from this door to the evaluation door
 * left the recorded name set IDENTICAL, so a surface diff answered NO CHANGE across the largest
 * surface change this platform has had. An instrument that says "nothing moved" about the thing
 * that moved is not silent, it is wrong in the direction nobody checks. `zz-tool plugin-surface`
 * is the reader; it reports a move as a move, and a version recorded before 052 as one whose
 * doors were never written rather than as a core door it can only have guessed at.
 *
 * Recorded per SERVICE VERSION, which is what makes "what moved" answerable: two releases
 * leave two rows, and `zz-tool plugin-surface` diffs the newest against the one before. A version
 * that has already been recorded is left alone rather than rewritten — the row means "this is
 * what that version served", and editing it would make the history agree with today by
 * construction, which is the one thing a history must not do. */
async function recordOwnSurface(): Promise<void> {
  const p = db();
  if (!p) return;                       // no platform database: nothing to record into
  const version = serviceVersion(import.meta.url);
  try {
    // PER PLUGIN, NOT PER SERVICE, and that is the correction. This recorded every tool this
    // process serves under one registry row named `platform` — so the ten evaluation tools,
    // which belong to zz-plugin-eval and arrive only with that plugin, were filed as the
    // platform's own. A door IS a plugin's declared server, so the door each tool registered
    // on already says whose it is, and `recordingDoor` captured that at the moment of
    // registration.
    //
    // ATTACHED TO A VERSION SOMEBODY ELSE WROTE. `register-plugins` creates zz.plugin_version
    // at release, from the lock, with the digest that vouches for the content. This only ever
    // attaches tools to a row that already exists: a version nobody has released has no
    // surface to record, and inventing the row here would put a version in the registry with
    // no digest behind it.
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
      if (!rows[0]) continue;           // this version is not in the registry yet
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
    // NEVER FATAL. This is the platform describing itself for a measurement nobody is waiting
    // on; a service that refuses to start because it could not write its own metrics has
    // mistaken the instrument for the work.
    console.error("could not record our own surface:", err instanceof Error ? err.message : err);
  }
}

function buildServer(): McpServer {
  // WHAT THIS DOOR SAYS ABOUT ITSELF, from orientation.ts — the `instructions` a client is
  // handed at `initialize`, before it has called anything. It is constructed there rather
  // than inline here so that a check can build the same server and read the handshake back
  // through a real client; this file cannot be imported, because it binds :8000 below.
  //
  // `recordingDoor` is what makes a thrown `Refusal` arrive in our refusal shape and what
  // fills OWN_TOOLS as each tool is declared. It lives in door.ts because the evaluation
  // door needs exactly the same thing and a second copy of it would drift — see that file.
  // "core" is the gateway's own name for this door — `doorSurface("/core/mcp")` — and it is
  // what lands in zz.block_tool.door beside every name registered below.
  const server = recordingDoor(coreServer(serviceVersion(import.meta.url)), "core");
  // THE TOOL MODULES THIS DOOR SERVES, in the order they are registered. The ten `plugin_*`
  // tools are NOT among them any more: they are the zz-plugin-eval flow's own instrument and
  // they are served by eval-door.ts, on the door that flow declares. This door is what every
  // account on the platform carries, so what is registered here is what everybody gets.
  registerSkillTools(server);
  // The version is handed in rather than read inside: the tool records which platform somebody
  // was talking to, and the one place that knows is the line above that built the server.
  registerBugTools(server, serviceVersion(import.meta.url));
  registerArtifactTools(server);
  registerKnowledgeTools(server);
  registerInitiativeStatusTools(server);
  registerInitiativeActTools(server);
  return server;
}

// zz-core serves ONE thing: the MCP endpoint. Every tool reads the caller from the
// forwarded identity headers and checks it.
//
// Those headers are CLAIMED, not proved. What makes that safe is that exactly one peer may
// assert them: the gateway, which authenticates every caller by their own token and then
// overwrites these headers with the identity it resolved.
//
// The front end used to be the second such peer, connecting here directly and asserting the
// identity of whoever was logged into it. It no longer is — LibreChat holds no platform
// identity and reaches zz-core the same way Claude Code and Codex do, through the gateway
// with the caller's own PAT. One authenticator, one door, and a front end that cannot claim
// to be anybody.
//
// It also used to serve /browse — an unauthenticated read-only artifact browser, rooted at
// /artifacts, which is the directory ABOVE teams/. Any container on the compose network
// could read every team's documents, knowledge nodes and activity logs with no credential:
// verified from a neighbouring container, which listed both team directories. The port is
// published to 127.0.0.1 on the host, so this was never open to the internet, but "not
// reachable from outside" is not the same as "authenticated", and the MCP endpoint on the
// SAME PORT enforced identity while this did not.
//
// It described itself as interim "until the real web frontend exists". That frontend
// exists: the gateway serves /app, behind a PAT, scoped to the caller's own team, with
// search and sources. Two viewers of one store, one of them with no idea who is asking.

/** Who may assert an identity to this port.
 *
 * Every tool reads the caller from the forwarded identity header and trusts it. The one
 * legitimate caller is the gateway, which overwrites that header with the identity it
 * authenticated — but nothing checked that the peer WAS the gateway. A throwaway container
 * on the compose network was answered 200 to `initialize` while claiming to be a named
 * person: read and write access to every document that person can reach, with no
 * credential. Verified, then closed.
 *
 * The mechanism is the gateway's own, for the same decision: the peer's address must be one
 * the trusted hostnames resolve to. No secret to distribute and nothing to keep in step. If
 * DNS cannot answer, this refuses rather than guessing — for the same reason the gateway
 * does, and with the same consequence if it is wrong, which is that the gateway could not
 * have resolved this host either. */
const TRUSTED_PEERS = (process.env.TRUSTED_PEERS || "cred-proxy")
  .split(",").map((h) => h.trim()).filter(Boolean);
// The resolver itself is @zz/contracts', which is what the paragraph above means by "the
// mechanism is the gateway's own": it was the gateway's own AND a second copy of it, cache,
// IPv4-mapped fold and all. What stays here is the policy — which hosts, and 403 on null.
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
// THE SECOND DOOR, on the same port and in the same process. The gateway publishes it as
// /eval/mcp and forwards here; see eval-door.ts for why the ten `plugin_*` tools are behind a
// door of their own rather than on the one every account carries.
serveMcp(app, "/eval-mcp", buildEvalServer);
app.listen(8000, "0.0.0.0", () => {
  console.log("zz-core (TS) listening on :8000 (/mcp /eval-mcp)");
  // The files are the truth and this index is derived, so it is rebuilt from them at boot.
  // Not awaited: the service serves while it runs, and a partial index beats a dead port.
  void reindexAllTeams().catch((err: unknown) => console.error("boot reindex failed:", err));
  // ONE THROWAWAY SERVER PER DOOR, TO LEARN OUR OWN SURFACE. The doors are stateless, so a
  // builder runs per request and nothing had ever run one by the time the process was ready —
  // leaving the set of registered names empty at exactly the moment we want to record it.
  // Building one of each here fills it from the same code path every request uses, so what we
  // record is what we serve rather than a second list that could disagree.
  //
  // BOTH, NOT JUST THE FIRST. Our recorded surface is the whole platform's, and building only
  // the core door would have recorded a platform that serves ten fewer tools than it does —
  // `zz-tool block-surface platform` would then report ten tools DELETED in the release that
  // merely moved them, which is worse than no measurement because it reads as a finding.
  void (async () => { buildServer(); buildEvalServer(); await recordOwnSurface(); })()
    .catch((err: unknown) => console.error("surface record failed:", err));
});
