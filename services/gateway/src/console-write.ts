/**
 * /api/console — the console's write surface.
 *
 * DELIBERATE: console.ts is GET only, so a read-only surface cannot be driven by a forged
 * cross-site form. This file is the acts, each arriving from a button in the console rather
 * than a chat turn.
 *
 * Each act collects the request's own `x-zz-*` headers, opens an `Mcp` client against
 * `CORE_MCP_URL` with them attached, and calls the tool. The gateway
 * writes no platform table itself and never sets `approved_by` — zz-core reads the author from
 * those headers and trusts them because a peer allowlist admits only the gateway, so forwarding
 * them is what keeps the web from acting as somebody else. `on_behalf_of` is never sent: that
 * field is for a verdict that is someone else's, and the console caller approves as themselves.
 *
 * Authorised through console.ts's own `handler()`, not a copy of it — the same
 * directory-or-superadmin gate and the same `resolveScope` that decides which team a read sees.
 * A write needs a settled answer to "which team": `document_approve` stamps one document
 * belonging to one team, so `?scope=platform` is refused with a 400 rather than picking a team
 * to log against.
 */
import type { Express, Request, Response } from "express";

import { Mcp, McpError } from "@zz/mcp-client";

import { handler, type ResolvedScope } from "./console/shared.js";
import { logEvent } from "./events.js";

export function mountConsoleWrite(app: Express): void {
  // NOT A TOOL: handler()'s first argument is the human-readable label in "console <name>
  // failed" and "could not read <name>".
  app.post("/api/console/documents/approve", handler("approve", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") {
      // Only `{ kind: "platform" }` reaches here otherwise — a refused scope already answered
      // inside handler(). The platform reading names no team, so there is nothing for
      // `zz.event`'s team column or the membership check below to be about.
      res.status(400).json({ error: "approve needs one team — pass ?team=<slug>, not ?scope=platform" });
      return;
    }
    const { initiative, path } = (req.body ?? {}) as Record<string, string>;
    if (!initiative || !path) {
      res.status(400).json({ error: "initiative and path required" });
      return;
    }
    const actor = req.zzIdentity!.email;
    // The caller's own identity, forwarded — see the file header for why this is not the
    // gateway acting on the caller's behalf.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
    }
    const core = new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
    const subject = `${initiative}/${path}`;
    let reply: string;
    try {
      reply = await core.call("document_approve", { path: subject });
    } catch (err) {
      // `Mcp.call` throws only for a transport or protocol failure — a refusal comes back as
      // ordinary text beginning with ERROR, read below. So everything that lands here is "could
      // not reach zz-core", never "zz-core said no".
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    // zz-core's refusal is the diagnosis — not a member of the document's team, the path
    // does not exist, the document is not one this flow declares — so it is carried back
    // unchanged rather than replaced with a generic message that would throw that away.
    if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }
    // Written after the act succeeds, never before, and `via: "web"` is stated here rather
    // than assumed from `document_approve` itself, which has callers that are not this console
    // and must not inherit a door marker they did not come through.
    //
    // COUPLED: no `teamSlug`. `scope.slug` is the team this REQUEST asked for (`?team=`), and
    // zz-core resolves the team the document is actually in from the caller's own identity headers
    // — they are two things, and a caller in two teams naming the other one used to have this row
    // attributed to a team the document does not belong to. The console cannot learn the real team
    // here: `document_approve` answers in prose, unlike `knowledge_search`, whose JSON reply is why
    // console-ask can record the team the act happened in. So the request's own choice is recorded
    // as what it is, in the detail, and the row is attributed to no team rather than the wrong one.
    logEvent({ actor, kind: "document.approve", subject, detail: { via: "web", asked_for: scope.slug } });
    res.json({ ok: true, result: reply });
  }));
}
