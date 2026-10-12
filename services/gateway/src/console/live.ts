/**
 * /api/console/live — the console's one Server-Sent Events stream, which carries hints and never data.
 *
 * A hint says which collection changed; the tab then reads that collection again through its own read. It carries no
 * record, no team and no cache tag, so a missed hint costs freshness and never correctness — which is why the tab also
 * has a safety poll and resyncs on every open. There is no `id:`, because the stream does not replay.
 *
 * The shape is the one `.agents/skills/zz-meridian/references/live.md` sets out and the one the console's
 * `src/lib/live.ts` already speaks:
 *
 *   retry: 3000
 *
 *   event: resync
 *   data: {"collections":["initiatives","knowledge"]}
 *
 *   event: change
 *   data: {"collection":"initiatives"}
 *
 *   : beat 1791181947919
 *
 * AUTHORIZED TWICE, which is the point of this file rather than a detail of it. The admission check runs before the
 * stream opens: no session is 401, a malformed list is 400, and a name this console has no read for is 403 with the
 * same body as one it has but the caller may not reach, so neither is disclosed. Then every frame waits on a second
 * check, made as it is sent rather than when the stream opened — `browserSession` re-reads `console_session`, so a
 * session revoked while a tab sat open ends the stream instead of feeding it. A hint is not data, but whether a caller
 * may be told that a collection changed is still a question about the caller, and the answer at open time is not the
 * answer an hour later. That second check being asynchronous is also what makes the queue below a real queue: frames
 * accumulate behind it while it resolves.
 *
 * The change source is Postgres `LISTEN`: one dedicated connection per process, shared by every subscriber. A writer
 * raises the notification inside its own transaction, so Postgres delivers it only on commit and a rollback sends
 * nothing. The payload is `{t, c}` — a team slug and a collection name, never a record — and the two are filtered
 * separately: `c` decides whether a tab follows the collection at all, `t` whether this caller may see that team. An
 * empty `t` means the change is nobody's team business (`plugins`, `settings`), and every console reader may hear it.
 */
import type { Express, Request, Response } from "express";
import pg from "pg";

import { platformDbReady, platformDbUrl } from "../db.js";
import { browserSession } from "../identity.js";
import { resolveScope } from "../scope.js";
import { mayReadConsole } from "./shared.js";

/** The channel every writer notifies on. A payload is a team slug and a collection name, never a record.
 *
 *  NOT THE ONLY SPELLING: `open()` below names the channel in a `listen` statement, and
 *  `migrations/003_console_live.sql` names it in the `pg_notify` every writer calls. The statement cannot be
 *  built from this constant — see the note on it in `open()` — so nothing holds the three together, and the
 *  day they drift the listener listens for something nobody sends: the console stops going live, with no
 *  error anywhere. Editing one of the three is editing all three. */
const CONSOLE_CHANGE_CHANNEL = "zz_console_change";

/** The collections a tab may follow: the console's reads, by their first path segment. */
const COLLECTIONS = [
  "me", "overview", "teams", "initiatives", "document", "knowledge", "plugins", "skills",
  "people", "runs", "activity", "settings",
] as const;

const MAX_NAMES = 50;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The most hints waiting behind the authorization check; past that they collapse into one resync of every name. */
const MAX_QUEUED = 100;
const HEARTBEAT_MS = 15_000;

/** One change out of the database: which team's business it is (empty when nobody's) and which collection it changed. */
type Change = { t: string; c: string };

type Subscriber = {
  /** The request the stream was opened on, kept so every frame can ask the session again. */
  req: Request;
  /** The team slugs this caller may see, or null for a platform-scoped one, which sees every team. */
  teams: string[] | null;
  names: string[];
  queue: Change[];
  /** Set when the queue overflowed: the next frame is one resync of every name instead of the queue. */
  overflowed: boolean;
  draining: boolean;
  closed: boolean;
  write: (frame: string) => void;
  close: () => void;
};

const subscribers = new Set<Subscriber>();

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const resyncOf = (names: string[]) => frame("resync", { collections: names });

/** 400 for a list that is empty or malformed, 403 for a name with no read behind it — one body for unknown and forbidden alike. */
function parseNames(raw: string | null): { names: string[] } | { status: number; error: string } {
  const parts = raw ? raw.split(",") : [];
  if (parts.length === 0 || !parts.every((n) => NAME.test(n))) return { status: 400, error: "Name the collections to follow." };
  const names = [...new Set(parts)];
  if (names.length > MAX_NAMES) return { status: 400, error: "Name the collections to follow." };
  if (!names.every((n) => (COLLECTIONS as readonly string[]).includes(n))) return { status: 403, error: "You do not have access to that." };
  return { names };
}

/** One change from the database, or null for a payload this cannot read. */
function parseChange(payload: string | undefined): Change | null {
  if (!payload) return null;
  try {
    const { t, c } = JSON.parse(payload) as { t?: unknown; c?: unknown };
    return typeof t === "string" && typeof c === "string" ? { t, c } : null;
  } catch {
    return null;
  }
}

/**
 * May this caller still be told? Asked immediately before each frame goes out, never at open time.
 *
 * The session first, so a revoked one ends the stream; then the same console-wide admission the route made; then the
 * team, because what a person may see can narrow — leaving a team is a change to what they may be told, not only to
 * what they may read.
 */
async function stillAllowed(s: Subscriber, change: Change): Promise<boolean> {
  const now = await browserSession(s.req).catch(() => null);
  if (!now || !mayReadConsole(now)) return false;
  if (change.t === "") return true;
  return s.teams === null || now.teams.some((t) => t.slug === change.t);
}

/**
 * Send what is waiting, one frame at a time, each behind its own authorization check.
 *
 * One at a time matters: the check is asynchronous, so two frames resolved at once could go out in the order the
 * database happened to answer rather than the order they changed in, and it is the queue that keeps them in order.
 */
async function drain(s: Subscriber): Promise<void> {
  if (s.draining || s.closed) return;
  s.draining = true;
  try {
    while (!s.closed && (s.overflowed || s.queue.length > 0)) {
      const overflowing = s.overflowed;
      const change = overflowing ? { t: "", c: s.names[0] ?? "" } : s.queue[0]!;
      const allowed = await stillAllowed(s, change);
      if (s.closed) return;
      if (!allowed) { s.close(); return; }
      if (overflowing) { s.overflowed = false; s.queue = []; s.write(resyncOf(s.names)); }
      else { s.queue.shift(); s.write(frame("change", { collection: change.c })); }
    }
  } finally {
    s.draining = false;
  }
}

/** Queue one change for a subscriber, collapsing the queue into a resync if it has grown past its bound. */
function enqueue(s: Subscriber, change: Change): void {
  if (s.closed || s.overflowed) return;
  if (s.queue.length >= MAX_QUEUED) { s.queue = []; s.overflowed = true; }
  else if (!s.queue.some((q) => q.c === change.c && q.t === change.t)) s.queue.push(change);
  void drain(s);
}

/** Every tab reads again: a hint raised while nobody was listening is gone, and a hint is cheap. */
function resyncEveryTab(): void {
  for (const s of [...subscribers]) {
    if (s.closed) continue;
    s.queue = [];
    s.overflowed = true;
    void drain(s);
  }
}

/** A committed change: the tabs that follow that collection, in the teams that may see it. */
function deliver(change: Change): void {
  for (const s of [...subscribers]) {
    if (!s.names.includes(change.c)) continue;
    if (change.t !== "" && s.teams !== null && !s.teams.includes(change.t)) continue;
    enqueue(s, change);
  }
}

/* The process's one LISTEN connection. Every subscriber shares it; a second client would leak and duplicate hints. */
let listener: pg.Client | undefined;
let opening: Promise<void> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

function lost(client: pg.Client): void {
  if (listener === client) listener = undefined;
  client.removeAllListeners();
  client.on("error", () => {});
  void client.end().catch(() => {});
  schedule();
}

/** Bounded backoff: half a second, doubling, never more than thirty. */
function schedule(): void {
  if (retry || listener || subscribers.size === 0) return;
  retry = setTimeout(() => { retry = undefined; connect(); }, Math.min(30_000, 500 * 2 ** attempt++));
}

function connect(): void {
  if (listener || opening || subscribers.size === 0) return;
  const url = platformDbUrl();
  if (!url) return;
  opening = open(url).finally(() => { opening = undefined; });
}

async function open(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, options: "-csearch_path=zz,public" });
  client.on("error", () => lost(client));
  client.on("end", () => lost(client));
  client.on("notification", (message) => {
    if (message.channel !== CONSOLE_CHANGE_CHANNEL) return;
    const change = parseChange(message.payload);
    // A payload the listener cannot read is one it cannot route, so every tab reads again rather than none of them.
    if (change) deliver(change);
    else resyncEveryTab();
  });
  try {
    await client.connect();
    // COUPLED: `CONSOLE_CHANGE_CHANNEL` above, and the `pg_notify` in `migrations/003_console_live.sql`.
    //
    // Spelled out rather than interpolated. `check:sql` hands every statement this repository sends to
    // Postgres, and a `listen` is not one PREPARE will hold — so a bare literal is excluded from the set it
    // prepares and NAMED in its skip list, with that reason, which is a fact a reader can act on. A hole is
    // not the same thing: `${...}` cannot be read as one statement at all, so the whole statement drops out
    // of the scan with nothing said, and the gate's literal rule refuses this file for exactly that.
    //
    // DELIBERATE: the scanner reads comments as well as code, so the name of the call it looks for is
    // never written in prose here. Spelled out in a comment it is read as a call site, and the failure it
    // reports lands on the comment rather than on any statement. `sql-check.ts` carries the same warning.
    await client.query("listen zz_console_change");
  } catch {
    lost(client);
    return;
  }
  if (subscribers.size === 0) { void client.end().catch(() => {}); return; }
  listener = client;
  attempt = 0;
  // A notification sent while no connection was listening is gone: every subscriber reads again.
  resyncEveryTab();
}

function stopListening(): void {
  clearTimeout(retry);
  retry = undefined;
  const client = listener;
  listener = undefined;
  if (!client) return;
  client.removeAllListeners();
  client.on("error", () => {});
  void client.end().catch(() => {});
}

/** Hold `res` open as one tab's stream, with the admission check already made. */
function serve(req: Request, res: Response, names: string[], teams: string[] | null): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.flushHeaders();

  let timer: ReturnType<typeof setInterval>;
  const s: Subscriber = {
    req,
    teams,
    names,
    queue: [],
    overflowed: false,
    draining: false,
    closed: false,
    write: (f) => { if (!s.closed) res.write(f); },
    close: () => {
      if (s.closed) return;
      s.closed = true;
      clearInterval(timer);
      subscribers.delete(s);
      res.end();
      // The last tab leaving closes the connection, so a console nobody is looking at holds none open.
      if (subscribers.size === 0) stopListening();
    },
  };

  // A heartbeat is transport time and never proof that anything was fetched, so it stands in for nothing: it goes out
  // whether or not the session still resolves, and the next real frame is what asks.
  timer = setInterval(() => s.write(`: beat ${Date.now()}\n\n`), HEARTBEAT_MS);

  res.on("close", s.close);
  subscribers.add(s);
  connect();
  s.write("retry: 3000\n\n");
  s.write(resyncOf(names));
}

/** The team slugs a scope sees, or null when it sees every team. */
function teamsOf(scope: Exclude<ReturnType<typeof resolveScope>, { kind: "refused" }>): string[] | null {
  return scope.kind === "platform" ? null : [scope.slug];
}

/**
 * `GET /api/console/live?collections=…` — change hints for the collections the caller may read.
 *
 * Mounted inside `mountConsole`, so `identityMiddleware` has already resolved `req.zzIdentity` for the admission check;
 * every frame after that one asks again for itself.
 */
export function mountConsoleLive(app: Express): void {
  app.get("/api/console/live", async (req: Request, res: Response) => {
    if (!platformDbReady()) { res.status(503).type("text/plain").send("platform database unavailable"); return; }
    const id = req.zzIdentity;
    if (!id) { res.status(401).type("text/plain").send("Sign in to continue."); return; }
    if (!mayReadConsole(id)) { res.status(403).type("text/plain").send("You do not have access to that."); return; }

    const parsed = parseNames(typeof req.query.collections === "string" ? req.query.collections : null);
    if ("status" in parsed) { res.status(parsed.status).type("text/plain").send(parsed.error); return; }

    // The scope decides which teams' changes this tab may be told about: a superadmin who asked for the platform hears
    // every team, anyone else hears their own.
    const scope = resolveScope(id, req);
    if (scope.kind === "refused") { res.status(scope.status).type("text/plain").send(scope.error); return; }
    serve(req, res, parsed.names, teamsOf(scope));
  });
}
