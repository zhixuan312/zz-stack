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
 *   - `document_shown`, the panel's own record that it rendered the whole of the current revision,
 *     through the one writer every present uses (`recordPresented`).
 *
 * DELIBERATE: `document_shown` takes a ticket, and the ticket travels only in `_meta`. A client that
 * ignores `visibility: ["app"]` lists the tool to its model, and a model that could call it with a
 * path would be approving what nobody read — a fail-OPEN path on the one gate agents are delegated.
 * The ticket is an HMAC over the team, the path, the revision and the person, so a model holding
 * none of `_meta` cannot mint one, and one ticket vouches for exactly one revision to one person.
 * Every record the panel writes rests on it. The key is drawn per process, so a restart ends every
 * ticket — which costs nothing for a document already on record, answered before the ticket is
 * read, and asks the person to open anything else again.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { documentBody, parseCaller, parseEnvelope } from "@zz/contracts";
import { WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { recordPresented, shownSinceLastChange, splitDocPath } from "./attest.js";
import { chainFor, gateRefusal } from "./chain.js";
import { db, teamFor } from "./platform-db.js";
import { loadDocument, recordAct } from "./versions.js";

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
 *  history is a read, and nothing it renders may vouch for the present. */
export interface PanelDocument {
  path: string;
  initiative: string;
  name: string;
  version: number;
  current: number | null;
  status: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Null when the document can be approved; otherwise why not, in `document_approve`'s words. */
  gate: string | null;
  history: { version: number; approvedBy: string | null; approvedAt: string | null }[];
  body: string;
  /** The revision before this one, when there is one and this is the current revision: what the
   *  panel marks changed and new sections against, so a reviewer checks what moved, not everything. */
  previous: { version: number; body: string } | null;
  ticket: string | null;
}

const KEY = randomBytes(32);
/** A day: long enough for a person to come back to a conversation, short enough that a leaked
 *  ticket stops mattering. */
const TICKET_TTL_MS = 24 * 3600 * 1000;

function signed(team: string, path: string, version: number, user: string, expires: number): string {
  return createHmac("sha256", KEY)
    .update([team, path, String(version), user.toLowerCase(), String(expires)].join("\n"))
    .digest("base64url");
}
/** A ticket for one person to record one revision as shown. */
export function ticketFor(team: string, path: string, version: number, user: string,
                          now = Date.now()): string {
  const expires = now + TICKET_TTL_MS;
  return `${expires}.${signed(team, path, version, user, expires)}`;
}
/** Whether `ticket` was issued by this process to `user` for exactly this revision, and is live. */
export function ticketValid(ticket: string, team: string, path: string, version: number,
                            user: string, now = Date.now()): boolean {
  const [exp, sig] = ticket.split(".");
  const expires = Number(exp);
  if (!sig || !Number.isFinite(expires) || expires < now) return false;
  const want = Buffer.from(signed(team, path, version, user, expires));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** What the panel draws for `relPath`, or null when there is nothing to draw — the text half of
 *  the result already says why. */
export async function panelDocument(
  p: pg.Pool, team: string, relPath: string, version: number | undefined, user: string,
): Promise<PanelDocument | null> {
  const at = splitDocPath(relPath);
  const loaded = await loadDocument(team, relPath, version);
  if (!at || !loaded.ok) return null;
  const env = parseEnvelope(loaded.text);
  const shown = loaded.rev.revision;
  const current = loaded.doc.current_revision;
  const before = shown === current && shown > 1 ? await loadDocument(team, relPath, shown - 1) : null;
  return {
    path: relPath, initiative: at.initiative, name: at.path,
    version: shown, current,
    status: env.status ?? null,
    approvedBy: env.approved_by ?? null,
    approvedAt: env.approved_at ?? null,
    gate: gateRefusal(await chainFor(p, team, relPath, loaded.text), at.path),
    history: loaded.history.map((r) => ({ version: r.revision, approvedBy: r.approved_by ?? null,
                                          approvedAt: r.approved_at ?? null })),
    body: documentBody(loaded.text).trim(),
    previous: before?.ok ? { version: shown - 1, body: documentBody(before.text).trim() } : null,
    ticket: shown === current ? ticketFor(team, relPath, shown, user) : null,
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
        "The document panel's own record that it showed a person the whole of a document. Only " +
        "the panel calls this, with the ticket document_present handed it; a model has nothing to " +
        "pass. To put a document in front of someone, call document_present.",
      inputSchema: {
        path: z.string().describe("The document the panel showed, `<initiative>/<name>.md`."),
        version: z.number().int().positive().describe("The revision the panel showed."),
        ticket: z.string().describe("The ticket document_present handed the panel."),
      },
      _meta: { ui: { visibility: ["app"] }, ...PANEL_CALLABLE },
    },
    async ({ path, version, ticket }) => {
      const user = parseCaller(requestHeaders()).email;
      const team = await teamFor(user);
      const p = db();
      if (!p || !team) return text("ERROR: no team to record this for");
      const loaded = await loadDocument(team, path);
      if (!loaded.ok) return text(loaded.refusal);
      // The same rule every present keeps: only the revision the document points at can be
      // vouched for, so a panel left open across a rewrite records nothing.
      if (loaded.doc.current_revision !== version) {
        return text(`ERROR: ${path} changed since the panel opened it (now v${loaded.doc.current_revision}) ` +
                    "— open it again with document_present");
      }
      // Once is the fact. A host re-mounts a panel whenever the person scrolls back to it or opens
      // it full screen — ChatGPT re-mounted seven at once in the first live session — and a second
      // record of the same present would count one reading as seven.
      //
      // DELIBERATE: asked BEFORE the ticket. It writes nothing, so it vouches for nothing, and a
      // panel that outlived its ticket — the key is drawn per process, so every deploy did that to
      // every panel open in a conversation — would otherwise show a person a refusal about a
      // document already on record as shown to them.
      if (await shownSinceLastChange(p, team, path)) {
        return text(`Already recorded: ${path} v${version} was shown in full. It counts as presented.`);
      }
      // Every record the panel writes rests on the ticket.
      if (!ticketValid(ticket, team, path, version, user)) {
        return text("ERROR: this panel's ticket is not valid for you and this revision — open the " +
                    "document again with document_present");
      }
      await recordPresented(p, team, path);
      recordAct(path, { user, action: "shown", path, version: String(version), via: "panel" });
      return text(`Shown in full in the panel: ${path} v${version}. It counts as presented.`);
    },
  );
}
