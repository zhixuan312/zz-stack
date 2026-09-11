/**
 * Signing in to a building block AS YOURSELF, so the block records you and not us.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every call the platform makes to a block today carries one shared API key. That block's audit log therefore
 * records the same principal for every action by every person of every team, everybody inherits
 * that key's full powers regardless of their own role, and one revocation stops all of them. The
 * platform is multi-tenant; at the block boundary that tenancy disappears.
 *
 * OAuth does not fix that by being a better credential. It fixes it by changing WHO IS ACTING.
 * That is what delegated OAuth is for: a third-party app acts on a user's data with that user's
 * consent rather than with a shared key. The person signs in with their own organisation
 * identity, consents to what we may do, and every call we then make is theirs — attributable,
 * bounded by their roles, revocable by them alone.
 *
 * ── WHAT IT IS NOT FOR ──────────────────────────────────────────────────────
 *
 * Unattended work. A delegated grant has an absolute lifetime — the refresh chain ends whether
 * or not it is being used — so it cannot carry anything that must keep running while nobody is
 * present. How long that is belongs to the block, and the platform must not assume it. Scheduled sweeps and the evaluation harness keep the API key, and that split — API key
 * for the platform's own work, delegation for anything a named person asked for — is the design,
 * not a temporary state.
 *
 * ── THE TWO ROUTES ──────────────────────────────────────────────────────────
 *
 *   connect_block(block)          an MCP tool, NOT a link. The person must be known before the
 *                                 result can be bound to them, and a browser arriving from the
 *                                 open internet carries no platform identity — the forwarded
 *                                 header is only trusted from inside the compose network. So the
 *                                 flow starts where the caller is already identified: their own
 *                                 agent session. The tool returns a URL for them to open.
 *   GET /oauth/<block>/callback   PUBLIC, and it has to be: the block redirects a BROWSER here,
 *                                 carrying no platform token. `state` is what identifies the
 *                                 person — single-use, unguessable, short-lived — because
 *                                 anything weaker lets one person's authorization be bound to
 *                                 another person's account.
 *
 * NO SCOPES ARE REQUESTED. CaseBox offers a consent screen where the user picks their own app and
 * permissions, which is better than anything we could name for them: we do not know their app
 * code, and asking for more than they need is how a consent screen teaches people to click
 * through without reading.
 */
import { createHash, randomBytes } from "node:crypto";

import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { logEvent } from "./events.js";

/** How a block's authorization server is reached. Discovered per block rather than hardcoded:
 *  RFC 9728 says the resource advertises its own authorization server, and a value copied into
 *  our source is one that cannot follow the block when it moves. */
interface Endpoints { authorize: string; token: string; userinfo?: string; scopes?: string[] }

// Cached, but NOT for the life of the process. A block that gains a `userinfo_endpoint`, or
// moves its token endpoint, would otherwise stay invisible until someone happened to restart the
// gateway — which is precisely how this was found: the mock started publishing userinfo and the
// gateway went on storing blank identities, with nothing anywhere saying why. Ten minutes costs
// one metadata fetch and removes a class of bug that only ever appears as stale behaviour.
const DISCOVERY_TTL_MS = 10 * 60_000;
const discovered = new Map<string, { at: number; ends: Endpoints }>();

async function endpointsFor(mcpUrl: string): Promise<Endpoints | null> {
  const cached = discovered.get(mcpUrl);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.ends;
  try {
    // TWO PLACES, because providers genuinely differ and the specification allows it. The
    // metadata for a resource at https://host/some/path may sit at
    //
    //     https://host/some/path/.well-known/oauth-protected-resource   (path-suffixed)
    //     https://host/.well-known/oauth-protected-resource             (at the origin)
    //
    // CaseBox publishes the first; our own mocks publish the second. A client that knows only
    // one of those shapes reports "this block publishes no authorization server" about a block
    // that plainly does — which is exactly what happened here, and it is the kind of thing only
    // running it against two different servers ever shows you.
    const base = mcpUrl.replace(/\/+$/, "");
    const origin = (() => { try { return new URL(base).origin; } catch { return ""; } })();
    const candidates = [`${base}/.well-known/oauth-protected-resource`];
    if (origin) candidates.push(`${origin}/.well-known/oauth-protected-resource`);

    let issuer = "";
    let scopes: string[] = [];
    for (const where of candidates) {
      const prm = await fetch(where, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (!prm?.ok) continue;
      const meta = await prm.json().catch(() => ({})) as
        { authorization_servers?: string[]; scopes_supported?: string[] };
      if (meta.authorization_servers?.[0]) {
        issuer = meta.authorization_servers[0];
        // RFC 9728 puts the resource's scopes HERE, not in the authorization server's own
        // metadata, and this read discarded them. A server may advertise its scopes only in the
        // resource document and declare none in the AS document, and may then refuse a request
        // that omits the scope parameter — so the field we were dropping was the field that made
        // the request valid. Read both locations and prefer the resource's.
        scopes = meta.scopes_supported ?? [];
        break;
      }
    }
    if (!issuer) return null;

    // OIDC discovery first: it carries userinfo, which is how a person's identity is learned.
    for (const wk of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
      const res = await fetch(`${issuer.replace(/\/+$/, "")}${wk}`, { signal: AbortSignal.timeout(15_000) })
        .catch(() => null);
      if (!res?.ok) continue;
      const as = await res.json().catch(() => ({})) as
        { authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string };
      if (!as.authorization_endpoint || !as.token_endpoint) continue;
      const found: Endpoints = { authorize: as.authorization_endpoint, token: as.token_endpoint,
                                 userinfo: as.userinfo_endpoint, scopes };
      discovered.set(mcpUrl, { at: Date.now(), ends: found });
      return found;
    }
    return null;
  } catch {
    return null;
  }
}

const b64 = (b: Buffer): string => b.toString("base64url");

/** The client we registered with each block. Per block, because two blocks are two
 *  registrations and sharing one client between them would ask each to trust the other's
 *  redirect.
 *
 *  SPELLED OUT, not computed from the block's name. `process.env[`${block}_OAUTH_CLIENT_ID`]`
 *  reads the same values but no longer says which they are — and this repository checks that
 *  every variable a service reads appears in .env.example by looking for the literal name in
 *  the source. A computed lookup passes that check while documenting nothing. */
// EMPTY, AND THAT IS THE TRUE ANSWER. This deployment ships no block: `blocks.ts` has an empty
// built-in registry and a deployment's blocks come entirely from `PLATFORMS`, which this one
// does not set. These two maps named `casebox`, `bookit` and `RuleMill` — three mock blocks that
// moved to their own repository — so `clientFor` returned null for every block a person could
// actually configure, and `connect_block`, a registered tool, could not succeed for any of
// them. Three names that resolve to nothing read, to an operator, exactly like a feature that
// is simply not set up yet.
//
// SPELLED OUT WHEN THERE IS ONE, never computed. `process.env[`${block}_OAUTH_CLIENT_ID`]`
// reads the same value and no longer says which — and this repository checks that every
// documented variable is read and every read variable is documented by finding the literal
// name in the source. A computed lookup passes that check while documenting nothing. It is
// also what compose can pass: `environment:` is an explicit list, so a generic name would
// need the whole of deploy/.env handed to the container, which is a wider secret surface than
// a block's client id is worth.
//
// ADDING A BLOCK'S OAUTH IS THREE EDITS, all visible to that check:
//   1. a line here, and one in OAUTH_SCOPES below, naming `<BLOCK>_OAUTH_CLIENT_ID` literally
//   2. the matching pair in deploy/docker-compose.yml's `environment:`
//   3. the same names offered in deploy/.env.example
// Until then `connect_block` refuses by name — "no OAuth client is configured for '<block>' on
// this gateway" — which is the truth, and the shared-key path through cred-proxy is unaffected.
const OAUTH_SCOPES: Record<string, string> = {};

const OAUTH_CLIENTS: Record<string, { id: string; secret: string }> = {};

function clientFor(block: string): { id: string; secret: string } | null {
  const c = OAUTH_CLIENTS[block];
  return c?.id ? c : null;
}

/** Begin an authorization for one person against one block, and return the URL they must open.
 *
 *  Everything the callback will need is written down FIRST — who it is for, the PKCE verifier,
 *  and the exact redirect — keyed by an unguessable single-use `state`. The browser then carries
 *  nothing but that state, which is what lets an anonymous callback be bound back to a person
 *  without trusting anything the browser claims about who they are. */
export async function beginAuthorization(
  email: string, block: string, mcpUrl: string,
  /** The platform authorization to finish once the block has consented, or undefined when
   *  this connection was started from ZZ Access and ends at the callback's own page.
   *  See migration 041 for why one click has to do both halves. */
  resumeAuthz?: string,
): Promise<{ url: string } | { error: string }> {
  const client = clientFor(block);
  if (!client) {
    return { error: `no OAuth client is configured for '${block}' on this gateway — it still needs a stored key` };
  }
  const ends = await endpointsFor(mcpUrl);
  if (!ends) {
    return { error: `'${block}' publishes no authorization server at /.well-known/oauth-protected-resource, ` +
                    "so there is nothing to redirect to. That block still needs a stored key." };
  }
  if (!platformDbReady()) return { error: "platform database unavailable" };

  const { rows: pr } = await platformDb().query<{ id: string }>(
    "select id::text as id from principal where email = $1", [email]);
  const principalId = pr[0]?.id;
  if (!principalId) return { error: `${email} is not a principal on this platform` };

  const state = b64(randomBytes(32));
  const verifier = b64(randomBytes(32));
  const challenge = b64(createHash("sha256").update(verifier).digest());
  // From configuration, never from a request header: the block matches this byte for byte
  // against what was registered, and a Host header is something a caller chooses.
  const redirect = `${(process.env.GATEWAY_PUBLIC_URL ?? "").replace(/\/+$/, "")}/oauth/${block}/callback`;
  if (!redirect.startsWith("http")) {
    return { error: "GATEWAY_PUBLIC_URL is not set, so there is no callback address to give the block" };
  }
  await platformDb().query(
    `insert into block_oauth_state (state, principal_id, block, code_verifier, redirect_uri, resume_authz, created_at)
     values ($1,$2,$3,$4,$5,$6, now())`, [state, principalId, block, verifier, redirect, resumeAuthz ?? null]);
  await platformDb().query("delete from block_oauth_state where created_at < now() - interval '10 minutes'");

  const q = new URLSearchParams({
    response_type: "code", client_id: client.id, redirect_uri: redirect,
    state, code_challenge: challenge, code_challenge_method: "S256",
    // Who the platform thinks is asking. A HINT, and named one — the block is free to ignore it,
    // and an authorization server that took a caller's word for who the user is would not be an
    // authorization server. It saves the person retyping an address they have already proven.
    login_hint: email,
  });
  // What we ask for, in order: the deployment's explicit answer, else what the RESOURCE says
  // it has, else nothing — a block advertising no scopes lets its own consent screen offer the
  // person the choice, which is the better arrangement and the one our mocks are built for.
  //
  // The override exists because discovery cannot see the whole answer. A resource document
  // advertises what the RESOURCE needs; the CLIENT may also need `offline_access`, and without
  // that there is no refresh token — so every person would re-consent as soon as the access
  // token expired and the entire refresh path below would be dead code that still compiled.
  //
  // It is a config value rather than a constant so that narrowing to per-permission scopes,
  // which is where this should end up, is an edit to one line of .env and not a release.
  const scope = (OAUTH_SCOPES[block] ?? "").trim() || (ends.scopes ?? []).join(" ");
  if (scope) q.set("scope", scope);
  return { url: `${ends.authorize}?${q.toString()}` };
}

export function mountBlockOauth(app: Express, blockUrl: (block: string) => string | undefined): void {
  app.get("/oauth/:block/callback", async (req: Request, res: Response) => {
    const block = String(req.params.block);
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const denied = String(req.query.error ?? "");
    const say = (msg: string, status = 400): void => { res.status(status).type("text/plain").send(msg); };

    if (denied) { say(`${block} refused the authorization: ${denied}`); return; }
    if (!code || !state) { say("that callback carried no code and no state"); return; }
    if (!platformDbReady()) { say("platform database unavailable", 503); return; }

    // SINGLE USE. Deleting as we read it means a replayed callback finds nothing, which is the
    // whole protection `state` offers.
    const { rows } = await platformDb().query<{ principal_id: string; code_verifier: string;
                                                redirect_uri: string; principal_email: string;
                                                resume_authz: string | null }>(
      `delete from block_oauth_state
        where state = $1 and block = $2 and created_at > now() - interval '10 minutes'
        returning principal_id, code_verifier, redirect_uri, resume_authz,
                  (select email from principal where id = principal_id) as principal_email`,
      [state, block]);
    const pending = rows[0];
    if (!pending) { say("that authorization is unknown, already used, or expired — start again"); return; }

    const client = clientFor(block);
    const url = blockUrl(block);
    const ends = client && url ? await endpointsFor(url) : null;
    if (!client || !ends) { say(`no OAuth client or endpoints for '${block}' any more`, 500); return; }

    const body = new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: pending.redirect_uri,
      client_id: client.id, code_verifier: pending.code_verifier,
    });
    if (client.secret) body.set("client_secret", client.secret);
    const tok = await fetch(ends.token, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body, signal: AbortSignal.timeout(30_000),
    });
    const payload = await tok.json().catch(() => ({})) as
      { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
    if (!tok.ok || !payload.access_token) {
      // The block's own sentence, not ours. `invalid_scope` and `invalid_grant` mean different
      // things to whoever has to fix it, and collapsing them into "login failed" throws that away.
      say(`${block} would not exchange the code: ${payload.error ?? `HTTP ${tok.status}`}`, 502);
      return;
    }

    let subject = "", email = "";
    if (ends.userinfo) {
      try {
        const ui = await fetch(ends.userinfo, {
          headers: { Authorization: `Bearer ${payload.access_token}` }, signal: AbortSignal.timeout(15_000) });
        if (ui.ok) {
          const claims = await ui.json() as { sub?: string; email?: string };
          subject = claims.sub ?? ""; email = claims.email ?? "";
        }
      } catch { /* identity is a nicety here; the token is the point */ }
    }

    const expiresAt = payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : null;
    await platformDb().query(
      `insert into block_token (principal_id, block, access_token, refresh_token, expires_at, scope, subject, email, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (principal_id, block) do update set
         access_token=excluded.access_token, refresh_token=excluded.refresh_token,
         expires_at=excluded.expires_at, scope=excluded.scope,
         subject=excluded.subject, email=excluded.email, updated_at=now()`,
      [pending.principal_id, block, payload.access_token, payload.refresh_token ?? "",
       expiresAt, payload.scope ?? "", subject, email]);

    // ONE CLICK, TWO CREDENTIALS. When this connection was started by the front end pressing
    // Connect, the person is mid-way through a platform authorization that is waiting on
    // exactly what just happened. Finish it and send them back, rather than showing them a
    // page about a block they will now have to leave in order to carry on.
    //
    // The platform authorization was created with no principal on it, deliberately: until the
    // block consented there was nobody to name, and /oauth/token refuses a row without one.
    // Naming them HERE is what makes the code redeemable, so the block's consent is a
    // precondition of the platform token rather than something that happens beside it.
    if (pending.resume_authz) {
      const { rows: ar } = await platformDb().query<{ redirect_uri: string; state: string }>(
        `update zz.mcp_oauth_authz set principal_id = $1
          where id = $2 and used = false and created_at > now() - interval '10 minutes'
        returning redirect_uri, state`,
        [pending.principal_id, pending.resume_authz]);
      const authz = ar[0];
      if (authz) {
        const back = new URL(authz.redirect_uri);
        back.searchParams.set("code", pending.resume_authz);
        if (authz.state) back.searchParams.set("state", authz.state);
        res.redirect(back.toString());
        return;
      }
      // The authorization expired while they were at the block's consent screen. Say so
      // plainly: the block connection DID land, so this is a "press Connect again", not a
      // "that failed". Telling them it failed would have them redo the part that worked.
      res.type("text/plain").send(
        `Connected to ${block}, but the sign-in that started this took too long and has ` +
        "expired. Your connection to the block is stored — press Connect once more to finish " +
        "linking it to the platform.");
      return;
    }

    res.type("text/plain").send([
      `Connected to ${block}.`,
      "",
      email ? `You are ${email} to ${block}.` : `${block} did not tell us who you are, which is fine — the token still acts as you.`,
      email && pending.principal_email && email.toLowerCase() !== pending.principal_email.toLowerCase()
        ? `NOTE: on this platform you are ${pending.principal_email}. Two different accounts for ` +
          "one person is workable, but check it is the account you meant — every call to this " +
          "block will now be made as the first one."
        : "",
      payload.scope ? `Granted: ${payload.scope}` : "The block returned no scope list, so what was granted is whatever you chose at its consent screen.",
      expiresAt ? `This access expires ${expiresAt.toISOString()}.` : "",
      payload.refresh_token
        ? "A refresh token was issued, so this renews without you until the block's absolute limit."
        : "NO refresh token was issued — you will have to do this again when the access expires.",
      "",
      "From now on your calls to this block are made as you, with these permissions and no others.",
    ].filter(Boolean).join("\n"));
  });
}

/** The caller's own token for a block, refreshed if it is about to expire.
 *  Returns null when they have not connected — which callers must treat as "ask them to", never
 *  as "fall back to the shared key": falling back silently restores the exact attribution problem
 *  delegation exists to remove. */
export async function delegatedToken(email: string, block: string, mcpUrl: string):
  Promise<{ token: string; email: string } | null> {
  if (!platformDbReady() || !email) return null;
  // BY EMAIL, resolved through principal — the caller identity carries an email, and the
  // first version of this took that email and compared it against a uuid column. Postgres
  // answered `invalid input syntax for type uuid`, on every single block call, which is a
  // loud failure and the only reason it was found in minutes rather than in a report.
  const { rows } = await platformDb().query<{ access_token: string; refresh_token: string;
                                              expires_at: string | null; email: string }>(
    `select t.access_token, t.refresh_token, t.expires_at, t.email
       from block_token t join principal p on p.id = t.principal_id
      where p.email = $1 and t.block = $2`, [email, block]);
  const row = rows[0];
  if (!row) return null;

  const soon = Date.now() + 60_000;   // a token that dies mid-call is a token that already died
  if (!row.expires_at || new Date(row.expires_at).getTime() > soon) {
    return { token: row.access_token, email: row.email };
  }
  if (!row.refresh_token) return null;

  const client = clientFor(block);
  const ends = client ? await endpointsFor(mcpUrl) : null;
  if (!client || !ends) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: row.refresh_token, client_id: client.id });
  if (client.secret) body.set("client_secret", client.secret);
  const res = await fetch(ends.token, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  const payload = res && res.ok ? await res.json().catch(() => ({})) as
    { access_token?: string; refresh_token?: string; expires_in?: number } : null;
  if (!payload?.access_token) {
    console.warn(`[oauth] ${block}: refresh failed for ${email} (http ${res ? res.status : "none"}) — sign-in required`);
    // The refresh chain has ended. A grant may carry an absolute lifetime that no amount of
    // refreshing extends, and this is what that looks like from here: the person has to sign in
    // again, and saying so beats retrying.
    await platformDb().query(
      "delete from block_token using principal p where principal_id = p.id and p.email=$1 and block=$2",
      [email, block]);
    return null;
  }
  const expiresAt = payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : null;
  await platformDb().query(
    `update block_token t set access_token=$3, refresh_token=coalesce(nullif($4,''), t.refresh_token),
            expires_at=$5, updated_at=now()
       from principal p where p.id = t.principal_id and p.email=$1 and t.block=$2`,
    [email, block, payload.access_token, payload.refresh_token ?? "", expiresAt]);
  return { token: payload.access_token, email: row.email };
}

/** The caller's own block connections (← Task I-13): which blocks they have signed into,
 *  with what scope and when the access expires. Never the tokens themselves — this is the
 *  read half of `delegatedToken`, which is the one function allowed to read those back out.
 *  Modelled on the same `block_token` shape console.ts's admin views already read (see
 *  `/api/console/people` and `/api/console/teams/:slug`), scoped down to one principal.
 *
 *  NO `platformDbReady()` GUARD HERE ON PURPOSE. An empty array and "the database is down"
 *  are different facts, and returning `[]` for both would have settings.ts's route report
 *  "not connected to any block" — a real, checkable claim — when the honest answer is "could
 *  not check". The CALLER (settings.ts) checks readiness before calling this, the same way
 *  it already does for tokens; if it is ever called anyway while the pool is unset,
 *  `platformDb()` throws rather than lying. */
export async function myBlockConnectionsFor(email: string): Promise<Array<{
  block: string; scope: string; expires_at: string | null; has_refresh_token: boolean; connected_at: string;
}>> {
  const { rows } = await platformDb().query<{
    block: string; scope: string; expires_at: string | null; refresh_token: string; updated_at: string;
  }>(
    `select bt.block, bt.scope, bt.expires_at, bt.refresh_token, bt.updated_at
       from block_token bt join principal p on p.id = bt.principal_id
      where p.email = $1 order by bt.block`, [email]);
  // `refresh_token` itself never leaves this function — only whether one is stored, which
  // is what tells a person whether this connection renews itself or will need re-consent.
  return rows.map((r) => ({
    block: r.block, scope: r.scope, expires_at: r.expires_at,
    has_refresh_token: !!r.refresh_token, connected_at: r.updated_at,
  }));
}

/** Disconnect the caller's OWN connection to one block — the other half of
 *  `beginAuthorization`, which this file had never grown: a person could connect but never
 *  revoke from here, only by waiting for the access token to expire. `extraDetail` is how
 *  the settings.ts route marks this `via: "web"` (← Task I-13) without a second, duplicate
 *  logEvent call at the route — see settings.ts's own header for why the marker has to be
 *  added by the caller rather than assumed here: this function has no other caller today,
 *  but a future agent-facing `disconnect_block` MCP tool must not inherit a browser's door.
 *  Deletes unconditionally; a caller who was never connected sees the same `false` a caller
 *  whose connection already expired would — there is nothing to undo either way. No
 *  `platformDbReady()` guard here either, for the same reason `myBlockConnectionsFor` has
 *  none: a database that cannot be reached must not read back as `false`/"nothing to
 *  disconnect" — the caller checks readiness first. */
export async function disconnectBlock(
  email: string, block: string, extraDetail: Record<string, unknown> = {},
): Promise<boolean> {
  const r = await platformDb().query(
    "delete from block_token using principal p where principal_id = p.id and p.email = $1 and block = $2",
    [email, block]);
  const removed = (r.rowCount ?? 0) > 0;
  if (removed) {
    logEvent({ actor: email, kind: "block.disconnect", subject: `${email}:${block}`, detail: extraDetail });
  }
  return removed;
}
