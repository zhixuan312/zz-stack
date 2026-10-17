/**
 * Who is looking, and whether the console will answer them at all.
 *
 * `/me` is not behind `ok()`: it answers 200 even to a caller the console will refuse everywhere
 * else, with `mayRead: false`, so the front end can render "you are signed in and this view is not
 * for you" rather than a bare 403 that reads as a broken login.
 */
import type { Express } from "express";

import { isSuper } from "../identity.js";
import { mayReadConsole } from "./shared.js";

export function mountMe(app: Express): void {
  /** Who is looking, and whether the console will answer them at all. Returns nothing but the
   *  caller's own identity. */
  app.get("/api/console/me", (req, res) => {
    const id = req.zzIdentity;
    if (!id) { res.status(401).json({ error: "authentication required" }); return; }
    res.json({
      email: id.email, name: id.displayName, role: id.platformRole,
      mayRead: mayReadConsole(id), superadmin: isSuper(id), via: id.via,
      // The sentence, not just the verdict: `ok()` names its refusals — "the console needs a
      // browser sign-in — x@y authenticated by pat" — and that sentence is the diagnosis. This
      // route answers 200, so it carries the same wording from the same two facts.
      ...(mayReadConsole(id) ? {} : {
        why: `the console needs a browser sign-in — ${id.email} authenticated by ${id.via}`,
      }),
      // `id.teams` already carries `{ slug, role }`; mapping it down to slugs would throw the
      // role away and the browser could not tell a team admin from a member.
      teams: id.teams, activeTeam: id.activeTeam,
    });
  });
}
