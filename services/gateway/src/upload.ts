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
 * has been written (UPLOAD_USED) or has expired. The write that turns the bytes into a document or a source is zz-core's, inside its
 * own transaction, and it decodes them with the same `uploadText` this route refuses by.
 *
 * DELIBERATE: mounted before the global body parsers (server.ts). A browser PUTs a `.json` file as
 * `application/json` and curl sends a form type when told nothing else, and either parser would
 * consume the file before it got here; this reads at most 8 MiB itself, whatever the type says.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { peerAddress, UPLOAD_ID, UPLOAD_MAX_BYTES, UPLOAD_SECRET, type UploadRefusal, uploadExtension, uploadSecretHash,
         uploadText } from "@zz/contracts";
import type { Express, Request, Response } from "express";

import { platformDb, platformDbReady } from "./db.js";
import { linkHeaders, uploadPage } from "./upload-page.js";

/** How staging is bounded — on trying, on memory and on what the database holds.
 *
 *  Attempts are counted per minute, refused ones included: the bound is on trying, not on
 *  succeeding. An attempt is counted against one upload only once the caller has shown it may
 *  stage that upload (its token owns it, or it holds the link), so nobody spends another's ten.
 *
 *  A count of attempts does not bound bytes, so two more bounds do. Memory: a body is read whole
 *  before it is bound, so at most `inFlight` bodies arrive from one client at once and
 *  `inFlightTotal` from everyone — at most that many times 8 MiB, however slowly they are sent.
 *  The database: an upload's owner holds at most `stagedBytes` staged and not yet written, in
 *  bodies whose window is still open. Per owner rather than per address because a row records
 *  who started it, never where a staging came from, and the owner is who a link stages for. An
 *  expired body leaves the count at once and the table at the next hourly sweep, so an owner
 *  holds at most five windows' worth (15 minutes open, up to 60 more before the sweep). */
interface StagingLimits {
  perUpload: number; perAddress: number; keys: number; inFlight: number; inFlightTotal: number; stagedBytes: number;
}
const LIMITS: StagingLimits = {
  perUpload: 10, perAddress: 60, keys: 100_000, inFlight: 4, inFlightTotal: 32, stagedBytes: 64 * 1024 * 1024,
};
const WINDOW_MS = 60_000;
const RATE_LIMITED = "ERROR: RATE_LIMITED — try again in a minute";

/** A counter of attempts in the current window, by `a:<client>` and `u:<upload id>`. In memory:
 *  one gateway process serves a deployment, and a restart forgetting a minute of attempts costs
 *  nothing.
 *
 *  Every window is `WINDOW_MS` long and a key is re-inserted when its window restarts, so the map
 *  is in order of expiry: finished windows sit at its head and each is dropped once, in one step.
 *  At most `maxKeys` windows are held; past that a key not already counted is refused rather than
 *  let through, because a bound that forgets under load is no bound. */
function limiter(maxKeys: number): (key: string, limit: number) => boolean {
  const attempts = new Map<string, { n: number; until: number }>();
  return (key, limit) => {
    const now = Date.now();
    for (const [k, a] of attempts) {
      if (a.until > now) break;
      attempts.delete(k);
    }
    let a = attempts.get(key);
    if (!a) {
      if (attempts.size >= maxKeys) return true;
      a = { n: 0, until: now + WINDOW_MS };
      attempts.set(key, a);
    }
    a.n += 1;
    return a.n > limit;
  };
}

/** The client a bound counts against: an IPv4 address whole, an IPv6 address by its /64. A /64 is
 *  what one subscriber is routinely given, so counting each of its addresses apart would hand one
 *  client 2^64 fresh counters. The IPv4-mapped fold is `peerAddress`'s, the platform's one. */
function clientOf(ip: string): string {
  const a = peerAddress({ remoteAddress: ip.replace(/%.*$/, "") });
  if (isIP(a) !== 6) return a;
  const width = (groups: string[]) => groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const [head = "", tail] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - width(left) - width(right)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
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

/** The row a staging works on: the fields that govern it, never its body. `owner` is the principal
 *  that started the upload, whose staged bytes are bounded. */
interface Row {
  id: string; filename: string; sha256: string | null; byte_count: number | null; expired: boolean; consumed: boolean;
  staged_via: string | null; staged_by: string | null; owner: string;
}

/** What one mounting's bounds allow a staging: room for its body to arrive, and the bytes its owner
 *  may hold staged. */
interface Room { arrive: (res: Response) => boolean; stagedBytes: number }

/** Binds the request's bytes to `row`, or answers why not. `by` is the staging principal for the
 *  token route and null for the link, which authenticates nobody. */
async function stage(req: Request, res: Response, row: Row, via: "token" | "link", by: string | null, room: Room): Promise<void> {
  // Consumed before expired: a written upload is done, and "start a new upload" would read as if
  // the write had not happened. The page reads the row in the same order.
  if (row.consumed) {
    refuse(req, res, 410, `ERROR: UPLOAD_USED — ${row.id} was already written by the agent, and an upload is used once; ` +
      `call upload_start for ${JSON.stringify(row.filename)} again to send another file.`);
    return;
  }
  const expired = `ERROR: UPLOAD_EXPIRED — this upload's 15 minutes are over; call upload_start for ${JSON.stringify(row.filename)} again ` +
    "and send the file to the new upload.";
  if (row.expired) { refuse(req, res, 410, expired); return; }
  // The filename that governs is the one upload_start recorded. A browser names the file it was
  // given, and a file of another extension is a different file from the one this upload is for.
  let sent = "";
  try { sent = decodeURIComponent(String(req.headers["x-filename"] ?? "")); } catch { sent = String(req.headers["x-filename"]); }
  if (sent && uploadExtension(sent) !== uploadExtension(row.filename)) {
    refuse(req, res, 415, `ERROR: UNSUPPORTED_FORMAT — this upload was started for ${JSON.stringify(row.filename)}, so it takes a .${uploadExtension(row.filename)} file; ` +
      `${JSON.stringify(sent)} is not one. Send that file, or start an upload for the other one.`);
    return;
  }
  if (!room.arrive(res)) {
    refuse(req, res, 429, "ERROR: RATE_LIMITED — too many files are arriving at once; wait for one to finish, then send this one again.");
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
  // DELIBERATE: the owner's held bytes are summed in the bind itself, through upload_sweep (the
  // bodies still held, by expiry). Two stagings for one owner binding at the same instant can each
  // pass it, so the bound can be exceeded by the bodies in flight at once — never more.
  const bound = await platformDb().query(
    `update zz.upload u set byte_count = $2, sha256 = $3, body = $4, staged_via = $5, staged_by = $6
      where u.id = $1 and u.sha256 is null and u.expires_at > now()
        and $2 + (select coalesce(sum(h.byte_count), 0) from zz.upload h
                   where h.principal_id = u.principal_id and h.body is not null and h.expires_at > now()) <= $7`,
    [row.id, body.length, sha256, body, via, by, room.stagedBytes]);
  if (bound.rowCount === 1) { res.json(binding); return; }
  // Another staging won the race, the window closed between the read and the bind, or the owner
  // holds too much.
  const now = await platformDb().query<Pick<Row, "sha256" | "staged_via" | "staged_by" | "expired">>(
    "select sha256, staged_via, staged_by, expires_at <= now() as expired from zz.upload where id = $1", [row.id]);
  const won = now.rows[0];
  if (won?.sha256 === sha256) res.json(binding);
  else if (won && won.sha256 === null && won.expired) res.status(410).json({ error: expired });
  else if (won && won.sha256 === null) {
    res.status(429).json({ error: `ERROR: RATE_LIMITED — the person this upload is for already has ${room.stagedBytes} bytes staged and not yet ` +
      "written; have the agent write those files, or wait for their 15 minutes to end, then send this one again." });
  } else res.status(409).json({ error: conflict(won ?? { sha256: null, staged_via: null, staged_by: null }) });
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

/** Mounts the three staging routes. `limits` exists for the checks, which stage more often than a
 *  minute allows and bound bytes far below production; what they leave out, and everything when
 *  production passes nothing, is `LIMITS`. */
export function mountUpload(app: Express, opts: { limits?: Partial<StagingLimits> } = {}): void {
  const limits: StagingLimits = { ...LIMITS, ...opts.limits };
  const { perUpload, perAddress } = limits;
  const overLimit = limiter(limits.keys);
  // Bodies arriving now, per client and in all. Released once, when the answer is sent or the
  // connection goes, however it ends — answered, refused or abandoned mid-body.
  const arriving = new Map<string, number>();
  let arrivingTotal = 0;
  const roomFor = (client: string): Room => ({
    stagedBytes: limits.stagedBytes,
    arrive: (res) => {
      const n = arriving.get(client) ?? 0;
      if (n >= limits.inFlight || arrivingTotal >= limits.inFlightTotal) return false;
      arriving.set(client, n + 1);
      arrivingTotal += 1;
      let gone = false;
      const release = () => {
        if (gone) return;
        gone = true;
        const left = (arriving.get(client) ?? 1) - 1;
        if (left > 0) arriving.set(client, left); else arriving.delete(client);
        arrivingTotal -= 1;
      };
      res.once("finish", release);
      res.once("close", release);
      return true;
    },
  });

  app.put("/upload/:id", guarded("upload staging", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const who = req.zzIdentity;
    // The identity gate runs before this in server.ts; without it, nothing here is anybody's.
    if (!who) { refuse(req, res, 401, "authentication required: Bearer PAT (zzp_…)"); return; }
    const id = req.params.id ?? "";
    const client = clientOf(req.ip ?? "");
    if (overLimit(`a:${client}`, perAddress)) { refuse(req, res, 429, RATE_LIMITED); return; }
    if (!UPLOAD_ID.test(id)) { refuse(req, res, 403, FORBIDDEN); return; }
    // Unknown, someone else's and another team's answer alike, so an id says nothing about
    // whether it exists.
    const found = await platformDb().query<Row & { principal: string | null; mine: boolean | null }>(
      `select u.id, u.filename, u.sha256, u.byte_count, u.expires_at <= now() as expired,
              u.consumed_at is not null as consumed, u.staged_via, u.staged_by, u.principal_id as owner,
              p.id as principal,
              (u.principal_id = p.id and u.team_id = t.id) as mine
         from zz.upload u
         left join zz.principal p on p.email = $2
         left join zz.team t on t.slug = $3
        where u.id = $1`,
      [id, who.email, who.activeTeam ?? ""]);
    const row = found.rows[0];
    if (!row?.mine || !row.principal) { refuse(req, res, 403, FORBIDDEN); return; }
    if (overLimit(`u:${id}`, perUpload)) { refuse(req, res, 429, RATE_LIMITED); return; }
    await stage(req, res, row, "token", row.principal, roomFor(client));
  }));

  /** The row a link names, or null for anything that is not one of ours. */
  const byLink = async (secret: string): Promise<Row | null> => {
    if (!UPLOAD_SECRET.test(secret)) return null;
    const found = await platformDb().query<Row>(
      `select id, filename, sha256, byte_count, expires_at <= now() as expired, consumed_at is not null as consumed,
              staged_via, staged_by, principal_id as owner
         from zz.upload where link_secret_hash = $1`,
      [uploadSecretHash(secret)]);
    return found.rows[0] ?? null;
  };

  // The page counts against its client like a staging does: each GET is a hash and a lookup, and
  // a person sending one file opens the page twice (before, and the reload after).
  app.get("/u/:secret", guarded("upload page", async (req, res) => {
    const row = overLimit(`a:${clientOf(req.ip ?? "")}`, perAddress) ? "busy" : await byLink(req.params.secret ?? "");
    const shown = uploadPage(
      row === "busy" ? { kind: "busy" }
      : !row ? { kind: "invalid" }
      : row.consumed ? { kind: "consumed", filename: row.filename }
      : row.expired ? { kind: "expired", filename: row.filename }
      : row.sha256 !== null ? { kind: "staged", filename: row.filename, bytes: row.byte_count ?? 0, sha256: row.sha256 }
      : { kind: "ready", filename: row.filename });
    res.status(shown.status).set(linkHeaders(shown.body)).type("html").send(shown.body);
  }));

  app.put("/u/:secret", guarded("link staging", async (req, res) => {
    res.set(linkHeaders());
    const client = clientOf(req.ip ?? "");
    if (overLimit(`a:${client}`, perAddress)) { refuse(req, res, 429, RATE_LIMITED); return; }
    const row = await byLink(req.params.secret ?? "");
    if (!row) {
      refuse(req, res, 403, "ERROR: FORBIDDEN — this is not a staging link ZZ issued; ask the agent for a new one.");
      return;
    }
    if (overLimit(`u:${row.id}`, perUpload)) { refuse(req, res, 429, RATE_LIMITED); return; }
    await stage(req, res, row, "link", null, roomFor(client));
  }));
}

/** Hourly, from server.ts. Removes the body of every upload that expired unconsumed — a body is
 *  only ever held while staged and unconsumed (the table's own check), so an expired row still
 *  holding one is exactly that — and deletes every row a write never consumed once its window has
 *  been over a day. A consumed row stays, so a used id is never new again; one never consumed
 *  backs no write and no request history, and the day lets a late write still hear why
 *  (UPLOAD_MISSING, UPLOAD_EXPIRED) rather than that the id is not theirs. Answers how many bodies and rows went. */
export async function sweepUploads(): Promise<number> {
  if (!platformDbReady()) return 0;
  const swept = await platformDb().query(
    "update zz.upload set body = null where body is not null and expires_at < now()");
  const dropped = await platformDb().query(
    "delete from zz.upload where consumed_at is null and expires_at < now() - interval '1 day'");
  return (swept.rowCount ?? 0) + (dropped.rowCount ?? 0);
}
