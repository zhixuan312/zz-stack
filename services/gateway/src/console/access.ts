/**
 * GET /api/console/access: what lets the caller in, and nothing of anybody else's. Their tokens by label
 * and date with the application each was minted through, the applications they authorised, the browsers
 * they are signed in on with the one asking marked, their passkeys, the teams they may act for with the
 * one acted for, and their client setup. A person in no team is answered too: Access is the caller's own,
 * not a team's.
 *
 * The parts, each from one read:
 *
 *   issued          the caller's zz.pat rows, as myAccessTokensFor reads them, newest first, each with the
 *                   OAuth client it was minted through (oauth_client_id), null for one issued by hand
 *   applications    those rows grouped by client, the client of the newest token first: the client's
 *                   registered name, how many tokens, the first issued and the last used
 *   browsers        the caller's live console sessions by id, the one asking first, then the newest
 *   authenticators  the caller's passkeys, newest first: label, transports and dates
 *   teams           myTeamsSummary's teams and the one acted for, none for a person in no team
 *   setup           myClientSetup, as settings/me/client-setup answers it
 *
 * DELIBERATE: no secret and nothing it could be used as. A token is its id and label, never its value or
 * hash; a browser is its session's id, never its cookie, hash or address; a passkey is never its
 * credential id or key. Which browser is asking is decided inside the query, by the cookie's hash, so the
 * hash never leaves the database. Every field is named so redact() leaves it alone, and the answer still
 * passes through redact(): a field added later under a secret's name is blanked rather than answered.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in a
 * comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's Access in src/lib/destination-shapes.ts, and its fake answer in
 * scripts/fake-gateway/work-access.ts, which checks/console-access.ts compares this route's answer with,
 * key set by key set. The two revokes are in settings/me.ts.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { CONSOLE_COOKIE, readCookie, sha256 } from "../identity.js";
import { redact } from "../redact.js";
import { myTeamsSummary } from "../settings.js";
import { myClientSetup } from "../settings/me.js";
import type { ReadMeta } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

type AccessToken = { id: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; application: string | null };
type AccessApplication = { client: string; name: string; issuedCount: number; firstAt: string; lastUsedAt: string | null };
type AccessBrowser = { id: string; current: boolean; userAgent: string | null; issuedAt: string; lastSeenAt: string | null; expiresAt: string };
type AccessPasskey = { label: string | null; transports: string[]; createdAt: string; lastUsedAt: string | null };
type Access = {
  meta: ReadMeta;
  issued: AccessToken[];
  applications: AccessApplication[];
  browsers: AccessBrowser[];
  authenticators: AccessPasskey[];
  teams: { actingFor: string | null; teams: { team: string; role: string; active: boolean }[] };
  setup: { client: string; config: string };
};

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const at = (d: Date | null): string | null => (d === null ? null : iso(d.getTime()));
/** What an OAuth client is called when it registered no name, as its tokens' labels call it. */
const UNNAMED = "unnamed client";

type Minted = { token: AccessToken; name: string | null };

/** The caller's tokens, newest first, with the client each was minted through and that client's name. */
async function tokensOf(email: string): Promise<Minted[]> {
  const { rows } = await platformDb().query<{
    id: string; label: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
    oauth_client_id: string | null; name: string | null;
  }>(
    `select pat.id::text as id, pat.label, pat.created_at, pat.last_used_at, pat.revoked_at, pat.oauth_client_id,
            c.name
       from pat
       join principal p on p.id = pat.principal_id
       left join mcp_oauth_client c on c.client_id = pat.oauth_client_id
      where p.email = $1
      order by pat.created_at desc, pat.id`, [email]);
  return rows.map((r) => ({
    token: {
      id: r.id, label: r.label, createdAt: iso(r.created_at.getTime()), lastUsedAt: at(r.last_used_at), revokedAt: at(r.revoked_at),
      application: r.oauth_client_id,
    },
    name: r.oauth_client_id === null ? null : r.name || UNNAMED,
  }));
}

/** The applications among the tokens, in the order their newest token comes. */
function applicationsOf(tokens: Minted[]): AccessApplication[] {
  const out = new Map<string, AccessApplication>();
  for (const { token: t, name } of tokens) {
    if (t.application === null) continue;
    const a = out.get(t.application);
    if (!a) {
      out.set(t.application, { client: t.application, name: name ?? UNNAMED, issuedCount: 1, firstAt: t.createdAt, lastUsedAt: t.lastUsedAt });
      continue;
    }
    a.issuedCount++;
    if (t.createdAt < a.firstAt) a.firstAt = t.createdAt;
    if (t.lastUsedAt !== null && (a.lastUsedAt === null || t.lastUsedAt > a.lastUsedAt)) a.lastUsedAt = t.lastUsedAt;
  }
  return [...out.values()];
}

/** The caller's live browsers at the cutoff, the one whose cookie hash is given first. */
async function browsersOf(email: string, cookieHash: string | null, asOf: string): Promise<AccessBrowser[]> {
  const { rows } = await platformDb().query<{
    id: string; is_current: boolean; user_agent: string | null; issued_at: Date; last_seen_at: Date | null; expires_at: Date;
  }>(
    `select s.id::text as id, coalesce(s.token_hash = $2, false) as is_current, s.user_agent, s.issued_at, s.last_seen_at,
            s.expires_at
       from console_session s
       join principal p on p.id = s.principal_id
      where p.email = $1 and s.revoked_at is null and s.expires_at > $3::timestamptz
      order by coalesce(s.token_hash = $2, false) desc, s.issued_at desc, s.id`, [email, cookieHash, asOf]);
  return rows.map((r) => ({
    id: r.id, current: r.is_current, userAgent: r.user_agent, issuedAt: iso(r.issued_at.getTime()),
    lastSeenAt: at(r.last_seen_at), expiresAt: iso(r.expires_at.getTime()),
  }));
}

/** The caller's passkeys, newest first. */
async function passkeysOf(email: string): Promise<AccessPasskey[]> {
  const { rows } = await platformDb().query<{ label: string | null; transports: string[] | null; created_at: Date; last_used_at: Date | null }>(
    `select k.label, k.transports, k.created_at, k.last_used_at
       from passkey k
       join principal p on p.id = k.principal_id
      where p.email = $1
      order by k.created_at desc, k.id`, [email]);
  return rows.map((r) => ({ label: r.label, transports: r.transports ?? [], createdAt: iso(r.created_at.getTime()), lastUsedAt: at(r.last_used_at) }));
}

export function mountAccess(app: Express): void {
  /** Access, for the caller alone, whatever team or scope the request names. */
  app.get("/api/console/access", platformPublic("access", async (req, res) => {
    const id = req.zzIdentity!;
    // The cutoff in whole seconds, rounded up, so what was written in the second the read began is inside it.
    const asOf = iso(Math.ceil(Date.now() / 1000) * 1000);
    const cookie = id.via === "session" ? readCookie(req, CONSOLE_COOKIE) : null;
    const [tokens, browsers, authenticators, setup] = await Promise.all([
      tokensOf(id.email), browsersOf(id.email, cookie === null ? null : sha256(cookie), asOf), passkeysOf(id.email), myClientSetup(id.email),
    ]);
    const summary = myTeamsSummary(id);
    const issued = tokens.map((t) => t.token);
    // The period is the caller's record: from the first of their tokens, live browsers and passkeys.
    const first = [...issued.map((t) => t.createdAt), ...browsers.map((b) => b.issuedAt), ...authenticators.map((k) => k.createdAt)].sort()[0];
    const answer: Access = {
      meta: {
        asOf, timezone: ZZ_TZ, period: { from: first ?? asOf, to: asOf }, scope: "caller-in-active-team",
        population: "the caller's own tokens, applications, browsers and passkeys", coverageFrom: null,
      },
      issued,
      applications: applicationsOf(tokens),
      browsers,
      authenticators,
      teams: summary.ok ? { actingFor: summary.actingFor, teams: summary.teams } : { actingFor: null, teams: [] },
      setup,
    };
    res.json(redact(answer));
  }));
}
