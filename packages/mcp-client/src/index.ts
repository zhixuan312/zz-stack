/**
 * One MCP client for everything in this repository that calls an MCP endpoint — the counterpart
 * to @zz/mcp-http, which hosts one.
 *
 * DELIBERATE: one implementation. A protocol implemented once per script drifts: every copy
 * agrees today, and the failure appears in whichever one was not updated.
 *
 * DELIBERATE: Node's own fetch, no dependencies. These calls happen during an install and a
 * release, and a dependency there is a dependency at the worst possible moment.
 */

/** The failures of a reused keep-alive socket the server had already closed. */
const STALE_SOCKET = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);
const causeCode = (err: unknown): string => {
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: unknown } }).cause : undefined;
  return typeof cause?.code === "string" ? cause.code : "";
};

/** One protocol version, announced by every caller. */
const PROTOCOL = "2025-06-18";

/** A browser User-Agent rather than Node's default, sent on every request. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A transport failure or a protocol-level error.
 *
 * A tool that refuses is not this: a refusal is a successful call whose text begins with
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
interface RpcEnvelope {
  error?: { code?: number; message?: string };
  result?: { content?: { text?: string }[]; serverInfo?: { name?: string; version?: string }; tools?: ToolInfo[] };
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * The JSON-RPC envelope out of a response, whether it arrived as JSON or as SSE.
 *
 * DELIBERATE: the last JSON object, not the first. A streamable-HTTP answer can carry progress
 * frames ahead of the result, so the first frame may be a notification rather than the answer.
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
  /** Extra headers sent on every request — the console forwards the caller's identity headers
   *  this way. */
  headers?: Record<string, string>;
  /** Send a request once more when the pooled socket was already dead. Off by default: a
   *  request that dies mid-flight may have been handled, so only a client whose every call is a
   *  read or carries an idempotency key may turn this on — a retried keyed call replays. */
  retryStaleSocket?: boolean;
}

/**
 * One session against one MCP endpoint.
 *
 * The session is opened lazily on the first call and reused: opening one per call makes a probe
 * of six tools look like six clients to the server.
 */
export class Mcp {
  readonly url: string;
  /** What the server said it was at initialize. Empty until the first call opens the
   * session, because that is when the server gets asked. */
  server: { name?: string; version?: string } = {};

  readonly #head: Record<string, string>;
  readonly #client: string;
  readonly #timeoutMs: number;
  readonly #retryStaleSocket: boolean;
  #session: string | null = null;

  constructor(url: string, opts: McpOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.#client = opts.client ?? "zz";
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#retryStaleSocket = opts.retryStaleSocket ?? false;
    this.#head = {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json, text/event-stream",
      // Who is calling, as a header and not only inside the handshake's clientInfo.
      //
      // COUPLED: the gateway correlates a skill load with the calls that follow it by
      // `x-zz-user-email` + `x-zz-client`. Without this, every process acting as one person
      // shares one trace, and the per-skill figures tool-report counts absorb whatever
      // automation is running. `client` is declared at every call site,
      // e.g. "call" or "chain-check".
      "x-zz-client": this.#client,
      ...(opts.pat ? { Authorization: `Bearer ${opts.pat}` } : {}),
      ...(opts.headers ?? {}),
    };
  }

  async #post(body: unknown, extra: Record<string, string> = {}): Promise<{ raw: string; session: string | null }> {
    // AbortSignal.timeout rather than a bare fetch: a server that accepts the connection and then
    // says nothing would hang the whole run with no output.
    let res: Response;
    const send = (): Promise<Response> => fetch(this.url, {
      method: "POST",
      headers: { ...this.#head, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    try {
      res = await send().catch((err: unknown) => {
        // Once more when the pooled connection was already dead and the caller opted in: a caller
        // that blocked its own event loop for longer than the server's keep-alive (a release CLI
        // running a gate and a release command synchronously) reuses a socket the server has
        // since closed. Opt-in only, because the same error can arrive after the server handled
        // the request — safe to resend only for reads and idempotency-keyed writes.
        if (!this.#retryStaleSocket || !STALE_SOCKET.has(causeCode(err))) throw err;
        return send();
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
   * COUPLED: a 404 on a request carrying a session id means the server no longer knows that
   * session, and the answer is to open a new one. @zz/mcp-http reclaims an idle session after
   * two hours and answers 404 for exactly this.
   *
   * DELIBERATE: once. A second 404 is the server refusing a session it has just issued, which
   * must not become a retry loop against somebody else's endpoint.
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
    // DELIBERATE: every text block, not the first. Our own servers answer with one, and an
    // answer silently truncated to its first block looks complete.
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
