/**
 * Verify the shared MCP client against a stub server. No gateway, no network, no fixtures.
 *
 * Every other engine here needs a live deployment; a protocol client is provable on a laptop.
 *
 * The case that matters most is `sse_with_progress`: a progress frame arrives before the
 * result, so a reading that takes the first `data:` line returns the notification and calls it
 * the answer.
 *
 *   npm run check:mcp-client      # exits non-zero on failure, like every engine here
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Mcp, McpError, lastJson } from "@zz/mcp-client";

const SEEN: { method?: string; session: string | null }[] = [];
const HEADERS: IncomingMessage["headers"][] = [];
/** Incrementing, so "it opened a new session" is something a check can see rather than
 * infer. The first client still gets S1, which is what the assertions below name. */
let sessions = 0;
/** Tools that answer 404 once, mirroring a session-managed server that has reclaimed a session. */
const expired = new Set<string>();

function stub(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
      method?: string;
      params?: { name?: string };
    };
    SEEN.push({ method: body.method, session: (req.headers["mcp-session-id"] as string) ?? null });
    HEADERS.push(req.headers);

    const json = (payload: string, code = 200): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(payload);
    };

    if (body.method === "initialize") {
      // /broken answers a well-formed JSON-RPC frame carrying no result — what a real endpoint
      // does when it is up but not an MCP server, where saying so at the handshake beats a
      // confusing failure one call later.
      if ((req.url ?? "").endsWith("/broken")) {
        json('{"jsonrpc":"2.0","id":1,"error":{"message":"not an MCP server"}}');
        return;
      }
      res.writeHead(200, { "mcp-session-id": `S${++sessions}`, "Content-Type": "application/json" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"stub","version":"9"}}}');
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    const tool = body.params?.name;
    // A session this server no longer knows, as a session-managed MCP server answers it: the
    // client keys on the status, so a stub answering 400 here would prove nothing.
    const gone = (): void => {
      json('{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found: initialize a new session"},"id":null}', 404);
    };
    if (tool === "gone_once" && !expired.has("gone_once")) { expired.add("gone_once"); gone(); return; }
    if (tool === "always_gone") { gone(); return; }
    if (tool === "multi") {
      json('{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"one"},{"text":"two"},{"text":"three"}]}}');
      return;
    }
    if (tool === "sse_with_progress") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
          'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"REAL"}]}}\n\n',
      );
      return;
    }
    if (tool === "refuses") {
      json('{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"ERROR: a rule"}]}}');
      return;
    }
    if (tool === "rpc_error") {
      json('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}');
      return;
    }
    json('{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"PLAIN"}]}}');
  });
}

/** Case-insensitively, and not out of politeness: header names are case-insensitive per
 * RFC 7230 and a test that pinned exact casing would fail on a client behaving correctly. */
const header = (h: IncomingMessage["headers"], name: string): string | undefined =>
  h[name.toLowerCase()] as string | undefined;

async function main(): Promise<number> {
  const srv = createServer(stub);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/core/mcp`;

  const results: boolean[] = [];
  const check = (name: string, condition: boolean, got: unknown = ""): void => {
    results.push(condition);
    console.log((condition ? "  PASS  " : "  FAIL  ") + name + (condition ? "" : `   -> ${JSON.stringify(got)}`));
  };

  const client = new Mcp(url, { pat: "zzp_stub", client: "mcp-client-check" });
  check("a plain JSON answer yields the tool's text", (await client.call("plain")) === "PLAIN");
  check(
    "an SSE answer yields the RESULT frame, not the progress frame ahead of it",
    (await client.call("sse_with_progress")) === "REAL",
  );
  check("a refusal is returned as text, never raised", (await client.call("refuses")) === "ERROR: a rule");
  try {
    await client.call("rpc_error");
    check("a JSON-RPC error raises", false, "no exception");
  } catch (e) {
    check("a JSON-RPC error raises", e instanceof McpError && e.message.includes("nope"), String(e));
  }

  check("the session is opened once and reused", SEEN.filter((s) => s.method === "initialize").length === 1, SEEN);
  check(
    "notifications/initialized is sent once",
    SEEN.filter((s) => s.method === "notifications/initialized").length === 1,
    SEEN,
  );
  check(
    "every tools/call carries the session id",
    SEEN.filter((s) => s.method === "tools/call").every((s) => s.session === "S1"),
    SEEN,
  );
  check("lastJson skips lines that are not JSON", JSON.stringify(lastJson('event: x\ndata: {"a":1}\n')) === '{"a":1}');
  check(
    "what the server said it is, is readable after the handshake",
    client.server.name === "stub" && client.server.version === "9",
    client.server,
  );

  // A caller may need to send a header that is not Authorization — the console forwards the
  // caller's identity headers this way.
  //
  // Marked from here, so every request this client makes is examined including its handshake:
  // reading only the last two requests leaves the initialize out, and a client that invented a
  // bearer token at the handshake and dropped it afterwards would pass.
  const firstKeyed = HEADERS.length;
  const keyed = new Mcp(url, { client: "mcp-client-check", headers: { "X-API-Key": "k-123" } });
  await keyed.call("plain");
  check(
    "a credential header that is not a bearer token reaches the server",
    HEADERS.some((h) => header(h, "X-API-Key") === "k-123"),
    HEADERS.map((h) => header(h, "X-API-Key")),
  );
  const keyedReqs = HEADERS.slice(firstKeyed);
  check(
    "no Authorization is invented when none was given, on any request including the handshake",
    keyedReqs.length >= 2 && !keyedReqs.some((h) => header(h, "Authorization") !== undefined),
    keyedReqs.map((h) => header(h, "Authorization")),
  );

  try {
    await new Mcp(`${url}/broken`, { client: "mcp-client-check" }).call("plain");
    check("a handshake that returns no result fails at the handshake", false, "no exception");
  } catch (e) {
    check("a handshake that returns no result fails at the handshake", String(e).includes("initialize"), String(e));
  }

  // A session the server has forgotten: a session-managed server answers 404 so a client can
  // open a new one.
  //
  // Sliced to this client's own requests. SEEN is every request the stub has taken, and `keyed`
  // has already opened a second session by this point, so an assertion over all of them would
  // be true before this client existed.
  const beforeDropped = SEEN.length;
  const dropped = new Mcp(url, { client: "mcp-client-check" });
  try {
    const got = await dropped.call("gone_once");
    check("a session the server has forgotten is reopened, not fatal", got === "PLAIN", got);
  } catch (e) {
    check("a session the server has forgotten is reopened, not fatal", false, String(e));
  }
  // Two attempts at one call: the first on the session the server forgot, the second on a
  // fresh one. Visible only in this client's slice.
  const droppedCalls = SEEN.slice(beforeDropped).filter((x) => x.method === "tools/call");
  check(
    "reopening means a NEW session, not the dead one resent",
    droppedCalls.length === 2 &&
      droppedCalls[1].session !== null &&
      droppedCalls[0].session !== droppedCalls[1].session,
    droppedCalls,
  );

  // Once: a server that 404s a session it has just issued is not dropping a session, and
  // retrying forever would be this client hammering somebody else's endpoint.
  const initsBefore = SEEN.filter((x) => x.method === "initialize").length;
  try {
    await new Mcp(url, { client: "mcp-client-check" }).call("always_gone");
    check("a second 404 raises rather than looping", false, "no exception");
  } catch (e) {
    const opened = SEEN.filter((x) => x.method === "initialize").length - initsBefore;
    check("a second 404 raises rather than looping", e instanceof McpError && opened === 2, `${String(e)} after ${opened} handshakes`);
  }

  const joined = await new Mcp(url, { client: "mcp-client-check" }).call("multi");
  check("every text block is returned, not just the first", joined === "one\ntwo\nthree", joined);

  try {
    await new Mcp("http://127.0.0.1:1/unreachable", { timeoutMs: 2000 }).call("x");
    check("an unreachable endpoint raises McpError", false, "no exception");
  } catch (e) {
    check("an unreachable endpoint raises McpError", e instanceof McpError, String(e));
  }

  srv.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n  ${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

process.exit(await main());
