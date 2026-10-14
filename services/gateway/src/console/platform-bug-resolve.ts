/**
 * `POST /api/console/platform/bugs/:id/resolve` — the superadmin closes a report from the console,
 * through the same `bug_resolve` an agent calls.
 *
 * The route decides three things itself and nothing else. Who: the superadmin alone, from the flag
 * `platformPublic` hands it, before anything is read, with no name in the refusal. Which report: an
 * id that is not a UUID naming a row of `zz.bug` is a 404 with no body, read here before zz-core is
 * asked. And how zz-core's answer reads as HTTP. Everything about the close itself — a blank
 * resolution, the duplicate target, a report already closed, two closes at once — is
 * `bug_resolve`'s, called as the person through `coreFor(req)` with the body's fields unchanged, so
 * the console and an agent cannot come to different answers. The route never writes `zz.bug`.
 *
 * The answer: the tool's JSON reply is a 204; a reply opening `ERROR: that report was already
 * closed as` is a 409 carrying the first decision's sentence, so the page keeps what the person
 * typed; every other reply, a refusal or the SDK's own validation text alike, is a 400 with
 * zz-core's text; a call that cannot reach zz-core is a 502.
 *
 * DELIBERATE: a POST mounted beside the console's reads. The console session cookie is
 * SameSite=Lax, so a cross-site form posting here arrives with no session and is answered 401, the
 * same protection every route in console-write.ts relies on.
 *
 * COUPLED: the console's `BugResolveInput` in src/lib/platform-shapes.ts, and its fake answer in
 * scripts/fake-gateway/platform-bugs.ts (`resolve`); `checks/console-bug-resolve.ts` holds this
 * route and the tool to the same rows and the same refusals.
 */
import type { Express } from "express";

import { McpError } from "@zz/mcp-client";

import { platformDb } from "../db.js";
import { coreFor } from "../core-as-caller.js";
import { logEvent } from "../events.js";
import { platformPublic } from "./shared.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** COUPLED: `bug_resolve`'s refusal of a second close (services/zz-core/src/tools/bugs.ts), which
 *  the release's chain check also reads. The one reply that is a conflict rather than a refusal. */
const ALREADY_CLOSED = "ERROR: that report was already closed as";

/** The tool's success reply, the id, the status and the resolution as stored, or null. */
function closed(reply: string): { id: string; status: string } | null {
  try {
    const v = JSON.parse(reply) as { id?: unknown; status?: unknown; resolution?: unknown };
    return typeof v.id === "string" && typeof v.status === "string" && typeof v.resolution === "string"
      ? { id: v.id, status: v.status } : null;
  } catch {
    return null;
  }
}

export function mountPlatformBugResolve(app: Express): void {
  app.post("/api/console/platform/bugs/:id/resolve", platformPublic("bug resolve", async (req, res, caller) => {
    if (!caller.superadmin) {
      res.status(403).json({ error: "not permitted" });
      return;
    }
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) {
      res.status(404).end();
      return;
    }
    const { rows } = await platformDb().query<{ id: string }>(
      "select id::text as id from zz.bug where id = $1::uuid", [id]);
    if (!rows.length) {
      res.status(404).end();
      return;
    }
    const body = (typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? req.body : {}) as
      Record<string, unknown>;
    const { status, resolution, duplicate_of } = body;
    let reply: string;
    try {
      reply = await coreFor(req).call("bug_resolve", { id, status, resolution, duplicate_of });
    } catch (err) {
      // `Mcp.call` throws only for a transport or protocol failure; a refusal is text, read below.
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    if (reply.startsWith(ALREADY_CLOSED)) {
      res.status(409).json({ error: reply });
      return;
    }
    const done = closed(reply);
    if (!done) {
      res.status(400).json({ error: reply });
      return;
    }
    // After the act, never before. DELIBERATE: not `bug.resolve`, which zz-core writes itself for
    // every close; this row is the door it came through.
    logEvent({ actor: req.zzIdentity!.email, kind: "bug.console_resolve", subject: done.id, origin: req.zzIdentity!.origin,
               detail: { via: "web", status: done.status } });
    res.status(204).end();
  }));
}
