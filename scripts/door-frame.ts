/**
 * One MCP call through a live door, read the way the doctor and the release need it read.
 *
 * DELIBERATE: its own module, beside deployment.ts rather than in it. deployment.ts builds the
 * handshake (`initFrame`) and this reads the answer, and the gate's "the MCP protocol is written
 * once" holds a file doing both to be a second MCP client. Neither imports @zz/mcp-client, for
 * the reason deployment.ts gives: the doctor runs before a build has necessarily produced any
 * JavaScript.
 */
import { asExecError, initFrame, run } from "./deployment.ts";

/** The three shapes the live probes read off an MCP frame. Every field is optional — the
 *  transport may answer with a JSON-RPC error, a frame missing the result a caller asked for, or
 *  this file's own `unreachable` marker — so the honest type is one no live answer can fail to
 *  satisfy, rather than a schema nothing here validates. */
export interface McpFrame {
  unreachable?: string;
  error?: unknown;
  result?: {
    tools?: { name: string }[];
    serverInfo?: { version?: string };
  };
}

/** One MCP call through a door, parsed. The transport may answer as SSE or as plain JSON, so the
 *  last non-empty line is taken and the `data: ` prefix dropped if it is there.
 *
 *  The caller resolves `addr` and `bearer` first, and that placement is the whole rule: a missing
 *  precondition must throw where the doctor reads it as `unknown`. From the request on, a failure
 *  is the platform's answer and is returned — a door that is down, or a Caddy 502 in front of it,
 *  must not become `unknown`, because a release does not roll back on `unknown`.
 *
 *  A status other than 2xx is named with its code: a 401 from the identity gate and a door that
 *  failed are different diagnoses, and their bodies can read alike. */
export function mcpFrame(addr: string, bearer: string, path: string, body: string, maxTime = 30): McpFrame {
  let out: string;
  try {
    out = run("curl", ["-sS", "-m", String(maxTime), "-w", "\n%{http_code}",
      "-H", `Authorization: Bearer ${bearer}`, "-H", "content-type: application/json",
      "-H", "accept: application/json, text/event-stream",
      "-d", body, `${addr}${path}`]);
  } catch (err) {
    // `-sS`: curl names what failed on stderr ("Failed to connect", "timed out"). The message of
    // the throw is never used — it carries the whole command line, bearer included.
    const e = asExecError(err);
    return { unreachable: `the door could not be reached: ${(e.stderr ?? "").trim().slice(0, 160) || "curl gave no reason"}` };
  }
  const lines = out.split("\n");
  const status = (lines.pop() ?? "").trim();
  const line = lines.map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (!/^2\d\d$/.test(status)) return { unreachable: `http ${status}: ${(line || "(empty)").slice(0, 160)}` };
  // Defensive for the same reason: a page that is not JSON makes JSON.parse throw SyntaxError,
  // and the doctor's runner would call that its own bug while the platform really was broken.
  try {
    const parsed: unknown = JSON.parse(line.replace(/^data:\s*/, ""));
    return parsed && typeof parsed === "object" ? (parsed as McpFrame)
      : { unreachable: `the door answered ${JSON.stringify(parsed)}, which is not an MCP frame` };
  } catch {
    return { unreachable: `the door answered something that is not JSON: ${(line || "(empty)").slice(0, 160)}` };
  }
}

/** Why a door's initialize did not answer as a working MCP server, or null when it did.
 *
 *  A status code cannot say: the gateway answers a dead upstream with HTTP 200 and a JSON-RPC
 *  error frame (services/gateway/src/relay.ts `mcpRefusal`), so only the frame tells a refusing
 *  door from a working one. Release 0.98.2's first run printed a refusing /core/mcp as answering. */
export function initializeRefusal(addr: string, bearer: string, path: string, who: string, maxTime = 30): string | null {
  const hello = mcpFrame(addr, bearer, path, initFrame(who), maxTime);
  if (hello.unreachable) return hello.unreachable;
  if (hello.error) return `refused initialize: ${JSON.stringify(hello.error).slice(0, 200)}`;
  return hello.result ? null : "the handshake answered no result";
}
