/**
 * The platform, over HTTP, from a script.
 *
 * Everything else on this platform reaches zz-core through the model's own MCP connection,
 * which is right for work that needs judgement. An import needs none: the mapping from an mma
 * journal node to a knowledge node is mechanical and there are several hundred of them. The
 * judgement stays in the skill and the moving stays here.
 *
 * COUPLED: the token is read in the same order as `packages/tools/src/lib/cli.ts` — $ZZ_TOKEN,
 * then $ZZ_TOKEN_FILE, then ~/.zz/token. Two answers to "where is the token" is how a tool
 * works in one place and 401s in the other.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** The marketplace this platform ships from. The filter below is about a credential, so it
 * must name one marketplace and never "whatever is installed". */
const MARKETPLACE = "zz-stack";
export function token() {
    const read = (p) => { try {
        return readFileSync(p, "utf8");
    }
    catch {
        return null;
    } };
    const t = process.env.ZZ_TOKEN
        || (process.env.ZZ_TOKEN_FILE ? read(process.env.ZZ_TOKEN_FILE) : null)
        || read(join(homedir(), ".zz", "token"));
    if (!t || !t.trim()) {
        throw new Error("No platform token. Looked at $ZZ_TOKEN, $ZZ_TOKEN_FILE and ~/.zz/token. " +
            "Ask for a token, then: (umask 077; mkdir -p ~/.zz) && (umask 077; printf '%s' \"$ZZ_TOKEN\" > ~/.zz/token)");
    }
    return t.trim();
}
/** `JSON.parse`'s result, narrowed to "an array of objects" — the one shape check that
 *  matters here, since every field below is read defensively (`typeof ... === "string"`)
 *  regardless. */
function asPluginArray(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((p) => typeof p === "object" && p !== null);
}
/** The gateway this machine's own zz plugin is pointed at.
 *
 * Read from the installed plugin, never written here: a base baked into this file would send
 * somebody's history to whichever deployment happened to be current the day it was typed. */
export function gateway() {
    let listed;
    try {
        listed = asPluginArray(JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })));
    }
    catch {
        throw new Error("Could not ask the claude CLI what is installed, so there is no way to " +
            "know which gateway to import into. Is `claude` on PATH?");
    }
    // Only this marketplace's plugins, and the reason is a credential rather than a hostname.
    // Walking every installed plugin and returning the first that names any MCP server hands back
    // another marketplace's host — and `Door` puts the platform token in an
    // `Authorization: Bearer` header on the very first request, so that sends somebody's platform
    // credential to a third party.
    //
    // COUPLED: `catalog/zz/zz-access/skills/zz-doctor/doctor.ts` filters to this marketplace by
    // the same rule, in the same words.
    const mine = listed.filter((p) => typeof p?.id === "string" && p.id.endsWith(`@${MARKETPLACE}`));
    // The core door by preference, then any door this marketplace's plugins declare. Every door
    // is on the same gateway, so either answers the question "which deployment" — but preferring
    // the one we are about to call keeps the answer obvious.
    const urls = mine.flatMap((p) => Object.values(p?.mcpServers ?? {}).map((sv) => sv?.url))
        .filter((u) => typeof u === "string");
    const host = (u) => /^(https?:\/\/[^/]+)/.exec(u)?.[1];
    for (const u of urls)
        if (u.includes("/core/mcp")) {
            const h = host(u);
            if (h)
                return h;
        }
    for (const u of urls) {
        const h = host(u);
        if (h)
            return h;
    }
    throw new Error(`No plugin from the ${MARKETPLACE} marketplace declares an MCP server, so ` +
        "this machine is not connected to the platform yet. Install the baseline first: " +
        "claude plugin marketplace add zhixuan312/zz-stack && claude plugin install zz-core@zz-stack");
}
const SSE_DATA = /^data: (.*)$/gm;
function asJsonRpcResponse(v) {
    return typeof v === "object" && v !== null ? v : {};
}
function asCallResult(v) {
    return typeof v === "object" && v !== null ? v : {};
}
/** One MCP door, as a callable.
 *
 * DELIBERATE: no handshake. The doors are stateless — no session id, nothing to keep alive —
 * and a `tools/call` on a cold connection is answered. So this never builds an `initialize`
 * and never names a protocol version; that string is written once, in `packages/mcp-client`.
 * Each call is one POST, and a retry is safe. */
export class Door {
    url;
    token;
    client;
    id;
    constructor(base, path, tok, client) {
        this.url = `${base}${path}`;
        this.token = tok;
        this.client = client;
        this.id = 0;
    }
    async #post(method, params) {
        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": `Bearer ${this.token}`,
                // Who is calling. The gateway correlates a skill load with the calls that follow it on
                // `x-zz-user-email` + `x-zz-client`, so a caller that omits this is not anonymous — it
                // joins the trace of every other process acting as the same person, silently, with the
                // numbers staying plausible.
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
        if (!res.ok)
            throw new Error(`${this.url} answered ${res.status}: ${body.slice(0, 300)}`);
        // The door answers as SSE even for a single reply; the JSON is the last `data:` frame.
        const frames = [...body.matchAll(SSE_DATA)].map((m) => m[1]);
        const raw = frames.length ? frames[frames.length - 1] : body;
        let msg;
        try {
            msg = asJsonRpcResponse(JSON.parse(raw));
        }
        catch {
            throw new Error(`${this.url} answered something that is not JSON: ${body.slice(0, 300)}`);
        }
        if (msg.error)
            throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        return msg.result;
    }
    /** A tool call, with the platform's refusals surfaced as failures.
     *
     * zz-core answers a refusal as a normal result whose text begins `ERROR:`, so a script that
     * only checked the JSON-RPC envelope would count every refusal as a success and report a
     * clean import over a store that received nothing. */
    async call(name, args) {
        const r = asCallResult(await this.#post("tools/call", { name, arguments: args }));
        const text = (r.content ?? []).map((c) => c.text ?? "").join("\n").trim();
        if (r.isError || /^ERROR:/.test(text))
            throw new Error(text || `${name} failed`);
        return text;
    }
}
