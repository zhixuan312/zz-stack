/**
 * @zz/mcp-http — session-managed streamable-HTTP hosting for MCP servers, with per-request
 * header propagation so tool handlers can read the forwarded caller identity. The MCP endpoint
 * is always a thin adapter: this package owns all transport plumbing so services stay pure
 * logic.
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
 * `moduleUrl` is the caller's `import.meta.url`; the version comes from the package.json above
 * its dist/, which is the same file the release process bumps. A literal here is what
 * `initialize` hands every client as serverInfo.version, and it does not move when the platform
 * does. */
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
 * Mount an MCP endpoint on an express app. `buildServer` is called once per request.
 *
 * DELIBERATE: there is no session. `sessionIdGenerator: undefined` makes the SDK's
 * `validateSession` return immediately — no session id is issued, none is required, and one
 * presented is not checked. A client still holding an id from a session-managed deployment
 * keeps working, because nothing looks at it.
 *
 * A session-managed endpoint holds its transport and McpServer in process memory, which every
 * deploy, restart, crash and idle sweep empties while the client's session id survives. The
 * spec's answer is 404 and a re-initialise, but the SDK client clears `_sessionId` only in
 * `terminateSession()` and has no 404 branch, so it keeps posting the dead id and every POST
 * throws `StreamableHTTPError` — which a client reads as a dead transport, and the person is
 * told their credentials need reconnecting, about a session rather than a credential.
 *
 * The cost is a fresh McpServer per request: the SDK refuses to reuse a stateless transport
 * ("Stateless transport cannot be reused across requests"), and one server drives one
 * transport. That is a few dozen in-memory tool registrations against handlers that then
 * go to Postgres. The session bought nothing else — the server-to-client stream is all it enables,
 * and this answers 405 to that below.
 *
 * `buildServer` may be async, and one door depends on it: /manage/mcp registers a different set
 * of tools depending on who is calling, which means a database read. The build therefore
 * happens inside the request's async-local context, after identity has resolved, and the
 * transport is created after it so a caller who hangs up mid-lookup leaves nothing to tear
 * down.
 */
export function serveMcp(
  app: Express, path: string, buildServer: () => McpServer | Promise<McpServer>,
): void {
  const handle = async (req: Request, res: Response): Promise<void> => {
    // GET is the optional server-to-client stream and 405 is its "no" — the SDK client reads
    // 405 as "this server does not push" and returns quietly, while any other status becomes a
    // transport error. DELETE is the client asking to end a session; with none to end, 405 is
    // again the spec's answer and the client's `terminateSession` special-cases it.
    //
    // Both are refused before the transport sees them: in stateless mode its own GET handler
    // would open a standalone SSE stream, with a keep-alive timer, that nothing ever writes to
    // or cleans up.
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
    // response is finished or the client hangs up, which is every exit this has.
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
