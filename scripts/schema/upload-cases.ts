/**
 * The gateway half of `checks/document-upload.ts` (AC-4.1, AC-4.2), and the case groups that stage
 * through it: the shell route, the link page, and the rules staging and consumption hold a file to.
 *
 * The gateway here is its own built code, driven in this process: an express app carrying
 * `identityMiddleware` with the `/u/` exemption server.ts gives it, then `mountUpload`, then the
 * global JSON parser and the console's document and write routes — the order server.ts mounts
 * them in. It listens before the zz-core child starts, so the child's `GATEWAY_PUBLIC_URL` is this
 * listener and `upload_start` answers routes that exist: a case runs the `shell` line it answers as
 * it is, with a real PAT seeded for the person, and opens the `link` it answers. A console read is
 * signed in through a real browser-session row.
 *
 * A helper, not a check: every `.ts` under `checks/` is a check the gate runs, so the case groups
 * that check runs live here, beside the harness they run on.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { documentBody } from "@zz/contracts";
import type { Mcp } from "@zz/mcp-client";
import type pg from "pg";

import { root } from "../deployment.ts";
import { esc, first } from "./normalize-cases.ts";
import type { Core } from "./throwaway-core.ts";

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
/** `text` read as a JSON object, or an empty one when it is not one. */
function objectOf(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
  } catch {
    return {};
  }
}
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");
const MIB8 = 8 * 1024 * 1024;

/** An answer from the gateway: its status, its text and, when it is JSON, the object. */
export interface Answer { status: number; headers: Headers; text: string; json: Record<string, unknown> }

/** The gateway, attached to the throwaway database the zz-core child runs on. */
export interface Gateway {
  /** Where it listens — the child's `GATEWAY_PUBLIC_URL`. */
  url: string;
  /** The seeded person's PAT. */
  token: string;
  /** A PAT for `email`, a principal already seeded. */
  tokenFor(email: string): Promise<string>;
  send(method: string, path: string, opts?: { body?: Buffer; headers?: Record<string, string> }): Promise<Answer>;
  /** A `shell` line `upload_start` answered, run by bash in a directory holding `filename` with
   *  `bytes`, with `ZZ_TOKEN` the person's PAT and nothing of this machine's own: curl's exit code
   *  and what it printed. */
  run(shell: string, filename: string, bytes: Buffer, token?: string): Promise<{ code: number; out: string }>;
  /** The console's document read, signed in as the seeded person through a browser session. */
  consoleDocument(path: string): Promise<Answer>;
  /** The gateway's hourly sweep, once. */
  sweep(): Promise<number>;
  /** End the gateway's pool, before the database it reads is removed. */
  end(): Promise<void>;
}

/** The listener, before and after the database exists. */
interface GatewayListener { url: string; attach(c: Core): Promise<Gateway>; stop(): Promise<void> }

const load = (p: string) => import(pathToFileURL(join(root, p)).href);

/** Starts the gateway's routes on a free port of 127.0.0.1. Nothing reads the database until
 *  `attach` points the gateway's pool at the one the check started. */
export async function listenGateway(): Promise<GatewayListener> {
  const express = (await import("express")).default;
  const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool;
                                                             platformDbReady: () => boolean };
  const { identityMiddleware } = (await load("services/gateway/dist/identity.js")) as { identityMiddleware: () => unknown };
  const { mountUpload, sweepUploads } = (await load("services/gateway/dist/upload.js")) as
    { mountUpload: (app: unknown, opts?: { limits?: { perUpload: number; perAddress: number } }) => void;
      sweepUploads: () => Promise<number> };
  const { mountInitiatives } = (await load("services/gateway/dist/console/initiatives.js")) as { mountInitiatives: (app: unknown) => void };
  const { mountConsoleWrite } = (await load("services/gateway/dist/console-write.js")) as { mountConsoleWrite: (app: unknown) => void };
  const app = express();
  const gate = identityMiddleware() as (req: unknown, res: unknown, next: () => void) => void;
  // COUPLED: services/gateway/src/server.ts — the identity gate with `/u/` its one upload
  // exemption, then the staging routes, then the parsers, then the console.
  app.use((req, res, next) => (req.path.startsWith("/u/") ? next() : gate(req, res, next)));
  // Every case stages more often than production's minute allows; checks/upload-staging.ts holds
  // the bounds.
  mountUpload(app, { limits: { perUpload: 1_000, perAddress: 100_000 } });
  app.use(express.json({ limit: "20mb" }));
  mountInitiatives(app);
  mountConsoleWrite(app);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const send: Gateway["send"] = async (method, path, opts = {}) => {
    const res = await fetch(`${url}${path}`, { method, body: opts.body as BodyInit | undefined, headers: opts.headers });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: objectOf(text) };
  };
  return {
    url,
    attach: async (c) => {
      process.env.TEAM_DB_URL = c.url;
      process.env.ZZ_CATALOG_DIR = join(root, "catalog");
      await db.initPlatformDb();
      const tokenFor = async (email: string): Promise<string> => {
        const token = `zzp_${randomBytes(24).toString("hex")}`;
        // Unlabelled, as a token nobody replaces is: one per principal, for this check's life.
        await c.sql.query("insert into zz.pat (principal_id, token_hash) select id, $2 from zz.principal where email = $1",
                          [email, sha(utf8(token))]);
        return token;
      };
      const session = randomBytes(24).toString("hex");
      await c.sql.query(`insert into zz.console_session (principal_id, token_hash, expires_at)
                         select id, $2, now() + interval '1 hour' from zz.principal where email = $1`, [c.email, sha(utf8(session))]);
      const token = await tokenFor(c.email);
      return {
        url, token, tokenFor, send,
        run: (shell, filename, bytes, as = token) => new Promise((resolve, reject) => {
          const dir = mkdtempSync(join(tmpdir(), "zz-upload-"));
          writeFileSync(join(dir, filename), bytes);
          // HOME is the scratch directory, so no token of this machine's own is read.
          const proc = spawn("bash", ["-c", shell], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, ZZ_TOKEN: as },
                                                      stdio: ["ignore", "pipe", "ignore"] });
          let out = "";
          proc.stdout.on("data", (b: Buffer) => { out += b.toString(); });
          proc.once("error", (err) => { rmSync(dir, { recursive: true, force: true }); reject(err); });
          proc.once("close", (code) => { rmSync(dir, { recursive: true, force: true }); resolve({ code: code ?? -1, out }); });
        }),
        consoleDocument: (path) => send("GET", `/api/console/document/${c.team}/${path}`, { headers: { cookie: `zz_console=${session}` } }),
        sweep: sweepUploads,
        end: async () => {
          if (db.platformDbReady()) await db.platformDb().end().catch(() => undefined);
          delete process.env.ZZ_CATALOG_DIR;
        },
      };
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** What `upload_start` answers. */
interface Started { upload: string; shell: string; link: string }

export async function start(c: Core, step: string, filename: string, via?: Mcp): Promise<Started> {
  const reply = await c.ok(step, "upload_start", { filename }, via);
  const { upload, shell, link } = objectOf(reply);
  if (typeof upload !== "string" || typeof shell !== "string" || typeof link !== "string") {
    return c.fail(step, `upload_start did not answer its upload, shell and link: ${reply}`);
  }
  return { upload, shell, link };
}

/** The route a `shell` line PUTs to, and the path a `link` opens — each on this gateway, or the
 *  case fails: the routes `upload_start` names are the ones the gateway serves. */
function routeOf(c: Core, g: Gateway, step: string, s: Started, which: "shell" | "link"): string {
  const m = which === "shell" ? new RegExp(` ${esc(g.url)}(/upload/up_[a-z2-7]{26})$`).exec(s.shell)
    : new RegExp(`^${esc(g.url)}(/u/us_[a-z2-7]{52})$`).exec(s.link);
  return m?.[1] ?? c.fail(step, `upload_start's ${which} names no route on ${g.url}: ${which === "shell" ? s.shell : s.link}`);
}

/** A file staged the way an agent with a shell stages one, without the shell: the PUT the line
 *  makes, with a PAT. */
async function staged(c: Core, g: Gateway, step: string, filename: string, bytes: Buffer, token = g.token,
                      via?: Mcp): Promise<{ id: string; sha: string; started: Started }> {
  const s = await start(c, step, filename, via);
  const a = await g.send("PUT", routeOf(c, g, step, s, "shell"), { body: bytes, headers: { authorization: `Bearer ${token}` } });
  if (a.status !== 200 || a.json.sha256 !== sha(bytes)) c.fail(step, `staging answered ${a.status} ${a.text.slice(0, 300)}`);
  return { id: s.upload, sha: sha(bytes), started: s };
}

/** The page's own PUT: the raw bytes to its path, named as a browser names the chosen file. */
function linkPut(g: Gateway, path: string, filename: string, bytes: Buffer): Promise<Answer> {
  return g.send("PUT", path, { body: bytes, headers: { "content-type": "application/octet-stream",
                                                         "x-filename": encodeURIComponent(filename) } });
}

/** An upload's row, as staging and consumption left it. */
export async function rowOf(c: Core, id: string): Promise<{ sha256: string | null; body: Buffer | null; staged_via: string | null;
    staged_by: string | null; consumed: boolean; operation: string | null } | undefined> {
  return (await c.sql.query(
    `select u.sha256, u.body, u.staged_via, p.email as staged_by, u.consumed_at is not null as consumed,
            u.consumed_by_operation as operation
       from zz.upload u left join zz.principal p on p.id = u.staged_by where u.id = $1`, [id])).rows[0];
}

/** Unconsumed, its staged body still held — or the case fails. */
export async function waiting(c: Core, step: string, id: string): Promise<void> {
  const r = await rowOf(c, id);
  if (!r || r.consumed || !r.body) c.fail(step, `${id} is not waiting unconsumed: ${JSON.stringify({ ...r, body: !!r?.body })}`);
}

/** A document's body three ways — as `document_read` prints it, as its current revision stores
 *  it, and as the console reads it — each the exact `want`, or the case fails. */
export async function exact(c: Core, g: Gateway, step: string, path: string, want: Buffer): Promise<void> {
  const read = documentBody(await c.ok(step, "document_read", { path }));
  const [initiative, ...rest] = path.split("/");
  const stored = (await c.sql.query<{ body: string }>(
    `select r.body from zz.doc d join zz.initiative i on i.id = d.initiative_id
       join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
      where i.slug = $1 and d.path = $2`, [initiative, rest.join("/")])).rows[0]?.body;
  const shown = await g.consoleDocument(path);
  const text = want.toString("utf8");
  for (const [where, got] of [["document_read", read], ["the stored revision", stored], ["the console's read", shown.json.body]]) {
    if (got !== text) c.fail(step, `${where} of ${path} is ${JSON.stringify(String(got).slice(0, 200))}, not the file's ${JSON.stringify(text.slice(0, 200))}`);
  }
}

/** The shell route, run as `upload_start` answers it, into each write. */
export async function shellRoute(c: Core, g: Gateway): Promise<void> {
  const I = await c.open("shell-route");
  let step = "upload_start names a /upload/ route and a /u/ link on the gateway that serves both";
  const s = await start(c, step, "scores.csv");
  routeOf(c, g, step, s, "shell");
  const page = await g.send("GET", routeOf(c, g, step, s, "link"));
  if (page.status !== 200 || !page.text.includes("scores.csv")) c.fail(step, `the link answered ${page.status}`);
  c.pass(step);

  step = "upload_start's shell, run as answered with the person's own token, stages a .csv, and document_write makes it a document byte for byte, consumed in its commit";
  const csv = utf8("name,score\r\nada,3\r\n\r\ngrace,\"5, of 5\"\r\n");
  const ran = await g.run(s.shell, "scores.csv", csv);
  const bound = objectOf(ran.out);
  if (ran.code !== 0 || bound.upload !== s.upload || bound.sha256 !== sha(csv) || bound.bytes !== csv.length) {
    c.fail(step, `the shell exited ${ran.code}: ${ran.out.slice(0, 300)}`);
  }
  const d = `${I}/scores.md`;
  const said = await c.ok(step, "document_write", { path: d, upload: s.upload });
  await exact(c, g, step, d, csv);
  const r = await rowOf(c, s.upload);
  if (!said.includes(`upload: ${s.upload} — "scores.csv", ${csv.length} bytes, sha256 ${sha(csv)}, staged via token by ${c.email}`)
      || !r?.consumed || r.body !== null || r.operation !== `document_write ${d}` || r.staged_via !== "token" || r.staged_by !== c.email) {
    c.fail(step, `${said}\n${JSON.stringify({ ...r, body: !!r?.body })}`);
  }
  c.pass(step);

  step = "document_edit takes a shell-staged file as the whole body, byte for byte";
  const next = utf8("name,score\r\nada,4\r\n");
  const e = await start(c, step, "scores.csv");
  if ((await g.run(e.shell, "scores.csv", next)).code !== 0) c.fail(step, "the shell failed");
  await c.ok(step, "document_edit", { path: d, upload: e.upload });
  await exact(c, g, step, d, next);
  c.pass(step);

  step = "source_add files a shell-staged file, and the source reads back byte for byte";
  const minutes = utf8("  Minutes\r\n\r\n- agreed: ship it\r\n- no newline at the end");
  const m = await start(c, step, "minutes.txt");
  if ((await g.run(m.shell, "minutes.txt", minutes)).code !== 0) c.fail(step, "the shell failed");
  await exact(c, g, step, await c.source(step, { initiative: I, title: "Minutes", upload: m.upload }), minutes);
  c.pass(step);

  step = "a refusal reaches the shell as JSON with a failing status, so the agent sees what to send, and binds nothing";
  const bad = await start(c, step, "broken.txt");
  const refused = await g.run(bad.shell, "broken.txt", Buffer.from([0x61, 0xff, 0x62]));
  if (refused.code !== 22 || !/^\{"error":"ERROR: INVALID_ENCODING — /.test(refused.out) || (await rowOf(c, bad.upload))?.sha256 !== null) {
    c.fail(step, `the shell exited ${refused.code}: ${refused.out.slice(0, 300)}`);
  }
  c.pass(step);
}

/** How many documents, revisions and document events the throwaway database holds. */
async function written(c: Core): Promise<string> {
  return JSON.stringify((await c.sql.query(
    `select (select count(*) from zz.doc) as docs, (select count(*) from zz.doc_revision) as revisions,
            (select count(*) from zz.event where kind like 'document.%' or kind like 'source.%') as events`)).rows[0]);
}

/** The link page, staged as its script stages, into each write — and nothing else. */
export async function linkRoute(c: Core, g: Gateway): Promise<void> {
  const I = await c.open("link-route");
  let step = "the link upload_start answered opens the staging page for its file, ready, under its own policy";
  const s = await start(c, step, "page.xml");
  const path = routeOf(c, g, step, s, "link");
  const page = await g.send("GET", path);
  if (page.status !== 200 || !page.text.includes('<form id="stage">') || !page.text.includes("page.xml")
      || !/script-src 'sha256-/.test(page.headers.get("content-security-policy") ?? "")) {
    c.fail(step, `the page answered ${page.status}: ${page.text.slice(0, 300)}`);
  }
  c.pass(step);

  step = "a link stages only: its PUT binds the file as link with no principal, and writes no document, revision or event";
  const xml = utf8('<?xml version="1.0"?>\n<page>\n  <script>alert("x")</script>\n  <p>a &amp; b</p>\n</page>\n');
  const before = await written(c);
  const bound = await linkPut(g, path, "page.xml", xml);
  // Read once the page has reloaded, as its script does after a staging: anything the PUT went on
  // to do has had its round trip.
  if (!(await g.send("GET", path)).text.includes(sha(xml))) c.fail(step, "the page does not show the binding");
  const r = await rowOf(c, s.upload);
  if (bound.status !== 200 || bound.json.sha256 !== sha(xml) || r?.staged_via !== "link" || r.staged_by !== null || r.consumed
      || !r.body || (await written(c)) !== before) {
    c.fail(step, `answered ${bound.status} ${bound.text.slice(0, 200)}; ${JSON.stringify({ ...r, body: !!r?.body })}`);
  }
  c.pass(step);

  step = "a link's secret is no credential: as a bearer token or a console cookie it reads no team document, stages no other upload and approves nothing";
  const d = `${I}/page.md`;
  await c.ok(step, "document_write", { path: d, upload: s.upload });
  const secret = path.slice("/u/".length);
  if ((await g.consoleDocument(d)).status !== 200) c.fail(step, "the console cannot read the document with a session");
  const other = await start(c, step, "other.txt");
  for (const [what, a] of [
    ["the console read, as a bearer token", await g.send("GET", `/api/console/document/${c.team}/${d}`, { headers: { authorization: `Bearer ${secret}` } })],
    ["the console read, as a cookie", await g.send("GET", `/api/console/document/${c.team}/${d}`, { headers: { cookie: `zz_console=${secret}` } })],
    ["the console's approval", await g.send("POST", "/api/console/documents/approve", {
      body: utf8(JSON.stringify({ team: c.team, path: d })), headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" } })],
    ["another upload's token route", await g.send("PUT", routeOf(c, g, step, other, "shell"), { body: utf8("x\n"), headers: { authorization: `Bearer ${secret}` } })],
  ] as const) {
    if (a.status !== 401) c.fail(step, `${what} answered ${a.status}: ${a.text.slice(0, 200)}`);
  }
  for (const [method, p] of [["POST", path], ["DELETE", path], ["GET", `${path}/documents`], ["PUT", `${path}/${other.upload}`]]) {
    const a = await g.send(method, p, { body: method === "GET" || method === "DELETE" ? undefined : utf8("x\n") });
    if (a.status !== 404) c.fail(step, `${method} ${p.replace(secret, "<secret>")} answered ${a.status}`);
  }
  const status = (await c.sql.query<{ status: string | null }>(
    "select d.status from zz.doc d join zz.initiative i on i.id = d.initiative_id where i.slug = $1 and d.path = 'page.md'", [I])).rows[0];
  if (status?.status === "approved" || (await rowOf(c, other.upload))?.sha256 !== null) c.fail(step, JSON.stringify(status));
  c.pass(step);

  step = "an .xml holding <script>, staged by the link, is stored byte for byte";
  await exact(c, g, step, d, xml);
  c.pass(step);

  step = "source_add and document_edit take link-staged files byte for byte";
  const src = await start(c, step, "notes.rst");
  const rst = utf8("Notes\n=====\n\n.. note:: kept as written\n");
  if ((await linkPut(g, routeOf(c, g, step, src, "link"), "notes.rst", rst)).status !== 200) c.fail(step, "the link did not stage");
  await exact(c, g, step, await c.source(step, { initiative: I, title: "Notes", upload: src.upload }), rst);
  const ed = await start(c, step, "page.xml");
  const xml2 = utf8('<?xml version="1.0"?>\n<page/>\n');
  if ((await linkPut(g, routeOf(c, g, step, ed, "link"), "page.xml", xml2)).status !== 200) c.fail(step, "the link did not stage");
  await c.ok(step, "document_edit", { path: d, upload: ed.upload });
  await exact(c, g, step, d, xml2);
  c.pass(step);
}

/** The window an upload is staged in, moved into the past. */
export const expire = (c: Core, id: string) => c.sql.query(
  "update zz.upload set created_at = now() - interval '20 minutes', expires_at = now() - interval '5 minutes' where id = $1", [id]);

/** The rules a file is held to on its way in: size, encoding, format, the byte-order mark, an
 *  immutable binding, expiry, and whose it is. */
export async function stagingRules(c: Core, g: Gateway): Promise<void> {
  const I = await c.open("staging-rules");
  const auth = { authorization: `Bearer ${g.token}` };
  let step = "one byte past 8 MiB is refused at staging (SIZE_LIMIT); exactly 8 MiB stages, and its stored form over the limit is refused in the write and left unconsumed";
  const big = await start(c, step, "big.txt");
  const over = await g.send("PUT", routeOf(c, g, step, big, "shell"), { body: Buffer.alloc(MIB8 + 1, 0x61), headers: auth });
  if (over.status !== 413 || !String(over.json.error).startsWith("ERROR: SIZE_LIMIT — ") || (await rowOf(c, big.upload))?.sha256 !== null) {
    c.fail(step, `answered ${over.status} ${over.text.slice(0, 200)}`);
  }
  const full = Buffer.alloc(MIB8, 0x61);
  if ((await g.send("PUT", routeOf(c, g, step, big, "shell"), { body: full, headers: auth })).status !== 200) c.fail(step, "8 MiB did not stage");
  await c.refused(step, "document_write", { path: `${I}/big.md`, upload: big.upload }, /^ERROR: SIZE_LIMIT — /);
  await waiting(c, step, big.upload);
  c.pass(step);

  step = "invalid UTF-8 and a file of another extension are refused at staging by name, and upload_start refuses an unsupported format before any upload exists";
  const t = await start(c, step, "notes.txt");
  const route = routeOf(c, g, step, t, "shell");
  const enc = await g.send("PUT", route, { body: Buffer.from([0xc3, 0x28]), headers: auth });
  const ext = await g.send("PUT", route, { body: utf8("%PDF-1.7\n"), headers: { ...auth, "x-filename": "minutes.pdf" } });
  const uploads = (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.upload")).rows[0].n;
  await c.refused(step, "upload_start", { filename: "minutes.pdf" }, /^ERROR: UNSUPPORTED_FORMAT — /);
  await c.refused(step, "upload_start", { filename: "slides.docx" }, /^ERROR: UNSUPPORTED_FORMAT — /);
  if (enc.status !== 422 || !String(enc.json.error).startsWith("ERROR: INVALID_ENCODING — ") || ext.status !== 415
      || !String(ext.json.error).startsWith("ERROR: UNSUPPORTED_FORMAT — ") || (await rowOf(c, t.upload))?.sha256 !== null
      || (await c.sql.query<{ n: number }>("select count(*)::int as n from zz.upload")).rows[0].n !== uploads) {
    c.fail(step, `answered ${enc.status} ${enc.text.slice(0, 120)} and ${ext.status} ${ext.text.slice(0, 120)}`);
  }
  c.pass(step);

  step = "a byte-order mark is removed and said, in the receipt and its details, and the rest is stored byte for byte";
  const text = utf8("a\tb\nc\td\n");
  const bom = await staged(c, g, step, "table.tsv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text]));
  const said = await c.ok(step, "document_write", { path: `${I}/table.md`, upload: bom.id });
  const details = await c.ok(step, "document_read", { path: `${I}/table.md`, details_ref: /details: `(dr_[a-z2-7]{26})`/.exec(said)?.[1] ?? "" });
  for (const where of [said, details]) {
    if (!where.includes('removed the byte-order mark "table.tsv" opened with')) c.fail(step, `no BOM line in: ${where}`);
  }
  await exact(c, g, step, `${I}/table.md`, text);
  c.pass(step);

  // A stored body cannot begin with a blank line: the line between the envelope and the body is
  // removed whatever its count (checks/document-body-roundtrip.ts). So the lines are said, as a BOM is.
  step = "blank lines a file opens with are removed and said, in the receipt and its details, and the rest is stored byte for byte";
  const opened = await staged(c, g, step, "spaced.csv", utf8("\n  \na,b\n1,2\n"));
  const told = await c.ok(step, "document_write", { path: `${I}/spaced.md`, upload: opened.id });
  const toldDetails = await c.ok(step, "document_read", { path: `${I}/spaced.md`, details_ref: /details: `(dr_[a-z2-7]{26})`/.exec(told)?.[1] ?? "" });
  for (const where of [told, toldDetails]) {
    if (!where.includes('removed the 2 blank lines "spaced.csv" opened with')) c.fail(step, `no blank-line line in: ${where}`);
  }
  await exact(c, g, step, `${I}/spaced.md`, utf8("a,b\n1,2\n"));
  c.pass(step);

  step = "a staged file's digest is immutable: the same bytes again answer the binding, other bytes are UPLOAD_CONTENT_CONFLICT, and the write stores the first";
  const firstBytes = utf8("first: true\n");
  const once = await staged(c, g, step, "pinned.yaml", firstBytes);
  const pinned = routeOf(c, g, step, once.started, "shell");
  const again = await g.send("PUT", pinned, { body: firstBytes, headers: auth });
  const other = await g.send("PUT", pinned, { body: utf8("second: true\n"), headers: auth });
  const viaLink = await linkPut(g, routeOf(c, g, step, once.started, "link"), "pinned.yaml", utf8("third: true\n"));
  if (again.status !== 200 || again.json.sha256 !== once.sha || other.status !== 409 || viaLink.status !== 409
      || !String(other.json.error).startsWith("ERROR: UPLOAD_CONTENT_CONFLICT — ")) {
    c.fail(step, `answered ${again.status}, ${other.status} ${other.text.slice(0, 160)} and ${viaLink.status}`);
  }
  await c.ok(step, "document_write", { path: `${I}/pinned.md`, upload: once.id });
  await exact(c, g, step, `${I}/pinned.md`, firstBytes);
  c.pass(step);

  step = "after its 15 minutes nothing stages (UPLOAD_EXPIRED), and a staged upload past them is refused by the write and writes nothing";
  const late = await start(c, step, "late.md");
  await expire(c, late.upload);
  const tooLate = await g.send("PUT", routeOf(c, g, step, late, "shell"), { body: utf8("# Late\n"), headers: auth });
  const lapsed = await staged(c, g, step, "lapsed.md", utf8("# Lapsed\n"));
  await expire(c, lapsed.id);
  const before = await written(c);
  await c.refused(step, "document_write", { path: `${I}/lapsed.md`, upload: lapsed.id }, /^ERROR: UPLOAD_EXPIRED — /);
  await c.refused(step, "source_add", { initiative: I, title: "Lapsed", upload: lapsed.id }, /^ERROR: UPLOAD_EXPIRED — /);
  if (tooLate.status !== 410 || !String(tooLate.json.error).startsWith("ERROR: UPLOAD_EXPIRED — ") || (await written(c)) !== before) {
    c.fail(step, `staging answered ${tooLate.status} ${tooLate.text.slice(0, 200)}`);
  }
  c.pass(step);

  step = "another person's token cannot stage an upload, and neither another person nor the owner acting for another team can consume one (FORBIDDEN)";
  const mine = await start(c, step, "mine.md");
  const theirs = await g.tokenFor(await c.member());
  const foreign = await g.send("PUT", routeOf(c, g, step, mine, "shell"), { body: utf8("# Mine\n"), headers: { authorization: `Bearer ${theirs}` } });
  if (foreign.status !== 403 || (await rowOf(c, mine.upload))?.sha256 !== null) c.fail(step, `their token answered ${foreign.status}`);
  const owned = await staged(c, g, step, "owned.md", utf8("# Owned\n"));
  const asMember = c.client({ email: await c.member() });
  const beforeForbidden = await written(c);
  await c.refused(step, "document_write", { path: `${I}/owned.md`, upload: owned.id }, /^ERROR: FORBIDDEN — /, asMember);
  // An upload started for another team the owner also belongs to: an upload is the team's it was
  // started for, and the owner acts for this one. (Moved by SQL: zz-core caches the acting team
  // for seconds, and a switch would wait them out.)
  await c.sql.query(
    `with t as (insert into zz.team (slug, name, created_by) select 'elsewhere', 'Elsewhere', id from zz.principal where email = $1 returning id),
          m as (insert into zz.membership (team_id, principal_id, role, added_by)
                select t.id, p.id, 'admin', p.id from t, zz.principal p where p.email = $1)
     update zz.upload set team_id = (select id from t) where id = any($2)`, [c.email, [owned.id, mine.upload]]);
  await c.refused(step, "source_add", { initiative: I, title: "Owned", upload: owned.id }, /^ERROR: FORBIDDEN — /);
  const awayStaging = await g.send("PUT", routeOf(c, g, step, mine, "shell"), { body: utf8("# Mine\n"), headers: auth });
  if (awayStaging.status !== 403 || (await rowOf(c, mine.upload))?.sha256 !== null) {
    c.fail(step, `the owner's token, on another team's upload, answered ${awayStaging.status}`);
  }
  await c.sql.query("update zz.upload set team_id = (select id from zz.team where slug = $2) where id = $1", [owned.id, c.team]);
  if ((await written(c)) !== beforeForbidden) c.fail(step, "a forbidden consumption wrote");
  await waiting(c, step, owned.id);
  c.pass(step);

  step = "the owner consumes, in its own team, the upload the others could not";
  const landed = await c.ok(step, "document_write", { path: `${I}/owned.md`, upload: owned.id });
  if (!first(landed).startsWith(`written: ${I}/owned.md `) || !(await rowOf(c, owned.id))?.consumed) c.fail(step, landed);
  c.pass(step);
}
