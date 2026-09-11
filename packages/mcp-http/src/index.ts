/**
 * @zz/mcp-http — session-managed streamable-HTTP hosting for MCP servers,
 * with per-request header propagation so tool handlers can read the
 * forwarded caller identity. The MCP endpoint is ALWAYS a thin adapter:
 * this package owns all transport plumbing so services stay pure logic.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";

type HeaderBag = Record<string, string | string[] | undefined>;

const als = new AsyncLocalStorage<{ headers: HeaderBag }>();

/** The HTTP headers of the request currently being handled by a tool. */
export function requestHeaders(): HeaderBag {
  return als.getStore()?.headers ?? {};
}

/** The running service's own version, for the MCP handshake.
 *
 * Every server declared a literal — "2.0.0", "1.0.0" — while the packages were at 0.2.0,
 * and that literal is what `initialize` hands every client as serverInfo.version. Three
 * servers, three different wrong numbers, none of which moved when the platform did. A
 * client asking what it is talking to was told something no release had ever produced.
 *
 * `moduleUrl` is the caller's `import.meta.url`; the version comes from the package.json
 * above its dist/, which is the same file the release process bumps. */
export function serviceVersion(moduleUrl: string): string {
  try {
    const here = dirname(fileURLToPath(moduleUrl));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

/** Standard text result for MCP tools. */
export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * Mount an MCP endpoint on an express app. `buildServer` is called once per REQUEST.
 *
 * THERE IS NO SESSION HERE, AND THAT IS THE WHOLE POINT.
 *
 * This endpoint used to be session-managed: `initialize` minted an id, the client sent it
 * back on every later POST, and a map held the transport and its McpServer. That map is
 * process memory, so it was emptied by every deploy, every container restart, every crash —
 * and, by design, by an idle sweeper after two hours. The client's session id survived all
 * of those. Ours did not.
 *
 * What a client does with a session we no longer know is the part that made this expensive.
 * The spec says answer 404 and says the client MUST then re-initialise; we answered 404
 * correctly, and the SDK's client does not implement the second half. Read its transport:
 * `_sessionId` is cleared in exactly one place, `terminateSession()`, which only runs when
 * the application deliberately ends the session. There is no `404` branch anywhere in it.
 * So the client keeps posting the dead id, every POST is another 404, and every 404 is
 *
 *     throw new StreamableHTTPError(status, `Error POSTing to endpoint: ${text}`)
 *
 * which LibreChat counts as a transport failure. Three of those open its per-user circuit
 * breaker, blocked attempts count as further failures, and the breaker never closes again.
 * The agent is then holding a block that answers nothing, so it tells the person their
 * credentials need reconnecting — about a session, not a credential. Measured on production
 * over seven days: 52 of that exact error, against TEN `credential_required` calls in a
 * fortnight. Reproduced directly: POST with an unknown id returned
 * `HTTP 404 {"jsonrpc":"2.0","error":{"code":-32001,...` — the `{` the logs are full of.
 *
 * Statelessness removes the class rather than the symptom. `sessionIdGenerator: undefined`
 * makes the SDK's `validateSession` return immediately: no session id is issued, none is
 * required, and one presented is not checked. So there is no state a deploy can drop, no
 * TTL to tune, and no id to go stale over lunch. A client still holding an id from before
 * this change keeps working without reconnecting, because nothing looks at it.
 *
 * The cost is a fresh McpServer per request — the SDK refuses to reuse a stateless transport
 * (`Stateless transport cannot be reused across requests`), and one server drives one
 * transport, so both are per-request. That is ~33 in-memory tool registrations against
 * handlers that then go to Postgres; measured against the 30ms/req warm baseline it is
 * noise. We were never buying anything with the session: the server->client stream is the
 * only thing it enables and we answer 405 to that below, as we always have.
 *
 * `buildServer` may be ASYNC, and one door depends on it. /manage/mcp registers a different
 * set of tools depending on who is calling — a member never sees a tool that would refuse
 * them — and knowing who is calling means a database read. The build therefore happens
 * inside the request's async-local context, after identity has resolved, and the transport
 * is created after it so a caller who hangs up mid-lookup leaves nothing to tear down.
 */
export function serveMcp(
  app: Express, path: string, buildServer: () => McpServer | Promise<McpServer>,
): void {
  const handle = async (req: Request, res: Response): Promise<void> => {
    // GET is the OPTIONAL server-to-client stream and 405 is its "no" — the SDK client
    // reads 405 as "this server does not push" and returns quietly, while ANY other status
    // becomes a transport error and feeds the same breaker as above. DELETE is the client
    // asking to end a session; with none to end, 405 is again the spec's answer and the
    // client's `terminateSession` special-cases it. Both must be refused BEFORE the
    // transport sees them: in stateless mode its own GET handler would open a standalone
    // SSE stream, with a keep-alive timer, that nothing will ever write to or clean up.
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed: this endpoint serves POST only" },
        id: null,
      });
      return;
    }

    const server = await buildServer();
    // The caller may have hung up while we were resolving who they are. Nothing is connected
    // yet, so there is nothing to close — but there is also no point building a transport for
    // a response that will never be written.
    if (res.destroyed) { await server.close().catch(() => { /* nothing held it */ }); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // The POST response is an SSE stream the transport closes when the last reply is sent,
    // so tearing down on `await` would cut it off mid-answer. `close` fires once the
    // response is finished OR the client hangs up, which is every exit this has.
    res.on("close", () => {
      void transport.close().catch(() => { /* already gone */ });
      void server.close().catch(() => { /* already gone */ });
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.all(path, (req: Request, res: Response) => {
    void als.run({ headers: req.headers }, () =>
      handle(req, res).catch((err: unknown) => {
        console.error("mcp request failed:", err);
        if (!res.headersSent) res.status(500).end();
      }),
    );
  });
}
