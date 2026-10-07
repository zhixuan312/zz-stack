/**
 * Staging — a file's bytes reach the platform without passing through a model.
 *
 * Why not an MCP tool's argument: an MCP call's arguments ARE the model's own output, so attaching
 * a 600 KB report costs 600 KB of output tokens, twice over once it is read back to check. Here the
 * caller's shell, or the person's browser, sends the file itself. Reading a file is settled work,
 * and settled work belongs in code.
 *
 * zz-core's `upload_start` mints a `zz.upload` row and answers with both ways in, which this module
 * serves:
 *   PUT /upload/<id>   the bytes, with the person's own token — the upload must be theirs, started
 *                      for the team they act for now;
 *   GET /u/<secret>    the staging page (upload-page.ts), for a person whose agent has no shell;
 *   PUT /u/<secret>    that page's raw-bytes PUT. The secret authorises staging this one upload and
 *                      nothing else: it reads no document, commits nothing and approves nothing.
 *
 * Staging binds the bytes and stops. The first staging binds `byte_count`, `sha256`, `body`,
 * `staged_via` and `staged_by` in one `update … where sha256 is null`; the same bytes again answer
 * that binding, different bytes answer UPLOAD_CONTENT_CONFLICT, and nothing stages once the upload
 * has expired. The write that turns the bytes into a document or a source is zz-core's, inside its
 * own transaction, and it decodes them with the same `uploadText` this route refuses by.
 *
 * DELIBERATE: mounted before the global body parsers (server.ts). A browser PUTs a `.json` file as
 * `application/json` and curl sends a form type when told nothing else, and either parser would
 * consume the file before it got here; this reads at most 8 MiB itself, whatever the type says.
 */
import { createHash } from "node:crypto";

import { UPLOAD_ID, UPLOAD_MAX_BYTES, UPLOAD_SECRET, type UploadRefusal, uploadSecretHash, uploadText } from "@zz/contracts";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { linkHeaders, uploadPage } from "./upload-page.js";

/** How many staging attempts one upload, and one client address, get per minute. Every attempt
 *  counts, refused ones included: the bound is on trying, not on succeeding. */
interface StagingLimits { perUpload: number; perAddress: number }
const LIMITS: StagingLimits = { perUpload: 10, perAddress: 60 };
const WINDOW_MS = 60_000;
const RATE_LIMITED = "ERROR: RATE_LIMITED — try again in a minute";

/** A counter of attempts in the current window, by `a:<address>` and `u:<upload id>`. In memory:
 *  one gateway process serves a deployment, and a restart forgetting a minute of attempts costs
 *  nothing. Finished windows are dropped once the table grows. */
function limiter(): (key: string, limit: number) => boolean {
  const attempts = new Map<string, { n: number; until: number }>();
  return (key, limit) => {
    const now = Date.now();
    if (attempts.size > 10_000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
    let a = attempts.get(key);
    if (!a || a.until <= now) { a = { n: 0, until: now + WINDOW_MS }; attempts.set(key, a); }
    a.n += 1;
    return a.n > limit;
  };
}

const STATUS: Record<UploadRefusal["code"], number> = { UNSUPPORTED_FORMAT: 415, SIZE_LIMIT: 413, INVALID_ENCODING: 422 };

/** A refusal, as JSON. The request is drained rather than the socket destroyed: a destroyed
 *  request takes the connection with it, and the refusal would never arrive. */
function refuse(req: Request, res: Response, status: number, error: string): void {
  req.resume();
  res.status(status).json({ error });
}

/** The request body, at most `UPLOAD_MAX_BYTES`, or `null` past it.
 *
 *  Read as a stream rather than buffered whole, because `Content-Length` is the client's claim and
 *  a stream that ignores it is how a cap becomes a lie. Past the cap the rest is read and dropped. */
function readBody(req: Request): Promise<Buffer | null | "aborted"> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > UPLOAD_MAX_BYTES) { req.resume(); resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) { over = true; resolve(null); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve("aborted"));
  });
}

/** The row a staging works on: the fields that govern it, never its body. */
interface Row {
  id: string; filename: string; sha256: string | null; byte_count: number | null; expired: boolean;
  staged_via: string | null; staged_by: string | null;
}

const extOf = (filename: string): string => /^.+\.([^.]+)$/.exec(filename)?.[1].toLowerCase() ?? "";

/** Binds the request's bytes to `row`, or answers why not. `by` is the staging principal for the
 *  token route and null for the link, which authenticates nobody. */
async function stage(req: Request, res: Response, row: Row, via: "token" | "link", by: string | null): Promise<void> {
  if (row.expired) {
    refuse(req, res, 410, `ERROR: UPLOAD_EXPIRED — this upload's 15 minutes are over; call upload_start for ${JSON.stringify(row.filename)} again and send the file to the new upload.`);
    return;
  }
  // The filename that governs is the one upload_start recorded. A browser names the file it was
  // given, and a file of another extension is a different file from the one this upload is for.
  let sent = "";
  try { sent = decodeURIComponent(String(req.headers["x-filename"] ?? "")); } catch { sent = String(req.headers["x-filename"]); }
  if (sent && extOf(sent) !== extOf(row.filename)) {
    refuse(req, res, 415, `ERROR: UNSUPPORTED_FORMAT — this upload was started for ${JSON.stringify(row.filename)}, so it takes a .${extOf(row.filename)} file; ` +
      `${JSON.stringify(sent)} is not one. Send that file, or start an upload for the other one.`);
    return;
  }
  const body = await readBody(req);
  if (body === "aborted") { if (!res.headersSent) res.status(400).json({ error: "the upload ended before it was complete" }); return; }
  if (body === null) {
    res.status(413).json({ error: `ERROR: SIZE_LIMIT — the file is over the 8 MiB (${UPLOAD_MAX_BYTES}-byte) limit for one upload; send a smaller file, or split it into parts.` });
    return;
  }
  const read = uploadText(row.filename, body);
  if ("code" in read) { res.status(STATUS[read.code]).json({ error: read.refusal }); return; }

  const sha256 = createHash("sha256").update(body).digest("hex");
  const binding = { upload: row.id, filename: row.filename, bytes: body.length, sha256 };
  // Who staged what is already there, so a person told "other bytes" can tell their own earlier
  // try from someone else holding the link.
  const conflict = (held: Pick<Row, "sha256" | "staged_via" | "staged_by">) => {
    const how = held.staged_via === "link" ? "staged through its link"
      : by !== null && held.staged_by === by ? "staged with your token" : "staged with its owner's token";
    return `ERROR: UPLOAD_CONTENT_CONFLICT — ${row.id} already holds other bytes (sha256 ${held.sha256 ?? "unknown"}, ${how}); ` +
      "a staged file never changes. Call upload_start again for the new file.";
  };
  if (row.sha256 !== null) {
    if (row.sha256 === sha256) res.json(binding);
    else res.status(409).json({ error: conflict(row) });
    return;
  }
  const bound = await platformDb().query(
    `update zz.upload set byte_count = $2, sha256 = $3, body = $4, staged_via = $5, staged_by = $6
      where id = $1 and sha256 is null and expires_at > now()`,
    [row.id, body.length, sha256, body, via, by]);
  if (bound.rowCount === 1) { res.json(binding); return; }
  // Another staging won the race, or the window closed between the read and the bind.
  const now = await platformDb().query<Pick<Row, "sha256" | "staged_via" | "staged_by">>(
    "select sha256, staged_via, staged_by from zz.upload where id = $1", [row.id]);
  const won = now.rows[0];
  if (won?.sha256 === sha256) res.json(binding);
  else if (won && won.sha256 === null) res.status(410).json({ error: "ERROR: UPLOAD_EXPIRED — this upload's 15 minutes are over; call upload_start again." });
  else res.status(409).json({ error: conflict(won ?? { sha256: null, staged_via: null, staged_by: null }) });
}

/** Runs one staging handler, turning an unexpected failure into a 500 that names nothing. */
const guarded = (what: string, handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    void handler(req, res).catch((err: unknown) => {
      // DELIBERATE: the error alone, never the request — a link's path is its secret.
      console.error(`${what} failed:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) refuse(req, res, 500, "the upload could not be completed");
    });
  };

const FORBIDDEN = "ERROR: FORBIDDEN — this is not an upload of yours in the team you are acting for; call upload_start, " +
  "then send the file to the upload it answers with.";

/** Mounts the three staging routes. `limits` exists for the check, which stages more often than a
 *  minute allows; production passes nothing and gets 10 per upload and 60 per address. */
export function mountUpload(app: Express, opts: { limits?: StagingLimits } = {}): void {
  const { perUpload, perAddress } = opts.limits ?? LIMITS;
  const overLimit = limiter();
  app.put("/upload/:id", guarded("upload staging", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const who = req.zzIdentity;
    // The identity gate runs before this in server.ts; without it, nothing here is anybody's.
    if (!who) { refuse(req, res, 401, "authentication required: Bearer PAT (zzp_…)"); return; }
    const id = req.params.id ?? "";
    if (overLimit(`a:${req.ip}`, perAddress)) { refuse(req, res, 429, RATE_LIMITED); return; }
    if (!UPLOAD_ID.test(id)) { refuse(req, res, 403, FORBIDDEN); return; }
    if (overLimit(`u:${id}`, perUpload)) { refuse(req, res, 429, RATE_LIMITED); return; }
    // Unknown, someone else's and another team's answer alike, so an id says nothing about
    // whether it exists.
    const found = await platformDb().query<Row & { principal: string | null; mine: boolean | null }>(
      `select u.id, u.filename, u.sha256, u.byte_count, u.expires_at <= now() as expired, u.staged_via, u.staged_by,
              p.id as principal,
              (u.principal_id = p.id and u.team_id = t.id) as mine
         from zz.upload u
         left join zz.principal p on p.email = $2
         left join zz.team t on t.slug = $3
        where u.id = $1`,
      [id, who.email, who.activeTeam ?? ""]);
    const row = found.rows[0];
    if (!row?.mine || !row.principal) { refuse(req, res, 403, FORBIDDEN); return; }
    await stage(req, res, row, "token", row.principal);
  }));

  /** The row a link names, or null for anything that is not one of ours. */
  const byLink = async (secret: string): Promise<Row | null> => {
    if (!UPLOAD_SECRET.test(secret)) return null;
    const found = await platformDb().query<Row>(
      `select id, filename, sha256, byte_count, expires_at <= now() as expired, staged_via, staged_by
         from zz.upload where link_secret_hash = $1`,
      [uploadSecretHash(secret)]);
    return found.rows[0] ?? null;
  };

  app.get("/u/:secret", guarded("upload page", async (req, res) => {
    const row = await byLink(req.params.secret ?? "");
    const shown = uploadPage(
      !row ? { kind: "invalid" }
      : row.sha256 !== null ? { kind: "staged", filename: row.filename, bytes: row.byte_count ?? 0, sha256: row.sha256 }
      : row.expired ? { kind: "expired", filename: row.filename }
      : { kind: "ready", filename: row.filename });
    res.status(shown.status).set(linkHeaders(shown.body)).type("html").send(shown.body);
  }));

  app.put("/u/:secret", guarded("link staging", async (req, res) => {
    res.set(linkHeaders());
    if (overLimit(`a:${req.ip}`, perAddress)) { refuse(req, res, 429, RATE_LIMITED); return; }
    const row = await byLink(req.params.secret ?? "");
    if (!row) {
      refuse(req, res, 404, "ERROR: FORBIDDEN — this is not a staging link ZZ issued; ask the agent for a new one.");
      return;
    }
    if (overLimit(`u:${row.id}`, perUpload)) { refuse(req, res, 429, RATE_LIMITED); return; }
    await stage(req, res, row, "link", null);
  }));
}

/** Removes the body of every upload that expired unconsumed, keeping the row so its id is never new
 *  again. A body is only ever held while staged and unconsumed (the table's own check), so an
 *  expired row still holding one is exactly that. Hourly, from server.ts. Answers how many went. */
export async function sweepUploads(): Promise<number> {
  if (!platformDbReady()) return 0;
  const swept = await platformDb().query(
    "update zz.upload set body = null where body is not null and expires_at < now()");
  return swept.rowCount ?? 0;
}
