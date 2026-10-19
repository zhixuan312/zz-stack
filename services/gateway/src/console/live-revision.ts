/**
 * The revision of a console collection: what lets a page's first live stream ask whether anything moved since the
 * console's server read the page, instead of reading every collection again (ZZ Meridian 0.18.0's `since`, the
 * console's `src/lib/live.ts`).
 *
 * A revision is `<boot>:<n>`. The boot names the stream's current `LISTEN` connection (`live.ts`), and changes every
 * time it connects, because a hint raised while nothing listened is gone and no count can say what it was. The count
 * is the number of changes to that collection this caller's stream would have been told of since the boot: the same
 * team filter `deliver` applies, so a change in a team the caller may not see moves nobody's revision but the
 * superadmin's, and the number names no team and counts no other team's changes for anybody else.
 *
 * Every console read is answered with its collection's revision in `REVISION_HEADER`, sampled when the request arrives,
 * before the route's query runs: a change committed while the read runs moves the count past what the read was handed,
 * so the stream resyncs it rather than calling a read that may have missed it `synced`. A read while nothing listens
 * carries no revision, and a stream asked with one from another boot, or while nothing listens, resyncs every name.
 *
 * The counts are this process's own and are held in memory: a second gateway process has its own boot, so a revision
 * one served is resynced by the other, never mistaken for its own.
 */
import { randomBytes } from "node:crypto";

import type { Express, Request } from "express";

import { isSuper, type Identity } from "../identity.js";
import { resolveScope } from "../scope.js";
import { mayReadConsole } from "./shared.js";

/** The collections a tab may follow: the console's reads, by their first path segment. */
export const COLLECTIONS = [
  "me", "teams", "initiatives", "document", "knowledge", "plugins", "skills",
  "people", "runs", "activity", "settings",
] as const;

/** One change out of the database: which team's business it is (empty when nobody's) and which collection it changed. */
export type Change = { t: string; c: string };

/**
 * The header a console read's revision travels in, as `<collection>:<boot>:<n>`: the pair the stream's `since` takes
 * back, so the console's server keeps it as it came and never works out which collection a path belongs to.
 *
 * COUPLED: the console's `src/data/gateway.ts` reads it, and `checks/console-live-since.ts` names it.
 */
const REVISION_HEADER = "x-zz-revision";

/** The reads whose collection is another's, as the console's `src/views/console-live.tsx` keeps them: Approvals is read
 *  from the documents' revisions, which a change names `initiatives`, and Access is the caller's own, named `settings`. */
const KEPT_UNDER: Record<string, string> = { approvals: "initiatives", access: "settings" };

const REVISION = /^[A-Za-z0-9_-]+:\d+$/;

/** One collection's changes since the boot: those that were nobody's team business, those of each team, and all. */
type Tally = { nobody: number; byTeam: Map<string, number>; all: number };

let boot: string | null = null;
let tallies = new Map<string, Tally>();
/** Payloads the listener could not read. Every tab was resynced for each, so each moves every revision. */
let unread = 0;

/** The `LISTEN` connection is up: a new boot, counted from nothing. */
export function listening(): void {
  boot = randomBytes(6).toString("base64url");
  tallies = new Map();
  unread = 0;
}

/** The `LISTEN` connection is down: no revision until it is up again. */
export function notListening(): void {
  boot = null;
  tallies = new Map();
  unread = 0;
}

/** Count one notification, or one the listener could not read (`null`). Nothing counts while nothing listens. */
export function count(change: Change | null): void {
  if (boot === null) return;
  if (!change) { unread++; return; }
  const tally = tallies.get(change.c) ?? { nobody: 0, byTeam: new Map<string, number>(), all: 0 };
  tallies.set(change.c, tally);
  tally.all++;
  if (change.t === "") tally.nobody++;
  else tally.byTeam.set(change.t, (tally.byTeam.get(change.t) ?? 0) + 1);
}

/** `collection`'s revision for a caller who hears `teams` (null for every team), or null while nothing listens. */
function heardRevision(collection: string, teams: string[] | null): string | null {
  if (boot === null) return null;
  const tally = tallies.get(collection);
  const n = !tally ? 0 : teams === null ? tally.all : tally.nobody + teams.reduce((sum, t) => sum + (tally.byTeam.get(t) ?? 0), 0);
  return `${boot}:${unread + n}`;
}

/**
 * The names a stream's greeting resyncs: every one of `names` whose revision in `since` is not the one the caller holds
 * now. No `since` resyncs them all, as every stream's greeting did before revisions; a pair that is not
 * `<name>:<boot>:<n>` is ignored, which resyncs its name, and a pair for a name the stream does not follow is ignored.
 */
export function movedSince(names: string[], since: string | null, teams: string[] | null): string[] {
  if (since === null) return names;
  const served = new Map<string, string>();
  for (const pair of since.split(",")) {
    const at = pair.indexOf(":");
    const name = pair.slice(0, at);
    const revision = pair.slice(at + 1);
    if (at > 0 && REVISION.test(revision) && !served.has(name)) served.set(name, revision);
  }
  return names.filter((n) => served.get(n) === undefined || served.get(n) !== heardRevision(n, teams));
}

/**
 * The teams whose changes a caller hears, for their stream and for every revision they are handed alike, or the
 * refusal the stream answers.
 *
 * A superadmin hears every team, whatever the request names: their console is the whole platform (the console's
 * reconciliation 76), and every read of theirs asks for it. Anyone else hears the team their scope resolves to, the
 * one they act for.
 */
export function heardBy(id: Identity, req: Request): { teams: string[] | null } | { status: number; error: string } {
  if (isSuper(id)) return { teams: null };
  const scope = resolveScope(id, req);
  if (scope.kind === "refused") return { status: scope.status, error: scope.error };
  return { teams: scope.kind === "team" ? [scope.slug] : null };
}

/**
 * Every console read answered with its collection's revision: mounted first in `mountConsole`, before any read, so
 * the revision is the one the read began at. A path whose first segment names no collection a tab may follow (the
 * stream itself, the search, the platform's reads) carries none, and neither does a caller the console does not admit.
 */
export function mountConsoleRevision(app: Express): void {
  app.use("/api/console", (req, res, next) => {
    if (req.method === "GET" && req.zzIdentity && mayReadConsole(req.zzIdentity)) {
      const head = req.path.split("/").filter(Boolean)[0] ?? "";
      const collection = KEPT_UNDER[head] ?? head;
      const heard = (COLLECTIONS as readonly string[]).includes(collection) ? heardBy(req.zzIdentity, req) : null;
      const revision = heard && "teams" in heard ? heardRevision(collection, heard.teams) : null;
      if (revision) res.setHeader(REVISION_HEADER, `${collection}:${revision}`);
    }
    next();
  });
}
