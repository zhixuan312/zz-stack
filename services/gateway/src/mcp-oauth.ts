/**
 * The gateway as an OAuth 2.1 authorization server for its OWN MCP doors.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A person used to reach a door by pasting a platform token into a box in the front end's
 * settings, under the words "ask ZZ Access for one". That is a secret carried through a human
 * and a clipboard to arrive somewhere it was always going to arrive, and every joiner had to
 * be walked through it.
 *
 * It also made the connection panel incapable of telling the truth. LibreChat marks a server
 * `connected` when `initialize` returns 200 — that is the whole test, read from its source —
 * and a door with no credential answered 200 with a one-tool stub so the agent would at least
 * see some guidance. So every server showed green, connected or not, and a person looking at
 * six green dots learned nothing at all. The complaint that started this work was exactly
 * that: green, and then a block that would not answer.
 *
 * An MCP client already knows how to do better, and is built to: refuse it with a 401 carrying
 * a WWW-Authenticate challenge and it discovers the authorization server, registers itself,
 * sends the person to sign in, and holds the resulting token itself. Nobody pastes anything,
 * and green means a handshake completed rather than a stub answered.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 *   GET  /.well-known/oauth-protected-resource/<door>   who authorises this door (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server        how (RFC 8414)
 *   POST /oauth/register                                the client registers itself (RFC 7591)
 *   GET  /oauth/authorize                               the person signs in and consents
 *   POST /oauth/token                                   the code becomes a platform token
 *
 * The access token IS a PAT. That is deliberate and is what keeps this small: `Identity.via`
 * stays the closed three-value union it is, `mayReadConsole` stays the literal
 * `via === "session"`, telemetry keeps counting what it counted, and every reader downstream
 * is unchanged. A fourth `via` would have touched all of them to express a distinction nobody
 * downstream needs — the token was minted by this platform for this person either way.
 *
 * ── PUBLIC CLIENTS ONLY ─────────────────────────────────────────────────────
 *
 * No client secret is issued and none is accepted. The alternative is a secret sitting in a
 * bind-mounted yaml on a deploy host, rsynced around, which is the same disease as the pasted
 * token one layer down. PKCE (S256, mandatory) is what proves the exchange instead.
 */
import { createHash, randomBytes } from "node:crypto";

import { mintPat } from "@zz/contracts";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";
import { browserSession, requestBase, sha256 } from "./identity.js";
import { escapeHtml } from "./markdown.js";

const PUBLIC = (process.env.GATEWAY_PUBLIC_URL ?? "").replace(/\/+$/, "");

/** Where a BROWSER is sent to authorize, which is not where a program calls this platform.
 *
 * Everything else here is read by the front end's server — discovery, registration, the token
 * exchange — and api.<host> is right for those. `/oauth/authorize` is the one endpoint a
 * PERSON opens, and it has to answer "who is at this keyboard" from the `zz_console` cookie.
 * That cookie is set by /auth/* on the console's origin and is HOST-ONLY by design, so
 * api.<host> cannot read it: served there, every authorize saw no session, sent the person to
 * sign in, and the provider's callback returned them to the console origin — which served no
 * /oauth/authorize and answered 404 with the authorization still unfinished.
 *
 * So this endpoint is advertised on the console's origin, which the Caddyfile proxies to this
 * same gateway. Falls back to the api address when no console is configured, which is a
 * deployment with no browser sign-in to offer anyway. */
const AUTHORIZE_ON = ((process.env.CONSOLE_PUBLIC_URL ?? "").replace(/\/+$/, "") || PUBLIC);

/** Whether a client may be handed authorization codes at this redirect.
 *
 * AN OPEN REGISTRATION ENDPOINT WITH NO ALLOWLIST IS AN OPEN REDIRECT FOR AUTHORIZATION
 * CODES. Anyone may call /oauth/register — they must be able to, it is how a client
 * introduces itself. Without a check, an attacker registers a client whose redirect is their
 * own server, gets a signed-in person to open one authorize link, and exchanges the code for
 * a platform token issued AS THAT PERSON. PKCE does not help: it binds the exchange to
 * whoever started it, and the attacker started it.
 *
 * TWO KINDS OF CLIENT REACH THIS PLATFORM, and the rule differs because the risk does.
 *
 * A LOOPBACK REDIRECT is how every native client works — Claude Code, Codex, anything running
 * on the person's own machine opens a port and waits. RFC 8252 §7.3 says to allow these and to
 * ignore the port, because the client cannot know which port it will get. The code goes to a
 * server on the same machine as the browser that was redirected; an attacker who could receive
 * it there could read the token from the client's own storage anyway.
 *
 * ANY OTHER ORIGIN must be named in OAUTH_REDIRECT_ORIGINS, comma-separated — a hosted
 * client whose servers receive the code, which on this deployment means ChatGPT
 * (`https://chatgpt.com`; it redirects to more than one path there, so the rule is by origin).
 * It was `LIBRECHAT_PUBLIC_URL` until 2026-09-10, a single origin for a front end that has
 * since gone.
 *
 * A HOSTED CLIENT IS ALSO WHY THERE IS A CONSENT PAGE. Anyone may register a client with
 * chatgpt.com as its redirect and point their OWN connector at a door here; a signed-in person
 * who opens that client's authorize link would then hand a platform token to the stranger's
 * connector without seeing anything. So every non-loopback authorization stops and asks.
 */
const EXTRA_ORIGINS = (process.env.OAUTH_REDIRECT_ORIGINS ?? "")
  .split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);

/** Loopback by ADDRESS, never by name: `localhost` can be made to resolve elsewhere, and a
 * redirect that leaves the machine is the thing being prevented. */
function isLoopback(u: URL): boolean {
  const local = u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  return local && (u.protocol === "http:" || u.protocol === "https:");
}

function redirectAllowed(uri: string): { ok: true } | { ok: false; why: string } {
  let u: URL;
  try { u = new URL(uri); } catch { return { ok: false, why: `'${uri}' is not a URL` }; }
  if (isLoopback(u)) return { ok: true };
  if (u.hostname === "localhost") {
    return { ok: false, why: `redirect_uri '${uri}' uses the name 'localhost'. Use 127.0.0.1 — a ` +
      "name can be pointed at another machine, and an address cannot." };
  }
  if (EXTRA_ORIGINS.includes(u.origin)) return { ok: true };
  return { ok: false, why: `redirect_uri '${uri}' is neither a loopback address nor an origin ` +
    `this platform allows${EXTRA_ORIGINS.length ? ` (${EXTRA_ORIGINS.join(", ")})` : " (none are configured)"}. ` +
    "An authorization code sent elsewhere is a platform token issued to whoever asked for it." };
}

/** How long a minted token lives.
 *
 * Ninety days, and the number is a decision rather than a default. Expiry is the exact
 * experience this whole change exists to end — "your connection needs reconnecting" — so
 * until the refresh_token grant lands, a short life would reintroduce the complaint through
 * the front door. LibreChat treats a token with no expiry as eternal, which is worse: a
 * revoked token would then never be retried. Ninety days is long enough that nobody meets it
 * by accident and short enough that a forgotten laptop is not forever. */
const TOKEN_TTL_DAYS = 90;

const b64 = (b: Buffer): string => b.toString("base64url");

/** The door a `resource` names, as a path — or null if it names none of ours.
 *
 * The client sends back exactly the URL it connected to, which on this deployment is the
 * INTERNAL one (`http://cred-proxy:8000/p/casebox/mcp`) because that is what librechat.yaml points
 * at. So this reads the path and ignores the origin: the origin is a routing detail of
 * whichever network the client sits on, and the door is what we are authorising. */
function doorOf(resource: string): string | null {
  let path: string;
  try { path = new URL(resource).pathname; } catch { return null; }
  path = path.replace(/\/+$/, "");
  if (/^\/(core|manage)\/mcp$/.test(path)) return path;
  if (/^\/p\/[a-z0-9-]+\/mcp$/.test(path)) return path;
  return null;
}

/** A one-line HTML page for the handful of things a BROWSER can be told here.
 *
 * These are the only errors a person ever sees from this file; everything else answers a
 * program in JSON. Plain, and it says what to do next rather than only what went wrong. */
function say(res: Response, status: number, title: string, detail: string): void {
  res.status(status).type("text/html").send(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
    `<h1 style="font-size:1.3rem">${title}</h1><p>${detail}</p></body>`);
}

/** The fields an authorization arrives with — carried through the consent form unchanged. */
const AUTHZ_FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge",
                      "code_challenge_method", "resource", "state"] as const;

/** The question a hosted client's authorization stops on.
 *
 * THE CLIENT NAMES ITSELF, SO ITS NAME PROVES NOTHING. Anyone registering may call themselves
 * "ChatGPT"; what they cannot forge is where the code goes, so that is the line in bold. The
 * page refuses to be framed, because a consent page under someone else's overlay is a click
 * they did not mean. */
function consentPage(res: Response, f: Record<string, string>, who: { email: string; admin: boolean },
                     clientName: string, door: string): void {
  const dest = new URL(f.redirect_uri).origin;
  const hidden = AUTHZ_FIELDS.map((k) =>
    `<input type="hidden" name="${k}" value="${escapeHtml(f[k] ?? "")}">`).join("");
  const reach = who.admin
    ? "everything you can reach, <b>including platform administration</b> — you are a superadmin"
    : "your teams' documents and knowledge, with the same access you have in the console";
  const btn = "font:inherit;padding:.5rem 1.2rem;margin-right:.6rem;border-radius:6px;cursor:pointer";
  res.set({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'",
            "Cache-Control": "no-store" });
  res.status(200).type("text/html").send(
    `<!doctype html><meta charset="utf-8"><title>Connect to ZZ?</title>` +
    `<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
    `<h1 style="font-size:1.3rem">Connect ${escapeHtml(clientName || dest)} to ZZ?</h1>` +
    `<p>It is asking to use <code>${escapeHtml(door)}</code> as <b>${escapeHtml(who.email)}</b>, ` +
    `and will be able to read and change ${reach}.</p>` +
    `<p>The connection is handed to <b>${escapeHtml(dest)}</b>. If you did not just press ` +
    `Connect there yourself, choose Deny.</p>` +
    `<form method="post" action="/oauth/authorize">${hidden}` +
    `<button name="decision" value="allow" style="${btn};background:#111;color:#fff;border:0">Allow</button>` +
    `<button name="decision" value="deny" style="${btn};background:none;border:1px solid #999">Deny</button>` +
    `</form></body>`);
}

export function mountMcpOauth(app: Express): void {
  // ── discovery ─────────────────────────────────────────────────────────────
  //
  // RFC 9728 says a resource server publishes this at
  // `/.well-known/oauth-protected-resource` + its own path, and clients also try the bare
  // form. Both are served, for every door, from one handler.
  // Express 4 here, so the wildcard is a bare `*`. `*splat` is Express 5's named form: it
  // registers a route matching a LITERAL "*splat" segment, which is to say nothing at all —
  // the bare path answered and every per-door path 404'd, which is the half that clients
  // actually fetch.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"],
    (req: Request, res: Response) => {
      const suffix = req.path.replace("/.well-known/oauth-protected-resource", "") || "/";
      // THE RESOURCE IS THE URL THE CLIENT ACTUALLY CONNECTED TO, not our public one. The SDK
      // compares this against the server URL it holds, and on this deployment those differ:
      // the front end reaches `http://cred-proxy:8000/...` on the compose network while a
      // browser reaches `https://api.…`. Answering with PUBLIC here fails that comparison and
      // the client abandons the flow with nothing useful to say.
      res.json({
        resource: `${requestBase(req)}${suffix === "/" ? "" : suffix}`,
        authorization_servers: [PUBLIC],
        bearer_methods_supported: ["header"],
      });
    });

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*"],
    (_req: Request, res: Response) => {
      res.json({
        issuer: PUBLIC,
        authorization_endpoint: `${AUTHORIZE_ON}/oauth/authorize`,
        token_endpoint: `${PUBLIC}/oauth/token`,
        registration_endpoint: `${PUBLIC}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        // S256 ALONE. `plain` is in the spec and is worth nothing: a challenge equal to its
        // own verifier proves that whoever redeems the code can read the request that started
        // it, which is exactly what an interceptor can do.
        code_challenge_methods_supported: ["S256"],
        // Public clients. See the header.
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

  // ── registration ──────────────────────────────────────────────────────────
  app.post("/oauth/register", (req: Request, res: Response) => {
    void (async () => {
      if (!platformDbReady()) { res.status(503).json({ error: "temporarily_unavailable" }); return; }
      const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") as string[] : [];
      if (uris.length === 0) {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
        return;
      }
      for (const u of uris) {
        const verdict = redirectAllowed(u);
        if (!verdict.ok) {
          // Named, not silently dropped. Whoever sees this is wiring up a client, and "which
          // redirect then?" is the only question they have.
          res.status(400).json({ error: "invalid_redirect_uri", error_description: verdict.why });
          return;
        }
      }
      const clientId = b64(randomBytes(24));
      const name = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "";
      await platformDb().query(
        "insert into zz.mcp_oauth_client (client_id, redirect_uris, name) values ($1,$2,$3)",
        [clientId, JSON.stringify(uris), name]);
      res.status(201).json({
        client_id: clientId,
        redirect_uris: uris,
        client_name: name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      });
    })().catch((err: unknown) => {
      console.error("oauth register failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
  });

  // ── authorize ─────────────────────────────────────────────────────────────
  //
  // One authorization, reached two ways: GET is the client sending the person here, POST is
  // the person answering the consent page. The POST re-validates everything, because its
  // fields came back through a browser and are exactly as trustworthy as the query was.
  const authorize = (req: Request, res: Response, input: Record<string, unknown>,
                     decision: "allow" | "deny" | null): void => {
    void (async () => {
      if (!platformDbReady()) { say(res, 503, "Not right now", "The platform database is unavailable. This is usually brief — try again in a moment."); return; }
      const q: Record<string, string> = Object.fromEntries(AUTHZ_FIELDS.map((k) =>
        [k, typeof input[k] === "string" ? input[k] as string : ""]));
      const clientId = q.client_id;
      const redirectUri = q.redirect_uri;
      const challenge = q.code_challenge;
      const method = q.code_challenge_method;
      const resource = q.resource;
      const state = q.state;

      // EVERY REFUSAL BEFORE THE REDIRECT IS VALIDATED GOES TO THE PERSON, NOT TO THE CLIENT.
      // Bouncing an error to a redirect_uri we have not yet verified is how an authorization
      // server becomes an open redirect on its error path instead of its success path.
      const { rows } = await platformDb().query<{ redirect_uris: string[]; name: string }>(
        "select redirect_uris, name from zz.mcp_oauth_client where client_id = $1", [clientId]);
      const client = rows[0];
      if (!client) { say(res, 400, "Unknown application", "This sign-in link came from an application this platform does not know. Ask it to register again."); return; }
      if (!client.redirect_uris.includes(redirectUri)) {
        say(res, 400, "That address is not registered",
            "The application asked us to send the result somewhere it did not register. Nothing has been shared.");
        return;
      }
      if ((q.response_type ?? "") !== "code") { say(res, 400, "Unsupported request", "Only the authorization code flow is available here."); return; }
      if (!challenge || method !== "S256") {
        say(res, 400, "This application is out of date",
            "It did not present a PKCE S256 challenge, which this platform requires of every client.");
        return;
      }
      const door = doorOf(resource);
      if (!door) {
        say(res, 400, "Unknown resource",
            `'${resource || "(none)"}' is not one of this platform's MCP doors, so there is nothing here to authorise.`);
        return;
      }

      // WHO IS AT THE KEYBOARD. No session means they have not signed in yet, and the answer
      // to that is a sign-in, not a refusal — the console's own `/login?next=` returns them
      // here with everything they arrived with.
      const me = await browserSession(req);
      if (!me) {
        // A POST has no query to come back to, and a person answering the consent page was
        // signed in a moment ago — so the session ended in between, and the client restarts.
        if (decision) { say(res, 401, "Your sign-in has ended", "Nothing has been shared. Go back to the application and connect again."); return; }
        // requestBase, not a constant: this endpoint is reached on the console's origin and
        // the sign-in screen is a page of that same app. Sending them anywhere else is what
        // produced the 404. `/login` rather than `/auth/…` because the passkey ceremony is
        // driven by the page's own script — there is no server route to navigate to.
        res.redirect(`${requestBase(req)}/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      const pr = await platformDb().query<{ id: string; role: string }>(
        "select id::text as id, role from principal where email = $1", [me.email]);
      const principalId = pr.rows[0]?.id;
      if (!principalId) { say(res, 403, "No account", `${me.email} is not a principal on this platform.`); return; }

      // A HOSTED CLIENT WAITS FOR THE PERSON; a loopback one does not. See the header of
      // `redirectAllowed` for why. Deny is answered to the client, which is safe now that the
      // redirect has been checked against what it registered.
      if (!isLoopback(new URL(redirectUri))) {
        if (decision === null) {
          consentPage(res, q, { email: me.email, admin: pr.rows[0]?.role === "superadmin" },
                      client.name, door);
          return;
        }
        if (decision === "deny") {
          const back = new URL(redirectUri);
          back.searchParams.set("error", "access_denied");
          if (state) back.searchParams.set("state", state);
          res.redirect(303, back.toString());
          return;
        }
      }

      // A BLOCK DOOR NEEDS TWO CREDENTIALS, AND CONNECT IS ONE GESTURE.
      //
      /* A DOOR ON THIS GATEWAY IS THE ONLY RESOURCE NOW. This used to branch: when the
         resource was a third party's server the caller had not connected, the flow sent them
         to THAT server's consent screen first and let its callback finish the authorization,
         so the platform token could not be minted before the other party had said yes. There
         is no other party any more — a plugin declares the servers its own skills call, and
         the gateway proxies to none of them — so the token is minted here, once, for the
         caller this request already identified. */
      const code = b64(randomBytes(32));
      await platformDb().query(
        `insert into zz.mcp_oauth_authz (id, client_id, principal_id, redirect_uri, code_challenge, state, resource)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        // THE PRINCIPAL IS KNOWN HERE, always. It used to be left null when the resource was
        // a third party's server, so that server's callback had to name it before
        // /oauth/token would mint anything — the mechanism that made its consent a
        // precondition. With no third party left, there is nobody else to wait for.
        [code, clientId, principalId, redirectUri, challenge, state, door]);
      await platformDb().query("delete from zz.mcp_oauth_authz where created_at < now() - interval '10 minutes'");

      // CONNECT ON A BLOCK ALWAYS RUNS THAT BLOCK'S SIGN-IN, even when we already hold a
      // delegated token for them. That is not a redundant round trip; it is the only thing
      // that makes Revoke mean anything.
      //
      // Revoke in the front end deletes the front end's OWN token. It cannot reach
      // zz.block_token, which is where the block's delegated token lives — so a version of
      // this that skipped an existing connection would let someone revoke, press Connect,
      // and be handed a green dot straight back without the block ever being consulted. The
      // block's grant would be exactly as live as before, and "revoke" would have been a
      // word for clearing a cache.
      //
      // The block's own authorization server decides whether that costs a click: one that
      // remembers the grant redirects straight back. So this is cheap when nothing changed
      // and correct when something did. The callback replaces the stored token
      // (ON CONFLICT DO UPDATE), so re-connecting rotates rather than duplicating, and
      // abandoning the flow leaves the previous connection untouched.
      // A loopback client gets its code without a screen: the code can only reach a program on
      // the person's own machine, and a screen that only ever has one honest answer teaches
      // people to click through screens. A hosted client got here through Allow above.
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      if (state) back.searchParams.set("state", state);
      res.redirect(303, back.toString());
    })().catch((err: unknown) => {
      console.error("oauth authorize failed:", err);
      if (!res.headersSent) say(res, 500, "Something went wrong", "The sign-in could not be completed. Nothing has been shared.");
    });
  };

  app.get("/oauth/authorize", (req: Request, res: Response) => {
    authorize(req, res, req.query as Record<string, unknown>, null);
  });

  // THE ANSWER MUST COME FROM THE CONSENT PAGE ITSELF. The session cookie is SameSite=Lax, so
  // a cross-site form already arrives without it; checking Origin as well means that stays
  // true even if the cookie's attributes ever change.
  app.post("/oauth/authorize", (req: Request, res: Response) => {
    if (req.headers.origin !== requestBase(req)) {
      say(res, 403, "Not from this page", "An answer to a connection request can only come from the page that asked it. Nothing has been shared.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    authorize(req, res, body, body.decision === "allow" ? "allow" : "deny");
  });

  // ── token ─────────────────────────────────────────────────────────────────
  app.post("/oauth/token", (req: Request, res: Response) => {
    void (async () => {
      if (!platformDbReady()) { res.status(503).json({ error: "temporarily_unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (k: string): string => (typeof body[k] === "string" ? body[k] as string : "");
      if (str("grant_type") !== "authorization_code") {
        res.status(400).json({ error: "unsupported_grant_type" });
        return;
      }
      const code = str("code");
      const verifier = str("code_verifier");
      // SINGLE USE, MARKED RATHER THAN DELETED. A replay then finds a row it may not use,
      // which is a different fact from finding nothing — and the difference is what lets the
      // log below say "replayed" instead of "unknown code".
      const { rows } = await platformDb().query<{
        client_id: string; principal_id: string; redirect_uri: string;
        code_challenge: string; resource: string; used: boolean; email: string;
      }>(
        `select a.client_id, a.principal_id::text as principal_id, a.redirect_uri,
                a.code_challenge, a.resource, a.used,
                (select email from principal where id = a.principal_id) as email
           from zz.mcp_oauth_authz a
          where a.id = $1 and a.created_at > now() - interval '10 minutes'`, [code]);
      const authz = rows[0];
      if (!authz || authz.used || !authz.principal_id) {
        res.status(400).json({ error: "invalid_grant", error_description: authz?.used ? "that code has already been exchanged" : "unknown or expired code" });
        return;
      }
      if (authz.client_id !== str("client_id") || authz.redirect_uri !== str("redirect_uri")) {
        res.status(400).json({ error: "invalid_grant", error_description: "this code was issued to a different client or address" });
        return;
      }
      // PKCE. The whole proof, since there is no client secret.
      const got = b64(createHash("sha256").update(verifier).digest());
      if (!verifier || got !== authz.code_challenge) {
        res.status(400).json({ error: "invalid_grant", error_description: "the PKCE verifier does not match the challenge this code was issued against" });
        return;
      }
      await platformDb().query("update zz.mcp_oauth_authz set used = true where id = $1", [code]);

      // THE TOKEN CARRIES THE PERSON'S OWN AUTHORITY, because that is what it is: them,
      // signed in, at this front end.
      //
      // It used to say so by COPYING their role onto the token — superadmin got `scope:
      // admin`, everyone else `member` — read at exchange time so a demotion in between took
      // effect. That copy is gone with the column: a token is not a statement about what its
      // holder may do, and every authority check now reads the principal on the call it is
      // deciding. The demotion window this paragraph was proud of narrowing from ninety days
      // to ten minutes is now zero, because there is nothing cached to go stale.
      // NAMED FOR THE PROTOCOL, NOT FOR ONE CLIENT. This read `librechat oauth`, which was
      // never accurate — this is the MCP OAuth exchange and any client that speaks it lands
      // here — and stopped being even approximately true when that front end was removed.
      // The label is what a person reads in their token list when deciding what to revoke.
      const label = `mcp oauth — ${authz.resource} — ${authz.email}`;
      const token = mintPat();
      const expiry = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000);
      // ONE LIVE TOKEN PER PERSON PER DOOR. Reconnecting is something people do when
      // something looks wrong, so without this the `pat` table grows a row every time anyone
      // presses a button, and revoking access means hunting through them.
      await platformDb().query(
        "delete from pat where principal_id = $1 and label = $2", [authz.principal_id, label]);
      await platformDb().query(
        "insert into pat (principal_id, token_hash, label, expires_at) values ($1,$2,$3,$4)",
        [authz.principal_id, sha256(token), label, expiry.toISOString()]);
      logEvent({
        actor: authz.email, teamSlug: null, kind: "credential.set",
        subject: `oauth:${authz.resource}`,
        detail: { via: "mcp-oauth", expires_at: expiry.toISOString() },
      });
      res.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_DAYS * 86_400,
        scope: authz.resource,
      });
    })().catch((err: unknown) => {
      console.error("oauth token failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
  });
}
