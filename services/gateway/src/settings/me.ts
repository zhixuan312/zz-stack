/**
 * A person's own settings: their access tokens, which team they act for, the teams they are on,
 * the client package that installs the platform for them, and the applications and browsers they
 * revoke from Access.
 *
 * Every route here acts on the caller. Those that name a token, an application or a browser find
 * it among the caller's own rows in the same statement that changes it, so somebody else's is
 * indistinguishable from one that does not exist and the only question left is whether the caller
 * is signed in.
 */
import type { Express, Request, Response } from "express";

import type { SettingsDeps } from "../settings.js";
import { myTeamsSummary } from "../settings.js";
import { redact } from "../redact.js";
import { CONSOLE_COOKIE, readCookie, sha256, TEAM_SLUG } from "../identity.js";
import { logEvent } from "../events.js";
import { platformDb, platformDbReady } from "../db.js";
import { renderClientSetup } from "../admin/flows.js";

/** A console session's id: a uuid, so anything else names no browser and is answered as one that is not yours. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Why a token-borne caller is refused Access's two revokes: each acts on what signs a person in. */
const BROWSER_ONLY = "revoke this from the console, signed in: a token cannot revoke what signs you in";

/** The caller's client setup: the Claude Code install steps, pointing here. Its bearer header is
 *  always a placeholder (`<YOUR-TOKEN>` / `$ZZ_TOKEN`); `renderClientSetup` never mints or embeds a
 *  real one. COUPLED: Access (console/access.ts) answers the same setup. */
export async function myClientSetup(email: string): Promise<{ client: string; config: string }> {
  return { client: "claude-code", config: await renderClientSetup(email) };
}

export function mountMySettings(app: Express, deps: SettingsDeps): void {
  /** The caller's own access tokens — masked at the query level (only a hash is ever
   *  stored), redacted here on top of that the same as every other row in this file. */
  app.get("/api/console/settings/me/tokens", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      res.json(redact(await deps.myAccessTokensFor(id.email)));
    })().catch((err: unknown) => {
      console.error("settings/me/tokens (list) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not list tokens" });
    });
  });

  /** Change which team this browser acts for: the console's own `team_switch`.
   *
   * COUPLED: the browser's team is `console_session.team_id`, which `resolveSession`
   * (identity.ts) reads on every request and stamps as `x-zz-session-team`. Moving it here
   * moves this browser alone — the agents that authenticate as the same person keep reading
   * `principal.active_team_id`, which is what `team_switch` on /manage moves and what the
   * console's Settings says it is not.
   *
   * The update is the authorisation: the `from membership` join means a team the caller is not
   * in matches no row and is indistinguishable from one that does not exist — the same shape
   * `revokeMyAccessTokenFor` uses for a token id belonging to somebody else. Superadmins get no
   * bypass; reading another team's data is what `?scope=platform` is for.
   *
   * The session is found by the cookie's own hash, as `/auth/logout` finds it. A caller who is
   * not a signed-in browser — an agent carrying a token — is refused and told where an agent's
   * team moves, rather than being handed a success that changed nothing they can see.
   */
  app.post("/api/console/settings/me/active-team", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const token = readCookie(req, CONSOLE_COOKIE);
      if (id.via !== "session" || !token) {
        res.status(400).json({
          error: "this moves the team a signed-in console browser acts for, and this request " +
                 "is not one. To move the team your agents act for, call team_switch on the " +
                 "/manage door.",
        });
        return;
      }
      const { team } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof team !== "string" || !TEAM_SLUG.test(team)) {
        res.status(400).json({ error: "team must be a slug" });
        return;
      }
      const from = id.activeTeam;
      const r = await platformDb().query(
        `update console_session s set team_id = t.id
           from team t join membership m on m.team_id = t.id
          where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
            and m.principal_id = s.principal_id
            and t.slug = $2 and t.status = 'active'`,
        [sha256(token), team],
      );
      if (!r.rowCount) {
        res.status(400).json({ error: `not a member of ${team}` });
        return;
      }
      // `via: "web"` is stated here and never inherited — see the gate check "every console
      // write route records the door it came through". Without it the row would say a person
      // switched teams and nothing would say a browser did it rather than an agent turn.
      logEvent({
        actor: id.email, kind: "team.switch", subject: team, teamSlug: team, origin: id.origin,
        detail: { via: "web", from },
      });
      res.json(redact({ ok: true, actingFor: team, from }));
    })().catch((err: unknown) => {
      console.error("settings/me/active-team failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not switch team" });
    });
  });

  /** Issue a brand new personal access token for the caller.
   *
   * DELIBERATE: `result.token` is returned in plaintext, outside `redact()`. It is shown exactly
   * once, at the moment of issue, and is useless to the platform afterwards. This is the only
   * response in settings.ts not passed through `redact()`, and `redact()` itself makes no
   * exception for a field named `token`, so the exemption can only live here. */
  app.post("/api/console/settings/me/tokens", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      // The same rule `pat_issue` keeps: a bound token cannot mint a wider one. This route issues
      // an unbound token — credentials.ts's insert has no team column — so without this it is the
      // HTTP way round the binding, beside a route that refuses the same token for a smaller act.
      if (id.patTeam) {
        res.status(403).json({
          error: `your token is bound to team '${id.patTeam}', so it cannot issue a token that ` +
                 "reaches further than it does. Sign in at the console, or use an unbound token.",
        });
        return;
      }
      const { label } = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.issueMyAccessTokenFor(
        id.email, typeof label === "string" ? label : undefined, { via: "web" }, id.origin);
      if (!result.ok) { res.status(400).json({ error: result.error }); return; }
      res.json({ token: result.token, label: result.label, email: result.email });
    })().catch((err: unknown) => {
      console.error("settings/me/tokens (issue) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not issue token" });
    });
  });

  /** Revoke one of the caller's own tokens. `revokeMyAccessTokenFor`'s own query is the
   *  whole authorisation check — its `principal_id = (select id from principal where
   *  email = $2)` makes a token id belonging to somebody else indistinguishable from one
   *  that never existed, so there is no separate ownership check to have forgotten here. */
  app.delete("/api/console/settings/me/tokens/:id", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const tokenId = req.params.id;
      const ok = await deps.revokeMyAccessTokenFor(id.email, tokenId, { via: "web" }, id.origin);
      if (!ok) { res.status(400).json({ error: "no such active token of yours" }); return; }
      res.json(redact({ ok: true, revoked: tokenId }));
    })().catch((err: unknown) => {
      console.error("settings/me/tokens (revoke) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not revoke token" });
    });
  });

  /** Revoke an application the caller authorised: every live token of theirs minted through that
   *  OAuth client, answered as how many.
   *
   *  DELIBERATE: the client registration is never touched. It is shared by everybody who connected
   *  through it, and revoking it is the superadmin's `client_revoke` on /manage. A client the
   *  caller holds no token of, live or revoked, is not theirs and answers 404; one whose tokens are
   *  all revoked already answers that it revoked none. Browser session only, as the team switch is:
   *  a token is refused rather than let revoke what signs its holder in. */
  app.delete("/api/console/settings/me/applications/:client", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      if (id.via !== "session" || !readCookie(req, CONSOLE_COOKIE)) { res.status(400).json({ error: BROWSER_ONLY }); return; }
      const client = req.params.client;
      // Ownership is the `mine` predicate: the caller's own tokens from that client, and nobody else's.
      const r = await platformDb().query<{ minted: number; revoked: string[] }>(
        `with mine as (
           select pat.id, pat.revoked_at from pat join principal p on p.id = pat.principal_id
            where p.email = $1 and pat.oauth_client_id = $2),
         ended as (
           update pat set revoked_at = now() where id in (select id from mine where revoked_at is null) returning id)
         select (select count(*) from mine)::int as minted,
                (select coalesce(array_agg(id::text order by id), '{}') from ended) as revoked`,
        [id.email, client]);
      const { minted, revoked } = r.rows[0];
      if (!minted) { res.status(404).json({ error: "no application of yours is registered as that client" }); return; }
      // One `pat.self_revoke` a token, as the token revoke writes, with the client it came from.
      for (const tokenId of revoked) {
        logEvent({ actor: id.email, kind: "pat.self_revoke", subject: tokenId, origin: id.origin, detail: { via: "web", client } });
      }
      res.json(redact({ ok: true, revoked: revoked.length }));
    })().catch((err: unknown) => {
      console.error("settings/me/applications (revoke) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not revoke application" });
    });
  });

  /** Sign out another browser the caller is signed in on, by its session's id.
   *
   *  The session is the caller's live one with that id, found in the statement that revokes it;
   *  anybody else's, or one already ended, answers 404. The browser asking is refused: ending it
   *  here would leave the page standing on a session that no longer exists, and Sign out in the
   *  menu ends it and clears its cookie. Browser session only, as the team switch is. */
  app.delete("/api/console/settings/me/browsers/:id", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const cookie = readCookie(req, CONSOLE_COOKIE);
      if (id.via !== "session" || !cookie) { res.status(400).json({ error: BROWSER_ONLY }); return; }
      const session = req.params.id;
      const missing = { error: "no browser of yours is signed in with that id" };
      if (!SESSION_ID.test(session)) { res.status(404).json(missing); return; }
      const r = await platformDb().query<{ is_current: boolean | null; revoked: number }>(
        `with target as (
           select s.id, s.token_hash = $3 as is_current
             from console_session s join principal p on p.id = s.principal_id
            where s.id = $2::uuid and p.email = $1 and s.revoked_at is null and s.expires_at > now()),
         ended as (
           update console_session s set revoked_at = now() from target t where s.id = t.id and not t.is_current returning s.id)
         select (select is_current from target) as is_current, (select count(*) from ended)::int as revoked`,
        [id.email, session, sha256(cookie)]);
      const { is_current: current, revoked } = r.rows[0];
      if (current === null) { res.status(404).json(missing); return; }
      if (current) {
        res.status(400).json({ error: "this is the browser you are using: sign out from the menu to end this session" });
        return;
      }
      logEvent({ actor: id.email, kind: "console.sign_out", subject: session, origin: id.origin, detail: { via: "web" } });
      res.json(redact({ ok: true, revoked }));
    })().catch((err: unknown) => {
      console.error("settings/me/browsers (sign out) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not sign the browser out" });
    });
  });

  /** The caller's own client setup, `myClientSetup` above. Still wrapped in `redact()`, so a
   *  future change to what this renders does not have to remember to add it. */
  app.get("/api/console/settings/me/client-setup", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      res.json(redact(await myClientSetup(id.email)));
    })().catch((err: unknown) => {
      console.error("settings/me/client-setup failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not render client setup" });
    });
  });

  /** The caller's own teams, and which one they act for — see `myTeamsSummary` above. */
  app.get("/api/console/settings/me/teams", (req: Request, res: Response) => {
    const id = req.zzIdentity;
    if (!id) { res.status(401).json({ error: "authentication required" }); return; }
    const result = myTeamsSummary(id);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json(redact({ actingFor: result.actingFor, teams: result.teams, note: result.note ?? null }));
  });
}
