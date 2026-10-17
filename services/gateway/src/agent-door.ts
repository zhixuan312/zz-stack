/**
 * The agent door: `POST /internal/agent-read/<tool>`, zz-core's way back to the console's reads.
 *
 * The core door offers `platform_status`, `release_list`, `activity_refusals`, `run_summary` and
 * `record_read` to every caller, and their values live here: each is a function of its caller and its
 * arguments that answers its page's DTO (console/agent-reads.ts), the function the page's own route
 * calls. zz-core cannot import them — a service never imports another — so its tools call this route
 * with `{ arguments }` and the identity headers it was forwarded, and the answer is that function's.
 *
 * What makes it safe is who may ask. It answers only a peer whose address is one `CORE_PEERS` resolves
 * to (default `zz-core`, the compose service), through the same resolver zz-core's own guard uses, and
 * refuses everyone else with 403 before the body is parsed or anything is read. The caller is the
 * identity zz-core received from this gateway, in the `x-zz-*` headers the identity middleware stamped
 * on the core door's request and nothing else: `callerIdentity` rebuilds the person from them through
 * the same principal lookup and `actingTeam` every other core tool acts by, and `isSuper` decides the
 * role on that whole identity, so a team-bound token is no platform authority here either. A peer that
 * already holds the database gains nothing by asking.
 *
 * DELIBERATE: mounted before the identity middleware, which would refuse zz-core (it carries no
 * credential), and not through `TRUSTED_FORWARD_HOST`, which lets one front end claim anyone on every
 * route; this door admits one peer to these reads. Caddy answers `/internal/*` with 404 on the public
 * host (deploy/Caddyfile), so a request from outside fails twice.
 *
 * Answers: 200 with the read's DTO, 400 `{ error }` for an input error (the read's own sentence),
 * 403 for a peer it does not trust or headers naming no active principal, 404 for a tool it does not
 * serve, 500 when the read fails.
 *
 * COUPLED: services/zz-core/src/tools/agent-reads.ts is the only caller; checks/core-agent-reads.ts
 * drives both halves.
 */
import { addressResolver, peerAddress } from "@zz/contracts";
import express from "express";

import { AGENT_READS } from "./console/agent-reads.js";
import { callerIdentity, isSuper } from "./identity.js";

/** The hosts whose calls this door answers. Set in compose, documented in deploy/.env.example. */
const CORE_PEERS = (process.env.CORE_PEERS || "zz-core")
  .split(",").map((h) => h.trim()).filter(Boolean);

/** Refuses with 403 any peer that is not one `peers` resolves to, before anything else runs.
 *
 * The resolver is @zz/contracts', cache, IPv4-mapped fold and all, as zz-core's TRUSTED_PEERS is.
 * An unresolvable host is null, and null refuses. */
function fromPeers(peers: readonly string[]): express.RequestHandler {
  const trustedIps = addressResolver(peers);
  return (req, res, next) => {
    void (async () => {
      const addr = peerAddress(req.socket);
      const trusted = await trustedIps();
      if (trusted && trusted.has(addr)) {
        next();
        return;
      }
      console.warn(`agent door: refused ${req.method} ${req.path} from ${addr || "an unknown peer"}`);
      res.status(403).json({ error: "not a trusted caller" });
    })().catch((err: unknown) => {
      console.error("agent door: the peer could not be checked:", err);
      if (!res.headersSent) res.status(403).json({ error: "not a trusted caller" });
    });
  };
}

/** Mounts the door, answering the hosts `peers` names: CORE_PEERS', unless a check hands in others. */
export function mountAgentDoor(app: express.Express, peers: readonly string[] = CORE_PEERS): void {
  app.post("/internal/agent-read/:tool", fromPeers(peers), express.json({ limit: "1mb" }), (req, res) => {
    void (async () => {
      const tool = req.params.tool;
      // Own keys only: `constructor` is on every object, and is no read.
      if (!Object.hasOwn(AGENT_READS, tool)) {
        res.status(404).json({ error: `no agent read ${tool}` });
        return;
      }
      const id = await callerIdentity(req.headers);
      if (!id) {
        res.status(403).json({ error: "the forwarded identity names no active principal" });
        return;
      }
      const args = (req.body as { arguments?: unknown } | undefined)?.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        res.status(400).json({ error: "arguments must be an object" });
        return;
      }
      const read = AGENT_READS[tool as keyof typeof AGENT_READS];
      const answer = await read({ email: id.email, superadmin: isSuper(id), activeTeam: id.activeTeam },
                                args as Record<string, unknown>);
      if ("inputError" in answer) {
        res.status(400).json({ error: (answer as { inputError: string }).inputError });
        return;
      }
      res.json(answer);
    })().catch((err: unknown) => {
      console.error(`agent door: ${req.params.tool} failed:`, err);
      if (!res.headersSent) res.status(500).json({ error: "the read failed" });
    });
  });
}
