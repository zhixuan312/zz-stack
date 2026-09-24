/**
 * Team administration: who is in a team.
 *
 * Every route is behind `teamAuthority` for the team named in the request, never behind
 * "administers some team": a team admin asking about another team's members is answered no.
 */
import type { Express, Request, Response } from "express";

import { redact } from "../redact.js";
import { platformDb, platformDbReady } from "../db.js";
import { addMember, removeMember } from "../admin/teams.js";
import { teamAuthority } from "../admin/authority.js";

export function mountTeamSettings(app: Express): void {
  // A team admin's write surface for their own team — never `/me/*`, because every route here
  // carries a field somebody could put another team's name in. `teamAuthority` is the whole
  // authorisation story: every route below calls it on the `team` the request names before
  // touching anything, and a plain member or a team admin of another team is refused 403.

  /** The team's own slug, trimmed — from the query string for a GET, the body otherwise. */
  function teamField(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }

  /** Members of a team the caller administers. Read-only and still gated by `teamAuthority`:
   *  a route that answered a GET for anyone while refusing every write would hand the roster
   *  to someone the UI never shows it to. */
  app.get("/api/console/settings/team/members", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const team = teamField(req.query.team);
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      if (!teamAuthority(id, team)) {
        res.status(403).json({ error: `team admin or superadmin required for ${team}` });
        return;
      }
      const rows = await platformDb().query<{ email: string; role: string }>(
        `select p.email, m.role from zz.membership m
           join zz.principal p on p.id = m.principal_id
           join zz.team t on t.id = m.team_id
          where t.slug = $1 order by m.role, p.email`, [team]);
      res.json(redact(rows.rows));
    })().catch((err: unknown) => {
      console.error("settings/team/members (list) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not list team members" });
    });
  });

  /** Add a member, or change one's role: `addMember` (admin.js) does both in one call through
   *  `on conflict ... do update set role`, so this route needs no second path for "already a
   *  member". */
  app.post("/api/console/settings/team/members", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = teamField(body.team);
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      if (!email) { res.status(400).json({ error: "email is required" }); return; }
      if (body.role !== undefined && body.role !== "member" && body.role !== "admin") {
        res.status(400).json({ error: "role must be 'member' or 'admin'" });
        return;
      }
      const r = await addMember(id, team, email, body.role as "member" | "admin" | undefined, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/team/members (add) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not add team member" });
    });
  });

  /** Remove a member. `confirm` must repeat the team slug exactly — `removeMember`'s own rule,
   *  surfaced here rather than duplicated. The UI's confirmation is an inline swap, not a
   *  modal; this is the gateway's own check regardless of what the browser sent. */
  app.delete("/api/console/settings/team/members", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = teamField(body.team);
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : "";
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      if (!email) { res.status(400).json({ error: "email is required" }); return; }
      const r = await removeMember(id, team, email, confirm, { via: "web" });
      // `removeMember`'s own "nothing was removed" refusal is a 400 like every other
      // validation error here, surfaced through `r.error` rather than swallowed into a generic
      // "removed".
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/team/members (remove) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not remove team member" });
    });
  });
}
