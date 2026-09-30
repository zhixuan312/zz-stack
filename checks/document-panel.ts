#!/usr/bin/env node
/**
 * The document panel is the page the release ships, looks like the console, renders safely, and
 * records a present only for the person and revision it was handed.
 *
 *   1. the built page is `buildPanel()`'s output, byte for byte — dist/ is not stale — it is
 *      self-contained (one inline script, no script or image fetched), and the only origins it
 *      loads from are the ones `PANEL_CSP` allows;
 *   2. the page type-checks against the DOM (`app/tsconfig.json`);
 *   3. `PANEL_MIME` is the MCP Apps media type ext-apps names;
 *   4. its tokens and its two brand images are the console's own — which needs the console
 *      checked out beside this repository, and FAILS without it rather than passing blind;
 *   5. `renderMarkdown` keeps raw HTML inert, drops a `javascript:` link and every fetched image,
 *      renders a GFM table, and gives each heading a unique id;
 *   6. a ticket is good for one person, one team, one path, one revision, and one day;
 *   7. driven through the real door, as a person, against a stubbed store:
 *      - `document_present` names the panel, and its result carries the WHOLE body in `_meta`
 *        with a ticket even when the text half is a part, and no `structuredContent`;
 *      - history carries no ticket, and a part the model asks for draws no panel at all;
 *      - `document_shown` is app-only, records the present with a valid ticket, and records
 *        nothing with a forged one, another person's, or once the document has changed.
 *
 * Run: node checks/document-panel.ts   (also run by scripts/gate.ts)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

process.env.TEAM_DB_URL = "postgresql://stub@127.0.0.1:1/stub";

const cwd = process.cwd();
const load = (p: string) => import(pathToFileURL(join(cwd, p)).href);
const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. The page
const { buildPanel, PANEL_OUT } = await load("services/zz-core/app/build.ts");
const { PANEL_URI, PANEL_MIME, ticketFor, ticketValid } = await load("services/zz-core/dist/document-panel.js");
const html: string = await buildPanel();
is(existsSync(PANEL_OUT) && readFileSync(PANEL_OUT, "utf8") === html,
   "dist/apps/document-panel.html is not what the source builds — run `npm run build`");
is((html.match(/<script\b/g) ?? []).length === 1 && !/<script[^>]*\bsrc=/.test(html),
   "the page does not carry exactly one inline script");
is(!/<img[^>]+src="https?:/.test(html), "the page fetches an image instead of carrying it");
const origins = new Set([...html.matchAll(/<link[^>]+href="(https:\/\/[^/"]+)/g)].map((m) => m[1]));
const panelSrc = readFileSync(join(cwd, "services/zz-core/src/document-panel.ts"), "utf8");
const allowed = new Set([...panelSrc.matchAll(/resourceDomains: \[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1])));
is([...origins].every((o) => allowed.has(o!)) && [...allowed].every((o) => origins.has(o)),
   `the page loads from ${[...origins].join(", ")} but PANEL_CSP allows ${[...allowed].join(", ")}`);
is(html.length < 600_000, `the page is ${Math.round(html.length / 1024)} KB`);

// 2. The page's own types
try {
  execFileSync(join(cwd, "node_modules/.bin/tsc"), ["-p", "services/zz-core/app/tsconfig.json"], { stdio: "pipe" });
} catch (err) {
  fail.push(`the panel does not type-check: ${String((err as { stdout?: Buffer }).stdout ?? err).slice(0, 400)}`);
}

// 3. The media type
const { RESOURCE_MIME_TYPE } = await import("@modelcontextprotocol/ext-apps/server");
is(PANEL_MIME === RESOURCE_MIME_TYPE, `PANEL_MIME is ${PANEL_MIME}, ext-apps says ${RESOURCE_MIME_TYPE}`);

// 4. The console's tokens and marks
const CONSOLE = join(cwd, "..", "zz-stack-dashboard");
if (!existsSync(join(CONSOLE, "app/globals.css"))) {
  fail.push(`the console is not checked out at ${CONSOLE}, so the panel's tokens cannot be compared ` +
            "with it — that is not evidence that they match");
} else {
  const consoleCss = readFileSync(join(CONSOLE, "app/globals.css"), "utf8");
  const panelCss = readFileSync(join(cwd, "services/zz-core/app/panel.css"), "utf8");
  const copied = panelCss.slice(panelCss.indexOf(":root {"), panelCss.indexOf("}", panelCss.indexOf(":root {")));
  for (const [, name, value] of copied.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    const theirs = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(consoleCss)?.[1]?.trim();
    is(theirs === value!.trim(), `${name} is ${value!.trim()} in the panel and ${theirs ?? "absent"} in the console`);
  }
  for (const f of ["wordmark.png", "state-approved.png"]) {
    const mine = readFileSync(join(cwd, "services/zz-core/app/brand", f));
    const theirs = join(CONSOLE, "public/assets/brand", f);
    is(existsSync(theirs) && mine.equals(readFileSync(theirs)), `brand/${f} is not the console's public/assets/brand/${f}`);
  }
}

// 5. Rendering
const { renderMarkdown } = await load("services/zz-core/app/render.ts");
const r = renderMarkdown([
  "# The title", "", "<script>alert(1)</script>", "", "[run](javascript:alert(1)) and [site](https://example.org)",
  "", "![tracker](https://evil.example/p.png)", "", "| a | b |", "|---|--:|", "| 1 | 2 |", "",
  "## Scope", "", "## Scope", "", "### Detail",
].join("\n"));
is(!/<script/i.test(r.html) && r.html.includes("&lt;script&gt;"), "raw HTML in a document is rendered, not shown as text");
is(!/javascript:/i.test(r.html) && r.html.includes('href="https://example.org"'), "the link policy is not the console's");
is(!/<img/.test(r.html) && r.html.includes('<em class="dropped">tracker</em>'), "an image is fetched rather than named");
is(/<table>[\s\S]*<td align="right">2<\/td>/.test(r.html), "a GFM table with alignment does not render");
is(r.title === "The title", `the title is ${r.title}`);
is(JSON.stringify(r.outline.map((o: { id: string }) => o.id)) === JSON.stringify(["scope", "scope-1", "detail"]),
   `heading ids are ${JSON.stringify(r.outline)}`);

// 6. Tickets
{
  const t = ticketFor("t1", "i/spec.md", 3, "U@zz.test", 1_000);
  is(ticketValid(t, "t1", "i/spec.md", 3, "u@zz.test", 2_000), "a ticket is refused for the person it was made for");
  for (const [why, ok] of [
    ["another person", ticketValid(t, "t1", "i/spec.md", 3, "v@zz.test", 2_000)],
    ["another revision", ticketValid(t, "t1", "i/spec.md", 4, "u@zz.test", 2_000)],
    ["another team", ticketValid(t, "t2", "i/spec.md", 3, "u@zz.test", 2_000)],
    ["another document", ticketValid(t, "t1", "i/plan.md", 3, "u@zz.test", 2_000)],
    ["a day later", ticketValid(t, "t1", "i/spec.md", 3, "u@zz.test", 1_000 + 24 * 3600 * 1000 + 1)],
    ["a forged signature", ticketValid(t.replace(/.$/, (c: string) => (c === "A" ? "B" : "A")), "t1", "i/spec.md", 3, "u@zz.test", 2_000)],
  ] as const) is(!ok, `a ticket is accepted for ${why}`);
}

// 7. Through the door
const TEAM = "t1", INIT = "2026-09-30-panel", REL = `${INIT}/spec.md`;
const body = ["# Spec", "", ...Array.from({ length: 2600 }, (_, i) => `Line ${i} of the body, long enough to page.`)].join("\n");
const doc = { current: 2, written_at: "2026-09-30T00:00:00.000Z", presented: 0 };
const events: { kind: string; detail: Record<string, unknown> }[] = [];
pg.Pool.prototype.query = (async function query(sql0: string, values: unknown[] = []) {
  const sql = String(sql0).replace(/\s+/g, " ");
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/CASE WHEN t\.status = 'active' THEN t\.slug END AS slug/.test(sql)) return one([{ slug: TEAM, role: "admin", active_slug: TEAM }]);
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    const rev = (n: number) => ({ revision: n, content_state: "retained", title: "Spec", body, tags: [],
      content_hash: `h${n}`, revision_note: null, fields: null, written_by: "u@zz.test", written_at: doc.written_at,
      approved_by: null, approved_at: null });
    return one([rev(1), rev(2)]);
  }
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) { doc.presented += 1; return { rows: [], rowCount: 1 }; }
  // `shownSinceLastChange`: presented after the revision was written, once anything recorded it.
  if (/select r\.presented_at::text as presented_at/.test(sql)) {
    return one([{ presented_at: doc.presented ? "2026-09-30T00:00:01.000Z" : null, written_at: doc.written_at }]);
  }
  if (/from zz\.doc d\b/.test(sql) && /d\.path = \$3/.test(sql)) {
    if (values[1] !== INIT || values[2] !== "spec.md") return one([]);
    return one([{ id: "d1", initiative: INIT, path: "spec.md", flow: "", type: "", status: "draft", outcome: null,
                  current_revision: doc.current, approved_revision: null, updated_at: doc.written_at }]);
  }
  if (/insert into zz\.event\b/.test(sql)) {
    events.push({ kind: String(values[3] ?? ""), detail: JSON.parse(String(values[5] ?? "{}")) });
    return one([]);
  }
  return one([]);
}) as unknown as typeof pg.Pool.prototype.query;

const express = (await import("express")).default;
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { serveMcp } = await load("packages/mcp-http/dist/index.js");
const { recordingDoor } = await load("services/zz-core/dist/door.js");
const { registerArtifactTools } = await load("services/zz-core/dist/tools/artifacts.js");
const { registerDocumentPanel } = await load("services/zz-core/dist/document-panel.js");

const app = express();
app.use(express.json({ limit: "4mb" }));
serveMcp(app, "/core/mcp", () => {
  const s = recordingDoor(new McpServer({ name: "zz-core", version: "0" }), "core");
  registerArtifactTools(s);
  registerDocumentPanel(s);
  return s;
});
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const as = async (email: string) => {
  const c = new Client({ name: "checks/document-panel.ts", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/core/mcp`),
    { requestInit: { headers: { "x-zz-user-email": email } } }));
  return c;
};
type Result = { content: { text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> };
const said = (res: Result) => res.content.map((c) => c.text).join("\n");
try {
  const me = await as("u@zz.test");
  const tools = (await me.listTools()).tools;
  const presentTool = tools.find((t) => t.name === "document_present");
  const shownTool = tools.find((t) => t.name === "document_shown");
  is((presentTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri === PANEL_URI,
     "document_present does not name the panel");
  is(JSON.stringify((shownTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility) === '["app"]',
     "document_shown is not app-only");
  const page = await me.readResource({ uri: PANEL_URI });
  is(page.contents[0]?.mimeType === PANEL_MIME && (page.contents[0] as { text?: string }).text === html,
     "the panel resource is not the built page, as the MCP Apps type");

  const res = await me.callTool({ name: "document_present", arguments: { path: REL } }) as Result;
  const drawn = (res._meta?.["zz-core/documents"] ?? []) as { body: string; ticket: string | null; version: number }[];
  is(said(res).includes("Presented in part"), "the fixture body did not come back in parts — it tests nothing");
  is(res.structuredContent === undefined, "document_present returns structuredContent, which Claude Code shows instead of the text");
  is(drawn.length === 1 && drawn[0]!.body === body.trim() && drawn[0]!.version === 2 && !!drawn[0]!.ticket,
     "the panel is not handed the whole current body with a ticket");
  const paged = await me.callTool({ name: "document_present", arguments: { path: REL, offset: 60000 } }) as Result;
  is(((paged._meta?.["zz-core/documents"] ?? []) as unknown[]).length === 0 && paged._meta?.["zz-core/reading"] === true,
     "a part the model asked for draws the whole document again, in another panel under the last");
  const old = await me.callTool({ name: "document_present", arguments: { path: REL, version: 1 } }) as Result;
  is(((old._meta?.["zz-core/documents"] ?? []) as { ticket: string | null }[])[0]?.ticket === null,
     "history is handed a ticket, so opening it could vouch for the present");

  const ticket = drawn[0]?.ticket ?? "";
  const before = doc.presented;
  const forged = await me.callTool({ name: "document_shown", arguments: { path: REL, version: 2, ticket: `${ticket}x` } }) as Result;
  const other = await (await as("v@zz.test")).callTool({ name: "document_shown", arguments: { path: REL, version: 2, ticket } }) as Result;
  is(/^ERROR/.test(said(forged)) && /^ERROR/.test(said(other)) && doc.presented === before,
     "a forged ticket, or another person's, records a present");
  const ok = await me.callTool({ name: "document_shown", arguments: { path: REL, version: 2, ticket } }) as Result;
  is(!/^ERROR/.test(said(ok)) && doc.presented === before + 1, `a valid ticket did not record the present: ${said(ok)}`);
  await new Promise((r) => setTimeout(r, 50));
  is(events.some((e) => e.kind === "document.shown" && e.detail.via === "panel"), "the panel's present is not in the record");
  // A host re-mounting the panel asks again: answered, not recorded twice.
  const again = await me.callTool({ name: "document_shown", arguments: { path: REL, version: 2, ticket } }) as Result;
  await new Promise((r) => setTimeout(r, 50));
  is(!/^ERROR/.test(said(again)) && doc.presented === before + 1
     && events.filter((e) => e.kind === "document.shown" && e.detail.via === "panel").length === 1,
     "a re-mounted panel records the same present a second time");
  doc.current = 3;
  const stale = await me.callTool({ name: "document_shown", arguments: { path: REL, version: 2, ticket } }) as Result;
  is(/^ERROR/.test(said(stale)) && doc.presented === before + 1, "a ticket for a revision the document has moved past records a present");
} catch (err) {
  fail.push(`the door could not be driven: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  server.close();
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok document-panel");
