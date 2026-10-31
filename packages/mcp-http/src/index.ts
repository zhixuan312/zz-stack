/**
 * @zz/mcp-http — stateless streamable-HTTP hosting for MCP servers, with per-request
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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
 * What a tool does to the world, in the MCP annotations a client decides confirmation from. Every
 * `registerTool` passes exactly one of these as `annotations`.
 *
 * ChatGPT treats a tool with no `readOnlyHint` as a write and asks the person to confirm every
 * call — and its "always allow" lasts one conversation — so a read tool without the hint is a
 * confirmation dialog on every look at an initiative. The MCP defaults are the other trap: an
 * unannotated write is assumed destructive and open-world, which none of ours are by default.
 *
 * `READS` — changes nothing. A record that the call happened (telemetry, the presentation record
 *           `document_present` writes) is not a change: it says a read took place.
 * `WRITES` — creates or changes a record, and loses nothing: a revision is filed, an old
 *           version stays readable, a state moves forward.
 * `DESTROYS` — deletes, revokes or deactivates something a person may have depended on.
 *
 * None of them reaches the open internet; a tool that does spreads one and sets
 * `openWorldHint: true` itself. COUPLED: `checks/tool-annotations.ts` holds every registration
 * to one of these. */
export const READS = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const DESTROYS = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/** Whether a JSON value holds a NUL character, in a string or a key, at any depth. */
const holdsNul = (v: unknown): boolean =>
  typeof v === "string" ? v.includes("\0")
    : typeof v === "object" && v !== null && Object.entries(v).some(([k, x]) => k.includes("\0") || holdsNul(x));

/** The argument of a single `tools/call` that holds a NUL character, by name, or null.
 *
 * No text column in Postgres stores a NUL, so a tool handed one fails at its first write with
 * the database's own words, and the call's telemetry, carrying the same argument, fails with it.
 * Refusing here, before any door's handler, is one answer for every tool on every door. */
function nulArgument(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { method, params } = body as { method?: unknown; params?: { arguments?: unknown } };
  if (method !== "tools/call" || typeof params?.arguments !== "object" || params.arguments === null) return null;
  return Object.entries(params.arguments).find(([k, v]) => k.includes("\0") || holdsNul(v))?.[0] ?? null;
}

/** The argument names a tool's input schema declares; null when its shape cannot be read. */
function declaredArguments(schema: unknown): string[] | null {
  if (schema === undefined) return [];
  const shape = (schema as { shape?: unknown }).shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : null;
}

/**
 * An argument a tool does not take is refused by name, with the arguments it does take.
 *
 * The SDK drops an undeclared key before the handler runs, so a misspelt argument is not a slip
 * the caller hears about: `flwo` on `initiative_open` opened a freeform initiative for good, and a
 * misspelt `request_id` or `base` would quietly switch off replay or stale-write protection. A
 * refusal costs one retry; a client holding a stale cached schema is told which name to drop.
 * Where the schema also refused the call, its own sentence leads.
 *
 * DELIBERATE: patched on the instance — `validateToolInput` is the SDK's one validation path and
 * has no hook. A schema whose shape cannot be read is left to the SDK alone. checks/
 * door-unknown-arguments.ts pins this to the installed SDK.
 */
function refusesUnknownArguments(server: McpServer): void {
  type Validate = (tool: { inputSchema?: unknown }, args: unknown, name: string) => Promise<unknown>;
  const inner = server as unknown as { validateToolInput: Validate };
  const rawValidate: Validate = inner.validateToolInput.bind(server);
  inner.validateToolInput = async (tool, args, name) => {
    const takes = declaredArguments(tool.inputSchema);
    const unknown = takes && args && typeof args === "object" ? Object.keys(args).filter((k) => !takes.includes(k)) : [];
    if (!takes || !unknown.length) return rawValidate(tool, args, name);
    // Worded as the SDK's own schema refusals are, so the telemetry owns it as the call's shape.
    const said = await rawValidate(tool, args, name).then(
      () => `Input validation error: Invalid arguments for tool ${name}: it`,
      (err: unknown) => {
        if (!(err instanceof McpError) || err.code !== ErrorCode.InvalidParams) throw err;
        return `${err.message.replace(/^MCP error -?\d+: /, "")} — ${name}`;
      });
    const named = (ks: string[]) => ks.map((k) => `\`${k}\``).join(", ");
    throw new McpError(ErrorCode.InvalidParams, takes.length
      ? `${said} takes no ${named(unknown)}; its arguments are ${named(takes)}`
      : `${said} takes no arguments; ${named(unknown)} was passed`);
  };
}

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

    const nul = nulArgument(req.body);
    if (nul !== null) {
      res.json({ jsonrpc: "2.0", id: (req.body as { id?: unknown }).id ?? null, result: {
        ...text(`ERROR: argument \`${nul.replaceAll("\0", "\\0")}\` holds a NUL character (U+0000), which ` +
                "nothing on this platform can store — remove it and call again."),
        isError: true } });
      return;
    }

    const server = await buildServer();
    refusesUnknownArguments(server);
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
