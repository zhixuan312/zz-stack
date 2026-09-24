/**
 * The gateway as an OAuth 2.1 authorization server for its own MCP doors.
 *
 * A client refused with a 401 carrying a WWW-Authenticate challenge discovers the authorization
 * server, registers itself, sends the person to sign in, and holds the resulting token itself.
 *
 *   GET  /.well-known/oauth-protected-resource/<door>   who authorises this door (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server        how (RFC 8414)
 *   POST /oauth/register                                the client registers itself (RFC 7591)
 *   GET  /oauth/authorize                               the person signs in and consents
 *   POST /oauth/token                                   the code becomes a platform token
 *
 * DELIBERATE: the access token is a PAT. `Identity.via` stays the closed three-value union it
 * is, `mayReadConsole` stays the literal `via === "session"`, and every reader downstream is
 * unchanged. A fourth `via` would express a distinction nobody downstream needs.
 *
 * Public clients only: no client secret is issued and none is accepted. PKCE (S256, mandatory)
 * proves the exchange instead.
 */
import { createHash, randomBytes } from "node:crypto";

import { mintPat } from "@zz/contracts";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";
import { browserSession, requestBase, sha256 } from "./identity.js";

/** HTML-escape, for anything a caller supplied that lands in the consent page.
 *
 * The quotes matter as much as the angle brackets: a value inside a double-quoted attribute
 * without `"` escaped closes the attribute and opens another. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const PUBLIC = (process.env.GATEWAY_PUBLIC_URL ?? "").replace(/\/+$/, "");

/** Where a browser is sent to authorize, which is not where a program calls this platform.
 *
 * Discovery, registration and the token exchange are read by a client's server, and api.<host>
 * serves those. `/oauth/authorize` is the one endpoint a person opens, and it answers "who is
 * at this keyboard" from the `zz_console` cookie — set by /auth/* on the console's origin and
 * host-only, so api.<host> cannot read it. It is therefore advertised on the console's origin,
 * which the Caddyfile proxies to this same gateway, falling back to the api address when no
 * console is configured. */
const AUTHORIZE_ON = ((process.env.CONSOLE_PUBLIC_URL ?? "").replace(/\/+$/, "") || PUBLIC);

/** Whether a client may be handed authorization codes at this redirect.
 *
 * /oauth/register is open, so without this check an attacker registers a client whose redirect
 * is their own server, gets a signed-in person to open one authorize link, and exchanges the
 * code for a platform token issued as that person. PKCE binds the exchange to whoever started
 * it, and that is the attacker.
 *
 * A loopback redirect is allowed with its port ignored (RFC 8252 §7.3): the client cannot know
 * which port it will get, and the code goes to a server on the same machine as the browser.
 *
 * Any other origin must be named in OAUTH_REDIRECT_ORIGINS, comma-separated — on this
 * deployment `https://chatgpt.com`, which redirects to more than one path there, so the rule is
 * by origin.
 *
 * A hosted client is also why there is a consent page: anyone may register a client with
 * chatgpt.com as its redirect and point their own connector at a door here, so every
 * non-loopback authorization stops and asks. */
const EXTRA_ORIGINS = (process.env.OAUTH_REDIRECT_ORIGINS ?? "")
  .split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);

/** Loopback by address, never by name: `localhost` can be made to resolve elsewhere, and a
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

/** How long a minted token lives. Ninety days: with no refresh_token grant, a short life
 *  reintroduces "your connection needs reconnecting", and no expiry at all is worse, because a
 *  client treats such a token as eternal and never retries a revoked one. */
const TOKEN_TTL_DAYS = 90;

const b64 = (b: Buffer): string => b.toString("base64url");

/** The door a `resource` names, as a path — or null if it names none of ours. The client sends
 *  back exactly the URL it connected to, which may be an internal address, so this reads the
 *  path and ignores the origin: the origin is a routing detail of whichever network the client
 *  sits on, and the door is what is being authorised. */
function doorOf(resource: string): string | null {
  let path: string;
  try { path = new URL(resource).pathname; } catch { return null; }
  path = path.replace(/\/+$/, "");
  if (/^\/(core|manage)\/mcp$/.test(path)) return path;
  if (/^\/p\/[a-z0-9-]+\/mcp$/.test(path)) return path;
  return null;
}

/** A one-line HTML page for the handful of things a browser can be told here. These are the
 *  only errors a person sees from this file; everything else answers a program in JSON. */
function say(res: Response, status: number, title: string, detail: string): void {
  res.status(status).type("text/html").send(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px/1.6 system-ui;margin:3rem auto;max-width:34rem;padding:0 1rem">` +
    `<h1 style="font-size:1.3rem">${title}</h1><p>${detail}</p></body>`);
}

/** The fields an authorization arrives with — carried through the consent form unchanged. */
const AUTHZ_FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge",
                      "code_challenge_method", "resource", "state"] as const;

/** The question a hosted client's authorization stops on. The client names itself, so its name
 *  proves nothing — what it cannot forge is where the code goes, so that is the line in bold.
 *  The page refuses to be framed. */
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
  // Discovery
  //
  // RFC 9728 puts this at `/.well-known/oauth-protected-resource` plus the resource's own path,
  // and clients also try the bare form. Both are served, for every door, from one handler.
  // DELIBERATE: Express 4, so the wildcard is a bare `*`. Express 5's named `*splat` registers
  // a route matching a literal "*splat" segment, which 404s every per-door path.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"],
    (req: Request, res: Response) => {
      const suffix = req.path.replace("/.well-known/oauth-protected-resource", "") || "/";
      // The resource is the URL the client actually connected to, not our public one. The SDK
      // compares this against the server URL it holds, and the two differ when a client reaches
      // the gateway on an internal address; answering with PUBLIC fails that comparison and the
      // client abandons the flow.
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
        // S256 alone. `plain` proves only that whoever redeems the code can read the request
        // that started it, which is exactly what an interceptor can do.
        code_challenge_methods_supported: ["S256"],
        // Public clients. See the header.
        token_endpoint_auth_methods_supported: ["none"],
      });
    });

  // Registration
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

  // Authorize
  //
  // One authorization, reached two ways: GET is the client sending the person here, POST is the
  // person answering the consent page. The POST re-validates everything, because its fields
  // came back through a browser.
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

      // Every refusal before the redirect is validated goes to the person, not to the client:
      // bouncing an error to an unverified redirect_uri makes this an open redirect on its
      // error path instead of its success path.
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

      // Who is at the keyboard. No session means they have not signed in yet, and the console's
      // own `/login?next=` returns them here with everything they arrived with.
      const me = await browserSession(req);
      if (!me) {
        // A POST has no query to come back to, and a person answering the consent page was
        // signed in a moment ago — so the session ended in between, and the client restarts.
        if (decision) { say(res, 401, "Your sign-in has ended", "Nothing has been shared. Go back to the application and connect again."); return; }
        // requestBase, not a constant: this endpoint is reached on the console's origin and the
        // sign-in screen is a page of that same app. `/login` rather than `/auth/…` because the
        // passkey ceremony is driven by the page's own script, with no server route to navigate to.
        res.redirect(`${requestBase(req)}/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      const pr = await platformDb().query<{ id: string; role: string }>(
        "select id::text as id, role from principal where email = $1", [me.email]);
      const principalId = pr.rows[0]?.id;
      if (!principalId) { say(res, 403, "No account", `${me.email} is not a principal on this platform.`); return; }

      // A hosted client waits for the person; a loopback one does not — see `redirectAllowed`.
      // Deny is answered to the client, safe now that the redirect has been checked against
      // what the client registered.
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

      /* A door on this gateway is the only resource: a plugin declares the servers its own
         skills call and the gateway proxies to none of them, so the token is minted here, once,
         for the caller this request already identified. */
      const code = b64(randomBytes(32));
      await platformDb().query(
        `insert into zz.mcp_oauth_authz (id, client_id, principal_id, redirect_uri, code_challenge, state, resource)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        // The principal is known here, always — there is no third party left to wait for.
        [code, clientId, principalId, redirectUri, challenge, state, door]);
      await platformDb().query("delete from zz.mcp_oauth_authz where created_at < now() - interval '10 minutes'");

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

  // The answer must come from the consent page itself. The session cookie is SameSite=Lax, so a
  // cross-site form already arrives without it; checking Origin as well keeps that true if the
  // cookie's attributes ever change.
  app.post("/oauth/authorize", (req: Request, res: Response) => {
    if (req.headers.origin !== requestBase(req)) {
      say(res, 403, "Not from this page", "An answer to a connection request can only come from the page that asked it. Nothing has been shared.");
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    authorize(req, res, body, body.decision === "allow" ? "allow" : "deny");
  });

  // Token
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
      // Single use, marked rather than deleted: a replay finds a row it may not use, which is a
      // different fact from finding nothing, and is what lets the log below say "replayed".
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

      // The token carries the person's own authority and states nothing about what its holder
      // may do: every authority check reads the principal on the call it is deciding.
      //
      // The label is named for the protocol, not for one client — any client speaking the MCP
      // OAuth exchange lands here — and it is what a person reads in their token list when
      // deciding what to revoke.
      const label = `mcp oauth — ${authz.resource} — ${authz.email}`;
      const token = mintPat();
      const expiry = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000);
      // One live token per person per door. Reconnecting is something people do when something
      // looks wrong, so without this the `pat` table grows a row every time anyone presses a
      // button, and revoking access means hunting through them.
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
