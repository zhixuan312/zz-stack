/**
 * The envelope every console answer carries: when this request was served, the change marker it could
 * hear, and whether the answer had already been computed.
 *
 * One middleware, mounted in `mountConsole` in front of every read, so no route composes these three
 * itself. A route states what its figures are (`asOf`, `builtAt`, `sourceRevision` and the six fields
 * `ReadMeta` has carried) and this file states what is true of the request that asked for them. The
 * split is the whole point: `asOf` belongs to the computation and survives a cache hit, while
 * `observedAt` is this request's and must not. Two routes that each took their own instant drifted the
 * moment one of them kept an answer, which is the defect this replaces.
 *
 * The body is a FRESH object per request. `answer-cache.ts` keeps one computation and serves it to every
 * caller inside one data version, so writing an envelope into it would show the first caller's
 * `observedAt` on the second one's answer. Nothing here touches the object it was handed.
 *
 * The table below is the marker half. `revision` is the composite of the collections an answer really
 * reads, folded by `revisionAcross` — never `dataVersion()`, which is one global count over every team:
 * another team's change would move this caller's marker, and a boot counter cannot be persisted. The
 * names are derived from each route's own statements (`from`/`join` lists) rather than from its path,
 * because a path is not a collection any tab follows. Which collection a table's change is told under is
 * `003_console_live.sql`'s and `005_page_view_no_hint.sql`'s answer: `zz.event` raises `activity` and
 * `runs`, `zz.doc` raises `document` and `initiatives`, `zz.membership` and `zz.team` raise `teams`,
 * `people` and `settings`, `zz.principal` raises `people`, `zz.initiative` raises `initiatives`,
 * `zz.knowledge_node` raises `knowledge`. Three collections are followed and raised by nothing —
 * `plugins`, `skills` and `me` — so an answer that reads `zz.plugin` or `zz.skill` names them anyway: it
 * costs no resync because no hint exists to resync it, and leaving them out would be a lie about what
 * moved. `zz.release`, `zz.schema_migration`, `zz.bug`, `zz.model_call` and the `zz.eval_*` family are
 * the same case in reverse: nothing raises a hint for them, so an answer built on one names the watched
 * collections it also reads and no more. A route that reads a table no trigger watches therefore goes
 * stale until the minute in `answer-cache.ts` expires; `ARCHITECTURE.md` collects those answer classes.
 *
 * DELIBERATE: naming an extra collection costs a tab one read it did not need, and omitting one costs it
 * freshness. Where a statement is ambiguous the collection is named, and where `zz.team` is joined only
 * to resolve the caller's own team to a slug it is not: that join prints no team, so a roster change does
 * not move the answer.
 *
 * DELIBERATE: an array answer is not stamped. Three console GETs answer bare arrays today and Task I-10
 * turns them into `{ rows, meta }`; until it does, `checks/console-read-envelope.ts`'s static arm is what
 * fails, rather than a skip here that would read as compliance.
 *
 * COUPLED: `live-revision.ts`, which exports `revisionFor` and needs this file's table to answer with —
 * the two modules import each other, and both edges are only followed while a request is being served,
 * never while either module is evaluated. And `checks/console-read-envelope.ts` and the walking skeleton
 * `checks/console-read-contract.ts`, which read `READ_ROUTES` rather than retyping it.
 */
import type { Express, Response } from "express";

import type { Identity } from "../identity.js";
import { revisionFor } from "./live-revision.js";

/** The three fields that describe the request rather than the figures. Everything else in a `meta` is the
 *  route's own and passes through untouched. */
type ReadEnvelope = { observedAt: string; revision: string | null; cacheHit: boolean };

/** One route whose answer is stamped: the path it is mounted at, and the collections its statements read. */
export type ReadRoute = { path: string; collections: readonly string[] };

/** Every console GET that answers a JSON object, and what its marker is a composite of. The stream
 *  (`/api/console/live`) is not here: it holds a connection open and answers no read. */
export const READ_ROUTES: readonly ReadRoute[] = [
  // Who is looking, and whether the console answers them at all: the identity this request resolved.
  { path: "/api/console/me", collections: ["me"] },
  // The platform's rosters: a team's own row, who is in it, and the people behind the memberships.
  { path: "/api/console/teams", collections: ["teams", "people", "settings", "initiatives", "knowledge", "activity", "runs"] },
  { path: "/api/console/teams/:slug", collections: ["teams", "people", "settings", "initiatives", "knowledge", "activity", "runs"] },
  { path: "/api/console/people", collections: ["people", "teams", "settings", "activity", "runs"] },
  // The caller's own tokens, applications, browsers, passkeys and setup: nothing of another person's.
  { path: "/api/console/access", collections: ["me", "settings"] },
  // Work, the active team's: its initiatives and the documents under them, and what was signed.
  { path: "/api/console/initiatives", collections: ["initiatives", "document"] },
  { path: "/api/console/initiatives/:team/:slug", collections: ["initiatives", "document", "people"] },
  { path: "/api/console/document/:team/:initiative/*", collections: ["document", "initiatives", "people"] },
  { path: "/api/console/approvals", collections: ["document", "initiatives", "activity", "runs", "people"] },
  // The refusals by owner and week, and the real-work log the refusals are drawn from.
  { path: "/api/console/activity", collections: ["activity", "runs", "initiatives", "people", "skills"] },
  { path: "/api/console/activity/summary", collections: ["activity", "runs", "initiatives", "people", "skills"] },
  // The two reads that reduce the whole record: the same collections, plus the runs and the shelf.
  { path: "/api/console/home", collections: ["initiatives", "document", "knowledge", "activity", "runs", "people", "skills"] },
  { path: "/api/console/record", collections: ["document", "initiatives", "knowledge", "activity", "people", "teams", "me", "settings", "runs"] },
  // The prepared work query: one measure of the active team, drawn from the same rows as its pages.
  { path: "/api/console/work/query", collections: ["activity", "runs", "initiatives", "knowledge", "skills"] },
  // The shelf and the searches that fed it, and one node by its address.
  { path: "/api/console/knowledge/summary", collections: ["knowledge", "activity", "runs"] },
  { path: "/api/console/knowledge", collections: ["knowledge", "initiatives"] },
  { path: "/api/console/knowledge/log", collections: ["knowledge", "activity", "runs", "people"] },
  { path: "/api/console/knowledge/:team/*", collections: ["knowledge", "initiatives"] },
  // zz-core's own ranking over the documents and the shelf.
  { path: "/api/console/search", collections: ["knowledge", "skills"] },
  { path: "/api/console/skills", collections: ["skills", "runs", "activity"] },
  { path: "/api/console/skills/:name", collections: ["skills", "runs", "activity"] },
  { path: "/api/console/runs", collections: ["runs", "skills", "activity", "initiatives"] },
  // The catalog: what the image ships, what it recorded, and the evaluation of a plugin.
  { path: "/api/console/plugins", collections: ["plugins", "skills", "activity", "runs"] },
  { path: "/api/console/plugins/:plugin/skills/:skill", collections: ["plugins", "skills"] },
  { path: "/api/console/plugins/:plugin/eval", collections: ["plugins"] },
  // The platform's own reads. Status, Releases and Usage count real-work calls, which is `zz.event`.
  { path: "/api/console/platform/status", collections: ["activity", "runs"] },
  { path: "/api/console/platform/releases", collections: ["activity", "runs"] },
  { path: "/api/console/platform/releases/:version", collections: ["activity", "runs"] },
  { path: "/api/console/platform/bugs", collections: ["activity", "runs", "initiatives", "plugins"] },
  { path: "/api/console/platform/bugs/:id", collections: ["activity", "runs", "initiatives", "plugins"] },
  { path: "/api/console/platform/bugs/:id/duplicates", collections: ["activity", "runs", "initiatives", "plugins"] },
  { path: "/api/console/platform/evaluation", collections: ["plugins"] },
  { path: "/api/console/platform/usage", collections: ["activity", "runs", "plugins"] },
  { path: "/api/console/platform/knowledge", collections: ["knowledge", "activity", "runs"] },
  { path: "/api/console/platform/audit", collections: ["activity", "runs", "people"] },
  { path: "/api/console/platform/query", collections: ["activity", "runs", "knowledge", "plugins"] },
  // The settings surface's five reads: a person's own, a team's roster, and the platform's people.
  { path: "/api/console/settings/me/tokens", collections: ["settings"] },
  { path: "/api/console/settings/me/client-setup", collections: ["settings"] },
  { path: "/api/console/settings/me/teams", collections: ["me", "teams", "settings"] },
  { path: "/api/console/settings/team/members", collections: ["teams", "people", "settings"] },
  { path: "/api/console/settings/platform/people", collections: ["people", "teams", "settings"] },
];

/** A declared path as the expression that matches a request's own: `:name` is one segment and the
 *  trailing `*` is the rest of the address. */
function patternOf(path: string): RegExp {
  const body = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${body}$`);
}

const MATCHERS = READ_ROUTES.map((route) => ({ collections: route.collections, at: patternOf(route.path) }));

/**
 * The collections `path` reads, or null when no route declares it.
 *
 * Null is what the middleware stamps as a `revision` of null rather than a guess: the runtime never
 * refuses a read because the table is incomplete, and the static arm of the check is what names the
 * route that was forgotten.
 */
export function collectionsFor(path: string): readonly string[] | null {
  return MATCHERS.find((entry) => entry.at.test(path))?.collections ?? null;
}

/** Whether an answer is one this stamps: a plain object, never an array. */
const isAnswer = (body: unknown): body is Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body);

/** The answer's own `meta`, or an empty one when it answered none. */
const metaOf = (body: Record<string, unknown>): Record<string, unknown> =>
  isAnswer(body.meta) ? body.meta : {};

/**
 * Every console GET answered with the envelope: mounted in `mountConsole` beside `mountConsoleRevision`,
 * before any read, so `observedAt` and the marker are both sampled when the request arrived rather than
 * when its last statement settled.
 *
 * `res.json` is replaced rather than `res.send`, because every read here answers one. A GET answering an
 * array, a refusal (`status >= 400`) and every non-GET are left exactly as the route wrote them: an error
 * body carries no read, and a stream body (`console/live.ts`) is not an answer.
 */
export function mountReadEnvelope(app: Express): void {
  app.use("/api/console", (req, res, next) => {
    if (req.method !== "GET") { next(); return; }
    // Before any route runs, and before any cache is consulted: the instant the request arrived and the
    // marker it began at. A change committed while the read runs moves the count past what it was handed.
    const observedAt = new Date().toISOString();
    const id: Identity | undefined = req.zzIdentity;
    const revision = id === undefined ? null : revisionFor(req.originalUrl.split("?")[0], id, req);
    const send = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode >= 400 || !isAnswer(body)) return send(body);
      const old = metaOf(body);
      // What is true of THIS request, and of nothing else: the route's own figures pass through around it.
      // `cacheHit` is the cache's statement through `served()` when the route made one, and false when it did
      // not — a route that keeps no answer never served a kept one.
      const stamp: ReadEnvelope = {
        observedAt,
        revision,
        cacheHit: typeof old.cacheHit === "boolean" ? old.cacheHit : false,
      };
      // `builtAt` and `sourceRevision` describe persisted derived data this file knows nothing about, so a route
      // that named them keeps them and every other answer says, truly, that it was computed from rows.
      const meta = { ...old, ...stamp, builtAt: old.builtAt ?? null, sourceRevision: old.sourceRevision ?? null };
      return send({ ...body, meta });
    }) as Response["json"];
    next();
  });
}
