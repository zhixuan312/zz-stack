/**
 * The platform, over HTTP, from a script.
 *
 * WHY A SCRIPT CALLS THE TOOLS AT ALL. Everything else on this platform reaches zz-core
 * through the model's own MCP connection, and that is right for work that needs judgement.
 * An import needs none: the mapping from an mma journal node to a knowledge node is
 * mechanical, and there are several hundred of them. Pushing several hundred documents
 * through a conversation would cost more than the corpus is worth and would fail halfway
 * through, at a different place every time. So the judgement stays in the skill and the
 * moving stays here.
 *
 * The token is read the same way the MCP header helper reads it, in the same order, for the
 * same reason: two answers to "where is the token" is how a tool works in one place and 401s
 * in the other.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function token() {
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  const t = process.env.ZZ_TOKEN
    || (process.env.ZZ_TOKEN_FILE ? read(process.env.ZZ_TOKEN_FILE) : null)
    || read(join(homedir(), ".zz", "token"));
  if (!t || !t.trim()) {
    throw new Error("No platform token. Looked at $ZZ_TOKEN, $ZZ_TOKEN_FILE and ~/.zz/token. " +
      "Ask for a token, then: (umask 077; mkdir -p ~/.zz) && (umask 077; printf '%s' \"$ZZ_TOKEN\" > ~/.zz/token)");
  }
  return t.trim();
}

/** The gateway this machine's own zz plugin is pointed at.
 *
 * Read from the installed plugin, never written here: a base baked into this file would send
 * somebody's history to whichever deployment happened to be current the day it was typed. */
export function gateway() {
  let listed;
  try {
    listed = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    throw new Error("Could not ask the claude CLI what is installed, so there is no way to " +
      "know which gateway to import into. Is `claude` on PATH?");
  }
  for (const p of listed) {
    for (const sv of Object.values(p?.mcpServers ?? {})) {
      const m = /^(https?:\/\/[^/]+)/.exec(sv?.url ?? "");
      if (m) return m[1];
    }
  }
  throw new Error("No installed plugin declares an MCP server, so this machine is not " +
    "connected to a platform yet. Install the baseline first: " +
    "claude plugin marketplace add zhixuan312/zz-stack && claude plugin install zz@zz-stack");
}

const SSE_DATA = /^data: (.*)$/gm;

/** One MCP door, as a callable.
 *
 * NO HANDSHAKE. The doors are stateless — no session id, nothing to keep alive — and a
 * `tools/call` on a cold connection is answered. So this never builds an `initialize`, which
 * means it never names a protocol version: that string is written once, in
 * `packages/mcp-client`, and a copy of it here would be a second answer to drift away from
 * it the day the gateway stops accepting the older one. Each call is one POST, and a retry
 * is safe. */
export class Door {
  constructor(base, path, tok, client) {
    this.url = `${base}${path}`; this.token = tok; this.client = client; this.id = 0;
  }

  async #post(method, params) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${this.token}`,
        // WHO IS CALLING. The gateway correlates a skill load with the calls that follow it
        // on `x-zz-user-email` + `x-zz-client`, so a caller that omits this does not become
        // anonymous — it JOINS the trace of every other process acting as the same person,
        // including that person's own chat session. An import of several hundred writes
        // landing in somebody's skill telemetry is exactly the corruption that key exists to
        // prevent, and it is silent: the numbers stay plausible.
        "X-ZZ-Client": this.client,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${this.url} refused the token (${res.status}). It is expired, mistyped, ` +
                      "or issued by another deployment.");
    }
    if (!res.ok) throw new Error(`${this.url} answered ${res.status}: ${body.slice(0, 300)}`);
    // The door answers as SSE even for a single reply; the JSON is the last `data:` frame.
    const frames = [...body.matchAll(SSE_DATA)].map((m) => m[1]);
    const raw = frames.length ? frames[frames.length - 1] : body;
    let msg;
    try { msg = JSON.parse(raw); }
    catch { throw new Error(`${this.url} answered something that is not JSON: ${body.slice(0, 300)}`); }
    if (msg.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  /** A tool call, with the platform's REFUSALS surfaced as failures.
   *
   * zz-core answers a refusal as a normal result whose text begins `ERROR:` — that is
   * deliberate, so a model reads the sentence and fixes the call. A script that only checked
   * the JSON-RPC envelope would count every refusal as a success and report a clean import
   * over a store that received nothing. */
  async call(name, args) {
    const r = await this.#post("tools/call", { name, arguments: args });
    const text = (r?.content ?? []).map((c) => c.text ?? "").join("\n").trim();
    if (r?.isError || /^ERROR:/.test(text)) throw new Error(text || `${name} failed`);
    return text;
  }
}
