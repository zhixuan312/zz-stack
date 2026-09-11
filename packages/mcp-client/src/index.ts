/**
 * One MCP client for everything in this repository that CALLS an MCP endpoint.
 *
 * The counterpart to @zz/mcp-http, which hosts one. Six scripts each carried their own —
 * the smoke harness, the conformance measurer, the chain probe, the block probe, the
 * credential batcher and the provisioner — and they had already drifted in the way separate
 * copies of one protocol always do. They announced three different protocol versions between
 * them (2025-06-18, 2025-03-26 and 2024-11-05) and parsed a streamable-HTTP response three
 * ways: the first `data:` line, the last JSON object, and the frame whose id matched the
 * request. One sent notifications/initialized and the others did not.
 *
 * None of that was a bug anybody had hit, which is the point: a protocol implemented six
 * times is six things that agree today and one that will not agree tomorrow, and the day it
 * stops agreeing the failure appears in whichever copy was not updated.
 *
 * Node's own fetch, no dependencies. These calls happen during an install and during a
 * release, and a dependency here is a dependency at the worst possible moment.
 */

/** One version, announced by everything. When the platform's own MCP hosting moves, this is
 * the line that moves — not six lines in six files, five of which get missed. */
const PROTOCOL = "2025-06-18";

/** LibreChat's uaParser refuses non-browser agents on some routes with "Illegal request",
 * and a default agent is one of the things it refuses. Harmless everywhere else. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A transport failure or a protocol-level error.
 *
 * A tool that REFUSES is not this: a refusal is a successful call whose text begins with
 * ERROR, and every caller here wants to read it rather than catch it. */
export class McpError extends Error {
  override readonly name = "McpError";
  /** The HTTP status, when the failure was one. 404 is the one a caller acts on: it is how
   * a server says the session is gone, and the answer is a new session, not a failed run. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A JSON-RPC envelope, as loosely as this client needs to know it. */
export interface RpcEnvelope {
  error?: { code?: number; message?: string };
  result?: { content?: { text?: string }[]; serverInfo?: { name?: string; version?: string }; tools?: ToolInfo[] };
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * The JSON-RPC envelope out of a response, whether it arrived as JSON or as SSE.
 *
 * Takes the LAST JSON object rather than the first. A streamable-HTTP answer can carry
 * progress frames ahead of the result, and the first frame is then a notification rather
 * than the answer — the reading that took the first line was right only because nothing had
 * sent one yet.
 */
export function lastJson(raw: string): RpcEnvelope | null {
  let obj: RpcEnvelope | null = null;
  for (const line of (raw ?? "").split("\n")) {
    const t = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!t.startsWith("{")) continue;
    try {
      obj = JSON.parse(t) as RpcEnvelope;
    } catch {
      // A `data:` line that is not JSON is a frame this client has no use for.
    }
  }
  return obj;
}

interface McpOptions {
  /** A bearer token, sent as `Authorization: Bearer <pat>`. */
  pat?: string;
  /** What this client calls itself in the handshake. Shows up in a server's logs. */
  client?: string;
  /** Milliseconds before a single request is abandoned. */
  timeoutMs?: number;
  /**
   * A credential that is not a bearer token.
   *
   * Blocks are other teams' services, and the header they authenticate on is theirs to
   * choose — X-API-Key as often as Authorization. A probe run the moment somebody hands
   * over a URL and a credential has to be able to send whatever they named.
   */
  headers?: Record<string, string>;
}

/**
 * One session against one MCP endpoint.
 *
 * The session is opened lazily on the first call and reused, because opening one per call is
 * what made a probe of six tools look like six clients to the server.
 */
export class Mcp {
  readonly url: string;
  /** What the server said it was at initialize. Empty until the first call opens the
   * session, because that is when the server gets asked. */
  server: { name?: string; version?: string } = {};

  readonly #head: Record<string, string>;
  readonly #client: string;
  readonly #timeoutMs: number;
  #session: string | null = null;

  constructor(url: string, opts: McpOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.#client = opts.client ?? "zz";
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#head = {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json, text/event-stream",
      // WHO IS CALLING, AS A HEADER — not only inside the MCP handshake's clientInfo.
      //
      // The gateway correlates a skill load with the calls that follow it by
      // `x-zz-user-email` + `x-zz-client`, and NOTHING wrote the second half: it was read in
      // one place and set in none, so it was the empty string for every caller and the two
      // halves of the key were one half. Every process acting as one person therefore shared
      // ONE trace — the onboarding timer, the provisioner, zz-tool and that person's own chat
      // session, all mutating it.
      //
      // Measured on UAT during a live round: 160 `render_agent_definition` rows from the
      // 60-second onboarding timer were attributed to `ops-build 1.2`, 35 to `zz-knowledge
      // 2.0`, and a `write_file` came out carrying one skill's name beside another's version.
      // Those rows are what tool-report, evolve-report and step-score count, so every
      // per-skill number was inflated by whatever automation happened to be running.
      //
      // `client` was already declared at every call site for exactly this — "provision",
      // "smoke", "call". It just never left the process.
      "x-zz-client": this.#client,
      ...(opts.pat ? { Authorization: `Bearer ${opts.pat}` } : {}),
      ...(opts.headers ?? {}),
    };
  }

  async #post(body: unknown, extra: Record<string, string> = {}): Promise<{ raw: string; session: string | null }> {
    // AbortSignal.timeout rather than a bare fetch: a server that accepts the connection and
    // then says nothing would otherwise hang the whole run with no output at all.
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { ...this.#head, ...extra },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new McpError(`cannot reach ${this.url}: ${(err as Error).message}`);
    }
    const raw = await res.text();
    if (!res.ok) throw new McpError(`HTTP ${res.status} from ${this.url}: ${raw.slice(0, 300)}`, res.status);
    return { raw, session: res.headers.get("mcp-session-id") };
  }

  async #open(): Promise<void> {
    if (this.#session !== null) return;
    const { raw, session } = await this.#post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: this.#client, version: "1" } },
    });
    const env = lastJson(raw);
    if (!env?.result) {
      // Said early and plainly. An endpoint that cannot complete a handshake fails every
      // call after this, and the first failure is the one worth reading.
      throw new McpError(`initialize returned no result from ${this.url}: ${(raw ?? "").slice(0, 300)}`);
    }
    this.server = env.result.serverInfo ?? {};
    // A server may answer without a session id; "" rather than null so the lazy check above
    // does not reopen on every call and leave a trail of dead sessions.
    this.#session = session ?? "";
    if (this.#session) {
      // Some servers refuse tools/call before this notification. It has no response, and a
      // server that does not want it ignores it — so it is always sent, and a failure here
      // is not fatal to the call that follows.
      try {
        await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": this.#session });
      } catch (err) {
        if (!(err instanceof McpError)) throw err;
      }
    }
  }

  /** One JSON-RPC call, returning the envelope.
   *
   * A 404 on a request carrying a session id means the server no longer knows that session,
   * and the protocol's answer is to open a new one. @zz/mcp-http reclaims an idle session
   * after two hours and answers 404 for exactly this reason — its own comment says a 400
   * there left LibreChat retrying a dead id until it ran out of reconnects, mid-scenario,
   * with no tools. This client is the other half of that contract and did not hold it up: it
   * threw, and a smoke lane or a long probe died on a session the server had simply tidied.
   *
   * ONCE. A second 404 is the server refusing a session it has just issued, which is not a
   * dropped session and must not become a retry loop against somebody else's endpoint.
   */
  async rpc(method: string, params: unknown = {}, rpcId = 2): Promise<RpcEnvelope> {
    for (let attempt = 0; ; attempt += 1) {
      await this.#open();
      const extra: Record<string, string> = this.#session ? { "mcp-session-id": this.#session } : {};
      let raw: string;
      try {
        ({ raw } = await this.#post({ jsonrpc: "2.0", id: rpcId, method, params }, extra));
      } catch (err) {
        if (attempt === 0 && this.#session && err instanceof McpError && err.status === 404) {
          this.#session = null;      // reopened by #open on the next pass
          continue;
        }
        throw err;
      }
      const env = lastJson(raw);
      if (env === null) {
        throw new McpError(`no JSON-RPC envelope in the answer from ${this.url}: ${raw.slice(0, 200)}`);
      }
      return env;
    }
  }

  /**
   * One tools/call, returning the tool's text.
   *
   * A refusal comes back as text beginning with ERROR, not as an exception: the platform
   * writes those messages to say which rule was broken, and every caller here reads them.
   */
  async call(tool: string, args: unknown = {}): Promise<string> {
    const env = await this.rpc("tools/call", { name: tool, arguments: args });
    if (env.error) throw new McpError(`${tool}: ${JSON.stringify(env.error).slice(0, 300)}`);
    // EVERY text block, not the first. Our own servers answer with one, so this read was
    // right for them and silently dropped the rest for anyone else's — and the callers that
    // matter here are the block probes, pointed at other teams' services precisely because
    // nobody knows yet what those return. A truncated answer that looks complete is the
    // worst thing a conformance measurement can report.
    return (env.result?.content ?? [])
      .map((c) => c?.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  /** Every tool this endpoint publishes, as the raw list. */
  async tools(): Promise<ToolInfo[]> {
    const env = await this.rpc("tools/list");
    return env.result?.tools ?? [];
  }
}
