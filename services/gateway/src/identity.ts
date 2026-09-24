/**
 * Identity resolution — the one authenticated door.
 *
 * Two authenticators, one principal model:
 *  - PAT: `Authorization: Bearer zzp_…` → sha256 lookup in the platform db.
 *    Self-declared identity headers on these requests are ignored and rewritten
 *    from the token's principal.
 *  - Forwarded headers (X-ZZ-User-*): trusted only when the request comes from
 *    a container named in TRUSTED_FORWARD_HOST, unset by default. Published-port
 *    ingress arrives from the docker bridge gateway (x.x.x.1) and is treated as
 *    external → PAT required either way.
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
  /** The one team this caller is acting as, by the platform's single rule. Null when a
   * bound token names a team they are not in, or when they belong to none. */
  activeTeam: string | null;
  /** Which door they came through. Not a permission — a fact about the request that
   * authorisation is allowed to consult. */
  via: "pat" | "forwarded" | "session";
  /** Which team a token is confined to, when one is. Answers "acting inside which team",
   *  not "may do what". */
  patTeam?: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    zzIdentity?: Identity;
  }
}

/** The browser session cookie's name.
 *
 * COUPLED: signin.ts sets and clears it; the session adapter below reads it. */
export const CONSOLE_COOKIE = "zz_console";

/** Read one cookie without a parser dependency.
 *
 * Splits on ";" and takes the first match: a duplicate cookie name is how a
 * subdomain shadows a host-only cookie, and taking the last one would let the
 * shadow win. */
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
 * COUPLED: the identity is built twice — the middleware resolves it from the token,
 * callerIdentity rebuilds it from the database — and both narrow through here.
 *
 * Unbound (null) means "leave it alone", which is what a forwarded-header session and an
 * unrestricted token both want. */
function bindTeams<T extends { slug: string }>(teams: T[], patTeam: string | null | undefined): T[] {
  return patTeam ? teams.filter((t) => t.slug === patTeam) : teams;
}

/**
 * The bound token's memberships, or null when the token must be refused outright.
 *
 * Bound to a team the person is not in, the narrowing leaves nothing — and an empty team
 * list is not a safe reading of that: it reads as a person in no team rather than a token
 * that must be refused.
 *
 * COUPLED: both builders of an identity — resolvePat and callerIdentity — narrow through
 * here. DELIBERATE: callerIdentity's refusal is unreachable today, because the middleware
 * refuses such a token before any handler runs; it stays so the narrowing cannot be loosened
 * on one path only.
 */
function boundMemberships<T extends { slug: string }>(
  teams: T[], patTeam: string | null | undefined,
): T[] | null {
  const narrowed = bindTeams(teams, patTeam);
  if (!patTeam) return narrowed;
  // Bound and not a member is refused, whether or not they are in some other team. A token
  // naming a team its holder is not in is a mistake in both shapes.
  return narrowed.length === 0 ? null : narrowed;
}

async function principalByEmail(email: string): Promise<Identity | null> {
  if (!platformDbReady()) {
    // No platform database: pass the forwarded identity through as a member with no teams,
    // so the store still works and every admin tool refuses. db.ts withdraws the pool on an
    // outage or a failed migration too, so only the forwarded door is open in that state;
    // resolvePat refuses outright, having nothing to look a token up against.
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

/** The team a person has chosen, when it is still live. Fetched beside their memberships
 * so this gateway can hand `actingTeam` the same inputs zz-core gives it. */
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
    status: string; team_slug: string | null;
  }>(
    `select pat.id, p.email, p.display_name, p.role, p.status, t.slug as team_slug
     from pat join principal p on p.id = pat.principal_id
     left join team t on t.id = pat.team_id
     where pat.token_hash = $1 and pat.revoked_at is null
       and (pat.expires_at is null or pat.expires_at > now())`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row || row.status !== "active") return null;
  // Logged because a permanently failing update here is indistinguishable from a succeeding
  // one, and this column is what "when was this token last used" answers.
  void db.query("update pat set last_used_at = now() where id = $1", [row.id])
    .catch((err) => console.error("pat.last_used_at update failed:", err));
  const base = await principalByEmail(row.email);
  if (!base) return null;

  // A team-bound token acts inside that team and nowhere else. Every reader — the catalog
  // listing, the installs, the knowledge store, which blocks are granted — is scoped by
  // `teams`, so narrowing here is what makes the binding real for all of them.
  const teams = boundMemberships(base.teams, row.team_slug);
  if (!teams) return null;
  // Recomputed with the binding: `base` was resolved without it, so a bound token would
  // otherwise carry the person's own chosen team.
  return {
    ...base, teams,
    activeTeam: actingTeam(base.teams, base.activeTeam, row.team_slug),
    via: "pat", patTeam: row.team_slug,
  };
}

/** Resolve a browser session cookie to the person who signed in.
 *
 * DELIBERATE: the same shape as resolvePat, down to the query. Both hash a
 * bearer secret, look it up, refuse a revoked or expired row, refuse a
 * non-active principal, and touch a last-used column without blocking the
 * request. COUPLED: a change to either belongs in both.
 *
 * No team binding, unlike a PAT: a session carries the person's whole
 * membership, exactly as an unbound token does. */
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
    .catch((err) => console.error("console_session.last_seen_at update failed:", err));
  const base = await principalByEmail(row.email);
  if (!base) return null;
  return { ...base, via: "session" };
}

/** The person whose browser this is, or null — the session door on its own.
 *
 * `identityMiddleware` runs every adapter and 401s when none match, which is wrong for
 * `/oauth/authorize`: that endpoint is reached before anyone has signed in, and must send
 * them to sign in rather than refuse them. COUPLED: it reads `console_session` only through
 * `resolveSession`, so the revoked and expired rules are stated once. */
export async function browserSession(req: Request): Promise<Identity | null> {
  const token = readCookie(req, CONSOLE_COOKIE);
  return token ? resolveSession(token) : null;
}

/** A container permitted to assert an identity with no secret at all.
 *
 * Off by default. Set it only for a front end that genuinely authenticates people itself
 * and cannot carry their token, and understand what it grants: whoever reaches this
 * gateway from that container may claim to be anyone. */
const TRUSTED_FORWARD_HOST = (process.env.TRUSTED_FORWARD_HOST || "").trim();
// COUPLED: zz-core authenticates its own network through the same @zz/contracts resolver.
// An empty host list resolves to null, which is what "no trusted front end: PAT or nothing"
// means here.
const trustedForwardIps = addressResolver(TRUSTED_FORWARD_HOST ? [TRUSTED_FORWARD_HOST] : []);

/** True when the socket peer is the front end itself: its address is one the
 * front end's hostname resolves to. Traffic arriving through a published port is
 * NAT'd to the bridge gateway address, so ingress from outside — including
 * anything a reverse proxy forwards — never passes and must present a token. */
async function fromComposeNetwork(req: Request): Promise<boolean> {
  // Off is not broken: TRUSTED_FORWARD_HOST is unset by default, so an unconfigured gateway
  // must not warn on every request carrying a forwarded-identity header.
  if (!TRUSTED_FORWARD_HOST) return false;
  const addr = peerAddress(req.socket);
  if (!addr) return false;
  const trusted = await trustedForwardIps();
  if (trusted) return trusted.has(addr);
  // DELIBERATE: no private-range fallback. An unresolvable host refuses rather than guessing,
  // because a platform that answers wrongly is worse than one that admits it cannot answer.
  // Only "set and unresolvable" reaches here.
  console.warn(`identity: TRUSTED_FORWARD_HOST=${TRUSTED_FORWARD_HOST} does not resolve — ` +
               "refusing forwarded identity");
  return false;
}

/** The identity port: one question, many doors.
 *
 * An adapter answers exactly one thing — which person is calling — with an email or with
 * nothing. It never decides what they may do: after identity is established, every door
 * converges on one membership lookup and one path ACL.
 *
 * Another way in (Keycloak, another OIDC provider, the directory) is one more entry in the
 * ADAPTERS array. `pat` stays in every profile as the fallback that needs no directory.
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
      // Refuses rather than falling through, as the PAT door does. An expired
      // session that fell through would be retried as a forwarded header on any
      // deployment with a trusted front end.
      return (await resolveSession(token)) ?? { refuse: "session expired or signed out" };
    },
  },
  {
    name: "forwarded",
    async resolve(req) {
      // Read raw rather than through parseCaller: this adapter runs before the middleware
      // stamps the canonical headers, so it normalises to the same one form.
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
 * Exported so the ordering can be tested: a door that says no must end the request, not hand
 * the caller to the next one. A revoked PAT falling through to the forwarded-header adapter
 * would let a revoked token become an unauthenticated header claim.
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

/** The origin this request arrived on, which is not always the platform's public address.
 *
 * RFC 9728 §3.3 makes a client check that the `resource` in the metadata equals the server
 * URL it is talking to, and refuse the flow otherwise. The front end reaches these doors at
 * `http://cred-proxy:8000/...` on the compose network, so the pointer has to be relative to
 * the door the caller actually reached. The authorization server named inside that metadata
 * is still the public address, because a browser opens that one.
 *
 * x-forwarded-* is honoured because a public caller arrives through Caddy, which terminates
 * TLS; without it every public challenge would say `http`. */
export function requestBase(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  return `${proto}://${host}`;
}

/** A 401 carrying `WWW-Authenticate`, which tells the client how to fix it.
 *
 * An MCP client reads the header, fetches the `resource_metadata` pointer, discovers this
 * platform's authorization server and starts a sign-in. Given a bare 401 the SDK sees a
 * transport error instead.
 *
 * The pointer is per-door, built from the path actually asked for, because each door is a
 * separate protected resource and a client authorising one has not authorised the others.
 *
 * DELIBERATE: the one exemption in the gate's "an MCP door never answers with an HTTP error
 * status" rule — 401 with a challenge is the handshake. A 401 without this header is not
 * exempt. */
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
      // `parseCaller` reads x-zz-user-id too, and the platform identifies a person by email,
      // so there is no second id to publish. Cleared rather than left alone, because
      // whatever the caller sent would otherwise pass through as an assertion.
      req.headers["x-zz-user-id"] = "";
      // Through isSuper, not off platformRole: a PAT bound to a team is not platform
      // authority, and the door receiving this header cannot tell the difference.
      req.headers["x-zz-user-role"] = isSuper(id) ? "admin" : "user";
      // How the caller proved who they are. Set on every request and never merged with what
      // arrived, so an unauthenticated caller writing it cannot promote itself.
      // COUPLED: callerAuth reads it, an MCP tool handler getting headers rather than the
      // request.
      req.headers["x-zz-via"] = id.via;

      // The team a person acts for is not on this request: it is a column on their principal,
      // switched in ZZ Access, and zz-core reads it per call. x-zz-pat-team means one thing
      // only — a token bound to a team.
      req.headers["x-zz-pat-team"] = id.patTeam ?? "";
      next();
    })().catch((err: unknown) => {
      console.error("identity resolution failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "identity resolution failed" });
    });
  };
}

/** How the caller authenticated, as the middleware stamped it on this request.
 *
 * An MCP tool handler is given headers, not the request, so it cannot reach req.zzIdentity.
 * COUPLED: identityMiddleware overwrites these headers on every request, which is what makes
 * them trustworthy here.
 *
 * No scope: authority is read from the principal, every time. `patTeam` answers a different
 * question — which team this token acts inside — which is not a claim about what its holder
 * may do. */
function callerAuth(headers: Record<string, string | string[] | undefined>): {
  via: "pat" | "forwarded"; patTeam: string | null;
} {
  return {
    via: one(headers["x-zz-via"]) === "pat" ? "pat" : "forwarded",
    patTeam: one(headers["x-zz-pat-team"]) || null,
  };
}

/** Authority checks used by admin tools — db truth, never headers.
 *
 * A team-bound token never carries platform authority, whoever holds it. Every superadmin
 * tool short-circuits on platformRole and never looks at `teams`, so narrowing `teams` alone
 * would leave a bound superadmin token unrestricted. */
export function isSuper(id: Identity): boolean {
  if (id.via === "pat" && id.patTeam) return false;
  return id.platformRole === "superadmin";
}

export function isTeamAdmin(id: Identity, teamSlug: string): boolean {
  if (isSuper(id)) return true;
  // DELIBERATE: resolvePat already narrowed `teams` to the bound team, so the check below
  // would fail anyway. Stated twice because it is an authorisation decision.
  if (id.via === "pat" && id.patTeam && id.patTeam !== teamSlug) return false;
  return id.teams.some((t) => t.slug === teamSlug && t.role === "admin");
}

/** Record an admin action, attributed to the team it acted on where there is one.
 *
 * A null team makes the event platform-wide: the browser's activity feed falls back to
 * "or team_slug is null", so every member sees it. */
export function auditAdmin(
  id: Identity, kind: string, subject: string,
  detail: Record<string, unknown> = {}, team: string | null = null,
): void {
  logEvent({ actor: id.email, kind: `admin.${kind}`, subject, detail, teamSlug: team });
}

/** The one team-slug rule.
 *
 * COUPLED: a slug names a row in `team` and a directory under the artifact store, so
 * team_create's validation and `scope.ts`'s slug guard both derive from this one regex. */
export const TEAM_SLUG = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** The platform's own team — a tenant like any other, holding what the platform learns
 * about its own registry entries rather than about anybody's delivery.
 *
 * Reserved: team_create refuses it, because a tenant holding this slug would read and write
 * the platform's own record. Seeded by the bootstrap with the superadmin as its admin. */
export const PLATFORM_TEAM = "zz-platform";

/** A slug for a display name, or null when nothing valid can be made of it — a name with
 * no ASCII letters or digits collapses to nothing, and a one-character name is too short.
 * A caller holding a stable id should fall back to that rather than invent a name. */
export function toTeamSlug(name: string): string | null {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 64);
  return TEAM_SLUG.test(s) ? s : null;
}

/** Who is calling, from the database rather than from the headers alone.
 *
 * Lives here, beside isSuper and isTeamAdmin, because those two take an Identity and this
 * is the only correct way to build one. */
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
  // Role and membership come from the database; how they authenticated comes from the
  // middleware, which overwrites these headers on every request so they cannot be forged.
  const auth = callerAuth(headers);
  const bound = boundMemberships(teams.rows, auth.patTeam);
  if (!bound) return null;
  return {
    email: p.rows[0].email,
    displayName: p.rows[0].display_name,
    platformRole: p.rows[0].role,
    // Narrowed to the token's team, exactly as the middleware does: this rebuild asks the
    // database who the person is, and the database has never heard of their token.
    teams: bound,
    activeTeam: actingTeam(teams.rows, await chosenTeam(p.rows[0].id), auth.patTeam ?? null),
    ...auth,
  };
}
