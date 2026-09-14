/**
 * Proxying a block: the call itself, and what the gateway does and does not pass on.
 *
 * Three sets, and each is a refusal rather than a convenience. Hop-by-hop headers belong to
 * one connection and forwarding them corrupts the next. The caller's own Authorization and
 * Cookie never reach a block — a block is told nothing about who is calling, which is the
 * invariant the whole delegated-access design rests on. And a block's own transport headers
 * are stripped from the response, because they describe its connection and not ours.
 */
import { Readable } from "node:stream";

import { personalCredential } from "@zz/contracts";
import express from "express";

import { delegatedToken } from "./block-oauth.js";
import { PLATFORMS } from "./blocks.js";
import { load } from "./credentials.js";
import { platformDb, platformDbReady } from "./db.js";
import { requestBase } from "./identity.js";
import { denialResponse, stageDenial } from "./stage-access.js";
import { callerKey } from "./step-trace.js";

export const HOP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive",
  "transfer-encoding", "upgrade", "proxy-authorization",
]);
/** Headers that must NEVER leave this gateway, whatever the destination.
 *
 * `authorization` carries the caller's zz PAT. The /core proxy dropped it by naming it
 * inline; the BLOCK proxy did not, so every third-party platform a block points at
 * received a token that authenticates as that person against this platform: their
 * documents, their team's knowledge, their whole access. Verified by
 * pointing a block at an echo server, which received both its own X-API-Key and the PAT.
 *
 * A block is given exactly one credential: its own, injected below. Nothing about how the
 * caller proved who they are is any of its business.
 *
 * Naming it here rather than at each call site is the point — the /core proxy remembered
 * and the block proxy forgot, and there was nothing to notice the difference. */
export const NEVER_FORWARD = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Upstream response headers that must not reach the caller.
 *
 * The first four are hop-by-hop: this gateway re-frames the body, so passing them through
 * describes the wrong connection. `set-cookie` is here for a different reason — a block is
 * a THIRD PARTY, and its response is streamed to a browser session on our origin. A
 * compromised or merely careless block could set a cookie in the caller's context. Nothing
 * a block returns has any business establishing state with our client. */
export const STRIP_RESPONSE = new Set([
  "content-length", "transfer-encoding", "content-encoding", "connection",
  "set-cookie", "set-cookie2",
]);
/** Relay an upstream response body to the caller, and SURVIVE it dying mid-stream.
 *
 * `.pipe()` does not forward errors. A Readable that errors with no `error` listener raises
 * an unhandled `error` event, and Node's default for that is `throw` — from an async socket
 * callback, where nothing can catch it. So when a block closed its socket mid-response
 * (`SocketError: other side closed`, routine for a long tool call against staging), the
 * whole proxy exited. It restarted twice in one afternoon, and each exit dropped EVERY
 * user's session, not the one request that failed — a flaky dependency taking down the
 * platform's front door.
 *
 * The two relays here were the only unguarded pipes, and both of them carry other people's
 * traffic. A truncated response to one caller is the correct blast radius. */
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

// AN MCP DOOR NEVER ANSWERS WITH AN HTTP ERROR STATUS. This is that rule, in one place.
//
// The MCP client SDK treats the HTTP status as the health of the TRANSPORT, not as the answer
// to the call. Read its POST path: 401 and 403-with-insufficient_scope start an auth flow, and
// every other non-2xx — 403, 404, 500, 502 alike — becomes
// `throw new StreamableHTTPError(status, "Error POSTing to endpoint: " + text)`. LibreChat
// counts three of those and opens a per-user circuit breaker over the whole block, after which
// blocked attempts count as further failures and it never closes.
//
// So a refusal we wrote to be READ — "you are acting for team 'x', which is not granted block
// 'casebox' — your team 'y' is: switch_team to it" — never reached the agent at all. It arrived as a
// dead socket, the agent concluded the block was unreachable, and it told the person to
// reconnect their credentials. That is the loop this platform has been stuck in: our clearest,
// most actionable sentences were the ones most reliably converted into "please re-authenticate".
//
// A JSON-RPC error inside a 200 is the opposite in every way that matters. The transport stays
// up, the breaker stays shut, the failure stays scoped to the ONE call, and the agent reads the
// sentence and can act on it. The HTTP status carries transport health; the body carries the
// answer. Two channels, two meanings — conflating them is what cost us the 52.
//
// The deliberate exceptions, both spec-mandated and both explicitly tolerated by the client:
// 405 on GET (we do not offer the server-to-client stream) and 401 with a WWW-Authenticate
// challenge (an auth challenge is a transport-level fact and the client is built to act on it).
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
export async function proxy(req: express.Request, res: express.Response): Promise<void> {
  const platform = req.params.platform as string;
  const conf = PLATFORMS[platform];
  if (!conf) {
    mcpRefusal(req, res, `There is no block called '${platform}' on this platform. Check the ` +
      "name against the blocks your team is granted rather than treating this as a connection problem.",
      -32601);
    return;
  }

  // FROM THE REQUEST, not from caller().
  //
  // caller() reads requestHeaders(), and that is an AsyncLocalStorage store entered in
  // exactly one place: serveMcp's own route handler. This proxy is a plain `app.all`, so the
  // store was never entered and requestHeaders() returned {} — while the middleware had
  // written the caller's address onto `req.headers` three lines earlier. Verified by running
  // both shapes side by side against the real serveMcp.
  //
  // So `email` was always "", resolveCredential looked the personal key up under the empty
  // address, found nothing, and every block call fell through to the team's shared key. A
  // person who had stored their own key spent the team's quota under the team's permissions,
  // and nothing said so: `level` came back "team" for everybody. "A personal key always
  // wins" is what this platform tells people, in the tool description, in the door index and
  // in the guidance below — and on this path it never won.
  //
  // The next line down already reads req.zzIdentity for the acting team, which is what makes
  // this the odd one out rather than a missing capability.
  const email = req.zzIdentity?.email ?? "";

  // registry enforcement: once a caller's team has ANY block grants recorded,
  // only granted blocks pass. A team with no grants recorded still passes freely — that is
  // deliberate, and it is what makes the first grant meaningful.
  //
  // A caller with NO TEAMS used to pass freely too, which is the rule inverted: grants are
  // held by teams, so belonging to none can only mean "granted nothing", and it came out
  // meaning "granted everything". Anyone on the platform can mint themselves a token and
  // store their own block key, so this was reachable without any admin action at all.
  //
  // Still skipped entirely when the platform database is unavailable: the identity's teams
  // come from that database, so treating "cannot ask" as "belongs to nothing" would take
  // every block away from everyone during an outage.
  const idn = req.zzIdentity;
  if (idn && platformDbReady()) {
    if (idn.teams.length === 0) {
      mcpRefusal(req, res, `You are in no team, and block access is granted to teams — ask a ` +
        `platform admin to add you to one before using '${platform}'. This is not a credential ` +
        `problem and signing in again will not change it.`);
      return;
    }
    // THE TEAM THAT AUTHORISES THE CALL IS THE TEAM THAT PAYS FOR IT. This asked whether ANY
    // of the caller's teams was granted the block, and resolveCredential three lines below
    // spends the ACTING team's key — so somebody in team A (granted casebox) and team B (not
    // granted, with a shared casebox key) could act for B, pass this on A's grant, and spend B's
    // key on a block B was never given. That is the incoherence actingTeam's own docstring
    // names: documents landing in one team's store while the block call spends another's.
    //
    // The client package is deliberately the union across a person's teams — it is a file on
    // their machine and cannot re-render when they switch. So the package offering a block is
    // not a claim that every team may call it, and this is where that narrows.
    const grants = await platformDb().query<{ team: string; block: string }>(
      `select t.slug as team, g.block from tool_grant g join team t on t.id = g.team_id
        where t.slug = any($1)`,
      [idn.teams.map((t) => t.slug)],
    );
    // A team with NO grants recorded still passes freely — that is what makes the first grant
    // meaningful, and it is asked of the acting team alone for the same reason as above.
    // A token bound to a team its owner is not in resolves to NO acting team. It has no
    // store, no key and no quota, so it has nothing to call a block with either — and
    // leaving it to fall through the grant check would have given a mis-bound token more
    // access than a correctly bound one.
    const acting = idn.activeTeam;
    if (!acting) {
      mcpRefusal(req, res, `Your token is bound to team '${idn.patTeam}', which you are not a ` +
        `member of, so it acts for no team and cannot reach block '${platform}'. Ask a platform ` +
        `admin to add you to that team or issue a token for one you are in.`);
      return;
    }
    const actingHasGrants = grants.rows.some((g) => g.team === acting);
    if (actingHasGrants && !grants.rows.some((g) => g.team === acting && g.block === platform)) {
      // Naming the team that DOES have it turns a refusal into an instruction: switching is
      // something the caller can do themselves, asking an admin to grant is not.
      const elsewhere = [...new Set(grants.rows.filter((g) => g.block === platform).map((g) => g.team))];
      mcpRefusal(req, res,
        `You are acting for team '${acting}', which is not granted block '${platform}'` +
        (elsewhere.length
          ? ` — your team ${elsewhere.join(" or ")} is: switch_team to it, or a platform admin can grant_tool it to '${acting}'.`
          : ` — a platform admin can grant_tool it.`) +
        " Your credential is fine; this is a grant, not a sign-in.");
      return;
    }
  }

  // WHICH STAGE IS CALLING, and whether that stage may call this block.
  //
  // Sits after the team grant and before any credential is resolved, because the two answer
  // different questions and the order matters for what gets spent: the grant asks whether the
  // TEAM may reach this block at all, and this asks whether the STAGE now running may. A call
  // refused here must not have gone as far as picking a key.
  //
  // `caller` is spelled the same way tool-telemetry spells it, and it has to be: the map it
  // keys is the one `skill_read` writes when a stage's skill is served. Two spellings would
  // mean enforcement reading an empty trace and letting everything through, which is the
  // failure that looks exactly like success.
  {
    const rpc = (req.body ?? {}) as { method?: string; id?: unknown };
    const caller = callerKey(req.headers as Record<string, unknown>);
    const why = await stageDenial(caller, req.zzIdentity?.activeTeam ?? null, platform,
                                  rpc.method ?? "");
    if (why) {
      res.json(denialResponse(rpc.id, why));
      return;
    }
  }

  // Personal key first, the team's second. A new joiner works on day one on the team's key;
  // anyone wanting their own quota or permissions stores one and it wins. The audit below
  // records the PERSON either way — whose key spent the quota is a separate fact from who
  // made the call, and conflating them is how "who did this" stops being answerable.
  // THE PERSON'S OWN DELEGATED ACCESS COMES FIRST, ahead of any stored key. When they have
  // signed in to this block themselves, the call is made as them: the block's audit log names
  // them, and its own limits apply rather than whatever a shared key could reach.
  //
  // Falling back to a stored key when they have not is deliberate and is the only reason this
  // is safe to turn on — nobody's access breaks the day it ships. What it must never do is
  // fall back SILENTLY after a delegated token was revoked, which is why an expired refresh
  // chain deletes the row: the next call then has no token, takes the stored key, and the
  // audit record shows the change of actor instead of hiding it.
  const delegated = conf.header
    ? await delegatedToken(req.zzIdentity?.email ?? "", platform, conf.url)
    : null;
  const resolved = conf.header && !delegated
    ? personalCredential(load(), email, platform)
    : null;
  const key = resolved?.key;
  if (conf.header && !key && !delegated) {
    // NOT CONNECTED IS A 401, AND IT USED TO BE A 200 THAT LIED.
    //
    // This served a stub MCP session: `initialize` answered 200 and `tools/list` offered one
    // tool, `credential_required`, whose description carried the onboarding guidance. The
    // reasoning was that an agent should see a sentence rather than the block silently
    // vanishing, and for an agent that was true.
    //
    // For a PERSON it was a disaster, and it is the thing this whole piece of work started
    // from. LibreChat marks a server `connected` when `initialize` returns 200 — that is the
    // entire test, read from its source — so a block nobody had signed in to showed the same
    // green dot as one they were using. Six green dots, and then a block that refuses. Asked
    // to explain it, the agent had no way to tell "you are not connected" from "the platform
    // is broken", and it reliably chose the second and told people to reconnect credentials
    // that were fine.
    //
    // A 401 carrying a WWW-Authenticate challenge says the true thing in the language the
    // client already speaks: it discovers our authorization server, the dot stops being
    // green, and Connect runs THIS BLOCK's own OAuth — which is the one credential actually
    // missing. The agent no longer needs a stub tool to explain the situation, because the
    // situation is now visible in the panel where it belongs.
    //
    // This is one of the two exemptions from "an MCP door never answers with an HTTP error
    // status": the client special-cases 401-with-a-challenge as a handshake rather than a
    // transport failure. A bare 401 here would be the bug that rule exists to catch.
    // Relative to the door the caller reached, never the public address — RFC 9728 §3.3 has
    // the client compare the two and refuse when they differ. See requestBase (identity.ts).
    res.set("WWW-Authenticate",
            `Bearer resource_metadata="${requestBase(req)}/.well-known/oauth-protected-resource/p/${platform}/mcp"`);
    res.status(401).json({
      error: `${conf.name} is not connected for ${email || "this user"}. Sign in to it from ` +
             "the MCP settings in this front end — that runs the block's own sign-in and " +
             "nothing is stored by the platform. Your ZZ access is unaffected.",
    });
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    // EVERY x-zz-*, by prefix rather than by name. These are stamped by this gateway's own
    // middleware and every one of them describes the caller; a block is a third party and
    // none of it is its business. Written as a list of names it was already wrong once —
    // `x-zz-via`, `x-zz-pat-scope` and `x-zz-pat-team` were added after the list and so told
    // every third-party platform how the person authenticated and which team their token is
    // bound to. The prefix is the rule; a list is the instances somebody had thought of.
    //
    // The /core proxy above deliberately does NOT do this: zz-core is us, and those headers
    // are how it knows who is calling.
    if (HOP_HEADERS.has(lk) || NEVER_FORWARD.has(lk) ||
        lk.startsWith("x-zz-")) continue;
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }
  // A block with no declared header takes no credential — nothing to inject.
  if (delegated) headers["authorization"] = `Bearer ${delegated.token}`;
  else if (conf.header && key) headers[conf.header] = key;

  const hasBody = req.method !== "GET" && req.method !== "DELETE";
  const upstream = await fetch(conf.url, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    signal: req.method === "GET" ? undefined : AbortSignal.timeout(120_000),
  });

  // Telemetry for this call is taken at the door by toolCallTelemetry, which reads the
  // ANSWER. This site could only reach the transport status, and an MCP refusal is a 200 —
  // so `{status: 200}` was the entire record of 2,369 calls and could not tell one that
  // worked from one the platform refused.

  // AN MCP DOOR ANSWERS MCP, WHATEVER THE BLOCK'S EDGE DID.
  //
  // A block is a third party behind somebody else's CDN, and when that edge has a bad moment
  // it answers with an HTML error page. This relayed it verbatim, so an MCP client received
  // `<html>…` where it expects JSON or an SSE stream. It cannot parse that, so it does not
  // report "casebox returned 502" — it reports a TRANSPORT error, and LibreChat's per-user circuit
  // breaker opens after three of those and then blocks every further attempt. Each blocked
  // attempt counts as another failure, so an agent retrying holds its own breaker open.
  //
  // One transient upstream blip on a block becomes a hard outage for the person behind it, and their agent — seeing a block that offers only `credential_required` —
  // told them their OAuth sign-in had not landed and to go and do it again. It had landed
  // four minutes earlier and was valid for another twelve hours. That is the real cost: not
  // the blip, but a diagnosis that sends a person to redo the one thing that was fine.
  //
  // So a non-MCP content type on this door becomes a JSON-RPC error that SAYS what happened.
  // The block's status and content type are named, because the next person to read it should
  // not have to guess which of the three parties broke.
  const ctype = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const speaksMcp = ctype.includes("json") || ctype.includes("event-stream");
  if (!speaksMcp) {
    console.error(`block ${platform}: upstream answered ${upstream.status} as '${ctype || "no content-type"}' — not MCP; ` +
                  "returning a JSON-RPC error rather than relaying it");
    // The MCP layer reads the ENVELOPE, not the HTTP status, so this is a 200 carrying an
    // error — the same shape every refusal on this platform takes.
    res.status(200).json({
      jsonrpc: "2.0",
      id: (req.body as { id?: unknown } | undefined)?.id ?? null,
      error: {
        code: -32603,
        message:
          `${platform} did not answer as MCP: its server returned HTTP ${upstream.status} ` +
          `as '${ctype || "no content-type"}'. This is the block's own edge, not your ` +
          "credential and not this platform — your connection is unaffected. Retry; if it " +
          "persists, the block is down.",
      },
    });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((v, k) => {
    if (!STRIP_RESPONSE.has(k.toLowerCase())) res.setHeader(k, v);
  });
  relayBody(upstream.body, res, `block ${platform}`);
}
