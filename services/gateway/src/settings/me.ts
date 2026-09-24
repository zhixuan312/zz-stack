/**
 * A person's own settings: their access tokens, which team they act for, the teams they are on,
 * and the client package that installs the platform for them.
 *
 * Every route here acts on the caller and takes no subject argument, so nothing here can reach
 * anybody else's account and the only question left is whether the caller is signed in.
 */
import type { Express, Request, Response } from "express";

import type { SettingsDeps } from "../settings.js";
import { myTeamsSummary } from "../settings.js";
import { redact } from "../redact.js";
import { TEAM_SLUG } from "../identity.js";
import { logEvent } from "../events.js";
import { platformDb, platformDbReady } from "../db.js";
import { renderClientSetup } from "../admin/flows.js";

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

  /** Change which of the caller's own teams they act for: the console's own `team_switch`.
   *
   * COUPLED: this is the same switch, not a second notion of one. `principal.active_team_id` is
   * what `chosenTeam` (identity.ts) reads on every request, so moving it here moves the browser,
   * every agent that authenticates as this person, and anything else that resolves an identity.
   *
   * The update is the authorisation: the `from membership` join means a team the caller is not in
   * matches no row and is indistinguishable from one that does not exist — the same shape
   * `revokeMyAccessTokenFor` uses for a token id belonging to somebody else. Superadmins get no
   * bypass; reading another team's data is what `?scope=platform` is for.
   *
   * A bound token is refused rather than silently ignored: writing active_team_id under one would
   * succeed in the database and change nothing the caller can see.
   */
  app.post("/api/console/settings/me/active-team", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const { team } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof team !== "string" || !TEAM_SLUG.test(team)) {
        res.status(400).json({ error: "team must be a slug" });
        return;
      }
      if (id.patTeam) {
        res.status(400).json({
          error: `your token is bound to team '${id.patTeam}', so it cannot be moved. ` +
                 `A token bound to a team is what makes it safe to leave running.`,
        });
        return;
      }
      const from = id.activeTeam;
      const r = await platformDb().query(
        `update principal p set active_team_id = t.id
           from team t join membership m on m.team_id = t.id
          where p.email = $1 and m.principal_id = p.id
            and t.slug = $2 and t.status = 'active'`,
        [id.email, team],
      );
      if (!r.rowCount) {
        res.status(400).json({ error: `not a member of ${team}` });
        return;
      }
      // `via: "web"` is stated here and never inherited — see the gate check "every console
      // write route records the door it came through". Without it the row would say a person
      // switched teams and nothing would say a browser did it rather than an agent turn.
      logEvent({
        actor: id.email, kind: "team.switch", subject: team, teamSlug: team,
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
      const result = await deps.issueMyAccessTokenFor(id.email, typeof label === "string" ? label : undefined, { via: "web" });
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
      const ok = await deps.revokeMyAccessTokenFor(id.email, tokenId, { via: "web" });
      if (!ok) { res.status(400).json({ error: "no such active token of yours" }); return; }
      res.json(redact({ ok: true, revoked: tokenId }));
    })().catch((err: unknown) => {
      console.error("settings/me/tokens (revoke) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not revoke token" });
    });
  });

  /** The caller's own client setup — the Claude Code install steps, pointing here. Its bearer
   *  header is always a placeholder (`<YOUR-TOKEN>` / `$ZZ_TOKEN`); `renderClientSetup` never
   *  mints or embeds a real one. Still wrapped in `redact()`, so a
   *  future change to what this renders does not have to remember to add it. */
  app.get("/api/console/settings/me/client-setup", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const config = await renderClientSetup(id.email);
      res.json(redact({ client: "claude-code", config }));
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
