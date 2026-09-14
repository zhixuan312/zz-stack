/**
 * /api/console/documents/thread — the discussion thread on one document.
 *
 * Not console-write.ts's shape. `document_approve()` there forwards a caller's headers to zz-core
 * and stamps a platform document because approval IS a flow-side act with a flow-side
 * author. A thread has no such counterpart: there is no zz-core tool called "say something
 * about this document", and inventing one would make every team's back-and-forth about a
 * spec into a `zz.event` row when it is not an act the platform performed. So THIS FILE
 * WRITES ITS OWN TABLE DIRECTLY — `zz.discussion_message` (migration 039) — and zz-core is
 * never called, in either direction.
 *
 * GET and POST both resolve through `handler()` (console.ts), the same scope and the same
 * directory-or-superadmin gate as every other console route. Both refuse a `platform` scope:
 * a thread is always one team's conversation about one document, and there is no
 * fleet-wide reading of it for `?scope=platform` to mean — the same refusal
 * console-write.ts's `document_approve` gives for the same reason. `resolveScope` refusing a caller
 * who names or defaults to a team they are not in is what makes a non-member's request
 * fail before this file's code runs at all; there is no second membership check here to
 * forget.
 *
 * SEQ IS A DATABASE GUARANTEE, not an application convention — see migration 039's header.
 * The insert below reads "one more than the current max for this thread" and writes the row
 * in the SAME statement, an `insert … select` with the max as a correlated subquery, so
 * nothing can run between the read and the write on THIS connection. Two concurrent
 * connections can still both compute the same next seq before either commits; the unique
 * constraint is what turns that race into a unique-violation on the loser rather than a
 * silently duplicated position in the thread. The route retries the insert exactly once —
 * which recomputes the max and so picks the next free seq — and only turns a SECOND
 * unique-violation into a 409, on the theory that a thread with real contention losing a
 * coin-flip twice in a row is worth surfacing to the caller rather than retrying forever.
 *
 * APPEND-ONLY: no PUT, no DELETE, and nothing below updates a row once written. A thread is
 * what was said and when, not a document to revise.
 *
 * AUTHOR IS A NAME AND AN EMAIL, NEVER A PRINCIPAL ID. GET joins `zz.discussion_message` to
 * `zz.principal` and selects `display_name`/`email`; POST already has both off the caller's
 * own identity (`req.zzIdentity`) and never re-reads the row it just wrote to get them. The
 * `author` field is shaped the same way in both responses so the console's thread view has
 * one rendering path for a message, however it arrived.
 *
 * `via: "web"` is logged explicitly on the write, same as every other console act — see
 * console-write.ts's own header for why that is stated by the route and not inherited, and
 * scripts/gate.ts's "every console write route records the door it came through" for what
 * enforces it. This table is gateway-owned and not yet evidence: nothing downstream treats
 * a thread message as a decision or a document, and that is why it lives here rather than
 * in `zz.doc`.
 */
import { EventEmitter } from "node:events";

import type { Express, Request, Response } from "express";
import type pg from "pg";

import { handler, type ResolvedScope } from "./console/shared.js";
import { platformDb } from "./db.js";
import { logEvent } from "./events.js";

const UNIQUE_VIOLATION = "23505";

/** A thread message, shaped identically wherever it appears — GET's `messages[]`, POST's
 * own reply, and every event the stream below sends. One type, so nothing downstream needs
 * a second rendering path for a message that arrived live versus one that was fetched.
 *
 * Exported for console-write.ts's `revise` route (Task I-23): that route reads the SAME
 * rows this file does — the discussion is the source a revision is authored from — and it
 * reuses `fetchMessages` below rather than writing a third query for them. */
export type ThreadMessage = {
  seq: number;
  author: { name: string; email: string };
  body: string;
  created_at: string;
};

/** THE LIVE-DELIVERY BUS — a plain `node:events` EventEmitter, module-level, no dependency.
 *
 * SINGLE-PROCESS AND PER-CONTAINER. This deployment runs exactly one `cred-proxy`
 * container; a second replica would give each of its own copy of this bus, so a message
 * posted to the replica handling the POST would never reach a subscriber whose GET stream
 * landed on the other one — silently, with no error on either side. That is only survivable
 * because of FR-20's `after=<seq>` cursor (see the GET route above): a client that keeps its
 * own last-seen `seq` and reconnects with `after=<seq>` after ANY disconnection — a replica
 * failover, a deploy, a laptop sleeping — is made whole by the database, not by the bus. A
 * client MUST reconnect with its last seq rather than trusting a stream to be complete; the
 * bus only carries what a live process happens to see, and this file makes no claim beyond
 * that.
 *
 * EVENT NAME IS THE THREAD KEY, not a single shared event that every handler filters. That
 * choice is also what keeps this emitter's default max-listeners warning meaningless here:
 * Node counts listeners per event name, so the number that matters is how many browsers hold
 * the SAME document's stream open at once — a handful, in the worst case a busy review — not
 * how many documents exist across the whole platform. `setMaxListeners` below is generous
 * headroom for that one-document case, not a blanket suppression: a genuine leak (a stream
 * whose cleanup never ran) still warns instead of growing silently forever. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

/** One thread, one event name. `JSON.stringify` rather than joining with a delimiter: an
 * initiative slug or a doc path can itself contain "/" or ":", and a delimiter that can also
 * appear inside a field is how two different threads end up sharing a key. */
function threadKey(team: string, initiative: string, path: string): string {
  return JSON.stringify([team, initiative, path]);
}

function toMessage(r: { seq: number; author_name: string; author_email: string; body: string; created_at: string }): ThreadMessage {
  return { seq: r.seq, author: { name: r.author_name, email: r.author_email }, body: r.body, created_at: r.created_at };
}

/** One place that runs GET's two-literal query — shared by the GET route and by the
 * stream's replay, so the "two complete statements" rule (see below) is written once,
 * not copied a second time for the stream to drift from. Exported for the same reason
 * `ThreadMessage` is — see that type's own comment. */
export async function fetchMessages(db: pg.Pool, team: string, initiative: string, path: string, after: number | undefined): Promise<ThreadMessage[]> {
  // TWO COMPLETE STATEMENTS, not one assembled from whether `after` was passed:
  // `check:sql` PREPAREs every query in this file against a live schema before release,
  // and a predicate built from a runtime expression is invisible to it — see console.ts's
  // own "two complete statements" queries for the 0.4.0 release this discipline exists to
  // catch. Both branches are spelled out in full below.
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

/** `{ kind: "platform" }` is the only non-`team` scope `resolveScope` can hand back — a
 *  thread has no fleet-wide reading, so both routes below refuse it the same way
 *  `console-write.ts`'s `document_approve` refuses it for a document. */
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

  // Live delivery (← AC-6). Same scope refusal, same required-params check, as GET above —
  // both run and can still answer before a byte of the stream opens, so a refused caller
  // never sees a 200 it cannot use.
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
    // Harmless with Caddy — flush_interval -1 on both hosts' `handle /api/console/*` is
    // what actually stops a buffering proxy holding this open, and that lives in the proxy
    // config, not here. Correct anyway, in case anything else ever fronts this route.
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
    // SUBSCRIBE BEFORE THE REPLAY QUERY RUNS. This is the one genuinely hard part of this
    // route: a message posted between "read the database" and "start listening" would
    // otherwise vanish for this connection until the next reconnect. Subscribing first
    // means every message posted from this instant on is captured — either by this
    // listener (queued) or, once `live` flips true, sent directly — so the only remaining
    // work is not double-sending one a slow replay query also happened to select. That is
    // solved by seq alone: replay sends every row up to `lastSeq`, then the queue is
    // drained in order, skipping anything at or below `lastSeq`, because a message the
    // query already returned cannot also need re-sending from the queue.
    bus.on(key, onMessage);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      bus.off(key, onMessage);
    };
    // Removes the listener and clears the heartbeat on navigation, tab close, or a dropped
    // connection — without this, the process leaks one subscriber per client that ever
    // left. Idempotent: also called from the catch below, and Node tolerates clearing an
    // interval or removing a listener a second time.
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
    // `seq` is read and written in the SAME statement — see this file's header and
    // migration 039's — so the only thing that can make this fail is a genuinely
    // concurrent append landing between this connection's read and its commit, which the
    // unique constraint turns into a unique-violation rather than a silently duplicated
    // seq. `insertOnce` is called up to twice, never assembled differently between calls:
    // one literal statement, so `check:sql` can PREPARE it exactly as it runs.
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
      // ONE RETRY, not a loop: a second connection winning the same race once is ordinary
      // contention and worth absorbing silently; losing twice in a row is worth surfacing
      // to the caller as a 409 rather than spinning forever on a thread with more going on
      // than a couple of people typing.
      try {
        result = await insertOnce();
      } catch (err2) {
        if ((err2 as { code?: string }).code !== UNIQUE_VIOLATION) throw err2;
        res.status(409).json({ error: "seq collided twice — try posting again" });
        return;
      }
    }
    const row = result.rows[0] as { seq: number; created_at: string };
    // Written after the act succeeds, never before, and `via: "web"` is stated explicitly
    // here — see console-write.ts's own header on why a write names its door itself rather
    // than inheriting one, and scripts/gate.ts's door check for what enforces it.
    logEvent({
      actor: identity.email, teamSlug: scope.slug, kind: "discussion.append",
      subject: `${initiative}/${path}`, detail: { via: "web" },
    });
    // Same shape as GET's `messages[]` — the console's thread view renders a message the
    // same way whether it just arrived in this response or came back from a later read,
    // and the author is the caller's OWN identity, never a re-read of the row just written.
    const message: ThreadMessage = {
      seq: row.seq, author: { name: identity.displayName, email: identity.email },
      body, created_at: row.created_at,
    };
    // Published AFTER the insert commits, never before — a subscriber that reconnects
    // instead of receiving this event still finds the row with `after=<seq>`, but a
    // publish before the insert lands could tell a subscriber about a `seq` a concurrent
    // retry (above) then reassigns to a different row.
    bus.emit(threadKey(scope.slug, initiative, path), message);
    res.json({ messages: [message] });
  }));
}
