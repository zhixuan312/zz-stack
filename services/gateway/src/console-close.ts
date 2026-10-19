/**
 * `POST /api/console/initiatives/:team/:slug/close` — a person closes an initiative from the console,
 * through the same `initiative_close` an agent calls.
 *
 * The route decides three things itself and nothing about the close. Which initiative: Work is the
 * active team's, and `initiative_close` takes no team, so a `:team` other than the one the identity
 * acts for, or a slug that team does not hold, is a 404 before zz-core is asked, answered with the
 * initiative page's own fixed sentence, which names nothing the request did. Which body it relays:
 * one naming `outcome` or `closed_by` is refused, because the platform records both; so is a
 * disposition outside the two, a sign-off field or `document` that is present and blank, and a
 * `document` the initiative does not hold. And how zz-core's answer reads as HTTP. Everything else —
 * the gates, the acceptor, the outcome, the closing document, a close already made — is
 * `initiative_close`'s, called as the person through `coreFor(req)` with the body's fields unchanged,
 * so the console and an agent cannot come to different answers. The route never writes
 * `zz.initiative`.
 *
 * DELIBERATE: a blank sign-off field is refused here although zz-core reads it as absent. The
 * console's `delivered` sends the person's explanation as `no_signoff_reason`; sent blank, zz-core
 * would record the closer as the acceptor, an outcome the person did not choose.
 *
 * The answer: a close is a 200 with the outcome, the closer and the closing document read back off
 * the initiative afterwards; a reply saying the initiative is already closed, was closed by someone
 * else just now or changed while it was being closed is a 409 carrying zz-core's sentence, so the page
 * keeps what the person chose; every other reply, a refusal or the SDK's own validation text alike, is
 * a 400 with zz-core's text; a call that cannot reach zz-core is a 502.
 *
 * DELIBERATE: a POST mounted beside the console's reads. The console session cookie is SameSite=Lax,
 * so a cross-site form posting here arrives with no session and is answered 401, the protection every
 * console write relies on.
 *
 * COUPLED: the console's `CloseInput` and `CloseResult` in src/lib/work-shapes.ts, and its fake
 * answer in ../zz-stack-dashboard/scripts/fake-gateway/work-initiatives.ts (`close`); `checks/console-close.ts` holds this
 * route and the tool to the same outcome, closer, acceptor, closing document and refusal.
 */
import type { Express } from "express";

import { McpError } from "@zz/mcp-client";

import { platformDb } from "./db.js";
import { coreFor } from "./core-as-caller.js";
import { logEvent } from "./events.js";
import { NO_INITIATIVE } from "./console/initiatives.js";
import { platformPublic } from "./console/shared.js";

/** The fields a close may not carry: the platform records them. */
const RECORDED = ["outcome", "closed_by"];

/** The replies that are a conflict rather than a refusal: the initiative closed before this call
 *  could, so the first decision stands.
 *
 *  COUPLED: the kernel's `a closing record already exists for this work` (closeInitiative,
 *  packages/contracts/src/close.ts); `was closed by someone else just now` and `changed while it was
 *  being closed` (services/zz-core/src/tools/initiative-close.ts); `was closed on its own anchor row
 *  by a concurrent call` (saveDocument, services/zz-core/src/document-save.ts). */
const CONFLICT = /^ERROR: (?:a closing record already exists for this work|\S+ (?:was closed by someone else just now|changed while it was being closed|was closed on its own anchor row by a concurrent call))/;

/** Whether the reply is a close the tool made.
 *
 *  COUPLED: `initiative_close`'s two success sentences, `<slug> closed as <outcome>, recorded by` and,
 *  for an initiative with no document, `<slug> abandoned — it holds no document`. */
function closedBy(reply: string, slug: string): boolean {
  return reply.startsWith(`${slug} closed as `) || reply.startsWith(`${slug} abandoned — `);
}

export function mountConsoleClose(app: Express): void {
  app.post("/api/console/initiatives/:team/:slug/close", platformPublic("initiative close", async (req, res, { activeTeam }) => {
    const team = String(req.params.team ?? "");
    const slug = String(req.params.slug ?? "");
    const missing = { error: NO_INITIATIVE };
    if (!activeTeam || team !== activeTeam) {
      res.status(404).json(missing);
      return;
    }
    // Slugs are unique within a team, so the team is part of the question. The documents a close may
    // name: the initiative's own, never a source and never the handover written after it.
    const { rows } = await platformDb().query<{ documents: string[] }>(
      `select coalesce(array_agg(d.path order by d.path)
                         filter (where d.path not like 'sources/%' and d.path <> 'handover.md'), '{}') as documents
         from zz.initiative i
         join zz.team t on t.id = i.team_id
         left join zz.doc d on d.initiative_id = i.id
        where t.slug = $1 and i.slug = $2
        group by i.id`, [activeTeam, slug]);
    if (!rows.length) {
      res.status(404).json(missing);
      return;
    }
    const body = (typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? req.body : {}) as
      Record<string, unknown>;
    const named = RECORDED.filter((k) => k in body);
    if (named.length) {
      res.status(400).json({ error: `${named.join(" and ")} ${named.length === 1 ? "is" : "are"} the platform's to record: ` +
        "send the disposition and the sign-off, and it derives the outcome" });
      return;
    }
    const { disposition, accepted_by, no_signoff_reason, document } = body;
    if (disposition !== "finished" && disposition !== "abandoned") {
      res.status(400).json({ error: "disposition must be finished or abandoned" });
      return;
    }
    for (const [name, v] of [["accepted_by", accepted_by], ["no_signoff_reason", no_signoff_reason], ["document", document]] as const) {
      if (v !== undefined && (typeof v !== "string" || !v.trim())) {
        res.status(400).json({ error: `ERROR: ${name} must be a non-empty string when given.` });
        return;
      }
    }
    if (typeof document === "string" && !rows[0].documents.includes(document)) {
      res.status(400).json({ error: `ERROR: ${document} is not a document of ${slug}.` });
      return;
    }
    let reply: string;
    try {
      reply = await coreFor(req).call("initiative_close", { initiative: slug, disposition, accepted_by, no_signoff_reason, document });
    } catch (err) {
      // `Mcp.call` throws only for a transport or protocol failure; a refusal is text, read below.
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    if (CONFLICT.test(reply)) {
      res.status(409).json({ conflict: "closed", error: reply });
      return;
    }
    if (!closedBy(reply, slug)) {
      res.status(400).json({ error: reply });
      return;
    }
    // The close as the initiative records it: the outcome and the closer off its own row, and the
    // document whose revision carries the outcome, none for work abandoned with no document.
    const { rows: [read] } = await platformDb().query<{ outcome: string | null; closed_by: string | null; document: string | null }>(
      `select i.outcome, p.email as closed_by,
              (select d.path from zz.doc d
                 join zz.doc_revision r on r.doc_id = d.id
                where d.initiative_id = i.id and r.fields->>'outcome' is not null
                order by r.written_at desc nulls last, r.revision desc
                limit 1) as document
         from zz.initiative i
         join zz.team t on t.id = i.team_id
         left join zz.principal p on p.id = i.closed_by
        where t.slug = $1 and i.slug = $2`, [activeTeam, slug]);
    if (!read?.outcome || !read.closed_by) {
      res.status(502).json({ error: `zz-core answered the close but ${slug} reads open: ${reply}` });
      return;
    }
    // After the act, never before. DELIBERATE: not `initiative_close`, which zz-core writes itself for
    // every close; this row is the door it came through. The team is named because the read above
    // found the initiative in it.
    logEvent({ actor: req.zzIdentity!.email, kind: "initiative.console_close", subject: slug, teamSlug: activeTeam,
               origin: req.zzIdentity!.origin, detail: { via: "web", outcome: read.outcome } });
    res.json({ outcome: read.outcome, closedBy: read.closed_by, document: read.document });
  }));
}
