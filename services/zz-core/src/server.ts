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
import { addressResolver, peerAddress } from "@zz/contracts";
import { serveMcp, serviceVersion, text } from "@zz/mcp-http";
import express from "express";

import { reindexAllTeams } from "./indexing.js";
import { coreServer } from "./orientation.js";
import { db } from "./platform-db.js";
import { Refusal } from "./refusal.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerPluginEvalTools } from "./tools/plugin-eval.js";
import { registerPluginJudgeTools } from "./tools/plugin-judge.js";
import { registerPluginRecordTools } from "./tools/plugin-record.js";
import { registerInitiativeActTools } from "./tools/initiative-acts.js";
import { registerInitiativeStatusTools } from "./tools/initiative-status.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSkillTools } from "./tools/skills.js";





















// Deterministic document-chain guardrail: downstream documents cannot be
// written while their gate document is unapproved. Prose rules get skipped
// under load; this one is code (our own R7 applied to ourselves).
// THE CHAIN COMES FROM THE INSTALLED FLOW'S MANIFEST (flow.json): the
// platform enforces whatever discipline the flow declares — not ours.
// The manifest type is CatalogManifest, from @zz/contracts, and it is used under that name.
// It was a two-field local view of catalog/<owner>/<flow>/flow.json — the same file the
// gateway read through a type of its own with a different set of fields, one file described
// in two places, each blind to what the other used. `type CatalogManifest = CatalogManifest`
// survived that fix as a second name for the same thing, which is the smaller version of the
// same problem.

// Multiple flows coexist on one server: an initiative declares its flow in
// the envelope (`flow:` frontmatter), and the chain enforced on it is THAT
// flow's manifest, resolved from the catalog. An initiative that declares none
// gets no chain, and flowDeclarationCheck refuses the write when the team runs
// more than one flow — there is no default to fall back to, and the three
// comments that said there was described a plugin mount this deployment has
// not had for some time.

















































/** WE ARE A BLOCK TOO, and until now the only one that could not be measured.
 *
 * `zz.block` has carried a row for us since migration 024, which said why in as many words:
 * our MCP "is not a block in the zz-blocks sense and never will be — but it IS an MCP surface
 * like any other". What it did not do was record a VERSION, so `eval_block_surface('platform')`
 * answered "no recorded surface" and the one instrument this platform has for judging a tool
 * surface could be pointed at everybody except us.
 *
 * Every other block is measured by probing it, because its surface is somebody else's to
 * declare. Ours is declared right here, by the registerTool calls above — so this is not an
 * estimate of our surface, it IS our surface, and it cannot drift from what we serve.
 *
 * Recorded per SERVICE VERSION, which is what makes "what moved" answerable: two releases
 * leave two rows, and `eval_block_surface` diffs the newest against the one before. A version
 * that has already been recorded is left alone rather than rewritten — the row means "this is
 * what that version served", and editing it would make the history agree with today by
 * construction, which is the one thing a history must not do. */
async function recordOwnSurface(): Promise<void> {
  const p = db();
  if (!p) return;                       // no platform database: nothing to record into
  const version = serviceVersion(import.meta.url);
  try {
    const { rows } = await p.query<{ id: string }>(
      `insert into zz.block_version (block_id, version)
       select b.id, $1 from zz.block b where b.name = 'platform'
       on conflict (block_id, version) do nothing
       returning id::text as id`, [version]);
    // Already recorded: this version's surface is not written twice, and not edited.
    if (!rows[0]) return;
    const names = [...OWN_TOOLS].sort();
    for (const name of names) {
      await p.query(
        `insert into zz.block_tool (block_version_id, name) values ($1::uuid, $2)
         on conflict do nothing`, [rows[0].id, name]);
    }
    console.log(`recorded our own surface as platform ${version}: ${names.length} tools`);
  } catch (err) {
    // NEVER FATAL. This is the platform describing itself for a measurement nobody is waiting
    // on; a service that refuses to start because it could not write its own metrics has
    // mistaken the instrument for the work.
    console.error("could not record our own surface:", err instanceof Error ? err.message : err);
  }
}

const OWN_TOOLS = new Set<string>();

function buildServer(): McpServer {
  // WHAT THIS DOOR SAYS ABOUT ITSELF, from orientation.ts — the `instructions` a client is
  // handed at `initialize`, before it has called anything. It is constructed there rather
  // than inline here so that a check can build the same server and read the handshake back
  // through a real client; this file cannot be imported, because it binds :8000 below.
  const server = coreServer(serviceVersion(import.meta.url));

  // A THROWN `Refusal` BECOMES `text(message)`, FOR EVERY TOOL, IN ONE PLACE.
  //
  // The SDK already catches whatever a handler throws and answers `isError: true` with the
  // raw `Error#message` — so this is not a rescue from a crash, it is the difference between
  // that generic shape and this file's own "ERROR: …" refusal shape, which is what every
  // OTHER refusal in this file already returns and what the gateway's own refusal-counting
  // (tool-telemetry's `/^ERROR\b/` check, knowledge_reconcile()'s comment about counting by refusal
  // TEXT) already expects to see.
  //
  // Patched on the INSTANCE, not renamed at each of the 28 call sites below: a gate check
  // (`a path is resolved before the document at it is judged`, scripts/gate.mjs) splits this
  // file's source on the literal string `server.registerTool(` to find each tool's body, so
  // every one of those call sites has to keep reading exactly that. The cast is confined to
  // this one assignment; every `server.registerTool(name, config, cb)` call below is still
  // checked against the SDK's own generic signature, because TypeScript resolves the call
  // against the declared type of the property, not the value assigned to it at runtime.
  type RegisterTool = typeof server.registerTool;
  const rawRegisterTool: RegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: RegisterTool }).registerTool = ((
    name: string, config: unknown, cb: (...a: unknown[]) => unknown,
  ) => {
    // OUR OWN SURFACE, RECORDED AS IT IS DECLARED. Every other block is measured by probing
    // it — we do not have to guess at ours, because this is the line that creates it.
    OWN_TOOLS.add(name);
    return rawRegisterTool(name, config as never, (async (...args: unknown[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        if (err instanceof Refusal) return text(err.message);
        throw err; // not ours to soften — a genuine bug stays exactly as loud as it is today
      }
    }) as never);
  }) as RegisterTool;
  // THE DOORS, in the order their tools are registered.
  registerPluginEvalTools(server);
  registerPluginJudgeTools(server);
  registerPluginRecordTools(server);
  registerSkillTools(server);
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
app.listen(8000, "0.0.0.0", () => {
  console.log("zz-core (TS) listening on :8000 (/mcp)");
  // The files are the truth and this index is derived, so it is rebuilt from them at boot.
  // Not awaited: the service serves while it runs, and a partial index beats a dead port.
  void reindexAllTeams().catch((err: unknown) => console.error("boot reindex failed:", err));
  // ONE THROWAWAY SERVER, TO LEARN OUR OWN SURFACE. The doors are stateless, so buildServer
  // runs per request and nothing had ever run it by the time the process was ready — leaving
  // the set of registered names empty at exactly the moment we want to record it. Building one
  // here fills it from the same code path every request uses, so what we record is what we
  // serve rather than a second list that could disagree.
  void (async () => { buildServer(); await recordOwnSurface(); })()
    .catch((err: unknown) => console.error("surface record failed:", err));
});
