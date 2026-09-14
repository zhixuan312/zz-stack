/**
 * Platform administration: people, enrolments, teams and blocks, across every tenant.
 *
 * Superadmin only, and that is the whole distinction from the team routes beside it. These
 * are the writes that create a tenant, retire a person, or change what every team can reach,
 * and none of them is something a team's own admin may do.
 */
import type { Express, Request, Response } from "express";

import { redact } from "../redact.js";
import { TEAM_SLUG } from "../identity.js";
import { platformDbReady } from "../db.js";
import { archiveTeam, createTeam } from "../admin/teams.js";
import { addPerson, deactivatePerson, grantTool, issueEnrolmentLink, listPeople, revokeTool } from "../admin/people.js";

export function mountPlatformSettings(app: Express): void {
  // --------------------------------------------------------- /platform/* (Task I-15, AC-5)
  //
  // A SUPERADMIN's write surface over the whole platform: add and deactivate people, create
  // and archive teams, and grant or revoke a team's block access. Every route below calls
  // one of the extracted admin.ts functions (`listPeople`, `addPerson`, `deactivatePerson`,
  // `createTeam`, `archiveTeam`, `grantTool`, `revokeTool`), each guarded by `superOnly`
  // INSIDE that function — the same discipline `teamAuthority` already gets in this file,
  // and for the same reason: a route that compared `platformRole` here instead
  // would pass this file's own review while quietly drifting from what the admin tools on
  // `/manage/mcp` actually enforce.
  //
  // BLOCK ACCESS STAYS SUPERADMIN-ONLY. `grantTool`/`revokeTool`'s own comment (admin.ts)
  // says access to a building block is a platform decision — there is no `/team/*` route
  // above that reaches either of them, and none should ever be added; only this tier does.

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
   * NOT WRAPPED IN `redact()`, and it is the second exemption in this file after `POST
   * /me/tokens`. The response carries a live one-time credential, exactly once, for the same
   * reason a freshly issued token does — the person has to be able to send it to somebody.
   * `redact()` would replace it with a marker and the route would report success while
   * handing back nothing usable, which is the worst of both. The field is named `url` rather
   * than anything the secret-name rule matches, so this is a deliberate exemption rather than
   * a field that slipped past one; see redact.ts on why that rule fails closed.
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

  /** Deactivate a principal. `confirm` must repeat the email exactly — `deactivatePerson`'s
   *  own rule (admin.ts), surfaced here rather than duplicated. The UI's own confirmation is
   *  an inline swap (NFR-4, no modal); this is the gateway's independent check regardless of
   *  what the browser sent. */
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

  /** Grant a team access to a building block — always `superOnly` (inside `grantTool`),
   *  never `teamAuthority`: see this section's header and `grantTool`'s own comment
   *  (admin.ts) for why block access is a platform decision no team-tier route may reach. */
  app.post("/api/console/settings/platform/blocks", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = typeof body.team === "string" ? body.team.trim() : "";
      const block = typeof body.block === "string" ? body.block.trim() : "";
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      if (!block) { res.status(400).json({ error: "block is required" }); return; }
      const r = await grantTool(id, team, block, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/blocks (grant) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not grant block access" });
    });
  });

  /** Revoke a team's block access. `confirm` must repeat the block id exactly —
   *  `revokeTool`'s own rule (admin.ts), surfaced here rather than duplicated. */
  app.delete("/api/console/settings/platform/blocks", (req: Request, res: Response) => {
    void (async () => {
      const id = req.zzIdentity;
      if (!id) { res.status(401).json({ error: "authentication required" }); return; }
      if (!platformDbReady()) { res.status(503).json({ error: "platform database unavailable" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const team = typeof body.team === "string" ? body.team.trim() : "";
      const block = typeof body.block === "string" ? body.block.trim() : "";
      const confirm = typeof body.confirm === "string" ? body.confirm : "";
      if (!team) { res.status(400).json({ error: "team is required" }); return; }
      if (!block) { res.status(400).json({ error: "block is required" }); return; }
      const r = await revokeTool(id, team, block, confirm, { via: "web" });
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      res.json(redact({ ok: true, result: r.message }));
    })().catch((err: unknown) => {
      console.error("settings/platform/blocks (revoke) failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "could not revoke block access" });
    });
  });
}
