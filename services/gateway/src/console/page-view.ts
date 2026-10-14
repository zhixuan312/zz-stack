/**
 * `POST /api/console/page-view` — one committed navigation in the console, recorded as one
 * `console.page_view` event, and counted as nothing else.
 *
 * The event says which destination was opened and nothing more: `subject` is a feature id from the
 * closed list below, `detail` is `{ workspace }` and only that, and the actor and team are the
 * authenticated caller's own. No address, query, initiative, document or record name can reach it,
 * because the only thing read from the body is a key that must already be in the list. The
 * workspace is the gateway's answer from the feature, never the caller's.
 *
 * A POST, where console.ts is GET only. The console session cookie is SameSite=Lax, so a cross-site
 * form posting here arrives with no session and is answered 401, the same protection every route in
 * console-write.ts relies on; the most a forged view could do is add one row nobody counts.
 *
 * DELIBERATE: `teamless`, not `handler`. `handler` resolves a scope, which refuses a caller in no
 * team and prefers the request's `?team=`; a page view is recorded for whoever is signed in, under
 * the team their identity acts for, and a person in no team is still a reader (team null).
 *
 * Telemetry never fails the page: `logEvent` does not wait for the write and never throws, and a
 * write that fails is logged and kept in its stranded file (events.ts). The answer is 204 either way.
 *
 * A page view is left out of every count of events a page shows. COUPLED: the activity log and the
 * overview's event census in console/overview.ts each leave `console.page_view` out by name; every
 * other event reader in the console counts `tool_call` or another kind it names.
 */
import type { Express } from "express";

import { logEvent } from "../events.js";
import { teamless } from "./shared.js";

type Workspace = "main" | "platform";

/** The features a page view may name, and the workspace each destination is in: the spec's
 *  destinations, the internal bug page's `bug`, and `settings`, which today's console still has.
 *  `teams` and `people` stay `main` until the phase that moves them to the Platform workspace.
 *
 *  COUPLED: the console's `src/data/features.ts` is its counterpart, and its fake gateway
 *  (`scripts/fake-gateway/server.ts`, `PAGE_FEATURES`) copies this list. */
const FEATURES: ReadonlyMap<string, Workspace> = new Map<string, Workspace>([
  ["home", "main"], ["record", "main"], ["initiatives", "main"], ["approvals", "main"],
  ["knowledge", "main"], ["activity", "main"], ["runs", "main"], ["plugins", "main"],
  ["access", "main"], ["settings", "main"], ["teams", "main"], ["people", "main"],
  ["platform-status", "platform"], ["releases", "platform"], ["bugs", "platform"],
  ["bug", "platform"], ["evaluation", "platform"], ["usage", "platform"], ["audit", "platform"],
  ["knowledge-health", "platform"],
]);

export function mountPageView(app: Express): void {
  app.post("/api/console/page-view", teamless("page view", async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "the body must be an object: { feature }" });
      return;
    }
    const { feature } = body as { feature?: unknown };
    if (typeof feature !== "string" || !feature) {
      res.status(400).json({ error: "feature required — the destination that was opened" });
      return;
    }
    const workspace = FEATURES.get(feature);
    if (!workspace) {
      // The list is closed, so a value that is not in it is never written, and never echoed back
      // longer than a feature id could be.
      res.status(400).json({ error: `${feature.slice(0, 64)} is not one of the console's destinations` });
      return;
    }
    const id = req.zzIdentity!;
    // No `via: "web"` and no request scope: the detail is the workspace and nothing else.
    logEvent({ actor: id.email, teamSlug: id.activeTeam, kind: "console.page_view", subject: feature,
               detail: { workspace } });
    res.status(204).end();
  }));
}
