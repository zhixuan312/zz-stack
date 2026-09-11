/**
 * Identity resolution — the one authenticated door.
 *
 * Two authenticators, one principal model:
 *  - PAT: `Authorization: Bearer zzp_…` → sha256 lookup in the platform db.
 *    Self-declared identity headers on these requests are IGNORED and
 *    rewritten from the token's principal.
 *  - Forwarded headers (X-ZZ-User-*): trusted ONLY when the request comes from
 *    a container named in TRUSTED_FORWARD_HOST, which is UNSET by default —
 *    the browser holds no platform identity and sends each person's own token.
 *    Published-port ingress arrives from the docker bridge gateway (x.x.x.1)
 *    and is treated as external → PAT required either way.
 */
import { createHash } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

import { actingTeam, addressResolver, parseCaller, peerAddress } from "@zz/contracts";
import { requestHeaders } from "@zz/mcp-http";

import { logEvent } from "./events.js";
import { platformDb, platformDbReady } from "./db.js";

export interface Identity {
  email: string;
  displayName: string;
  platformRole: "superadmin" | "member";
  teams: { slug: string; role: "admin" | "member" }[];
  /** The ONE team this caller is acting as, by the platform's single rule. Null when a
   * bound token names a team they are not in, or when they belong to none. */
  activeTeam: string | null;
  /** Which door they came through. NOT a permission — a fact about the request
   * that authorisation is allowed to consult. The console consults it because
   * "signed in at the directory just now" and "holds a token minted last month"
   * are genuinely different assurances about the same person. */
  via: "pat" | "forwarded" | "session";
  patScope?: "member" | "admin";
  patTeam?: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    zzIdentity?: Identity;
  }
}

/** The browser session cookie's name, spelled ONCE.
 *
 * Two files need it — signin.ts sets and clears it, the session adapter below
 * reads it — and a cookie whose name is written twice is a logout that silently
 * clears a different cookie than the one authenticating the request. */
export const CONSOLE_COOKIE = "zz_console";

/** Read one cookie without a parser dependency.
 *
 * Splits on ";" and takes the FIRST match. A duplicate cookie name is how a
 * subdomain shadows a host-only cookie, and taking the last one would let the
 * shadow win. The session cookie is set host-only precisely so that cannot
 * happen, and this reads defensively anyway. */
export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** First value of a header, trimmed — headers may arrive as an array. */
const one = (h: string | string[] | undefined): string =>
  (Array.isArray(h) ? h[0] : h ?? "").trim();

/** A team-bound token's membership is that one team, and nothing else.
 *
 * ONE function because the identity gets built TWICE and the second builder did not know this.
 * The middleware resolves it from the token; admin.ts rebuilds it from the database inside
 * an MCP tool handler, which cannot reach req.zzIdentity — and that rebuild returned the
 * principal's whole membership, so the binding held on every path except the admin surface,
 * which is the one where it matters most. Same shape as the scope bug before it: an
 * identity reconstructed from the database knows the person and nothing about the token in
 * their hand.
 *
 * Unbound (null) means "leave it alone", which is what a forwarded-header session and an
 * unrestricted token both want. */
function bindTeams<T extends { slug: string }>(teams: T[], patTeam: string | null | undefined): T[] {
  return patTeam ? teams.filter((t) => t.slug === patTeam) : teams;
}

/**
 * The bound token's memberships, or null when the token must be refused outright.
 *
 * Bound to a team the person is not in, the narrowing leaves NOTHING — and an empty team
 * list is not a safe reading of that: block-grant enforcement treats "no teams" as "nothing
 * to enforce", so the token comes out MORE permissive than an unbound one. A superadmin can
 * issue such a token and it can only ever be a mistake.
 *
 * ONE function because the identity is built twice, and the second builder did not do this.
 * resolvePat refused it; callerIdentity — the rebuild an MCP tool handler gets, on the admin
 * surface, which the comment two functions down calls "the one place it matters most" —
 * narrowed and carried on. Unreachable today, because the middleware refuses the token before
 * any handler runs. That is exactly the argument isTeamAdmin rejects for its own duplicate
 * check: the cost of stating an authorisation decision twice is nothing against the cost of
 * the narrowing being loosened later, and this file has been bitten twice by the two builders
 * disagreeing — once on scope, once on the binding itself.
 */
function boundMemberships<T extends { slug: string }>(
  teams: T[], patTeam: string | null | undefined,
): T[] | null {
  const narrowed = bindTeams(teams, patTeam);
  if (!patTeam) return narrowed;
  // BOUND AND NOT A MEMBER IS REFUSED, whether or not they are in some OTHER team. This
  // asked `teams.length > 0` as well, so a person whose only team was the bound one — the
  // exact state remove_member leaves behind — kept a working token that simply carried no
  // team. Every team-scoped door then refuses it and blocks answer 403, so it could do
  // nothing; but remove_member tells the administrator the token "stops working now", and
  // for that person it did not. A token naming a team its holder is not in is a mistake in
  // both shapes, and the cheaper reading was the one that made the tool's own message false.
  return narrowed.length === 0 ? null : narrowed;
}

async function principalByEmail(email: string): Promise<Identity | null> {
  if (!platformDbReady()) {
    // No platform database: pass the forwarded identity through as a member with no teams,
    // so the store still works and every admin tool refuses.
    //
    // This is local dev, and it is ALSO a database outage or a failed migration — db.ts
    // withdraws the pool deliberately in that case rather than let features query a
    // half-migrated schema. Worth knowing which door is open then: only the forwarded one,
    // which already requires the request to come from the front end's own container, and
    // resolvePat refuses outright because it has nothing to look a token up against.
    return { email, displayName: "", platformRole: "member", teams: [], activeTeam: null, via: "forwarded" };
  }
  const db = platformDb();
  const p = await db.query<{ id: string; email: string; display_name: string; role: "superadmin" | "member"; status: string }>(
    "select id, email, display_name, role, status from principal where email = $1",
    [email.toLowerCase()],
  );
  const row = p.rows[0];
  if (!row || row.status !== "active") return null;
  const teams = await db.query<{ slug: string; role: "admin" | "member" }>(
    `select t.slug, m.role from membership m join team t on t.id = m.team_id
     where m.principal_id = $1 and t.status = 'active'`,
    [row.id],
  );
  return {
    email: row.email,
    displayName: row.display_name,
    platformRole: row.role,
    teams: teams.rows,
    activeTeam: actingTeam(teams.rows, await chosenTeam(row.id), null),
    via: "forwarded",
  };
}

/** The team a person has CHOSEN, when it is still live. Fetched beside their memberships
 * so this gateway can hand `actingTeam` the same inputs zz-core gives it. Without it the
 * gateway had no notion of a chosen team at all and any caller needing one took whichever
 * membership row came back first. */
async function chosenTeam(principalId: string): Promise<string | null> {
  const r = await platformDb().query<{ slug: string | null }>(
    `select t.slug from principal p
       left join team t on t.id = p.active_team_id and t.status = 'active'
      where p.id = $1`, [principalId]);
  return r.rows[0]?.slug ?? null;
}

async function resolvePat(token: string): Promise<Identity | null> {
  if (!platformDbReady()) return null;
  const db = platformDb();
  const r = await db.query<{
    id: string; email: string; display_name: string; role: "superadmin" | "member";
    status: string; scope: "member" | "admin"; team_slug: string | null;
  }>(
    `select pat.id, p.email, p.display_name, p.role, p.status, pat.scope, t.slug as team_slug
     from pat join principal p on p.id = pat.principal_id
     left join team t on t.id = pat.team_id
     where pat.token_hash = $1 and pat.revoked_at is null
       and (pat.expires_at is null or pat.expires_at > now())`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status !== "active") return null;
  void db.query("update pat set last_used_at = now() where id = $1", [row.id]).catch(() => undefined);
  const base = await principalByEmail(row.email);
  if (!base) return null;

  // A team-bound token acts INSIDE that team and nowhere else.
  //
  // The binding was recorded, reported by issue_pat as "(scope admin, team X)", and then
  // consulted in exactly one place: isTeamAdmin refused a mismatched team. Everything that
  // READS — the catalog listing, the installs, the knowledge store, which blocks are
  // granted — is scoped by `teams`, which came from the principal's full membership and had
  // never heard of the binding. So a token bound to one team still read every other team
  // its owner belonged to, while saying on its face that it was bound.
  //
  // Narrowing here fixes all of them at once, because every reader already asks the
  // identity rather than the token.
  const teams = boundMemberships(base.teams, row.team_slug);
  if (!teams) return null;
  // Recomputed WITH the binding. `base` was resolved without it, so a bound token would
  // otherwise carry the person's own chosen team — and the entire point of binding a token
  // to a team is that it cannot act outside it.
  return {
    ...base, teams,
    activeTeam: actingTeam(base.teams, base.activeTeam, row.team_slug),
    via: "pat", patScope: row.scope, patTeam: row.team_slug,
  };
}

/** Resolve a browser session cookie to the person who signed in.
 *
 * DELIBERATELY THE SAME SHAPE AS resolvePat, down to the query. Both hash a
 * bearer secret, look it up, refuse a revoked or expired row, refuse a
 * non-active principal, and touch a last-used column without blocking the
 * request. Keeping them line-for-line comparable is what makes it possible to
 * review one by reading the other, and it is why the session table was given
 * the same columns rather than a shape of its own.
 *
 * NO TEAM BINDING, unlike a PAT. A session is a person at a keyboard and it
 * carries their whole membership, exactly as an unbound token does. The console
 * is cross-team by design, so there is nothing here to narrow — and if a
 * team-scoped browser view is ever wanted, it belongs in the query string where
 * the user can see it, not silently welded into their credential. */
async function resolveSession(token: string): Promise<Identity | null> {
  if (!platformDbReady()) return null;
  const db = platformDb();
  const r = await db.query<{ id: string; email: string; status: string }>(
    `select s.id, p.email, p.status
       from console_session s join principal p on p.id = s.principal_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status !== "active") return null;
  void db.query("update console_session set last_seen_at = now() where id = $1", [row.id])
    .catch(() => undefined);
  const base = await principalByEmail(row.email);
  if (!base) return null;
  return { ...base, via: "session" };
}

/** The person whose browser this is, or null — the session door on its own.
 *
 * `identityMiddleware` runs every adapter and 401s when none match, which is right for a
 * door but wrong for `/oauth/authorize`: that endpoint is reached BEFORE anyone has signed
 * in, and its job when nobody has is to send them to sign in rather than to refuse them.
 * So it needs the session answer by itself, and it must not be tempted to re-derive it —
 * a second reading of `console_session` is a second place the revoked and expired rules
 * could drift from `resolveSession`, which is the one that matters. */
export async function browserSession(req: Request): Promise<Identity | null> {
  const token = readCookie(req, CONSOLE_COOKIE);
  return token ? resolveSession(token) : null;
}

/** A container permitted to assert an identity with no secret at all.
 *
 * OFF by default, and that is the change: the front end used to be trusted this way,
 * because Open WebUI held the accounts and the browser had no token to send. LibreChat
 * holds no platform identity — each person supplies their own PAT — so nothing needs
 * this path any more, and a gateway on the public internet should not carry a way in
 * that rests on a source address rather than a credential.
 *
 * Set TRUSTED_FORWARD_HOST only for a front end that genuinely authenticates people
 * itself and cannot carry their token, and understand what it grants: whoever reaches
 * this gateway from that container may claim to be anyone. */
const TRUSTED_FORWARD_HOST = (process.env.TRUSTED_FORWARD_HOST || "").trim();
// Resolving a hostname to a comparable set of addresses is @zz/contracts' — zz-core
// authenticates its own network the same way, and had a second implementation of this down
// to the cache and the IPv4-mapped fold. An empty host list resolves to null, which is what
// "no trusted front end: PAT or nothing" means here.
const trustedForwardIps = addressResolver(TRUSTED_FORWARD_HOST ? [TRUSTED_FORWARD_HOST] : []);

/** True when the socket peer is the front end itself.
 *
 * Preferred answer: the peer's address is one the front end's hostname resolves
 * to. Fallback, only when that lookup fails: a private-range address that is not
 * the bridge gateway. Traffic arriving through a published port is NAT'd to the
 * gateway address, so ingress from outside — including anything a reverse proxy
 * forwards — never passes either test and must present a token instead. */
async function fromComposeNetwork(req: Request): Promise<boolean> {
  // OFF is not BROKEN. TRUSTED_FORWARD_HOST is unset by default, and this warned
  // "cannot resolve " — with an empty hostname — on every request that carried a
  // forwarded-identity header, which is the normal state of a gateway nobody has configured
  // this way. A warning that fires when nothing is wrong is how the one that matters gets
  // scrolled past.
  if (!TRUSTED_FORWARD_HOST) return false;
  const addr = peerAddress(req.socket);
  if (!addr) return false;
  const trusted = await trustedForwardIps();
  if (trusted) return trusted.has(addr);
  // No approximation. This used to fall back to "any private range, not the bridge
  // gateway", which is a guess standing in for an authentication decision — and the guess
  // is only consulted in the one situation where the exact answer is unavailable. It held
  // for today's topology (Caddy is a host process, so its requests arrive from x.x.x.1) and
  // it would silently start trusting any container the day a front end moves onto this
  // network. db.ts already states the rule for exactly this case: a platform that answers
  // wrongly is worse than one that admits it cannot answer.
  //
  // Costing nothing, either: Docker's embedded DNS failing means `http://zz-core:8000`
  // cannot resolve for anything on this network, so there is no working platform to protect.
  // Set and unresolvable IS worth saying, and only that case reaches here now.
  console.warn(`identity: TRUSTED_FORWARD_HOST=${TRUSTED_FORWARD_HOST} does not resolve — ` +
               "refusing forwarded identity");
  return false;
}

/** THE IDENTITY PORT: one question, many doors.
 *
 * An adapter answers exactly one thing — WHICH PERSON is calling — and answers it with an
 * email or with nothing. It never decides what they may do: after identity is established,
 * authorisation converges on one path for every door, a membership lookup and a path ACL.
 * Whichever way somebody came in, everything after they are in is identical.
 *
 * The shape matters more than the number of adapters, and it has to be right before it is
 * needed. "We have our own auth, SSO can come later" is the road that welds itself shut:
 * once a PAT is the FOUNDATION rather than one adapter among several, every new way of
 * logging in means surgery on identity resolution — and that is the first thing an
 * organisation asks about and the most expensive place to change late.
 *
 * So the two doors that exist today are two adapters, and adding Keycloak, another OIDC provider,
 * the directory or anything else is adding one more to this array. `pat` stays forever in every
 * profile as the fallback that needs no directory.
 *
 * `refuse` is the difference between "not my door" and "my door, and no". A PAT that is
 * revoked must 401 immediately, not fall through to be tried as a forwarded header. */
export interface IdentityAdapter {
  name: string;
  /** null when this door does not apply; `refuse` when it does and the caller failed it. */
  resolve(req: Request): Promise<Identity | null | { refuse: string }>;
}

const ADAPTERS: IdentityAdapter[] = [
  {
    name: "pat",
    async resolve(req) {
      const m = (req.headers.authorization ?? "").match(/^Bearer\s+(zzp_[A-Za-z0-9]+)\s*$/);
      if (!m) return null;                       // no PAT presented: not this door
      return (await resolvePat(m[1])) ?? { refuse: "invalid, expired or revoked PAT" };
    },
  },
  {
    name: "session",
    async resolve(req) {
      const token = readCookie(req, CONSOLE_COOKIE);
      if (!token) return null;                   // no cookie presented: not this door
      // REFUSES rather than falling through, exactly as the PAT door does. An
      // expired session that fell through would be retried as a forwarded
      // header, and "your session ended" would silently become "you are
      // whoever this request claims" on any deployment with a trusted front
      // end. A door that says no must end the request.
      return (await resolveSession(token)) ?? { refuse: "session expired or signed out" };
    },
  },
  {
    name: "forwarded",
    async resolve(req) {
      // Read raw rather than through parseCaller because this adapter runs BEFORE the
      // middleware stamps the canonical headers — so it normalises to the same one form.
      const fwd = (req.headers["x-zz-user-email"] as string | undefined)?.trim().toLowerCase();
      if (!fwd || !(await fromComposeNetwork(req))) return null;
      // A forwarded caller who is not yet a principal: pass through minimally so the store
      // still works; admin tools will still refuse them.
      return (await principalByEmail(fwd))
        ?? { email: fwd, displayName: "", platformRole: "member", teams: [], activeTeam: null, via: "forwarded" };
    },
  },
];

/** Walk the doors in order and return the first answer.
 *
 * Exported so the ORDERING can be tested, because the property that matters is not visible
 * by reading: a door that says NO must end the request, not hand the caller to the next one.
 * A revoked PAT falling through to the forwarded-header adapter would let a revoked token
 * become an unauthenticated header claim, which is the opposite of revoking it.
 */
export async function resolveThrough(
  adapters: IdentityAdapter[], req: Request,
): Promise<Identity | { refuse: string } | null> {
  for (const adapter of adapters) {
    const got = await adapter.resolve(req);
    if (got && "refuse" in got) return got;   // this door said no: stop, do not try another
    if (got) return got;
  }
  return null;
}

/** The origin THIS request arrived on, which is not always the platform's public address.
 *
 * RFC 9728 §3.3 makes a client check that the `resource` in the metadata equals the server
 * URL it is talking to, and refuse the flow otherwise — a real protection, since otherwise
 * one server could hand out metadata describing another. The front end reaches these doors at
 * `http://cred-proxy:8000/...` on the compose network, deliberately, so a challenge pointing
 * at `https://api.…` returned metadata describing a different origin and LibreChat refused,
 * in as many words:
 *
 *   Protected Resource Metadata 'resource' (https://api.…/p/casebox/mcp) does not match
 *   server URL (http://cred-proxy:8000/p/casebox/mcp). Refusing OAuth flow (RFC 9728 §3.3).
 *
 * So the pointer is relative to the door the caller actually reached. The AUTHORIZATION
 * SERVER named inside that metadata is still the public address, and has to be: a browser
 * opens that one. Two different origins for two different readers, which is the whole shape
 * of this deployment.
 *
 * x-forwarded-* is honoured because a public caller arrives through Caddy, which terminates
 * TLS — without it every public challenge would say `http` and the client would fetch a URL
 * that redirects. */
export function requestBase(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  return `${proto}://${host}`;
}

/** A 401 that TELLS THE CLIENT HOW TO FIX IT, which a bare 401 does not.
 *
 * An MCP client reads `WWW-Authenticate` and, finding a `resource_metadata` pointer, fetches
 * it, discovers this platform's authorization server, and starts a sign-in. Finding nothing,
 * it has only a status code — and this SDK treats a bare 401 the same as any other failed
 * request: a transport error, three of which open the front end's per-user circuit breaker.
 * So the difference between these two responses is the difference between a person being
 * offered a Connect button and a person being told, wrongly, that the platform is down.
 *
 * The pointer is per-door, built from the path actually asked for, because each door is a
 * separate protected resource and a client authorising one has not authorised the others.
 *
 * This is also the ONE exemption in the gate's "an MCP door never answers with an HTTP error
 * status" rule, and it is exempt precisely because the client special-cases it: 401 with a
 * challenge is the handshake, not a failure. A 401 WITHOUT this header is not exempt and is
 * the bug that rule was written for. */
function challenge(req: Request, res: Response, why: string): void {
  res.set("WWW-Authenticate",
          `Bearer resource_metadata="${requestBase(req)}/.well-known/oauth-protected-resource${req.path.replace(/\/+$/, "")}"`);
  res.status(401).json({ error: why });
}

/** Resolve identity through the port, rewrite the downstream identity headers, and 401 when
 * no adapter applies. */
export function identityMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      const got = await resolveThrough(ADAPTERS, req);
      if (got && "refuse" in got) {
        challenge(req, res, got.refuse);
        return;
      }
      const id: Identity | null = got;
      if (!id) {
        challenge(req, res, "authentication required: Bearer PAT (zzp_…)");
        return;
      }
      req.zzIdentity = id;
      // canonical identity for everything downstream — spoofed headers die here
      req.headers["x-zz-user-email"] = id.email;
      req.headers["x-zz-user-name"] = id.displayName;
      req.headers["x-zz-user-role"] = id.platformRole === "superadmin" ? "admin" : "user";
      // How the caller proved who they are, and what their token is allowed to do.
      //
      // An MCP tool handler receives headers, not the request, so admin.ts could not see
      // req.zzIdentity and rebuilt an identity from the database instead — which knows the
      // person's ROLE but nothing about the TOKEN, so it filled in via: "forwarded" and every
      // scope check downstream compared against a constant. A member-scope token therefore
      // carried its owner's full superadmin authority, which is the one thing scope exists
      // to prevent.
      //
      // These are set on EVERY request, never merged with what arrived: an unauthenticated
      // caller writing x-zz-pat-scope: admin must not be able to promote itself, and the only
      // way to guarantee that is to overwrite unconditionally, exactly as the three lines
      // above already do for identity.
      req.headers["x-zz-via"] = id.via;
      req.headers["x-zz-pat-scope"] = id.patScope ?? "";

      // The team a person acts for is NOT on this request. It is a column on their
      // principal, switched in ZZ Access, and zz-core reads it per call — so there is one
      // answer to "which team", in one place, rather than a header every client has to
      // remember to send and this middleware has to police.
      //
      // x-zz-pat-team still travels, and still means only one thing: a token BOUND to a
      // team, for automation that must never wander out of it.
      req.headers["x-zz-pat-team"] = id.patTeam ?? "";
      next();
    })().catch((err: unknown) => {
      console.error("identity resolution failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "identity resolution failed" });
    });
  };
}

/** How the caller authenticated, as the middleware stamped it on THIS request.
 *
 * An MCP tool handler is given headers, not the request, so it cannot reach req.zzIdentity.
 * The middleware overwrites these three on every request — see identityMiddleware — so they
 * are as trustworthy here as the identity headers beside them and cannot be forged.
 *
 * One reader, because the first one was written inline in admin.ts and /manage then went on
 * checking a header-derived role with no notion of scope at all: a member-scope token could
 * store a credential on another person's behalf. */
export function callerAuth(headers: Record<string, string | string[] | undefined>): {
  via: "pat" | "forwarded"; patScope: "member" | "admin"; patTeam: string | null;
} {
  return {
    via: one(headers["x-zz-via"]) === "pat" ? "pat" : "forwarded",
    patScope: one(headers["x-zz-pat-scope"]) === "admin" ? "admin" : "member",
    patTeam: one(headers["x-zz-pat-team"]) || null,
  };
}

/** Authority checks used by admin tools — DB truth, never headers.
 *
 * A TEAM-BOUND token never carries platform authority, whoever holds it. Narrowing `teams`
 * in resolvePat did nothing for a superadmin, because every tool short-circuits on
 * platformRole and never looks at `teams` at all — so a token stamped "(scope admin, team
 * team_one)" listed every team on the platform. Verified live before this.
 *
 * "Bound" has to mean the same thing for everyone or it means nothing. A superadmin who
 * wants a token confined to one team's work asks for one and gets it; the unbound token
 * they already hold is unchanged. */
export function isSuper(id: Identity): boolean {
  if (id.via === "pat" && id.patTeam) return false;
  return id.platformRole === "superadmin" && (id.via !== "pat" || id.patScope === "admin");
}

export function isTeamAdmin(id: Identity, teamSlug: string): boolean {
  if (isSuper(id)) return true;
  if (id.via === "pat" && id.patScope !== "admin") return false;
  // Belt and braces: resolvePat already narrowed `teams` to the bound team, so the check
  // below would fail anyway. Kept because it is an authorisation decision, and the cost of
  // stating it twice is nothing against the cost of the narrowing being loosened later.
  if (id.via === "pat" && id.patTeam && id.patTeam !== teamSlug) return false;
  return id.teams.some((t) => t.slug === teamSlug && t.role === "admin");
}

/** Record an admin action, attributed to the team it acted on where there is one.
 *
 * `team` was never passed by any of these call sites, so 1941 of 1942 events carried a null
 * team: the column existed, an index existed on it, and the one consumer — the browser's
 * activity feed — had to fall back to "or team_slug is null" to show anything at all, which
 * is how every member came to see the whole platform's history. An event about a team is
 * one of the few things that genuinely knows its team; it just was not being asked. */
export function auditAdmin(
  id: Identity, kind: string, subject: string,
  detail: Record<string, unknown> = {}, team: string | null = null,
): void {
  logEvent({ actor: id.email, kind: `admin.${kind}`, subject, detail, teamSlug: team });
}

/** The one team-slug rule.
 *
 * A slug names a row in `team` AND a directory under the artifact store, so every reader
 * has to agree on it. There were three derivations of it: create_team's zod regex, kb.ts's
 * TEAM_SLUG guarding the path, and a third inside the Open WebUI import that agreed with
 * neither. */
export const TEAM_SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** The platform's own team — a tenant like any other, holding what the platform learns
 * about its own registry entries rather than about anybody's delivery.
 *
 * Reserved, not merely conventional: create_team refuses it, because a tenant holding this
 * slug would be writing into the platform's record and reading it. Seeded by the bootstrap
 * with the superadmin as its admin. */
export const PLATFORM_TEAM = "zz-platform";

/** A slug for a display name, or null when nothing valid can be made of it — a name with
 * no ASCII letters or digits collapses to nothing, and a one-character name is too short.
 * A caller holding a stable id should fall back to that rather than invent a name. */
export function toTeamSlug(name: string): string | null {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64);
  return TEAM_SLUG.test(s) ? s : null;
}

/** WHO IS CALLING, from the database rather than from the headers alone.
 *
 * Lives here, beside isSuper and isTeamAdmin, because those two take an Identity and this
 * is the only correct way to build one. It was private to admin.ts, so any other surface
 * wanting a team-authority check had to either import from admin.ts or write a second,
 * lighter check of its own — and a second authority check that ignores token scope is
 * precisely the defect isSuper and isTeamAdmin already carry scars from. */
export async function callerIdentity(): Promise<Identity | null> {
  const headers = requestHeaders();
  const email = parseCaller(headers).email;
  if (!email || !platformDbReady()) return null;
  const db = platformDb();
  const p = await db.query<{ id: string; email: string; display_name: string; role: "superadmin" | "member"; status: string }>(
    "select id, email, display_name, role, status from principal where email = $1",
    [email],
  );
  if (!p.rows[0] || p.rows[0].status !== "active") return null;
  const teams = await db.query<{ slug: string; role: "admin" | "member" }>(
    `select t.slug, m.role from membership m join team t on t.id = m.team_id
     where m.principal_id = $1 and t.status = 'active'`,
    [p.rows[0].id],
  );
  // Role and membership come from the database, which is the only truth about who someone
  // is. How they authenticated comes from the middleware, which is the only thing that
  // knows — and which overwrites these headers on every request, so they cannot be forged.
  //
  // This used to say via: "forwarded" unconditionally, with a comment that a route guard
  // enforced PAT scope for /admin. There was no such guard, and the two scope-aware checks
  // that would have done it were exported and called by nobody.
  const auth = callerAuth(headers);
  const bound = boundMemberships(teams.rows, auth.patTeam);
  if (!bound) return null;
  return {
    email: p.rows[0].email,
    displayName: p.rows[0].display_name,
    platformRole: p.rows[0].role,
    // Narrowed to the token's team, exactly as the middleware does. Without this the
    // binding held everywhere EXCEPT the admin surface — the one place it matters most —
    // because this rebuild asks the database who the person is and the database has never
    // heard of their token.
    teams: bound,
    activeTeam: actingTeam(teams.rows, await chosenTeam(p.rows[0].id), auth.patTeam ?? null),
    ...auth,
  };
}
