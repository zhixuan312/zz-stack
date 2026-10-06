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
 * The console approves what it showed (AC-3.2). Opening a document records its own presentation
 * — `documents/shown` calls `document_shown` with the snapshot the page displayed, and zz-core
 * accepts that without a panel ticket only from a console session (`x-zz-via: session`, which the
 * gateway stamps and a client cannot) and answers the console's review context. Approve then sends
 * that snapshot as `expected_revision` and that context, so it signs exactly what the page showed.
 * zz-core's two refusals that mean "this page is out of date" — the document changed after it was
 * shown, or nothing of this session's shows the current snapshot — are answered 409 in the
 * console's own words, with zz-core's sentence beside them as `detail`; the page offers a reload.
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

/** A zz-core client carrying the caller's own `x-zz-*` headers — see the file header for why this
 *  is not the gateway acting on the caller's behalf. */
function coreFor(req: Request): Mcp {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase().startsWith("x-zz-") && typeof v === "string") headers[k] = v;
  }
  return new Mcp(process.env.CORE_MCP_URL || "http://zz-core:8000/mcp", { headers });
}

/** zz-core's answer to a page that is out of date, in the console's words, or null for any other.
 *
 * COUPLED: the refusals' openings in services/zz-core — `APPROVAL_CONFLICT` and
 * `PRESENTATION_REQUIRED` (attest.ts), and `document_shown`'s "is at content revision … now, not"
 * and `commitPresentation`'s "changed while it was being presented" (document-panel.ts,
 * review-context.ts). `changed` is a document that moved after the page showed it; `unshown` is an
 * approval no presentation of this session's covers. `signing` words the answer for the Approve button. */
function staleAnswer(reply: string, name: string, signing: boolean):
  { conflict: "changed" | "unshown"; error: string } | null {
  if (/^ERROR: APPROVAL_CONFLICT\b/.test(reply) || /^ERROR: \S+ (is at content revision \S+ now, not|changed while it was being presented)/.test(reply)) {
    return {
      conflict: "changed",
      error: signing
        ? `${name} changed after this page showed it, so it was not approved. Reload to read what it says now, then approve that.`
        : `${name} changed after this page loaded it. Reload to read what it says now.`,
    };
  }
  if (/^ERROR: PRESENTATION_REQUIRED\b/.test(reply)) {
    return {
      conflict: "unshown",
      error: `${name} was not approved: the console has no record of showing you what it says now. Reload the page, then approve.`,
    };
  }
  return null;
}

export function mountConsoleWrite(app: Express): void {
  /* The presentation a person's page makes when it displays a document: `document_shown` with the
   * snapshot it rendered (`content_revision`, from the document read) and, after the first, the
   * context it was handed back. Answers that context. */
  app.post("/api/console/documents/shown", handler("shown", async (req: Request, res: Response, scope: ResolvedScope) => {
    // Same settled team as approve below, for the same reason.
    if (scope.kind !== "team") {
      res.status(400).json({ error: "shown needs one team — pass ?team=<slug>, not ?scope=platform" });
      return;
    }
    const { initiative, path, content_revision, review_context } = (req.body ?? {}) as Record<string, string>;
    if (!initiative || !path || !content_revision) {
      res.status(400).json({ error: "initiative, path and content_revision required" });
      return;
    }
    const core = coreFor(req);
    const subject = `${initiative}/${path}`;
    let reply: string;
    try {
      reply = await core.call("document_shown", { path: subject, content_revision, ...(review_context ? { review_context } : {}) });
    } catch (err) {
      // See approve below: a throw here is "could not reach zz-core", never a refusal.
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    const stale = staleAnswer(reply, path, false);
    if (stale) { res.status(409).json({ ...stale, detail: reply }); return; }
    if (/^ERROR/.test(reply)) { res.status(400).json({ error: reply }); return; }
    // COUPLED: `shownAs` in services/zz-core/src/document-panel.ts — both of the console's answers,
    // recorded and already recorded, end "Review context: rc_….". A reply naming none is not a
    // recorded presentation, whatever else it says.
    const context = /Review context: (rc_[a-z2-7]{26})\./.exec(reply)?.[1];
    if (!context) {
      res.status(502).json({ error: `zz-core answered document_shown without a review context: ${reply}` });
      return;
    }
    // DELIBERATE: not `document.shown`. zz-core writes that kind itself, and both the pin rule
    // (document-snapshot.ts) and a context's coverage (review-context.ts) read it — a row here under
    // that name would mark a snapshot presented that zz-core never recorded. No `teamSlug`, as below.
    logEvent({ actor: req.zzIdentity!.email, kind: "document.console_shown", subject,
               detail: { via: "web", asked_for: scope.slug, content_revision, review_context: context } });
    res.json({ ok: true, review_context: context, content_revision, recorded: !/^Already recorded/.test(reply) });
  }));

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
    const { initiative, path, expected_revision, review_context } = (req.body ?? {}) as Record<string, string>;
    // Both identities are required: the console signs only the snapshot its page showed, under
    // the context `documents/shown` answered for it.
    if (!initiative || !path || !expected_revision || !review_context) {
      res.status(400).json({ error: "initiative, path, expected_revision and review_context required" });
      return;
    }
    const actor = req.zzIdentity!.email;
    const core = coreFor(req);
    const subject = `${initiative}/${path}`;
    let reply: string;
    try {
      reply = await core.call("document_approve", { path: subject, expected_revision, review_context });
    } catch (err) {
      // `Mcp.call` throws only for a transport or protocol failure — a refusal comes back as
      // ordinary text beginning with ERROR, read below. So everything that lands here is "could
      // not reach zz-core", never "zz-core said no".
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    const stale = staleAnswer(reply, path, true);
    if (stale) { res.status(409).json({ ...stale, detail: reply }); return; }
    // Every other refusal is the diagnosis — not a member of the document's team, the path
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
