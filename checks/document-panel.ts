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
 *      renders a GFM table, and gives each heading a unique id; `marksOf` marks the sections the
 *      real change set's records name — by position, so of two sections with one title only the
 *      edited one — and a deeper change marks the section it sits in, a heading inside a footnote
 *      moving none;
 *   6. a ticket is good for one person, one team, one path, one content revision, and one day;
 *   7. driven through the real door, as a person, against a stubbed store:
 *      - `document_present` names the panel, and its result carries the WHOLE body in `_meta`
 *        with a ticket even when the text half is a part, the review context its reply names, the
 *        snapshot's content revision, and no `structuredContent`; its row records the panel
 *        payload's size;
 *      - the panel speaks PUBLIC versions: one history entry per version, and the current version
 *        read by number is its last snapshot;
 *      - history carries no ticket and no context, and a part the model asks for draws no panel;
 *      - `document_shown` is app-only, records full coverage under the panel's context with a
 *        valid ticket, answers a second call from the context's coverage, and records nothing with a
 *        forged ticket, another person's, once the row it drew is rewritten in place or the
 *        document has a new snapshot of the same version (the ticket binds the content revision),
 *        or once it has a new version;
 *      - without a ticket it records only for a console session (`x-zz-via: session`), minting and
 *        returning the console's context, and refuses a snapshot that is not current; with
 *        `x-zz-via` `pat` or `forwarded` it is refused and records nothing;
 *      - a present passing the panel's context back after a change draws `previous` as the
 *        context's baseline, with the change set the panel marks;
 *      - `document_read` records no presentation.
 *
 * Run: node checks/document-panel.ts   (also run by scripts/gate.ts)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { contentRevision } from "@zz/contracts";
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
if (!existsSync(join(CONSOLE, "src/styles/tokens.css"))) {
  fail.push(`the console is not checked out at ${CONSOLE}, so the panel's tokens cannot be compared ` +
            "with it — that is not evidence that they match");
} else {
  // The console's Meridian tokens: the light theme's roles, then the base block for what no theme
  // changes (the accent's hue and chroma, the faces, the radii). Each block is its own `{…}`.
  const consoleCss = readFileSync(join(CONSOLE, "src/styles/tokens.css"), "utf8");
  const block = (selector: string): string => {
    const at = consoleCss.indexOf(`${selector}{`);
    return at < 0 ? "" : consoleCss.slice(at, consoleCss.indexOf("\n}", at));
  };
  const light = block('[data-theme="light"]');
  const base = block(":root");
  is(light !== "" && base !== "", "the console's tokens.css has no light theme block or no base :root block");
  const same = (v: string): string => v.replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim();
  const valueIn = (css: string, name: string): string | undefined =>
    new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(css)?.[1];
  const panelCss = readFileSync(join(cwd, "services/zz-core/app/panel.css"), "utf8");
  // Guarded the way the console's own `block` above is, and counted, because this claim is only
  // true of what it actually compared: `indexOf` answering -1 sliced the string to nothing, the
  // loop below found no declarations, and "its tokens are the console's own" passed over a panel
  // whose token block had been renamed or moved.
  const panelAt = panelCss.indexOf(":root {");
  is(panelAt >= 0, "services/zz-core/app/panel.css has no `:root {` block, so nothing here was compared");
  const copied = panelAt < 0 ? "" : panelCss.slice(panelAt, panelCss.indexOf("}", panelAt));
  let compared = 0;
  for (const [, name, value] of copied.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    compared++;
    const theirs = valueIn(light, name!) ?? valueIn(base, name!);
    is(theirs !== undefined && same(theirs) === same(value!),
       `${name} is ${value!.trim()} in the panel and ${theirs?.trim() ?? "absent"} in the console`);
  }
  is(compared > 0, "the panel's `:root` block declares no tokens, so nothing was compared");
  for (const f of ["wordmark.png", "state-approved.png"]) {
    const mine = readFileSync(join(cwd, "services/zz-core/app/brand", f));
    const theirs = join(CONSOLE, "public/assets/brand", f);
    is(existsSync(theirs) && mine.equals(readFileSync(theirs)), `brand/${f} is not the console's public/assets/brand/${f}`);
  }
}

// 5. Rendering
const { renderMarkdown, marksOf } = await load("services/zz-core/app/render.ts");
const { deltaOf } = await load("services/zz-core/dist/document-delta.js");
{
  // A re-review reads what moved: the change set's records mark a section edited as changed, one
  // added as new, and name one gone as removed.
  const snap = (body: string, title = "T") => ({ body, title, tags: [], stakeholder: "", fields: {} });
  const was = `# T\n\nintro\n\n## Kept\n\n${"same words, long enough to keep the change set shorter than the document. ".repeat(12)}\n\n` +
    "## Scope\n\nfirst scope\n\n## Edited\n\nold words\n\n## Gone\n\nbye\n\n## Scope\n\nsecond scope\n\n" +
    "```sh\n# not a heading\n```\n\n### Deep\n\nunder the second scope\n";
  const now = was.replace("old words", "new words").replace("## Gone\n\nbye\n\n", "")
    .replace("second scope", "second scope, edited").replace("under the second scope", "under it, edited")
    .replace("## Edited\n\nnew words\n\n", "## Edited\n\nnew words\n\n## Added\n\nhello\n\n");
  const delta = deltaOf(snap(was), snap(now, "T2"));
  const view = renderMarkdown(now);
  const cmp = marksOf(view, delta.kind === "delta" ? delta.records : []);
  is(delta.kind === "delta" && JSON.stringify([...cmp.marks]) === '[["edited","changed"],["added","new"],["scope-1","changed"],["deep","changed"]]'
     && JSON.stringify(cmp.removed) === '["Gone"]' && JSON.stringify(cmp.other) === '["title"]',
     `the change set marks ${JSON.stringify([...cmp.marks])}, removed ${JSON.stringify(cmp.removed)}, other ${JSON.stringify(cmp.other)} ` +
     `(records ${JSON.stringify(delta.kind === "delta" ? delta.records : delta)})`);
  // A deeper change alone marks the second-level section it sits in.
  const deep = deltaOf(snap(was), snap(was.replace("under the second scope", "under it")));
  const deepMarks = marksOf(renderMarkdown(was), deep.kind === "delta" ? deep.records : []);
  is(JSON.stringify([...deepMarks.marks]) === '[["deep","changed"],["scope-1","changed"]]',
     `a third-level change does not mark its section: ${JSON.stringify([...deepMarks.marks])}`);
  is(/<section class="sec" data-sec="kept">/.test(view.html), "a second-level section is not wrapped, so it cannot be marked or hidden");
  // Headings markdown renders but the change set's line scan does not count — quoted, listed,
  // indented, underlined — shift nothing: the edited section is marked, not its neighbour. A
  // formatted heading is still found, and a later `#` part is named, not called the opening.
  const odd = "# Doc\n\n> ## Quoted\n\n- ## Listed\n\n   ## Indented\n\nUnderlined\n----------\n\n" +
    "## Alpha\n\nalpha text\n\n## **Bold** `code`\n\nbold text\n\n## Beta\n\nbeta text\n\n# Part 2\n\npart text\n\n## Gamma\n\ngamma text\n";
  const oddMarks = (to: string) => {
    const d = deltaOf(snap(odd), snap(to));
    return marksOf(renderMarkdown(to), d.kind === "delta" ? d.records : []);
  };
  const beta = oddMarks(odd.replace("beta text", "beta text, edited"));
  is(JSON.stringify([...beta.marks]) === '[["beta","changed"]]',
     `an edit to Beta, under headings the change set does not count, marks ${JSON.stringify([...beta.marks])}`);
  const bold = oddMarks(odd.replace("bold text", "bold text, edited"));
  is(JSON.stringify([...bold.marks]) === '[["bold-code","changed"]]', `an edit under a formatted heading marks ${JSON.stringify([...bold.marks])}`);
  const part = oddMarks(odd.replace("part text", "part text, edited"));
  is(!part.marks.size && JSON.stringify(part.other) === '["Part 2"]',
     `an edit under a second \`#\` part marks ${JSON.stringify([...part.marks])}, other ${JSON.stringify(part.other)}`);
  // A heading inside a footnote definition renders after every other, where GFM puts the notes:
  // pairing rendered headings with lines in order gave each later heading its neighbour's line.
  const noted = "# Doc\n\nText with a note.[^1]\n\n[^1]: The note.\n\n    ## Inside the note\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n";
  const notedMarks = (to: string) => {
    const d = deltaOf(snap(noted), snap(to));
    return JSON.stringify([...marksOf(renderMarkdown(to), d.kind === "delta" ? d.records : []).marks]);
  };
  for (const [what, want] of [["alpha", '[["alpha","changed"]]'], ["beta", '[["beta","changed"]]']]) {
    const got = notedMarks(noted.replace(`${what} text`, `${what} text, edited`));
    is(got === want, `an edit to ${what}, after a heading inside a footnote, marks ${got}`);
  }
  is(!/<!--/.test(renderMarkdown(noted).html), "the line marks are left in the rendered page");
}
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
  const [A, B] = ["cr_aaaaaaaaaaaaaaaaaaaaaaaaaa", "cr_bbbbbbbbbbbbbbbbbbbbbbbbbb"];
  const t = ticketFor("t1", "i/spec.md", A, "U@zz.test", 1_000);
  is(ticketValid(t, "t1", "i/spec.md", A, "u@zz.test", 2_000), "a ticket is refused for the person it was made for");
  for (const [why, ok] of [
    ["another person", ticketValid(t, "t1", "i/spec.md", A, "v@zz.test", 2_000)],
    ["another content revision", ticketValid(t, "t1", "i/spec.md", B, "u@zz.test", 2_000)],
    ["another team", ticketValid(t, "t2", "i/spec.md", A, "u@zz.test", 2_000)],
    ["another document", ticketValid(t, "t1", "i/plan.md", A, "u@zz.test", 2_000)],
    ["a day later", ticketValid(t, "t1", "i/spec.md", A, "u@zz.test", 1_000 + 24 * 3600 * 1000 + 1)],
    ["a forged signature", ticketValid(t.replace(/.$/, (c: string) => (c === "A" ? "B" : "A")), "t1", "i/spec.md", A, "u@zz.test", 2_000)],
  ] as const) is(!ok, `a ticket is accepted for ${why}`);
}

// 7. Through the door
const TEAM = "t1", INIT = "2026-09-30-panel", REL = `${INIT}/spec.md`, DOC = "00000000-0000-0000-0000-00000000d0c5";
const body = ["# Spec", "", ...Array.from({ length: 26 }, (_, s) => [`## Part ${s + 1}`, "",
  ...Array.from({ length: 100 }, (_, i) => `Line ${i} of part ${s + 1}, long enough to page.`), ""]).flat()].join("\n");
const signedBody = "# Spec\n\nThe signed first version.";
// Stored snapshots: v1 approved at r1; v2 at r2, and r3 joins v2 later — the same public version.
const revs: { revision: number; version: number; body: string; approved_by: string | null; own: string }[] = [
  { revision: 1, version: 1, body: signedBody, approved_by: "ada@zz.test", own: "0" },
  { revision: 2, version: 2, body, approved_by: null, own: "1" },
];
const doc = { current: 2, version: 2, generation: 1, written_at: "2026-09-30T00:00:00.000Z", presented: 0 };
const events: { kind: string; detail: Record<string, unknown> }[] = [];
const cr = (g: number) => contentRevision(DOC, g);
const route = async (sql0: string, values: unknown[] = []) => {
  const sql = String(sql0).replace(/\s+/g, " ");
  const one = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
  if (/CASE WHEN t\.status = 'active' THEN t\.slug END AS slug/.test(sql)) return one([{ slug: TEAM, role: "admin", active_slug: TEAM }]);
  if (/from zz\.doc_revision r\b/.test(sql) && /where r\.doc_id = \$1::uuid/.test(sql)) {
    return one(revs.map((r) => ({ revision: r.revision, version: r.version, content_state: "retained", title: "Spec",
      body: r.body, tags: ["alpha", "beta"], content_hash: `h${r.revision}`, revision_note: null,
      fields: { stakeholder: "Ana", component: "billing" }, written_by: "u@zz.test",
      written_at: doc.written_at, approved_by: r.approved_by, approved_at: r.approved_by ? "2026-09-29" : null,
      content_generation: r.own })));
  }
  if (/update zz\.doc_revision r set presented_at = now\(\)/.test(sql)) { doc.presented += 1; return { rows: [], rowCount: 1 }; }
  if (/as own_generation/.test(sql)) {
    return one([{ id: DOC, current_revision: doc.current, content_generation: String(doc.generation),
                  own_generation: revs.find((r) => r.revision === doc.current)!.own }]);
  }
  if (/e\.detail->>'review_context' as context/.test(sql)) {
    return one(events.filter((e) => e.detail.review_context && String(e.detail.user).toLowerCase() === String(values[3]).toLowerCase()
        && (e.detail.credential ?? "") === values[4] && (values[5] === null || e.detail.review_context === values[5]))
      .map((e) => ({ context: e.detail.review_context, target: e.detail.target, baseline: e.detail.baseline,
                     kind: e.detail.kind, start: e.detail.start, end: e.detail.end, total: e.detail.total })));
  }
  if (/from zz\.doc d\b/.test(sql) && /d\.path = \$3/.test(sql)) {
    if (values[1] !== INIT || values[2] !== "spec.md") return one([]);
    return one([{ id: DOC, initiative: INIT, path: "spec.md", flow: "", type: "", status: "draft", outcome: null,
                  current_revision: doc.current, approved_revision: 1, current_version: doc.version,
                  content_generation: String(doc.generation), updated_at: doc.written_at }]);
  }
  if (/insert into zz\.event\b/.test(sql)) {
    events.push({ kind: String(values[3] ?? ""), detail: JSON.parse(String(values[5] ?? "{}")) });
    return one([]);
  }
  return one([]);
};
pg.Pool.prototype.query = route as unknown as typeof pg.Pool.prototype.query;
pg.Pool.prototype.connect = (async () => ({ query: route, release() {} })) as unknown as typeof pg.Pool.prototype.connect;

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
// DELIBERATE: bound to the address the check calls. On `::`, another process may hold
// 127.0.0.1 on the same port, and the check then talks to it.
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as { port: number }).port;
/** A client for one person, under the credential kind the gateway would stamp. */
const as = async (email: string, via = "pat") => {
  const c = new Client({ name: "checks/document-panel.ts", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/core/mcp`),
    { requestInit: { headers: { "x-zz-user-email": email, "x-zz-via": via } } }));
  return c;
};
type Result = { content: { text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> };
type Drawn = { body: string; metadata: unknown; ticket: string | null; version: number; current: number | null; latest: boolean;
  history: { version: number; approvedBy: string | null; superseded?: { approvedBy: string; content_revision: string | null } | null }[]; review_context: string | null; content_revision: string | null;
  previous: { version: number; content_revision: string; changes: { kind: string; heading?: string; at?: number }[] | null } | null };
const said = (res: Result) => res.content.map((c) => c.text).join("\n");
const drawnOf = (res: Result) => (res._meta?.["zz-core/documents"] ?? []) as Drawn[];
const settle = () => new Promise((r) => setTimeout(r, 50));
try {
  const me = await as("u@zz.test");
  const tools = (await me.listTools()).tools;
  const presentTool = tools.find((t) => t.name === "document_present");
  const shownTool = tools.find((t) => t.name === "document_shown");
  is((presentTool?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri === PANEL_URI,
     "document_present does not name the panel");
  is(JSON.stringify((shownTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility) === '["app"]',
     "document_shown is not app-only");
  is(/review_context/.test(presentTool?.description ?? "") && /full: true/.test(presentTool?.description ?? "")
     && /review context/.test(shownTool?.description ?? "") && /console session/.test(shownTool?.description ?? ""),
     "document_present's and document_shown's descriptions do not teach review contexts and `full`");
  const page = await me.readResource({ uri: PANEL_URI });
  is(page.contents[0]?.mimeType === PANEL_MIME && (page.contents[0] as { text?: string }).text === html,
     "the panel resource is not the built page, as the MCP Apps type");

  const res = await me.callTool({ name: "document_present", arguments: { path: REL } }) as Result;
  const drawn = drawnOf(res);
  const rc = /^Review context: (rc_[a-z2-7]{26})/m.exec(said(res))?.[1];
  is(said(res).includes("Presented in part"), "the fixture body did not come back in parts — it tests nothing");
  is(res.structuredContent === undefined, "document_present returns structuredContent, which Claude Code shows instead of the text");
  is(drawn.length === 1 && drawn[0]!.body === body.trim() && drawn[0]!.version === 2 && drawn[0]!.latest
     && !!drawn[0]!.ticket, "the panel is not handed the whole current body with a ticket");
  is(!!rc && drawn[0]?.review_context === rc && drawn[0]?.content_revision === cr(1) && drawn[0]?.previous === null,
     `the panel is not handed the review context the reply names and the snapshot's identity: ${JSON.stringify({ ...drawn[0], body: undefined })}`);
  // The review metadata an approval signs with the body is shown with it, in the text and the panel.
  const metadata = 'Review metadata, which an approval signs with the body: title "Spec"; tags "alpha, beta"; ' +
    'stakeholder "Ana"; fields.component "billing".';
  is(said(res).includes(metadata), `a full presentation does not show the review metadata: ${said(res).slice(0, 600)}`);
  is(JSON.stringify(drawn[0]?.metadata) === '{"title":"Spec","tags":["alpha","beta"],"stakeholder":"Ana","fields":{"component":"billing"}}',
     `the panel is not handed the review metadata: ${JSON.stringify(drawn[0]?.metadata)}`);
  await settle();
  is(events[0]?.detail.meta_bytes === Buffer.byteLength(JSON.stringify(drawn[0])) && events[0]?.detail.text_chars === said(res).length,
     `the present's row does not record the panel payload's and the text's sizes: ${JSON.stringify(events[0]?.detail)}`);
  const paged = await me.callTool({ name: "document_present", arguments: { path: REL, offset: 60000 } }) as Result;
  is(drawnOf(paged).length === 0 && paged._meta?.["zz-core/reading"] === true,
     "a part the model asked for draws the whole document again, in another panel under the last");
  is(said(paged).includes(metadata), "a later part of a full presentation does not show the review metadata");
  const old = drawnOf(await me.callTool({ name: "document_present", arguments: { path: REL, version: 1 } }) as Result);
  is(old[0]?.ticket === null && old[0]?.review_context === null,
     "history is handed a ticket or a review context, so opening it could vouch for the present");

  const ticket = drawn[0]?.ticket ?? "";
  const shownWith = (c: typeof me, args: Record<string, unknown>) =>
    c.callTool({ name: "document_shown", arguments: { path: REL, ...args } }) as Promise<Result>;
  const before = { presented: doc.presented, events: events.length };
  const unchanged = () => doc.presented === before.presented && events.length === before.events;
  const forged = await shownWith(me, { version: 2, ticket: `${ticket}x`, review_context: rc });
  const other = await shownWith(await as("v@zz.test"), { version: 2, ticket, review_context: rc });
  await settle();
  is(/^ERROR/.test(said(forged)) && /^ERROR/.test(said(other)) && unchanged(),
     "a forged ticket, or another person's call with this panel's context, records a present");
  const versionless = await shownWith(me, { ticket, review_context: rc });
  is(/^ERROR: INVALID_MODE — the panel's record names the public `version`/.test(said(versionless)),
     `a ticket without the version it was shown at is not refused by name: ${said(versionless)}`);
  // No ticket, from an agent's credential: refused, and nothing written.
  for (const via of ["pat", "forwarded"]) {
    const agent = await shownWith(await as("u@zz.test", via), { content_revision: cr(1) });
    await settle();
    is(/^ERROR: document_shown records a presentation only with the ticket/.test(said(agent)) && unchanged(),
       `a ticketless document_shown under x-zz-via ${via} was not refused, or recorded something: ${said(agent)}`);
  }
  // A rewrite in place: the same row, a new generation — a snapshot the panel never drew. The
  // ticket binds the content revision it was cut for, so it vouches for nothing here.
  const drawnBody = revs[1]!.body;
  revs[1]!.body = body.replace("Line 3 of part 2,", "Line 3 of part 2, rewritten,"); revs[1]!.own = "9"; doc.generation = 9;
  const rewritten = await shownWith(me, { version: 2, ticket, review_context: rc });
  await settle();
  is(/^ERROR: this panel's ticket is not valid/.test(said(rewritten)) && unchanged(),
     `a ticket recorded a snapshot rewritten in place since the panel drew it: ${said(rewritten)}`);
  revs[1]!.body = drawnBody; revs[1]!.own = "1"; doc.generation = 1;
  const ok = await shownWith(me, { version: 2, ticket, review_context: rc });
  await settle();
  const panelRow = events[events.length - 1];
  is(!/^ERROR/.test(said(ok)) && doc.presented === before.presented + 1 && panelRow?.kind === "document.shown"
     && panelRow.detail.via === "panel" && panelRow.detail.review_context === rc && panelRow.detail.kind === "full"
     && panelRow.detail.target === cr(1) && panelRow.detail.start === 0 && panelRow.detail.end === body.trim().length,
     `a valid ticket did not record full coverage under the panel's context: ${said(ok)} ${JSON.stringify(panelRow?.detail)}`);
  // A host re-mounting the panel asks again: answered from the context's coverage, not recorded twice.
  const recorded = events.length;
  const again = await shownWith(me, { version: 2, ticket, review_context: rc });
  // A panel that outlived its ticket — a deploy redraws the key — on a document already covered in
  // its context: answered, never refused, and nothing written.
  const outlived = await shownWith(me, { version: 2, ticket: "0.from-before-the-restart", review_context: rc });
  await settle();
  is(/^Already recorded/.test(said(again)) && /^Already recorded/.test(said(outlived)) && events.length === recorded
     && doc.presented === before.presented + 1,
     `a re-mounted panel, or one open across a restart, records again or is refused: ${said(again)} / ${said(outlived)}`);

  // The console: a session records its own presentation, under a context it is handed back.
  const consoleClient = await as("u@zz.test", "session");
  const stale = await shownWith(consoleClient, { content_revision: cr(0) });
  const opened = await shownWith(consoleClient, { content_revision: cr(1) });
  await settle();
  const consoleRc = /Review context: (rc_[a-z2-7]{26})\.$/.exec(said(opened))?.[1];
  const consoleRow = events[events.length - 1];
  is(/^ERROR: .* is at content revision /.test(said(stale)) && /^Shown in full in the console/.test(said(opened))
     && !!consoleRc && consoleRc !== rc && consoleRow?.detail.via === "console" && consoleRow.detail.credential === "session"
     && consoleRow.detail.review_context === consoleRc && consoleRow.detail.target === cr(1),
     `a console session's record is not its own context's full coverage of the current snapshot: ${said(stale)} / ${said(opened)}`);

  // A new snapshot of the SAME version: the version still matches, the ticket does not — and a
  // present passing the panel's context back draws the change set from its baseline.
  revs.push({ revision: 3, version: 2, body: body.replace("Line 7 of part 5,", "Line 7 of part 5, revised,"), approved_by: null, own: "2" });
  doc.current = 3; doc.generation = 2;
  const sameVersion = await shownWith(me, { version: 2, ticket, review_context: rc });
  await settle();
  is(/^ERROR/.test(said(sameVersion)) && events.length === recorded + 1,
     `a ticket for a snapshot the document has moved past, within one version, records a present: ${said(sameVersion)}`);
  const changed = await me.callTool({ name: "document_present", arguments: { path: REL, review_context: rc } }) as Result;
  const marked = drawnOf(changed)[0];
  is(new RegExp(`^Review context: ${rc} — delta \\(1 record\\), target ${cr(2)}, baseline ${cr(1)}, covered\\.$`, "m").test(said(changed))
     && marked?.review_context === rc && marked.previous?.version === 2 && marked.previous.content_revision === cr(1)
     && JSON.stringify(marked.previous.changes) === '[{"kind":"edited","heading":"## Part 5","at":6}]'
     && JSON.stringify([...marksOf(renderMarkdown(marked.body), marked.previous.changes ?? []).marks]) === '[["part-5","changed"]]',
     `a present in the panel's context after a change does not draw the change set from its baseline: ` +
     `${said(changed).split("\n").slice(0, 2).join(" | ")} ${JSON.stringify(marked?.previous)}`);
  // One entry per public version, though three snapshots are stored; and the current version read
  // by number is its last snapshot, signed or not — r3, the current one, drawn with a ticket.
  const now = drawnOf(await me.callTool({ name: "document_present", arguments: { path: REL } }) as Result);
  is(JSON.stringify(now[0]?.history.map((h) => h.version)) === "[1,2]" && now[0]?.history[0]?.approvedBy === "ada@zz.test",
     `the panel's history is not one entry per public version: ${JSON.stringify(now[0]?.history)}`);
  revs[1]!.approved_by = "bo@zz.test";
  const byNumber = drawnOf(await me.callTool({ name: "document_present", arguments: { path: REL, version: 2 } }) as Result);
  is(byNumber[0]?.version === 2 && byNumber[0]?.latest === true && !!byNumber[0]?.ticket
     && byNumber[0]?.content_revision === now[0]?.content_revision,
     `v2 read by number is not its last snapshot: ${JSON.stringify({ ...byNumber[0], body: undefined })}`);
  // v2's signed r2, superseded inside v2 by r3, is named in the history by the token that reads it,
  // as `document_present`'s versions line and the console's history name it.
  const superseded = byNumber[0]?.history.find((h) => h.version === 2)?.superseded;
  is(superseded?.approvedBy === "bo@zz.test" && superseded.content_revision === cr(1),
     `the panel's history does not name v2's superseded approved snapshot: ${JSON.stringify(byNumber[0]?.history)}`);
  revs[1]!.approved_by = null;
  // A new public version: named as the change.
  doc.version = 3;
  const beforeStale = doc.presented;
  const staleVersion = await shownWith(me, { version: 2, ticket, review_context: rc });
  is(/^ERROR/.test(said(staleVersion)) && /now v3/.test(said(staleVersion)) && doc.presented === beforeStale,
     "a ticket for a version the document has moved past records a present");
  // A read is not a presentation.
  const reads = events.length;
  await me.callTool({ name: "document_read", arguments: { path: REL } });
  await settle();
  is(events.length === reads, "document_read recorded a presentation");
} catch (err) {
  fail.push(`the door could not be driven: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
} finally {
  server.close();
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok document-panel");
