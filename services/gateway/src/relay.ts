/**
 * Proxying a door to zz-core: the call itself, and what the gateway does and does not pass on.
 *
 * Three sets, each a refusal. Hop-by-hop headers belong to one connection and forwarding them
 * corrupts the next. The caller's own Authorization and Cookie never go upstream — zz-core is
 * told who is calling by the identity headers the gateway stamps, not by the caller's
 * credential. Upstream transport headers are stripped from the response, because they describe
 * that connection and not ours.
 */
import { Readable } from "node:stream";

import express from "express";


const HOP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive",
  "transfer-encoding", "upgrade", "proxy-authorization",
]);
/** Headers that must never leave this gateway, whatever the destination.
 *
 * `authorization` carries the caller's zz PAT, which authenticates as that person against this
 * platform. Nothing about how the caller proved who they are goes upstream.
 *
 * COUPLED: named here rather than at each call site, so every proxy strips the same set. */
export const NEVER_FORWARD = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Upstream response headers that must not reach the caller.
 *
 * The first four are hop-by-hop: this gateway re-frames the body, so passing them through
 * describes the wrong connection. `set-cookie` is here for a different reason — an upstream
 * response is streamed to a browser session on our origin, and nothing it returns may establish
 * state with our client. */
const STRIP_RESPONSE = new Set([
  "content-length", "transfer-encoding", "content-encoding", "connection",
  "set-cookie", "set-cookie2",
]);
/** Relay an upstream response body to the caller, and survive it dying mid-stream.
 *
 * `.pipe()` does not forward errors. A Readable that errors with no `error` listener raises an
 * unhandled `error` event, and Node's default for that is `throw` — from an async socket callback,
 * where nothing can catch it, so an upstream closing its socket mid-response exits the whole proxy
 * and drops every user's session. A truncated response to one caller is the correct blast radius. */
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

// An MCP door never answers with an HTTP error status. This is that rule, in one place.
//
// The MCP client SDK treats the HTTP status as the health of the transport, not as the answer to
// the call: 401 and 403-with-insufficient_scope start an auth flow, and every other non-2xx —
// 403, 404, 500, 502 alike — becomes `throw new StreamableHTTPError(status, …)`. A refusal
// written to be read then arrives as a dead transport, and a client may stop calling the door.
//
// A JSON-RPC error inside a 200 keeps the transport up and the failure scoped to the one call.
// The HTTP status carries transport health; the body carries the answer.
//
// DELIBERATE exceptions, both spec-mandated and both tolerated by the client: 405 on GET (no
// server-to-client stream is offered) and 401 with a WWW-Authenticate challenge, which is a
// transport-level fact the client is built to act on.
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
/** /eval/mcp — the evaluation door's upstream: the same process, a second path.
 *
 * zz-core mounts `/mcp` and `/eval-mcp` on one port, so this is a second URL on the same host
 * rather than a second service — no new container and one credential.
 *
 * Its own environment variable, so the two doors can be pointed at different hosts the day they
 * stop being one process without that becoming a code change. */
export const EVAL_URL = process.env.EVAL_MCP_URL || "http://zz-core:8000/eval-mcp";

/** Stream one MCP request through to zz-core, and answer a dead upstream with a sentence.
 *
 * COUPLED: one function serves both doors. Header filtering, the two-minute timeout, the
 * response-header strip and the guarded body relay are written once, so no door can forward
 * the caller's PAT that another strips.
 *
 * `refusal` is per door and is not optional: a door that cannot say which door failed sends the
 * agent looking in the wrong place, and mcpRefusal exists because that sentence is the only thing
 * the model ever receives. */
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
