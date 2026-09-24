/**
 * /api/console/documents/thread — the discussion thread on one document.
 *
 * DELIBERATE: this file writes `zz.discussion_message` directly and never calls zz-core, in
 * either direction. There is no zz-core tool for saying something about a document, and one
 * would turn a team's back-and-forth about a spec into `zz.event` rows for acts the platform
 * did not perform. The table is gateway-owned and not evidence: nothing downstream treats a
 * thread message as a decision or a document.
 *
 * GET and POST both resolve through `handler()` (console/shared.ts), the same scope and
 * directory-or-superadmin gate as every other console route. Both refuse a `platform` scope:
 * a thread is one team's conversation about one document. `resolveScope` is what makes a
 * non-member's request fail before this file's code runs, so there is no membership check
 * here.
 *
 * `seq` is a database guarantee, not an application convention. The
 * insert reads "one more than the current max for this thread" and writes the row in the
 * same statement, an `insert … select` with the max as a correlated subquery, so nothing can
 * run between the read and the write on this connection. Two concurrent connections can
 * still compute the same next seq before either commits, and the unique constraint turns
 * that into a unique-violation on the loser. The route retries once, which recomputes the
 * max, and turns only a second unique-violation into a 409.
 *
 * Append-only: no PUT, no DELETE, and nothing below updates a row once written.
 *
 * The author is a name and an email, never a principal id. GET joins `zz.principal` for
 * `display_name`/`email`; POST takes both off `req.zzIdentity` and never re-reads the row it
 * just wrote. The `author` field is shaped the same way in both, so the console's thread view
 * has one rendering path.
 *
 * COUPLED: `via: "web"` is stated by the write rather than inherited, and the gate's
 * "every console write route records the door it came through" check reads it back.
 */
import { EventEmitter } from "node:events";

import type { Express, Request, Response } from "express";
import type pg from "pg";

import { handler, type ResolvedScope } from "./console/shared.js";
import { platformDb } from "./db.js";
import { logEvent } from "./events.js";

const UNIQUE_VIOLATION = "23505";

/** A thread message, shaped identically wherever it appears — GET's `messages[]`, POST's own
 * reply, and every event the stream below sends.
 *
 * Exported for console-write.ts's `revise` route, which reads the same rows through
 * `fetchMessages` below rather than a query of its own. */
export type ThreadMessage = {
  seq: number;
  author: { name: string; email: string };
  body: string;
  created_at: string;
};

/** The live-delivery bus, single-process and per-container. A second replica would hold its
 * own copy, so a message posted to one would never reach a subscriber streaming from the
 * other, with no error on either side. A client is made whole by the database, not by this
 * bus: it must keep its last-seen `seq` and reconnect with `after=<seq>` after any
 * disconnection rather than trusting a stream to be complete.
 *
 * The event name is the thread key, not one shared event every handler filters. Node counts
 * listeners per event name, so `setMaxListeners` below is headroom for how many browsers
 * hold the same document's stream open, not a blanket suppression — a stream whose cleanup
 * never ran still warns. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

/** One thread, one event name. DELIBERATE: `JSON.stringify` rather than joining with a
 * delimiter — an initiative slug or a doc path can contain "/" or ":", so a delimiter that
 * can appear inside a field lets two different threads share a key. */
function threadKey(team: string, initiative: string, path: string): string {
  return JSON.stringify([team, initiative, path]);
}

function toMessage(r: { seq: number; author_name: string; author_email: string; body: string; created_at: string }): ThreadMessage {
  return { seq: r.seq, author: { name: r.author_name, email: r.author_email }, body: r.body, created_at: r.created_at };
}

/** GET's two-literal query, shared by the GET route and by the stream's replay. Exported for
 * console-write.ts's `revise` route. */
export async function fetchMessages(db: pg.Pool, team: string, initiative: string, path: string, after: number | undefined): Promise<ThreadMessage[]> {
  // DELIBERATE: two complete statements, not one assembled from whether `after` was passed.
  // `check:sql` PREPAREs every query in this file against a live schema before release, and
  // a predicate built from a runtime expression is invisible to it.
  const result = after === undefined
    ? await db.query(
      `select m.seq, p.display_name as author_name, p.email as author_email, m.body,
              to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
         from zz.discussion_message m
         join zz.principal p on p.id = m.principal_id
        where m.team_slug = $1 and m.initiative = $2 and m.doc_path = $3
        order by m.seq`,
      [team, initiative, path])
    : await db.query(
      `select m.seq, p.display_name as author_name, p.email as author_email, m.body,
              to_char(m.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
         from zz.discussion_message m
         join zz.principal p on p.id = m.principal_id
        where m.team_slug = $1 and m.initiative = $2 and m.doc_path = $3 and m.seq > $4
        order by m.seq`,
      [team, initiative, path, after]);
  return result.rows.map(toMessage);
}

function sendEvent(res: Response, msg: ThreadMessage): void {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

/** `{ kind: "platform" }` is the only non-`team` scope `resolveScope` can hand back, and a
 *  thread has no fleet-wide reading, so every route below refuses it. */
function refusePlatformScope(res: Response): void {
  res.status(400).json({ error: "a thread belongs to one team — pass ?team=<slug>, not ?scope=platform" });
}

export function mountDiscussion(app: Express): void {
  app.get("/api/console/documents/thread", handler("the thread", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") { refusePlatformScope(res); return; }
    const { initiative, path } = req.query as Record<string, string | undefined>;
    if (!initiative || !path) {
      res.status(400).json({ error: "initiative and path required" });
      return;
    }
    const afterRaw = req.query.after as string | undefined;
    let after: number | undefined;
    if (afterRaw !== undefined) {
      after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        res.status(400).json({ error: "after must be a non-negative integer" });
        return;
      }
    }
    const db = platformDb();
    const messages = await fetchMessages(db, scope.slug, initiative, path, after);
    res.json({ messages });
  }));

  // Live delivery. The scope refusal and the required-params check both run before a byte of
  // the stream opens, so a refused caller never sees a 200 it cannot use.
  app.get("/api/console/documents/thread/stream", handler("the thread stream", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") { refusePlatformScope(res); return; }
    const { initiative, path } = req.query as Record<string, string | undefined>;
    if (!initiative || !path) {
      res.status(400).json({ error: "initiative and path required" });
      return;
    }
    const afterRaw = req.query.after as string | undefined;
    let after: number | undefined;
    if (afterRaw !== undefined) {
      after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        res.status(400).json({ error: "after must be a non-negative integer" });
        return;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Caddy's `flush_interval -1` on `handle /api/console/*` is what stops a buffering proxy
    // holding this open; this header covers anything else that fronts the route.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    // Sent before anything else: a stream that stays silent until the first real message
    // is indistinguishable, from the browser's side, from one that never connected.
    res.write(": connected\n\n");

    // Heartbeat starts now, not after the replay below — a slow replay query is exactly
    // the kind of idle gap a proxy or a browser could time out on.
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);

    const key = threadKey(scope.slug, initiative, path);
    // While `live` is false, a message the bus delivers is queued instead of written — see
    // the race this closes, below.
    let live = false;
    const queued: ThreadMessage[] = [];
    const onMessage = (msg: ThreadMessage): void => {
      if (live) sendEvent(res, msg);
      else queued.push(msg);
    };
    // DELIBERATE: subscribe before the replay query runs. A message posted between reading
    // the database and starting to listen would otherwise vanish for this connection until
    // the next reconnect. Subscribing first captures every message from this instant on,
    // queued or sent directly once `live` flips true; double-sending is prevented by seq —
    // replay sends every row up to `lastSeq`, then the queue is drained skipping anything at
    // or below it.
    bus.on(key, onMessage);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      bus.off(key, onMessage);
    };
    // Removes the listener and clears the heartbeat on navigation, tab close, or a dropped
    // connection. Idempotent: also called from the catch below, and Node tolerates clearing
    // an interval or removing a listener a second time.
    req.on("close", cleanup);

    try {
      const db = platformDb();
      const messages = await fetchMessages(db, scope.slug, initiative, path, after);
      let lastSeq = after ?? 0;
      for (const msg of messages) {
        sendEvent(res, msg);
        lastSeq = msg.seq;
      }
      for (const msg of queued) {
        if (msg.seq > lastSeq) { sendEvent(res, msg); lastSeq = msg.seq; }
      }
      queued.length = 0;
      live = true;
    } catch (err) {
      console.error("thread stream replay failed:", err);
      cleanup();
      res.end();
    }
  }));

  app.post("/api/console/documents/thread", handler("post to the thread", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") { refusePlatformScope(res); return; }
    const { initiative, path, body } = (req.body ?? {}) as Record<string, string>;
    if (!initiative || !path || !body) {
      res.status(400).json({ error: "initiative, path and body required" });
      return;
    }
    const identity = req.zzIdentity!;
    const db = platformDb();
    // `seq` is read and written in the same statement, so the only thing that can make this
    // fail is a concurrent append landing between this connection's read and its commit,
    // which the unique constraint turns into a unique-violation. `insertOnce` is called up
    // to twice and never assembled differently between calls, so `check:sql` can PREPARE it
    // exactly as it runs.
    const insertOnce = () => db.query(
      `insert into zz.discussion_message (team_slug, initiative, doc_path, seq, principal_id, body)
       select $1, $2, $3,
              coalesce(
                (select max(seq) from zz.discussion_message
                  where team_slug = $1 and initiative = $2 and doc_path = $3),
                0) + 1,
              (select id from zz.principal where email = $4),
              $5
       returning seq,
                 to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`,
      [scope.slug, initiative, path, identity.email, body]);
    let result;
    try {
      result = await insertOnce();
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      // DELIBERATE: one retry, not a loop. Losing the race twice in a row becomes a 409
      // rather than spinning on a thread with real contention.
      try {
        result = await insertOnce();
      } catch (err2) {
        if ((err2 as { code?: string }).code !== UNIQUE_VIOLATION) throw err2;
        res.status(409).json({ error: "seq collided twice — try posting again" });
        return;
      }
    }
    const row = result.rows[0] as { seq: number; created_at: string };
    // Written after the act succeeds, never before. COUPLED: the gate's door check reads the
    // literal `via: "web"` out of this route body.
    logEvent({
      actor: identity.email, teamSlug: scope.slug, kind: "discussion.append",
      subject: `${initiative}/${path}`, detail: { via: "web" },
    });
    // Same shape as GET's `messages[]`, and the author is the caller's own identity rather
    // than a re-read of the row just written.
    const message: ThreadMessage = {
      seq: row.seq, author: { name: identity.displayName, email: identity.email },
      body, created_at: row.created_at,
    };
    // DELIBERATE: published after the insert commits. A publish before it lands could tell a
    // subscriber about a `seq` that the retry above then reassigns to a different row; a
    // subscriber that misses this event still finds the row with `after=<seq>`.
    bus.emit(threadKey(scope.slug, initiative, path), message);
    res.json({ messages: [message] });
  }));
}
