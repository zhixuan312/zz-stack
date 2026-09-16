/**
 * A person's own settings: their keys, their access tokens, which team they act for, the
 * and the client package that installs the platform for them.
 *
 * EVERY ROUTE HERE ACTS ON THE CALLER and takes no subject argument, which is what makes the
 * authorisation trivial and the surface safe: there is nothing here that can reach anybody
 * else's account, so the only question left is whether the caller is signed in.
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

  /** Change which of the caller's own teams they act for (← the console's own team_switch).
   *
   * IT IS THE SAME SWITCH, not a second notion of one. `principal.active_team_id` is what
   * `chosenTeam` (identity.ts) reads on every request, so moving it here moves the browser,
   * every agent that authenticates as this person, and anything else that resolves an
   * identity — which is right: a person acts for ONE team at a time and that fact belongs
   * to the person, not to whichever client is in front of them.
   *
   * THE UPDATE IS THE AUTHORISATION. The `from membership` join means a team the caller is
   * not in matches no row and is indistinguishable from one that does not exist — the same
   * shape `revokeMyAccessTokenFor` uses for a token id belonging to somebody else, and for
   * the same reason: a separate membership check is a check somebody can forget, where a
   * join that produces nothing cannot be. Superadmins get no bypass here; reading another
   * team's data is what `?scope=platform` is for, and ACTING as a team you are not in is a
   * different claim that nothing on this console needs to make.
   *
   * A BOUND TOKEN IS REFUSED RATHER THAN SILENTLY IGNORED. `myTeamsSummary` already tells
   * the caller their token is bound and that team_switch cannot move it; writing
   * active_team_id under a bound token would succeed in the database and change nothing
   * they can see, which is worse than saying no.
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
      // `via: "web"` is stated HERE and never inherited — see the gate check "every console
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
   * THE ONE DELIBERATE EXCEPTION IN THIS FILE: `result.token` is returned in plaintext,
   * outside `redact()`, on purpose. It is shown exactly once, at the moment of issue, and is
   * useless to the platform forever after — redacting it would not protect anything, it
   * would just break the one response whose entire purpose is handing over the secret the
   * caller just asked for. This is the ONLY response in settings.ts not passed through
   * `redact()`; every other route in this file is. See redact.ts's own header for the other
   * half of this contract — `redact()` itself makes no exception for a field named `token`,
   * so the exemption can only ever live here, in this route choosing not to call it. */
  app.post("/api/console/settings/me/tokens", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
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

  /** The caller's own client setup — the MCP config for Claude Code, Codex or Hermes,
   *  pointing here, carrying only the blocks their team's installed flows declare. Its
   *  bearer header is always a placeholder (`<YOUR-TOKEN>` / `$ZZ_TOKEN`) — `renderClientSetup`
   *  never mints or embeds a real one — so there is no live secret in this response for
   *  `redact()` to catch; it is still wrapped for the same reason every other read here is:
   *  a future change to what this renders should not have to remember to add it. */
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
