#!/usr/bin/env node
/**
 * checks/upload-staging.ts — the gateway's staging routes, driven over HTTP against a real database.
 *
 *   node checks/upload-staging.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated the way the gateway migrates one, mints `zz.upload` rows
 * with SQL the way `upload_start` will, and mounts the gateway's own built routes — `mountUpload(app)`
 * from `services/gateway/dist/upload.js` — on an express app it builds, behind an identity it stamps
 * itself the way the gateway's middleware would. What it establishes:
 *
 *   - `mountUpload` serves exactly PUT /upload/:id, GET /u/:secret and PUT /u/:secret, and server.ts
 *     mounts it before the global body parsers, with `/u/` the one new public prefix;
 *   - the first staging binds byte_count, sha256, body, staged_via and staged_by; the same bytes again
 *     answer that binding; different bytes answer UPLOAD_CONTENT_CONFLICT and change nothing; two
 *     different first stagings racing bind exactly one;
 *   - nothing stages after expiry (UPLOAD_EXPIRED), with someone else's token, in another team, with
 *     no identity, past 8 MiB (SIZE_LIMIT), as invalid UTF-8 or as a file of another extension;
 *   - the link page escapes a hostile filename, loads nothing, never prints its secret, sends no
 *     referrer, cannot be framed, and runs one script, the one its CSP hash allows; its PUT stages
 *     that one upload and no other, as `link` with no principal; a malformed or unknown secret is
 *     refused, and an upload id is not a secret;
 *   - staging is bounded at 10 attempts per upload and 60 per client address a minute, answering
 *     `ERROR: RATE_LIMITED — try again in a minute`;
 *   - the sweep removes the body of an expired, unused upload and keeps the row;
 *   - no HTML, Office or PDF reader remains in the gateway.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { mintUploadId, mintUploadSecret, uploadSecretHash } from "@zz/contracts";
import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "upload-staging";
class CaseFailure extends Error {}
const fail = (step: string, detail: string): never => { throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`); };
const ok = (line: string) => console.log(`ok ${line}`);
const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const utf8 = (s: string) => Buffer.from(s, "utf8");

/** What the source says, before anything runs. */
function sourceReads(): void {
  const server = readFileSync(join(root, "services/gateway/src/server.ts"), "utf8");
  const prefixes = /const PUBLIC_PREFIXES = (\[[^\]]*\])/.exec(server)?.[1];
  if (prefixes !== '["/schemas/", "/auth/", "/oauth/", "/.well-known/", "/u/"]') {
    fail("public prefixes", `PUBLIC_PREFIXES is ${prefixes ?? "unreadable"}, not the four it had and /u/`);
  }
  const mounted = server.indexOf("\nmountUpload(app);");
  const parsed = server.indexOf("\napp.use(express.json(");
  const gated = server.indexOf("\napp.use((req, res, next) => {\n  if (PUBLIC_PATHS.has(req.path)");
  if (mounted < 0 || parsed < 0 || gated < 0 || !(gated < mounted && mounted < parsed)) {
    fail("mount order", `server.ts must run the identity gate, then mountUpload(app), then express.json (at ${gated}, ${mounted}, ${parsed})`);
  }
  ok("PUBLIC_PREFIXES gains /u/ only, and the upload routes sit behind the gate and before the body parsers");
  const gatewaySrc = join(root, "services/gateway/src");
  const readers = readdirSync(gatewaySrc).filter((f) => f.endsWith(".ts"))
    .filter((f) => /inflateRawSync|word\/document\.xml|fromPdf|fromHtml|\.docx|\.odt/.test(readFileSync(join(gatewaySrc, f), "utf8")));
  if (readers.length || existsSync(join(gatewaySrc, "extract.ts"))) fail("extractors gone", `a file reader remains: ${readers.join(", ")}`);
  ok("no HTML, .docx, .odt or PDF reader remains in the gateway");
}

type Answer = { status: number; headers: Headers; text: string; json: Record<string, unknown> };

async function run(sql: pg.Client, url: string): Promise<void> {
  // Two members of one team and a second team the owner also belongs to.
  const person = async (email: string) => (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ($1, $2, 'member') returning id", [email, email])).rows[0].id;
  const owner = await person("owner@example.test");
  const other = await person("other@example.test");
  const team = async (slug: string) => (await sql.query<{ id: string }>(
    "insert into zz.team (slug, name, created_by) values ($1, $2, $3) returning id", [slug, slug, owner])).rows[0].id;
  const home = await team("home-team");
  const away = await team("away-team");
  for (const [t, p] of [[home, owner], [home, other], [away, owner]]) {
    await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) values ($1, $2, 'member', $2)", [t, p]);
  }
  /** A row as upload_start mints it. */
  const mint = async (filename = "notes.md", by = owner, inTeam = home) => {
    const id = mintUploadId();
    const secret = mintUploadSecret();
    await sql.query("insert into zz.upload (id, team_id, principal_id, filename, link_secret_hash) values ($1, $2, $3, $4, $5)",
      [id, inTeam, by, filename, uploadSecretHash(secret)]);
    return { id, secret };
  };
  const rowOf = async (id: string) => (await sql.query<{ byte_count: number | null; sha256: string | null; body: Buffer | null;
    staged_via: string | null; staged_by: string | null }>(
    "select byte_count, sha256, body, staged_via, staged_by from zz.upload where id = $1", [id])).rows[0];
  const expire = (id: string) => sql.query(
    "update zz.upload set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' where id = $1", [id]);

  // The gateway's own routes on an app this check builds, behind an identity it stamps.
  process.env.TEAM_DB_URL = url;
  const dbModule = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  const { mountUpload, sweepUploads } = (await load("services/gateway/dist/upload.js")) as
    { mountUpload: (app: unknown, opts?: { limits?: { perUpload: number; perAddress: number } }) => void;
      sweepUploads: () => Promise<number> };
  const express = (await import("express")).default;

  const routes: string[] = [];
  mountUpload({ get: (p: string) => routes.push(`GET ${p}`), put: (p: string) => routes.push(`PUT ${p}`),
                post: (p: string) => routes.push(`POST ${p}`), all: (p: string) => routes.push(`ALL ${p}`),
                use: () => routes.push("USE") });
  if (routes.join(", ") !== "PUT /upload/:id, GET /u/:secret, PUT /u/:secret") fail("routes", `mountUpload served ${routes.join(", ")}`);
  ok("mountUpload serves exactly PUT /upload/:id, GET /u/:secret and PUT /u/:secret");

  /** An app as the gateway builds one: the identity this check stamps in place of the gate, the
   *  staging routes, and then the global body parsers, which must never see a staged file. */
  const appWith = async (limits?: { perUpload: number; perAddress: number }): Promise<Server> => {
    const app = express();
    // Behind one proxy hop, as the gateway is, so a case can arrive from an address of its own.
    app.set("trust proxy", 1);
    app.use((req, _res, next) => {
      const email = req.headers["x-check-email"];
      if (typeof email === "string") {
        (req as unknown as { zzIdentity: unknown }).zzIdentity = { email, displayName: email, platformRole: "member",
          teams: [], activeTeam: String(req.headers["x-check-team"] ?? "home-team"), via: "pat" };
      }
      next();
    });
    mountUpload(app, limits ? { limits } : {});
    app.use(express.json({ limit: "20mb" }));
    app.use(express.urlencoded({ extended: false, limit: "1mb" }));
    // DELIBERATE: bound to the address the check calls. On `::`, another process may hold 127.0.0.1
    // on the same port — a throwaway database's published port, under the gate's concurrency — and
    // the check then talks to it.
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return server;
  };
  // Every case but the bounds stages more often than a minute allows; the bounds get production's.
  const listener = await appWith({ perUpload: 1_000, perAddress: 100_000 });
  const bounded = await appWith();
  const port = (listener.address() as { port: number }).port;
  const boundedPort = (bounded.address() as { port: number }).port;
  let n = 0;
  const call = async (method: string, path: string, body?: Uint8Array, headers: Record<string, string> = {},
                      to = port): Promise<Answer> => {
    const res = await fetch(`http://127.0.0.1:${to}${path}`, {
      method, body: body as BodyInit | undefined,
      headers: { "x-forwarded-for": `10.1.${Math.floor(++n / 250)}.${n % 250}`, ...headers } });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a page */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const as = (email = "owner@example.test", team = "home-team") => ({ "x-check-email": email, "x-check-team": team });
  const expect = (step: string, a: Answer, status: number, code?: string) => {
    if (a.status !== status || (code && !String(a.json.error ?? "").startsWith(`ERROR: ${code} — `))) {
      fail(step, `answered ${a.status} ${a.text.slice(0, 300)} — expected ${status}${code ? ` ${code}` : ""}`);
    }
  };

  try {
    // Binding, the same bytes again, and different bytes.
    const first = await mint();
    const bytes = utf8("# Notes\n\nline one\r\n");
    const bound = await call("PUT", `/upload/${first.id}`, bytes, as());
    expect("first staging", bound, 200);
    const want = { upload: first.id, filename: "notes.md", bytes: bytes.length, sha256: sha(bytes) };
    if (JSON.stringify(bound.json) !== JSON.stringify(want)) fail("first staging", `answered ${bound.text}, not ${JSON.stringify(want)}`);
    const r = await rowOf(first.id);
    if (r.byte_count !== bytes.length || r.sha256 !== sha(bytes) || !r.body?.equals(bytes) || r.staged_via !== "token" || r.staged_by !== owner) {
      fail("first staging", `the row holds ${JSON.stringify({ ...r, body: r.body?.toString() })}`);
    }
    ok("the first staging binds byte_count, sha256, the bytes, staged_via token and the staging principal");
    const again = await call("PUT", `/upload/${first.id}`, bytes, as());
    expect("same bytes", again, 200);
    if (JSON.stringify(again.json) !== JSON.stringify(want)) fail("same bytes", `answered ${again.text}`);
    ok("the same bytes again answer the binding");
    const changed = await call("PUT", `/upload/${first.id}`, utf8("# Other\n"), as());
    expect("different bytes", changed, 409, "UPLOAD_CONTENT_CONFLICT");
    if (!String(changed.json.error).includes("staged with your token")) fail("different bytes", `the refusal does not say how: ${changed.text}`);
    if ((await rowOf(first.id)).sha256 !== sha(bytes)) fail("different bytes", "the binding moved");
    ok("different bytes answer UPLOAD_CONTENT_CONFLICT and leave the binding as it was");
    const race = await mint();
    const [x, y] = await Promise.all([call("PUT", `/upload/${race.id}`, utf8("one\n"), as()), call("PUT", `/upload/${race.id}`, utf8("two\n"), as())]);
    const won = [x, y].filter((a) => a.status === 200);
    const lost = [x, y].filter((a) => a.status === 409);
    if (won.length !== 1 || lost.length !== 1 || (await rowOf(race.id)).sha256 !== won[0].json.sha256) {
      fail("racing stagings", `answered ${x.status} and ${y.status}; the row holds ${(await rowOf(race.id)).sha256}`);
    }
    ok("two different first stagings racing bind exactly one, and the other is a conflict");
    // The bind itself is the guard: a staging that read the row unstaged and is still receiving its
    // bytes when another binds must not overwrite that binding when it finishes.
    const slow = await mint();
    const late = request({ port, method: "PUT", path: `/upload/${slow.id}`,
      headers: { ...as(), "x-forwarded-for": "10.9.9.9", "content-length": "8" } });
    const lateAnswer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      late.on("response", (res) => { let b = ""; res.on("data", (c: Buffer) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
      late.on("error", reject);
    });
    late.write("late");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect("bind while another reads", await call("PUT", `/upload/${slow.id}`, utf8("first\n"), as()), 200);
    late.end("r!\n\n");
    const second = await lateAnswer;
    if (second.status !== 409 || (await rowOf(slow.id)).sha256 !== sha(utf8("first\n"))) {
      fail("bind is guarded", `the late staging answered ${second.status} ${second.body.slice(0, 200)}; the row holds ${(await rowOf(slow.id)).sha256}`);
    }
    ok("a staging still receiving its bytes when another binds answers a conflict and never overwrites the binding");

    // What never stages.
    const old = await mint();
    await expire(old.id);
    expect("expired", await call("PUT", `/upload/${old.id}`, bytes, as()), 410, "UPLOAD_EXPIRED");
    if ((await rowOf(old.id)).sha256 !== null) fail("expired", "an expired upload was staged");
    ok("a staging after expires_at answers UPLOAD_EXPIRED and binds nothing");
    const mine = await mint();
    expect("foreign token", await call("PUT", `/upload/${mine.id}`, bytes, as("other@example.test")), 403, "FORBIDDEN");
    expect("other team", await call("PUT", `/upload/${mine.id}`, bytes, as("owner@example.test", "away-team")), 403, "FORBIDDEN");
    expect("unknown id", await call("PUT", `/upload/${mintUploadId()}`, bytes, as()), 403, "FORBIDDEN");
    expect("malformed id", await call("PUT", "/upload/source", bytes, as()), 403, "FORBIDDEN");
    expect("no identity", await call("PUT", `/upload/${mine.id}`, bytes), 401);
    if ((await rowOf(mine.id)).sha256 !== null) fail("foreign token", "someone else staged the owner's upload");
    ok("someone else's token, another team, an unknown or malformed id and no identity stage nothing");
    const big = await mint("big.txt");
    expect("over 8 MiB", await call("PUT", `/upload/${big.id}`, new Uint8Array(8 * 1024 * 1024 + 1).fill(0x61), as()), 413, "SIZE_LIMIT");
    if ((await rowOf(big.id)).sha256 !== null) fail("over 8 MiB", "an oversized body was staged");
    const full = new Uint8Array(8 * 1024 * 1024).fill(0x62);
    const exact = await call("PUT", `/upload/${big.id}`, full, as());
    expect("exactly 8 MiB", exact, 200);
    if ((await rowOf(big.id)).byte_count !== full.length) fail("exactly 8 MiB", "the full-size body was not bound whole");
    ok("one byte past 8 MiB answers SIZE_LIMIT, and exactly 8 MiB is bound whole");
    const text = await mint();
    expect("invalid UTF-8", await call("PUT", `/upload/${text.id}`, new Uint8Array([0x61, 0xff, 0x62]), as()), 422, "INVALID_ENCODING");
    expect("another extension", await call("PUT", `/upload/${text.id}`, bytes, { ...as(), "x-filename": "minutes.pdf" }), 415, "UNSUPPORTED_FORMAT");
    const pdf = await mint("minutes.pdf");
    expect("unsupported row", await call("PUT", `/upload/${pdf.id}`, utf8("%PDF-1.7"), as()), 415, "UNSUPPORTED_FORMAT");
    // A curl that names no type sends a form type; a browser sends a .json file as JSON. The global
    // parsers mounted after the routes see neither.
    const json = await mint("data.json");
    const raw = utf8('{"a": 1}');
    expect("typed bytes", await call("PUT", `/upload/${json.id}`, raw, { ...as(), "content-type": "application/json" }), 200);
    if (!(await rowOf(json.id)).body?.equals(raw)) fail("typed bytes", "a JSON-typed file was not staged byte for byte");
    const form = await mint("pairs.txt");
    const pairs = utf8("a=1&b=2\n");
    expect("form-typed bytes", await call("PUT", `/u/${form.secret}`, pairs, { "content-type": "application/x-www-form-urlencoded" }), 200);
    if (!(await rowOf(form.id)).body?.equals(pairs)) fail("form-typed bytes", "a form-typed file was not staged byte for byte");
    ok("invalid UTF-8, another extension and an unsupported filename are refused by name; a typed body is staged raw");

    // The link.
    const hostile = `"><img src=x onerror=alert(1)><b>&'.md`;
    const link = await mint(hostile);
    const neighbour = await mint();
    const page = await call("GET", `/u/${link.secret}`);
    expect("link page", page, 200);
    if (/<img src=x/.test(page.text) || !/&lt;img src=x onerror=alert\(1\)&gt;&lt;b&gt;&amp;&#39;\.md/.test(page.text)) {
      fail("hostile filename", "the filename reached the page unescaped, or not at all");
    }
    if (/(src|href)="https?:/i.test(page.text) || /url\(\s*['"]?https?:/i.test(page.text) || /@import/i.test(page.text)) {
      fail("self-contained", "the page requests something from the network");
    }
    if (page.text.includes(link.secret)) fail("secret", "the page prints its own secret");
    const scripts = [...page.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const csp = page.headers.get("content-security-policy") ?? "";
    const hash = scripts[0] === undefined ? "" : createHash("sha256").update(scripts[0], "utf8").digest("base64");
    const allowed = /script-src ([^;]*)/.exec(csp)?.[1].trim();
    if (scripts.length !== 1 || /<script[^>]+src=/i.test(page.text) || allowed !== `'sha256-${hash}'`) {
      fail("one script", `${scripts.length} inline script(s); script-src is ${allowed ?? "absent"}`);
    }
    const styles = [...page.text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    const styleHash = styles[0] === undefined ? "" : createHash("sha256").update(styles[0], "utf8").digest("base64");
    if (styles.length !== 1 || /style-src ([^;]*)/.exec(csp)?.[1].trim() !== `'sha256-${styleHash}'`) {
      fail("one stylesheet", `${styles.length} inline stylesheet(s); the policy is ${csp}`);
    }
    if (/unsafe-inline|unsafe-eval|https?:/.test(csp)) fail("CSP", `the policy allows more than its own hashes: ${csp}`);
    for (const part of ["default-src 'none'", "img-src data:", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'", "connect-src 'self'"]) {
      if (!csp.includes(part)) fail("CSP", `the policy lacks ${part}: ${csp}`);
    }
    for (const [h, v] of [["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"], ["cache-control", "no-store"]]) {
      if (page.headers.get(h) !== v) fail("headers", `${h} is ${page.headers.get(h)}, not ${v}`);
    }
    if (/method="post"|<form[^>]+action=/i.test(page.text)) fail("no post", "the page's form posts somewhere");
    ok("the link page escapes a hostile filename, loads nothing, prints no secret, sends no referrer, cannot be framed, runs one hashed script");
    const linkBytes = utf8("staged through the page\n");
    const viaLink = await call("PUT", `/u/${link.secret}`, linkBytes, { "x-filename": encodeURIComponent("anything.md") });
    expect("link staging", viaLink, 200);
    const lr = await rowOf(link.id);
    if (viaLink.json.upload !== link.id || viaLink.json.filename !== hostile || lr.staged_via !== "link" || lr.staged_by !== null
        || !lr.body?.equals(linkBytes)) {
      fail("link staging", `answered ${viaLink.text}; the row holds ${lr.staged_via}/${lr.staged_by}`);
    }
    if (viaLink.headers.get("referrer-policy") !== "no-referrer") fail("link staging", "the PUT's answer sends a referrer");
    if ((await rowOf(neighbour.id)).sha256 !== null) fail("one upload only", "a link staged an upload it does not name");
    const linkConflict = await call("PUT", `/u/${link.secret}`, utf8("other\n"));
    expect("link conflict", linkConflict, 409, "UPLOAD_CONTENT_CONFLICT");
    if (!String(linkConflict.json.error).includes("staged through its link")) fail("link conflict", `the refusal does not say how: ${linkConflict.text}`);
    const staged = await call("GET", `/u/${link.secret}`);
    if (staged.status !== 200 || !staged.text.includes(sha(linkBytes)) || /<script>/.test(staged.text) || /<form/.test(staged.text)) {
      fail("staged page", `the page after staging answered ${staged.status} without the digest, or still offers the form`);
    }
    ok("a link stages its one upload as link with no principal, the governing filename is the row's, and the page then shows the binding");
    const expiredLink = await mint();
    await expire(expiredLink.id);
    const gone = await call("GET", `/u/${expiredLink.secret}`);
    if (gone.status !== 410 || !/expired/.test(gone.text)) fail("expired page", `answered ${gone.status}`);
    expect("expired link", await call("PUT", `/u/${expiredLink.secret}`, bytes), 410, "UPLOAD_EXPIRED");
    for (const bad of ["garbage", `${link.secret}x`, neighbour.id, mintUploadSecret()]) {
      const g = await call("GET", `/u/${bad}`);
      if (g.status !== 404 || g.text.includes("notes.md")) fail("malformed secret", `GET /u/${bad.slice(0, 12)}… answered ${g.status}`);
      expect("malformed secret", await call("PUT", `/u/${bad}`, bytes), 404, "FORBIDDEN");
    }
    if ((await call("POST", `/u/${neighbour.secret}`, bytes)).status !== 404) fail("staging only", "a link answers POST");
    expect("secret as id", await call("PUT", `/upload/${neighbour.secret}`, bytes, as()), 403, "FORBIDDEN");
    if ((await rowOf(neighbour.id)).sha256 !== null) fail("staging only", "the neighbour was staged");
    ok("an expired link says so; a malformed or unknown secret, an upload id as a secret and a secret as an id stage nothing");

    // The bounds. Ten attempts on one upload from ten addresses, then an eleventh.
    const busy = await mint();
    for (let i = 0; i < 10; i++) expect(`attempt ${i + 1}`, await call("PUT", `/upload/${busy.id}`, bytes, as(), boundedPort), 200);
    const eleventh = await call("PUT", `/upload/${busy.id}`, bytes, as(), boundedPort);
    if (eleventh.status !== 429 || eleventh.json.error !== "ERROR: RATE_LIMITED — try again in a minute") {
      fail("per upload", `the eleventh attempt answered ${eleventh.status} ${eleventh.text}`);
    }
    const linked = await mint();
    for (let i = 0; i < 10; i++) await call("PUT", `/u/${linked.secret}`, bytes, {}, boundedPort);
    expect("per upload, link", await call("PUT", `/u/${linked.secret}`, bytes, {}, boundedPort), 429, "RATE_LIMITED");
    // Sixty attempts from one address, on sixty different ids, then a sixty-first on either route.
    const from = { "x-forwarded-for": "192.0.2.7" };
    for (let i = 0; i < 60; i++) expect(`address ${i + 1}`, await call("PUT", `/upload/${mintUploadId()}`, bytes, { ...as(), ...from }, boundedPort), 403);
    expect("per address", await call("PUT", `/upload/${(await mint()).id}`, bytes, { ...as(), ...from }, boundedPort), 429, "RATE_LIMITED");
    expect("per address, link", await call("PUT", `/u/${(await mint()).secret}`, bytes, from, boundedPort), 429, "RATE_LIMITED");
    ok("staging is bounded at 10 attempts per upload and 60 per client address a minute, on both routes");

    // The sweep: an expired, unused body goes; a live one stays; every row stays.
    const live = await mint();
    expect("live staging", await call("PUT", `/upload/${live.id}`, bytes, as()), 200);
    const stale = await mint();
    expect("stale staging", await call("PUT", `/upload/${stale.id}`, bytes, as()), 200);
    await expire(stale.id);
    const swept = await sweepUploads();
    const after = await sql.query<{ id: string; body: Buffer | null; sha256: string | null }>(
      "select id, body, sha256 from zz.upload where id = any($1)", [[live.id, stale.id]]);
    const of = (id: string) => after.rows.find((x) => x.id === id);
    if (swept !== 1 || of(stale.id)?.body !== null || of(stale.id)?.sha256 !== sha(bytes) || !of(live.id)?.body) {
      fail("sweep", `swept ${swept}; stale body ${of(stale.id)?.body ? "kept" : "gone"}, live body ${of(live.id)?.body ? "kept" : "gone"}`);
    }
    ok("the sweep removes an expired, unused body, keeps a live one, and keeps every row");
  } finally {
    for (const l of [listener, bounded]) { l.closeAllConnections(); l.close(); }
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
  }
}

let url = "";
try {
  sourceReads();
  await withThrowawayDb((sql) => run(sql, url), async (u) => { url = u; });
  console.log(`${NAME}: binding, conflict, expiry, ownership, size, format, the link page and its bounds, and the sweep: ok`);
} catch (err) {
  if (err instanceof CaseFailure) { console.error(err.message); process.exitCode = 1; }
  else if (/Docker is not running/.test(String(err))) { console.error(`${NAME}: SKIPPED — ${String(err)}`); process.exitCode = 2; }
  else { console.error(`${NAME}: FAILED — ${err instanceof Error ? err.stack : String(err)}`); process.exitCode = 1; }
}
