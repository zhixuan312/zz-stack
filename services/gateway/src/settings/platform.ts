/**
 * Platform administration: people, enrolments and teams, across every tenant.
 *
 * Superadmin only, which is the whole distinction from the team routes beside it. These are the
 * writes that create a tenant or retire a person.
 */
import type { Express, Request, Response } from "express";

import { redact } from "../redact.js";
import { TEAM_SLUG } from "../identity.js";
import { platformDbReady } from "../db.js";
import { archiveTeam, createTeam } from "../admin/teams.js";
import { addPerson, deactivatePerson, issueEnrolmentLink, listPeople } from "../admin/people.js";

export function mountPlatformSettings(app: Express): void {
  // A superadmin's write surface over the whole platform: add and deactivate people, and create
  // and archive teams. Every route calls one of the extracted admin functions, each guarded by
  // `superOnly` inside that function rather than by a `platformRole` comparison here, so this
  // file and `/manage/mcp` enforce one rule.

  /** Every principal, with the teams they are in, their role there, and who added them. */
  app.get("/api/console/settings/platform/people", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const r = await listPeople(id);
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact(r.rows));
    })().catch((err: unknown) => {
      console.error("settings/platform/people (list) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not list people" });
    });
  });

  /** Create a principal, or reactivate a deactivated one on the same email — `addPerson`'s
   *  own `on conflict` (admin.ts) is why there is no second path for "already exists". */
  app.post("/api/console/settings/platform/people", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const displayName = typeof body.display_name === "string" ? body.display_name : undefined;
      if (!email) { res.status(400).json({ error: "email is required" }); return; }
      const r = await addPerson(id, email, displayName, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/people (add) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not add person" });
    });
  });

  /** Mint an enrolment link so a principal can register a passkey.
   *
   * DELIBERATE: not wrapped in `redact()`, the second exemption in this file after
   * `POST /me/tokens`. The response carries a live one-time credential the person has to be able
   * to send on; `redact()` would replace it with a marker and report success while handing back
   * nothing usable. The field is named `url` rather than anything the secret-name rule matches.
   */
  app.post("/api/console/settings/platform/enrolments", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!email) { res.status(400).json({ error: "email is required" }); return; }
      const r = await issueEnrolmentLink(id, email, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json({ ok: true, url: r.url, expires_at: r.expiresAt, result: r.message });
    })().catch((err: unknown) => {
      console.error("settings/platform/enrolments (issue) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not issue an enrolment link" });
    });
  });

  /** Deactivate a principal. `confirm` must repeat the email exactly — `deactivatePerson`'s own
   *  rule (admin.ts), surfaced here rather than duplicated. This is the gateway's independent
   *  check regardless of what the browser sent. */
  app.delete("/api/console/settings/platform/people", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : "";
      if (!email) { res.status(400).json({ error: "email is required" }); return; }
      const r = await deactivatePerson(id, email, confirm, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/people (deactivate) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not deactivate person" });
    });
  });

  /** Create a team, or reactivate an archived one on the same slug — `createTeam`'s own
   *  `on conflict` (admin.ts) is why. */
  app.post("/api/console/settings/platform/teams", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const slug = typeof body.slug === "string" ? body.slug.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!slug) { res.status(400).json({ error: "slug is required" }); return; }
      // `team_create`'s own MCP schema rejects a malformed slug before the handler runs
      // (zod's `.regex(TEAM_SLUG)`); this route has no zod in front of it, so the same rule
      // is checked here instead of relying on the query below to fail some other way.
      if (!TEAM_SLUG.test(slug)) { res.status(400).json({ error: "slug must be lowercase letters, digits, - or _" }); return; }
      if (!name) { res.status(400).json({ error: "name is required" }); return; }
      const r = await createTeam(id, slug, name, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/teams (create) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not create team" });
    });
  });

  /** Archive a team. `confirm` must repeat the team slug exactly — `archiveTeam`'s own rule
   *  (admin.ts), surfaced here rather than duplicated. */
  app.delete("/api/console/settings/platform/teams", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = typeof body.team === "string" ? body.team.trim() : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : "";
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      const r = await archiveTeam(id, team, confirm, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/teams (archive) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not archive team" });
    });
  });
}
