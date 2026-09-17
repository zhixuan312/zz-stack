/**
 * Team administration: who is in a team.
 *
 * Every route is behind `teamAuthority` for the team NAMED IN THE REQUEST, never behind
 * "administers some team" — a team admin asking about another team's members is answered no.
 * The two are different questions and reading them as one is the failure this guards.
 */
import type { Express, Request, Response } from "express";

import { redact } from "../redact.js";
import { platformDb, platformDbReady } from "../db.js";
import { addMember, removeMember } from "../admin/teams.js";
import { teamAuthority } from "../admin/authority.js";

export function mountTeamSettings(app: Express): void {
  // -------------------------------------------------------------- /team/* (Task I-14, AC-5)
  //
  // A TEAM ADMIN's write surface for their own team — never `/me/*`, because every route
  // here DOES carry a field somebody could put another team's name in. `teamAuthority` is
  // the whole authorisation story: every route below calls it directly on the `team` the
  // request names, before touching anything, and a plain member or a team admin of some
  // OTHER team is refused 403 the same way member_add itself refuses them over MCP.

  /** The team's own slug, trimmed — from the query string for a GET, the body otherwise. */
  function teamField(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }

  /** Members of a team the caller administers. Read-only, but still gated by
   *  `teamAuthority` rather than left open to any member — this is the settings surface a
   *  plain member never sees a control for, and a route that answered a GET for anyone
   *  while refusing every write would leak the roster to someone the UI never shows it to. */
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

  /** Add a member, or change one's role — `addMember` (admin.js) is ADD and CHANGE-ROLE in
   *  one call (its own `on conflict ... do update set role` is why), so this route needs no
   *  second path for "already a member" that could disagree with the first. */
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

  /** Remove a member. `confirm` must repeat the team slug exactly — `removeMember`'s own
   *  rule, surfaced here rather than duplicated, so this route and member_add's destructive
   *  sibling can never disagree about what counts as confirmed. The UI's own confirmation is
   *  an inline swap (NFR-4, no modal); this is the gateway's independent check regardless of
   *  what the browser sent. */
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
      // `removeMember`'s own "nothing was removed" refusal is a 400 the same as every other
      // validation error here — surfaced through `r.error`, never swallowed into a generic
      // "removed" the way the tool this route wraps once was.
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/team/members (remove) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not remove team member" });
    });
  });
}
