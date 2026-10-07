/**
 * The document panel: `document_present` shown to a person, whole, in any client that renders MCP
 * Apps — ChatGPT, Claude, VS Code — and the record that the panel showed it.
 *
 * Why it exists. A present is a tool result, and a tool result is model input, not a display: a
 * 114k-character review reached a person only as fast as a model could page it into its own
 * context, 60k characters a call, and on ChatGPT not at all (0.91.1). The panel puts the document
 * in front of the person directly, at any length, and says so itself once it has.
 *
 * Three pieces, one module:
 *   - the resource, `PANEL_URI`: the built page, `dist/apps/document-panel.html`;
 *   - `panelDocuments`, what `document_present` hands the panel in its result's `_meta`. Never in
 *     `content` and never as `structuredContent`: Claude Code shows a model ONLY the structured
 *     half when one is present, and every client measured — Claude Code, Codex, and ChatGPT by its
 *     own documentation — keeps `_meta` from the model. Measured on 0.92.0, not assumed;
 *   - `document_shown`, the record that the whole of the current snapshot was shown — by the panel,
 *     under the review context its present minted, or by the console, under the console's own —
 *     through the one writer every presentation uses (`commitPresentation`, review-context.ts).
 *
 * DELIBERATE: `document_shown` takes a ticket, and the ticket travels only in `_meta`. A client that
 * ignores `visibility: ["app"]` lists the tool to its model, and a model that could call it with a
 * path would be approving what nobody read — a fail-OPEN path on the one gate agents are delegated.
 * The ticket is an HMAC over the team, the path, the content revision drawn and the person, so a
 * model holding none of `_meta` cannot mint one, and one ticket vouches for exactly one snapshot to
 * one person. The CONTENT REVISION, not the public version a person is shown nor the row number:
 * several snapshots can share one version, and a row rewritten in place keeps its number while its
 * content moves — a ticket for what was drawn must vouch for nothing else.
 * Every record the panel writes rests on it. The key is drawn per process, so a restart ends every
 * ticket — which costs nothing for a document already covered in the panel's context, answered
 * before the ticket is read, and asks the person to open anything else again.
 *
 * DELIBERATE: without a ticket, `document_shown` records only for a console browser session — the
 * gateway stamps `x-zz-via: session` on those and nothing else, and overwrites whatever a client
 * sent. An agent's call (`pat`, `forwarded`) without a ticket is refused and records nothing: it
 * would be a model marking a document presented that nobody saw.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller, parseEnvelope } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { splitDocPath } from "./attest.js";
import { chainFor, gateRefusal } from "./chain.js";
import type { deltaOf } from "./document-delta.js";
import { db, teamFor } from "./platform-db.js";
import { commitPresentation, contextState, mintContext, presentedBody, snapshotRevision, type Viewer,
         viewerOf } from "./review-context.js";
import { changeSnapshot } from "./stale-base.js";
import { initiativeState } from "./tools/initiative-status.js";
import { loadDocument, publicVersions, supersededApproval } from "./versions.js";

type Loaded = Extract<Awaited<ReturnType<typeof loadDocument>>, { ok: true }>;
/** One record of the change set the panel marks sections by. */
type Change = Extract<ReturnType<typeof deltaOf>, { kind: "delta" }>["records"][number];

/** The panel's address. Stable across releases on purpose: a hosted client caches the template it
 *  read at connect time, and an address that moved every release would need a reconnect for each. */
export const PANEL_URI = "ui://zz-core/document-panel.html";
/** The MCP Apps media type. COUPLED: `RESOURCE_MIME_TYPE` in @modelcontextprotocol/ext-apps;
 *  checks/document-panel.ts compares the two. */
export const PANEL_MIME = "text/html;profile=mcp-app";

/** Where the panel may load from beyond itself: the console's type, from Google Fonts. Everything
 *  else — script, style, both brand images — is inside the page. */
const PANEL_CSP = { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] };

/** The `_meta` on `document_present`'s registration: which page renders its result.
 *  `openai/toolInvocation/*` is what ChatGPT says while the call runs. */
export const PRESENT_META = {
  ui: { resourceUri: PANEL_URI },
  "openai/toolInvocation/invoking": "Opening the document",
  "openai/toolInvocation/invoked": "Document ready",
};
/** A tool the panel itself calls. `visibility` is the MCP Apps rule; `openai/widgetAccessible`
 *  is ChatGPT's older switch for the same permission, still read by it. */
export const PANEL_CALLABLE = { "openai/widgetAccessible": true };

/** One document as the panel draws it. `ticket` is present only for the current revision: showing
 *  history is a read, and nothing it renders may vouch for the present. `review_context` is the
 *  context the present minted or continued, the same one its reply names; null for a `version` read.
 *
 *  Versions are PUBLIC versions — what a person is shown and approves by. `latest` says whether the
 *  snapshot drawn is the document's current one: only the current snapshot can be approved, and an
 *  earlier version is drawn as history. */
export interface PanelDocument {
  path: string;
  initiative: string;
  name: string;
  version: number;
  /** The document's current public version. */
  current: number | null;
  latest: boolean;
  status: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Null when the document can be approved; otherwise why not, in `document_approve`'s words. */
  gate: string | null;
  /** One entry per public version, and the approved snapshot a later row of it superseded — what
   *  `document_present`'s versions line says, drawn as the panel's version history. */
  history: { version: number; approvedBy: string | null; approvedAt: string | null;
             superseded: ReturnType<typeof supersededApproval> }[];
  /** Set when the initiative has closed and this document is the correction awaiting its own
   *  approval that `initiative_status` names, with the outcome the initiative closed with. */
  correction: { outcome: string } | null;
  body: string;
  /** The review metadata an approval signs with the body — the snapshot's title, tags, stakeholder
   *  and flow fields, as its content identity is taken over — drawn beside it. */
  metadata: { title: string; tags: string[]; stakeholder: string; fields: Record<string, string> };
  /** The snapshot drawn, by its content revision; null for a superseded row that has none. */
  content_revision: string | null;
  review_context: string | null;
  /** The context's baseline — the snapshot it last covered — and the change set from it to this one,
   *  which the panel marks changed, new and removed sections by, so a reviewer checks what moved, not
   *  everything. `changes` is null when the change set is as long as the document. Null when the
   *  context has no baseline.
   *
   *  DELIBERATE: the baseline's body is not carried. The marks come from the records, and the body
   *  would double the payload of every presentation after the first. */
  previous: { version: number; content_revision: string; changes: Change[] | null } | null;
  ticket: string | null;
}

const KEY = randomBytes(32);
/** A day: long enough for a person to come back to a conversation, short enough that a leaked
 *  ticket stops mattering. */
const TICKET_TTL_MS = 24 * 3600 * 1000;

function signed(team: string, path: string, contentRevision: string, user: string, expires: number): string {
  return createHmac("sha256", KEY)
    .update([team, path, contentRevision, user.toLowerCase(), String(expires)].join("\n"))
    .digest("base64url");
}
/** A ticket for one person to record one snapshot, named by its content revision, as shown. */
export function ticketFor(team: string, path: string, contentRevision: string, user: string,
                          now = Date.now()): string {
  const expires = now + TICKET_TTL_MS;
  return `${expires}.${signed(team, path, contentRevision, user, expires)}`;
}
/** Whether `ticket` was issued by this process to `user` for exactly this content revision, and is live. */
export function ticketValid(ticket: string, team: string, path: string, contentRevision: string,
                            user: string, now = Date.now()): boolean {
  const [exp, sig] = ticket.split(".");
  const expires = Number(exp);
  if (!sig || !Number.isFinite(expires) || expires < now) return false;
  const want = Buffer.from(signed(team, path, contentRevision, user, expires));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The close this document is a correction of, or null: `initiative_status`'s own `corrections`
 *  (`correctionsOf` in tools/initiative-closed.ts), so the panel and the status never disagree,
 *  every correction is named, and the handover a finished close owes never is. Asked only of a
 *  document that could be one — approved before, not approved now — so a present pays for the
 *  initiative's state only then. */
async function correctionOf(
  p: pg.Pool, team: string, at: { initiative: string; path: string }, chain: Awaited<ReturnType<typeof chainFor>>,
  doc: Loaded["doc"],
): Promise<PanelDocument["correction"]> {
  if (doc.status === "approved" || doc.approved_revision == null) return null;
  const state = await initiativeState(p, team, at.initiative, chain, chain.documents);
  return state.outcome && state.corrections?.includes(at.path) ? { outcome: state.outcome } : null;
}

/** What the panel draws for one loaded snapshot of `relPath`, in review context `context`, marked
 *  against `previous`; null when the path is not `<initiative>/<document>`. */
export async function panelDocument(
  p: pg.Pool, who: Viewer, relPath: string, loaded: Loaded, context: string | null,
  previous: PanelDocument["previous"],
): Promise<PanelDocument | null> {
  const at = splitDocPath(relPath);
  if (!at) return null;
  const { team, email: user } = who;
  const env = parseEnvelope(loaded.text);
  const latest = loaded.rev.revision === loaded.doc.current_revision;
  const drawn = snapshotRevision(loaded);
  const { title, tags, stakeholder, fields } = changeSnapshot(loaded.text);
  const chain = await chainFor(p, team, relPath, loaded.text);
  return {
    path: relPath, initiative: at.initiative, name: at.path,
    version: loaded.rev.version, current: loaded.doc.current_version, latest,
    status: env.status ?? null,
    approvedBy: env.approved_by ?? null,
    approvedAt: env.approved_at ?? null,
    gate: gateRefusal(chain, at.path),
    history: publicVersions(loaded.history).map((r) => ({ version: r.version, approvedBy: r.approved_by ?? null,
                                                          approvedAt: r.approved_at ?? null,
                                                          superseded: supersededApproval(loaded.doc.id, loaded.history, r) })),
    correction: await correctionOf(p, team, at, chain, loaded.doc),
    body: presentedBody(loaded.text),
    metadata: { title, tags, stakeholder, fields },
    content_revision: drawn,
    review_context: context,
    previous,
    ticket: latest && drawn ? ticketFor(team, relPath, drawn, user) : null,
  };
}

/** The built page, read once. A missing build is loud: a panel that silently rendered nothing
 *  would look, to the person, like a document with no content. */
let html: string | null = null;
function panelHtml(): string {
  if (html) return html;
  const file = new URL("./apps/document-panel.html", import.meta.url);
  if (!existsSync(file)) {
    throw new Error("the document panel is not built — `npm run build` writes dist/apps/document-panel.html");
  }
  return (html = readFileSync(file, "utf8"));
}

export function registerDocumentPanel(server: McpServer): void {
  const meta = { ui: { csp: PANEL_CSP, prefersBorder: false } };
  server.registerResource("document-panel", PANEL_URI, {
    title: "Document",
    description: "A document from your team's store, whole, with its status and — where it gates — " +
      "the approval.",
    mimeType: PANEL_MIME,
    _meta: meta,
  }, async () => ({ contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: panelHtml(), _meta: meta }] }));

  server.registerTool(
    "document_shown",
    {
      annotations: WRITES,
      description:
        "The record that a person was shown the whole of a document's current snapshot. The document " +
        "panel calls it with the ticket and the review context document_present handed it; a console " +
        "session calls it with the `content_revision` it displayed, and gets back the console's review " +
        "context. A model has nothing to pass and is refused: to put a document in front of someone, " +
        "call document_present, and pass back the review_context its reply names.",
      inputSchema: {
        path: z.string().describe("The document shown, `<initiative>/<name>.md`."),
        version: z.number().int().positive().optional().describe("The public version the panel showed."),
        ticket: z.string().optional().describe("The ticket document_present handed the panel."),
        review_context: z.string().optional()
          .describe("The panel's review context, from document_present; a console session's, when it has one."),
        content_revision: z.string().optional().describe("The snapshot a console session displayed."),
      },
      _meta: { ui: { visibility: ["app"] }, ...PANEL_CALLABLE },
    },
    async ({ path, version, ticket, review_context, content_revision }) => {
      const user = parseCaller(requestHeaders()).email;
      const team = await teamFor(user);
      const p = db();
      if (!p || !team) return text("ERROR: no team to record this for");
      const who = viewerOf(team);
      // Asked first, before anything is read: a model's call carries no ticket, and only a console
      // browser session may record without one.
      if (ticket === undefined && who.credential !== "session") {
        return text("ERROR: document_shown records a presentation only with the ticket document_present handed " +
                    "the document panel, or from a console session — call document_present to put a document " +
                    "in front of someone");
      }
      const loaded = await loadDocument(team, path);
      if (!loaded.ok) return text(loaded.refusal);
      const target = snapshotRevision(loaded)!;
      const body = presentedBody(loaded.text);
      const record = (context: string, baseline: string | null, via: string, said: string) =>
        commitPresentation(p, who, path, {
          context, target, baseline, kind: "full", start: 0, end: body.length, total: body.length, via,
          version: loaded.rev.version, revision: loaded.rev.revision,
          current: { revision: loaded.rev.revision, generation: Number(loaded.rev.content_generation ?? loaded.doc.content_generation) },
          meta_bytes: 0,
        }, () => said);
      if (ticket === undefined) {
        if (content_revision !== target) {
          return text(`ERROR: ${path} is at content revision ${target} now, not ${content_revision ?? "(none named)"} ` +
                      "— open it again to show what it says now");
        }
        const known = review_context !== undefined && (await contextState(p, who, path, review_context)).known;
        const context = known ? review_context! : mintContext();
        const state = await contextState(p, who, path, context);
        const shownAs = `${path} v${loaded.rev.version} at ${target}. Review context: ${context}.`;
        if (state.covered.includes(target)) return text(`Already recorded: ${shownAs}`);
        return text(await record(context, state.baseline, "console", `Shown in full in the console: ${shownAs}`));
      }
      if (version === undefined) {
        return text("ERROR: INVALID_MODE — the panel's record names the public `version` it showed beside its ticket");
      }
      // The same rule every present keeps: only the revision the document points at can be
      // vouched for, so a panel left open across a rewrite records nothing. A new version is named
      // here; a new snapshot of the same version, or the row rewritten in place, is caught by the
      // ticket, which binds the content revision drawn.
      if (loaded.doc.current_version !== version) {
        return text(`ERROR: ${path} changed since the panel opened it (now v${loaded.doc.current_version}) ` +
                    "— open it again with document_present");
      }
      const state = review_context === undefined ? null : await contextState(p, who, path, review_context);
      if (!state?.known) {
        return text("ERROR: this panel's review context is not one of yours for this document — open the " +
                    "document again with document_present");
      }
      // Once is the fact. A host re-mounts a panel whenever the person scrolls back to it or opens
      // it full screen — ChatGPT re-mounted seven at once in the first live session — and a second
      // record of the same present would count one reading as seven.
      //
      // DELIBERATE: asked BEFORE the ticket. It writes nothing, so it vouches for nothing, and a
      // panel that outlived its ticket — the key is drawn per process, so every deploy did that to
      // every panel open in a conversation — would otherwise show a person a refusal about a
      // document already covered in its own context.
      if (state.covered.includes(target)) {
        return text(`Already recorded: ${path} v${version} was shown in full under ${review_context}. It counts as presented.`);
      }
      // Every record the panel writes rests on the ticket, and the ticket on the current snapshot.
      if (!ticketValid(ticket, team, path, target, user)) {
        return text("ERROR: this panel's ticket is not valid for you and this revision — open the " +
                    "document again with document_present");
      }
      return text(await record(review_context!, state.baseline, "panel",
                               `Shown in full in the panel: ${path} v${version}. It counts as presented.`));
    },
  );
}
