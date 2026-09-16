/**
 * Proxying a block: the call itself, and what the gateway does and does not pass on.
 *
 * Three sets, and each is a refusal rather than a convenience. Hop-by-hop headers belong to
 * one connection and forwarding them corrupts the next. The caller's own Authorization and
 * Cookie never reach a block — a block is told nothing about who is calling, which is the
 * invariant the whole delegated-access design rests on. And a block's own transport headers
 * are stripped from the response, because they describe its connection and not ours.
 */
import { Readable } from "node:stream";

import express from "express";


const HOP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive",
  "transfer-encoding", "upgrade", "proxy-authorization",
]);
/** Headers that must NEVER leave this gateway, whatever the destination.
 *
 * `authorization` carries the caller's zz PAT. The /core proxy dropped it by naming it
 * inline; the BLOCK proxy did not, so every third-party platform a block points at
 * received a token that authenticates as that person against this platform: their
 * documents, their team's knowledge, their whole access. Verified by
 * pointing a block at an echo server, which received both its own X-API-Key and the PAT.
 *
 * A block is given exactly one credential: its own, injected below. Nothing about how the
 * caller proved who they are is any of its business.
 *
 * Naming it here rather than at each call site is the point — the /core proxy remembered
 * and the block proxy forgot, and there was nothing to notice the difference. */
export const NEVER_FORWARD = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Upstream response headers that must not reach the caller.
 *
 * The first four are hop-by-hop: this gateway re-frames the body, so passing them through
 * describes the wrong connection. `set-cookie` is here for a different reason — a block is
 * a THIRD PARTY, and its response is streamed to a browser session on our origin. A
 * compromised or merely careless block could set a cookie in the caller's context. Nothing
 * a block returns has any business establishing state with our client. */
const STRIP_RESPONSE = new Set([
  "content-length", "transfer-encoding", "content-encoding", "connection",
  "set-cookie", "set-cookie2",
]);
/** Relay an upstream response body to the caller, and SURVIVE it dying mid-stream.
 *
 * `.pipe()` does not forward errors. A Readable that errors with no `error` listener raises
 * an unhandled `error` event, and Node's default for that is `throw` — from an async socket
 * callback, where nothing can catch it. So when a block closed its socket mid-response
 * (`SocketError: other side closed`, routine for a long tool call against staging), the
 * whole proxy exited. It restarted twice in one afternoon, and each exit dropped EVERY
 * user's session, not the one request that failed — a flaky dependency taking down the
 * platform's front door.
 *
 * The two relays here were the only unguarded pipes, and both of them carry other people's
 * traffic. A truncated response to one caller is the correct blast radius. */
export function relayBody(body: unknown, res: express.Response, what: string): void {
  if (!body) { res.end(); return; }
  const src = Readable.fromWeb(body as never);
  src.on("error", (err: unknown) => {
    console.error(`${what}: upstream stream failed mid-response:`, err);
    res.end();          // headers are already sent, so the caller sees a truncated response
  });
  // A caller that hangs up leaves the upstream stream with nowhere to go; without this it
  // stays open until its own timeout, holding a socket per abandoned request.
  res.on("close", () => { if (!src.destroyed) src.destroy(); });
  src.pipe(res);
}

// AN MCP DOOR NEVER ANSWERS WITH AN HTTP ERROR STATUS. This is that rule, in one place.
//
// The MCP client SDK treats the HTTP status as the health of the TRANSPORT, not as the answer
// to the call. Read its POST path: 401 and 403-with-insufficient_scope start an auth flow, and
// every other non-2xx — 403, 404, 500, 502 alike — becomes
// `throw new StreamableHTTPError(status, "Error POSTing to endpoint: " + text)`. LibreChat
// counts three of those and opens a per-user circuit breaker over the whole block, after which
// blocked attempts count as further failures and it never closes.
//
// So a refusal we wrote to be READ — "you are acting for team 'x', which is not granted block
// 'casebox' — your team 'y' is: team_switch to it" — never reached the agent at all. It arrived as a
// dead socket, the agent concluded the block was unreachable, and it told the person to
// reconnect their credentials. That is the loop this platform has been stuck in: our clearest,
// most actionable sentences were the ones most reliably converted into "please re-authenticate".
//
// A JSON-RPC error inside a 200 is the opposite in every way that matters. The transport stays
// up, the breaker stays shut, the failure stays scoped to the ONE call, and the agent reads the
// sentence and can act on it. The HTTP status carries transport health; the body carries the
// answer. Two channels, two meanings — conflating them is what cost us the 52.
//
// The deliberate exceptions, both spec-mandated and both explicitly tolerated by the client:
// 405 on GET (we do not offer the server-to-client stream) and 401 with a WWW-Authenticate
// challenge (an auth challenge is a transport-level fact and the client is built to act on it).
export function mcpRefusal(req: express.Request, res: express.Response, message: string, code = -32000): void {
  if (res.headersSent) { res.end(); return; }
  const body = req.body as unknown;
  const id = body && typeof body === "object" && !Array.isArray(body) && "id" in (body as object)
    ? ((body as { id?: unknown }).id ?? null)
    : null;
  // A notification carries no id, so there is nothing for a response to correlate with and the
  // client would be handed a reply it cannot route. 202 is what the notification path already
  // answers, and it is not an error status.
  if (id === null && (body as { method?: string })?.method?.startsWith("notifications/")) {
    res.status(202).end();
    return;
  }
  res.status(200).json({ jsonrpc: "2.0", id, error: { code, message } });
}
// /core/mcp — streaming pass-through to zz-core with the canonical
// identity headers the middleware just rewrote. One host serves it all.
export const CORE_URL = process.env.CORE_MCP_URL || "http://zz-core:8000/mcp";
/** /eval/mcp — the evaluation door's upstream. THE SAME PROCESS, A SECOND PATH.
 *
 * zz-core mounts two MCP endpoints on one port: `/mcp` and `/eval-mcp`. So this is a second
 * URL on the same host rather than a second service — no new container, no second copy of
 * the "zz-core has no authentication of its own" premise, and one credential. A third
 * service remains possible later; nothing here blocks it.
 *
 * Its own environment variable, because the two doors can be pointed at different hosts the
 * day they stop being one process, and a caller that could only override both together would
 * make that a code change rather than a deployment one. */
export const EVAL_URL = process.env.EVAL_MCP_URL || "http://zz-core:8000/eval-mcp";

/** Stream one MCP request through to zz-core, and answer a dead upstream with a SENTENCE.
 *
 * ONE FUNCTION, TWO DOORS. This was written inline for `/core/mcp`: header filtering, the
 * two-minute timeout, the response-header strip and the guarded body relay. A second door
 * written the same way is exactly the shape NEVER_FORWARD's comment above records — "the
 * /core proxy remembered and the block proxy forgot, and there was nothing to notice the
 * difference" — where one of two hand-maintained copies leaked the caller's PAT to a third
 * party for however long it took somebody to look. Two doors, one body.
 *
 * `refusal` is per door and is not optional: a door that cannot say WHICH door failed sends
 * the agent looking in the wrong place, and mcpRefusal exists because that sentence is the
 * only thing the model ever receives — an HTTP error status reaches it as a dead transport
 * and comes out as "please reconnect your credentials". */
export function passThrough(
  url: string, what: string, refusal: string,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void (async () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (HOP_HEADERS.has(lk) || NEVER_FORWARD.has(lk)) continue;
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(", ");
      }
      const hasBody = req.method !== "GET" && req.method !== "DELETE";
      const upstream = await fetch(url, {
        method: req.method, headers,
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: req.method === "GET" ? undefined : AbortSignal.timeout(120_000),
      });
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => {
        if (!STRIP_RESPONSE.has(k.toLowerCase())) res.setHeader(k, v);
      });
      relayBody(upstream.body, res, what);
    })().catch((err: unknown) => {
      console.error(`${what} failed:`, err);
      mcpRefusal(req, res, refusal);
    });
  };
}
