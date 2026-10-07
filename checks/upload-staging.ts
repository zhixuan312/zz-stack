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
 *   - nothing stages after expiry (UPLOAD_EXPIRED), once written (UPLOAD_USED), with someone else's
 *     token, in another team, with no identity, past 8 MiB (SIZE_LIMIT), as invalid UTF-8 or as a
 *     file of another extension;
 *   - the link page escapes a hostile filename, loads nothing, never prints its secret, sends no
 *     referrer, cannot be framed, and runs one script, the one its CSP hash allows; its PUT stages
 *     that one upload and no other, as `link` with no principal; a malformed or unknown secret is
 *     refused, and an upload id is not a secret; a written or expired upload's page says so, never
 *     "staged";
 *   - staging is bounded at 10 attempts per upload and 60 staging PUTs per client a minute — an
 *     IPv6 client by its /64, an upload's attempts only once the caller may stage it — answering
 *     `ERROR: RATE_LIMITED — try again in a minute`; a link that resolves to nothing is counted
 *     against nobody; a link's page loads are bounded on the link, apart from the client's PUTs;
 *     past its table of counters a new client is still served; bodies arriving at once are bounded
 *     per owner, not per address, and in all; a body that does not arrive within the read deadline
 *     answers UPLOAD_TIMEOUT and frees its slot; and an owner's staged, unwritten bytes are
 *     bounded;
 *   - the sweep removes the body of an expired, unused upload, deletes a row no write consumed a day
 *     after its window, and keeps a consumed row;
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
  // Opened from here on, so everything opened is closed whatever fails.
  const servers: Server[] = [];
  try {
    await cases(sql, dbModule.platformDb(), servers, mint, rowOf, expire, owner);
  } finally {
    for (const l of servers) { l.closeAllConnections(); l.close(); }
    await dbModule.platformDb().end();
    delete process.env.TEAM_DB_URL;
  }
}

type Limits = { perUpload?: number; perAddress?: number; perPage?: number; keys?: number; inFlight?: number; inFlightTotal?: number;
                stagedBytes?: number; readMs?: number };

async function cases(sql: pg.Client, pool: pg.Pool, servers: Server[],
                     mint: (filename?: string, by?: string) => Promise<{ id: string; secret: string }>,
                     rowOf: (id: string) => Promise<{ byte_count: number | null; sha256: string | null; body: Buffer | null;
                                                      staged_via: string | null; staged_by: string | null }>,
                     expire: (id: string) => Promise<unknown>, owner: string): Promise<void> {
  const { mountUpload, sweepUploads } = (await load("services/gateway/dist/upload.js")) as
    { mountUpload: (app: unknown, opts?: { limits?: Limits }) => void; sweepUploads: () => Promise<number> };
  const express = (await import("express")).default;

  const routes: string[] = [];
  mountUpload({ get: (p: string) => routes.push(`GET ${p}`), put: (p: string) => routes.push(`PUT ${p}`),
                post: (p: string) => routes.push(`POST ${p}`), all: (p: string) => routes.push(`ALL ${p}`),
                use: () => routes.push("USE") });
  if (routes.join(", ") !== "PUT /upload/:id, GET /u/:secret, PUT /u/:secret") fail("routes", `mountUpload served ${routes.join(", ")}`);
  ok("mountUpload serves exactly PUT /upload/:id, GET /u/:secret and PUT /u/:secret");

  /** An app as the gateway builds one: the identity this check stamps in place of the gate, the
   *  staging routes, and then the global body parsers, which must never see a staged file. */
  const appWith = async (limits?: Limits): Promise<Server> => {
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
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return server;
  };
  // Every case but the bounds stages more often than a minute allows; the attempt bounds get
  // production's; the byte and table bounds get figures a case can reach.
  const portOf = (s: Server) => (s.address() as { port: number }).port;
  const port = portOf(await appWith({ perUpload: 1_000, perAddress: 100_000 }));
  const boundedPort = portOf(await appWith());
  const tightPort = portOf(await appWith({ perUpload: 1_000, perAddress: 100_000, inFlight: 1, inFlightTotal: 2, stagedBytes: 64 }));
  const crowdedPort = portOf(await appWith({ keys: 2 }));
  const slowPort = portOf(await appWith({ perUpload: 1_000, perAddress: 100_000, inFlight: 1, readMs: 300 }));
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

  /** The gateway's own pool, watched for one upload: `read` settles once a staging's row read for
   *  it has answered — that staging then waits on its body — and `binds` records each bind tried on
   *  it with the rows it bound. The order of two stagings is then certain rather than slept for.
   *  `readBy` waits for that read and fails instead when the staging answers first, or after 10 s:
   *  a staging refused before its row read, or a reworded read, must not hang the check. */
  const watch = (id: string) => {
    const real = pool.query.bind(pool) as (...a: unknown[]) => Promise<pg.QueryResult>;
    let rowRead = () => {};
    const read = new Promise<void>((resolve) => { rowRead = resolve; });
    const binds: { body: string; rows: number | null }[] = [];
    (pool as unknown as { query: unknown }).query = async (...a: unknown[]) => {
      const got = await real(...a);
      const [text, values] = a as [unknown, unknown[] | undefined];
      if (typeof text === "string" && values?.[0] === id) {
        if (/^\s*select u\.id/.test(text)) rowRead();
        if (/^\s*update zz\.upload u set byte_count/.test(text)) binds.push({ body: String(values[3]), rows: got.rowCount });
      }
      return got;
    };
    const readBy = async (step: string, answer: Promise<number>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      try {
        await Promise.race([
          read,
          answer.then((status) => { if (!settled) fail(step, `the staging answered ${status} before reading its row`); }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new CaseFailure(`${NAME}: FAILED at "${step}": no row read for ${id} within 10 s`)), 10_000);
          }),
        ]);
      } finally {
        settled = true;
        clearTimeout(timer);
      }
    };
    return { readBy, binds, stop: () => { delete (pool as unknown as { query?: unknown }).query; } };
  };

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
  // bytes when another binds must not overwrite that binding when it finishes. The gateway's own
  // pool is watched, so the order is certain rather than slept for: the competing staging starts
  // only once the late one's row read has answered (it then waits on its body), and the late one's
  // bind is seen to run and to bind nothing.
  const slow = await mint();
  const w = watch(slow.id);
  try {
    const late = request({ port, method: "PUT", path: `/upload/${slow.id}`,
      headers: { ...as(), "x-forwarded-for": "10.9.9.9", "content-length": "8" } });
    const lateAnswer = new Promise<{ status: number; body: string }>((resolve, reject) => {
      late.on("response", (res) => { let b = ""; res.on("data", (c: Buffer) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
      late.on("error", reject);
    });
    late.write("late");
    await w.readBy("bind is guarded", lateAnswer.then((a) => a.status));
    expect("bind while another reads", await call("PUT", `/upload/${slow.id}`, utf8("first\n"), as()), 200);
    late.end("r!\n\n");
    const second = await lateAnswer;
    if (second.status !== 409 || (await rowOf(slow.id)).sha256 !== sha(utf8("first\n"))) {
      fail("bind is guarded", `the late staging answered ${second.status} ${second.body.slice(0, 200)}; the row holds ${(await rowOf(slow.id)).sha256}`);
    }
    if (JSON.stringify(w.binds) !== JSON.stringify([{ body: "first\n", rows: 1 }, { body: "later!\n\n", rows: 0 }])) {
      fail("bind is guarded", `the late staging did not reach its guarded bind: the binds were ${JSON.stringify(w.binds)}`);
    }
  } finally {
    w.stop();
  }
  ok("a staging still receiving its bytes when another binds reaches its bind, binds nothing, and answers a conflict");

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
  // A staged upload that then expired, or that a write consumed, is not "staged": its body is
  // gone, and a write naming it is refused. The page says what the write would say.
  const stagedThenExpired = await mint();
  expect("staged then expired", await call("PUT", `/u/${stagedThenExpired.secret}`, bytes), 200);
  await expire(stagedThenExpired.id);
  const lapsed = await call("GET", `/u/${stagedThenExpired.secret}`);
  if (lapsed.status !== 410 || !/expired/.test(lapsed.text) || /Staged\./.test(lapsed.text)) {
    fail("staged then expired page", `answered ${lapsed.status} ${lapsed.text.replace(/<style>[\s\S]*?<\/style>/, "").slice(0, 400)}`);
  }
  const consumed = await mint();
  expect("staged then consumed", await call("PUT", `/u/${consumed.secret}`, bytes), 200);
  await sql.query(`update zz.upload set consumed_at = now(), consumed_by_operation = 'document_write a/b.md',
                     consumed_digest = $2, body = null where id = $1`, [consumed.id, sha(bytes)]);
  const written = await call("GET", `/u/${consumed.secret}`);
  if (written.status !== 410 || !/already written/.test(written.text) || /Staged\./.test(written.text)) {
    fail("consumed page", `answered ${written.status} ${written.text.replace(/<style>[\s\S]*?<\/style>/, "").slice(0, 400)}`);
  }
  expect("consumed link", await call("PUT", `/u/${consumed.secret}`, bytes), 410, "UPLOAD_USED");
  ok("a staged upload that expired, or that a write consumed, says so on its page and refuses a staging");
  for (const bad of ["garbage", `${link.secret}x`, neighbour.id, mintUploadSecret()]) {
    const g = await call("GET", `/u/${bad}`);
    if (g.status !== 404 || g.text.includes("notes.md")) fail("malformed secret", `GET /u/${bad.slice(0, 12)}… answered ${g.status}`);
    expect("malformed secret", await call("PUT", `/u/${bad}`, bytes), 403, "FORBIDDEN");
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
  // A link that resolves to nothing is counted against nobody: seventy of them from one address,
  // page and PUT, and that address's own link still opens and stages.
  const stranger = { "x-forwarded-for": "192.0.2.9" };
  for (let i = 0; i < 70; i++) {
    const bad = mintUploadSecret();
    if ((await call("GET", `/u/${bad}`, undefined, stranger, boundedPort)).status !== 404) fail("unknown links", `GET ${i + 1} was not a 404`);
    expect(`unknown link ${i + 1}`, await call("PUT", `/u/${bad}`, bytes, stranger, boundedPort), 403, "FORBIDDEN");
  }
  const strangersOwn = await mint();
  if ((await call("GET", `/u/${strangersOwn.secret}`, undefined, stranger, boundedPort)).status !== 200) fail("unknown links", "the page was refused");
  expect("unknown links", await call("PUT", `/u/${strangersOwn.secret}`, bytes, stranger, boundedPort), 200);
  ok("a link that resolves to nothing is counted against nobody");
  // An upload's ten are spent only by callers who may stage it: another member trying the owner's
  // id is refused as a stranger every time, and the owner then stages.
  const coveted = await mint();
  for (let i = 0; i < 12; i++) expect(`stranger ${i + 1}`, await call("PUT", `/upload/${coveted.id}`, bytes, as("other@example.test"), boundedPort), 403, "FORBIDDEN");
  expect("owner after strangers", await call("PUT", `/upload/${coveted.id}`, bytes, as(), boundedPort), 200);
  // One IPv6 /64 is one client; the next /64 is another.
  for (let i = 1; i <= 60; i++) {
    expect(`/64 ${i}`, await call("PUT", `/upload/${mintUploadId()}`, bytes, { ...as(), "x-forwarded-for": `2001:db8:1:2::${i.toString(16)}` }, boundedPort), 403);
  }
  expect("same /64", await call("PUT", `/upload/${mintUploadId()}`, bytes, { ...as(), "x-forwarded-for": "2001:db8:1:2:ffff:ffff:ffff:fffe" }, boundedPort), 429, "RATE_LIMITED");
  expect("next /64", await call("PUT", `/upload/${mintUploadId()}`, bytes, { ...as(), "x-forwarded-for": "2001:db8:1:3::1" }, boundedPort), 403, "FORBIDDEN");
  // A link's page loads count on the link, from any address, and spend no address's staging: one
  // address opening pages for a whole office still stages, and opens another link's page.
  const looked = await mint();
  const viewer = { "x-forwarded-for": "192.0.2.8" };
  for (let i = 0; i < 60; i++) {
    const g = await call("GET", `/u/${looked.secret}`, undefined, i % 2 ? viewer : {}, boundedPort);
    if (g.status !== 200) fail("page bound", `GET ${i + 1} answered ${g.status}`);
  }
  const tooMany = await call("GET", `/u/${looked.secret}`, undefined, {}, boundedPort);
  if (tooMany.status !== 429 || !/Too many tries/.test(tooMany.text) || tooMany.text.includes("notes.md")) {
    fail("page bound", `the sixty-first GET answered ${tooMany.status}`);
  }
  expect("page loads spend no staging", await call("PUT", `/u/${looked.secret}`, bytes, viewer, boundedPort), 200);
  if ((await call("GET", `/u/${(await mint()).secret}`, undefined, viewer, boundedPort)).status !== 200) fail("page bound", "another link's page was refused");
  ok("an upload's attempts count only once the caller may stage it, an IPv6 client is its /64, and a link's page loads count on the link alone");

  // Past its table of counters the oldest is forgotten: a client not yet counted is served.
  const crowd = (ip: string) => call("PUT", `/upload/${mintUploadId()}`, bytes, { ...as(), "x-forwarded-for": ip }, crowdedPort);
  expect("first client", await crowd("203.0.113.1"), 403, "FORBIDDEN");
  expect("second client", await crowd("203.0.113.2"), 403, "FORBIDDEN");
  expect("a client past the table", await crowd("203.0.113.3"), 403, "FORBIDDEN");
  expect("a client counted before", await crowd("203.0.113.1"), 403, "FORBIDDEN");
  ok("past its table of counters a new client is still served");

  // Bytes: one body arriving per owner and two in all, and 64 staged bytes per owner — a person of
  // their own, so the earlier cases' staged files count for nobody here.
  const third = (await sql.query<{ id: string }>(
    "insert into zz.principal (email, display_name, role) values ('third@example.test', 'third', 'member') returning id")).rows[0].id;
  await sql.query("insert into zz.membership (team_id, principal_id, role, added_by) select id, $1, 'member', $1 from zz.team where slug = 'home-team'", [third]);
  const asThird = (ip: string) => ({ ...as("third@example.test"), "x-forwarded-for": ip });
  const otherId = (await sql.query<{ id: string }>("select id from zz.principal where email = 'other@example.test'")).rows[0].id;
  /** A body that has begun to arrive and waits, holding its slot, until `finish`. */
  const held = async (ip: string, email = "third@example.test", by = third) => {
    const up = await mint("held.md", by);
    const w = watch(up.id);
    const req = request({ port: tightPort, method: "PUT", path: `/upload/${up.id}`,
                          headers: { ...as(email), "x-forwarded-for": ip, "content-length": "8" } });
    const answer = new Promise<number>((resolve, reject) => {
      req.on("response", (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject);
    });
    req.write("late");
    try {
      await w.readBy("arriving bodies", answer);
    } finally {
      w.stop();
    }
    return { finish: () => { req.end("r!\n\n"); return answer; } };
  };
  const one = await held("198.51.100.1");
  expect("a second body for one owner, from another address", await call("PUT", `/upload/${(await mint("q.md", third)).id}`, bytes,
    asThird("198.51.100.9"), tightPort), 429, "RATE_LIMITED");
  // Another owner behind the same address is not held back by the first.
  const two = await held("198.51.100.1", "other@example.test", otherId);
  expect("a third body in all", await call("PUT", `/upload/${(await mint("q.md", owner)).id}`, bytes, as(), tightPort), 429, "RATE_LIMITED");
  if (await one.finish() !== 200 || await two.finish() !== 200) fail("arriving bodies", "a held body did not stage once sent whole");
  const after = await mint("q.md", third);
  expect("room again", await call("PUT", `/upload/${after.id}`, bytes, asThird("198.51.100.1"), tightPort), 200);
  // 8 + 20 bytes held now; 40 more is past 64, until a write consumes one.
  const over = await mint("over.md", third);
  const forty = utf8("x".repeat(39) + "\n");
  const quota = await call("PUT", `/upload/${over.id}`, forty, asThird("198.51.100.4"), tightPort);
  expect("staged bytes", quota, 429, "RATE_LIMITED");
  if (!String(quota.json.error).includes("past the 64-byte limit on files staged and not yet written") || (await rowOf(over.id)).sha256 !== null) {
    fail("staged bytes", `answered ${quota.text}`);
  }
  await sql.query(`update zz.upload set consumed_at = now(), consumed_by_operation = 'document_write a/q.md',
                     consumed_digest = sha256, body = null where id = $1`, [after.id]);
  expect("staged bytes after a write", await call("PUT", `/upload/${over.id}`, forty, asThird("198.51.100.4"), tightPort), 200);
  ok("bodies arriving at once are bounded per owner, not per address, and in all, and an owner's staged, unwritten bytes are bounded");

  // A body that does not arrive within the read deadline is refused, binds nothing, and frees its
  // slot for the owner's next one.
  const stalled = await mint();
  const slowReq = request({ port: slowPort, method: "PUT", path: `/upload/${stalled.id}`, headers: { ...as(), "content-length": "8" } });
  const timedOut = new Promise<{ status: number; body: string }>((resolve, reject) => {
    slowReq.on("response", (res) => { let b = ""; res.on("data", (c: Buffer) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b })); });
    slowReq.on("error", reject);
  });
  slowReq.write("late");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stall = await Promise.race([timedOut, new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 5_000); })]);
  clearTimeout(deadline);
  slowReq.destroy();
  if (!stall || stall.status !== 408 || !stall.body.includes("ERROR: UPLOAD_TIMEOUT — ") || (await rowOf(stalled.id)).sha256 !== null) {
    fail("read deadline", stall ? `answered ${stall.status} ${stall.body.slice(0, 200)}` : "a stalled body was still held after 5 s");
  }
  expect("read deadline frees the slot", await call("PUT", `/upload/${(await mint()).id}`, bytes, as(), slowPort), 200);
  ok("a body that does not arrive within the read deadline answers UPLOAD_TIMEOUT, binds nothing and frees its slot");

  // The sweep: an expired body goes and its row stays; a row no write consumed goes a day after its
  // window, staged or not; a recently expired row and a consumed row stay.
  const longAgo = (id: string) => sql.query(
    "update zz.upload set created_at = now() - interval '2 days 1 minute', expires_at = now() - interval '2 days' where id = $1", [id]);
  const live = await mint();
  expect("live staging", await call("PUT", `/upload/${live.id}`, bytes, as()), 200);
  const stale = await mint();
  expect("stale staging", await call("PUT", `/upload/${stale.id}`, bytes, as()), 200);
  await expire(stale.id);
  const recent = await mint();
  await expire(recent.id);
  const abandoned = await mint();
  await longAgo(abandoned.id);
  const forgotten = await mint();
  expect("forgotten staging", await call("PUT", `/upload/${forgotten.id}`, bytes, as()), 200);
  await longAgo(forgotten.id);
  const usedLongAgo = await mint();
  expect("used staging", await call("PUT", `/upload/${usedLongAgo.id}`, bytes, as()), 200);
  await sql.query(`update zz.upload set consumed_at = now(), consumed_by_operation = 'document_write a/u.md',
                     consumed_digest = sha256, body = null where id = $1`, [usedLongAgo.id]);
  await longAgo(usedLongAgo.id);
  const due = (await sql.query<{ n: number }>(
    `select ((select count(*) from zz.upload where body is not null and expires_at < now())
           + (select count(*) from zz.upload where consumed_at is null and expires_at < now() - interval '1 day'))::int as n`)).rows[0].n;
  const swept = await sweepUploads();
  const rows = await sql.query<{ id: string; body: Buffer | null; sha256: string | null }>(
    "select id, body, sha256 from zz.upload where id = any($1)", [[live.id, stale.id, recent.id, abandoned.id, forgotten.id, usedLongAgo.id]]);
  const of = (id: string) => rows.rows.find((x) => x.id === id);
  const state = { swept, due, live: !!of(live.id)?.body, stale: of(stale.id) ? (of(stale.id)?.body ? "body" : "row") : "gone",
                  recent: !!of(recent.id), abandoned: !!of(abandoned.id), forgotten: !!of(forgotten.id), used: !!of(usedLongAgo.id) };
  if (swept !== due || due < 4 || !state.live || state.stale !== "row" || of(stale.id)?.sha256 !== sha(bytes) || !state.recent
      || state.abandoned || state.forgotten || !state.used) {
    fail("sweep", JSON.stringify(state));
  }
  ok("the sweep removes an expired body and keeps its row, deletes a row no write consumed a day after its window, and keeps a consumed one");
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
