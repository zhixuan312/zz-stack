/**
 * /api/console/search — the platform's own ranked search, for the console.
 *
 * The one console read that is not a query of this gateway's own. It calls zz-core's
 * `knowledge_search` as the caller (`coreFor`, core-as-caller.ts) and reshapes each row so a
 * console can link it. Retrieval is not reimplemented here: that tool already fuses the lexical,
 * tag and evidence lanes over a team's documents and the knowledge shelf together, labels what was
 * superseded, and says which kind of empty an empty answer is. A second search beside it would be
 * a second ranking to keep in step with the real one.
 *
 * Why it exists as a read by itself: the console's assistant answers from what this returns. The
 * gateway used to wrap the same call in a route that also wrote the answer with a model of its
 * own; the console now has one assistant, so this is the retrieval half and nothing else. No model
 * is reached from here.
 *
 * Whose search it is. `knowledge_search` takes no team argument: it searches the team the caller
 * acts for and the platform's shared shelf, decided from the identity headers this gateway stamps.
 * So the route has no fleet-wide reading and refuses `?scope=platform` rather than answering one
 * team's search under the platform's name, and it refuses a `?team=` that is not the team the
 * search ran as. The reply names that team.
 *
 * What a row gains here. A search row is keyed `initiative/path`, and a node sits under the
 * initiative `_knowledge`; the console addresses a node by its shelf's team and a document by its
 * team, its initiative and its path. So each row is given its `kind` and the `team` whose store
 * holds it, read from the `shelf` the tool reports. Nothing is looked up to do it.
 */
import type { Express, Request, Response } from "express";

import { McpError } from "@zz/mcp-client";

import { coreFor } from "../core-as-caller.js";
import { PLATFORM_TEAM } from "../identity.js";
import { handler, type ResolvedScope } from "./shared.js";

/** The initiative every knowledge node is filed under, as `knowledge_search` spells a node's row. */
const KNOWLEDGE_INITIATIVE = "_knowledge";

/** The longest question taken. `knowledge_search` records the first 200 characters of a query as
 *  the event's subject, so a longer one would be searched whole and logged cut. */
const MAX_QUERY = 200;

const INITIATIVE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;
const TYPE = /^[a-z][a-z0-9-]{0,49}$/;

/** One row of `knowledge_search`'s `results[]`, as services/zz-core/src/tools/knowledge-search.ts
 *  builds it. COUPLED: a field renamed there arrives here as `undefined`, which the mapping below
 *  turns into the empty value of its type rather than into a row that looks complete. */
interface SearchRow {
  initiative: string;
  path: string;
  title: string | null;
  type: string | null;
  shelf: "team" | "platform";
  status: string | null;
  superseded_by: string | number | null;
  tags: string[] | null;
  /** The cited initiatives of the team the search ran as; `cited_elsewhere` counts every other team's. */
  evidence: string[] | null;
  cited_elsewhere: number | null;
  flow: string | null;
  outcome: string | null;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string | null;
  snippet: string;
  score: number;
  via: string[];
}

interface SearchReply {
  team?: string;
  query?: string | null;
  ranked_total?: number;
  returned?: number;
  withheld?: number;
  superseded_in_results?: number;
  note?: string;
  recall?: { result?: string };
  results?: SearchRow[];
}

/** An instant the way every other console route sends one, or null for a value that is not a date. */
function instant(value: string | null): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A search row as the console links it. */
function linkable(r: SearchRow, team: string) {
  const node = r.initiative === KNOWLEDGE_INITIATIVE;
  return {
    kind: node ? "node" : "document",
    // The team whose store holds it: the caller's own, or the shared shelf's.
    team: r.shelf === "platform" ? PLATFORM_TEAM : team,
    shelf: r.shelf,
    initiative: node ? null : r.initiative,
    path: r.path,
    title: r.title ?? r.path,
    // A freeform document has neither: the tool sends the empty string, and nothing is not a type.
    type: r.type || null,
    status: r.status || null,
    superseded_by: r.superseded_by === null || r.superseded_by === undefined ? null : String(r.superseded_by),
    tags: r.tags ?? [],
    // The tool names the cited initiatives of the team it ran as alone and counts the rest (reconciliation
    // 81), so neither is chosen again here.
    evidence: r.evidence ?? [],
    cited_elsewhere: r.cited_elsewhere ?? 0,
    flow: r.flow || null,
    outcome: r.outcome ?? null,
    approved_by: r.approved_by ?? null,
    approved_at: instant(r.approved_at),
    updated: instant(r.updated_at),
    // The tool's matched fragment, at most 600 characters, whitespace collapsed, with each matched
    // term between `**` as the tool marks it.
    excerpt: r.snippet ?? "",
    score: r.score,
    via: r.via ?? [],
  };
}

export function mountSearch(app: Express): void {
  /** What the caller's team and the shared shelf hold on a question, ranked, each with a matched
   *  excerpt. `?q=` is the question; `?limit=` 1 to 50; `?initiative=` and `?type=` narrow it the
   *  way the tool's own filters do. */
  app.get("/api/console/search", handler("the search", async (req: Request, res: Response, scope: ResolvedScope) => {
    if (scope.kind !== "team") {
      res.status(400).json({ error: "search runs as one team and the platform's shared shelf — it has no fleet-wide reading, so not ?scope=platform" });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) { res.status(400).json({ error: "q required — the question to search for" }); return; }
    if (q.length > MAX_QUERY) { res.status(400).json({ error: `q is at most ${MAX_QUERY} characters` }); return; }

    const args: Record<string, unknown> = { query: q };
    if (req.query.limit !== undefined) {
      const limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        res.status(400).json({ error: "limit must be a whole number from 1 to 50" });
        return;
      }
      args.limit = limit;
    }
    if (req.query.initiative !== undefined) {
      const initiative = String(req.query.initiative);
      if (!INITIATIVE.test(initiative)) { res.status(400).json({ error: "initiative must be an initiative's name" }); return; }
      args.initiative = initiative;
    }
    if (req.query.type !== undefined) {
      const type = String(req.query.type);
      if (!TYPE.test(type)) { res.status(400).json({ error: "type must be a document or node type" }); return; }
      args.type = type;
    }

    let raw: string;
    try {
      raw = await coreFor(req).call("knowledge_search", args);
    } catch (err) {
      // A throw is "could not reach zz-core", never the tool refusing: its refusals come back as text.
      res.status(502).json({ error: err instanceof McpError ? err.message : "zz-core unreachable" });
      return;
    }
    // The tool's own refusal ("you are not in a team", "knowledge index unavailable"), carried
    // back unchanged, as every route in console-write.ts does.
    if (/^ERROR/.test(raw)) { res.status(400).json({ error: raw }); return; }

    let reply: SearchReply;
    try {
      reply = JSON.parse(raw) as SearchReply;
    } catch {
      // The tool's contract is a JSON body. Text that does not parse is zz-core answering in a
      // shape this route does not know, which is not the same fact as "nothing matched".
      res.status(502).json({ error: "zz-core returned an unreadable search result" });
      return;
    }
    // Whose search it was, from the tool's own reply: it resolves the team from the caller's
    // identity, and that is the store every `team` row below lives in.
    const team = reply.team ?? scope.slug;
    if (team !== scope.slug) {
      res.status(400).json({ error: `search runs as the team you act for, ${team}, not ${scope.slug} — switch teams to search another` });
      return;
    }
    const results = (reply.results ?? []).map((r) => linkable(r, team));
    res.json({
      team,
      query: q,
      ranked_total: reply.ranked_total ?? results.length,
      returned: results.length,
      withheld: reply.withheld ?? 0,
      superseded_in_results: reply.superseded_in_results ?? 0,
      // The tool's own sentence: the results are leads because no document held every term, or
      // lower-ranked ones were not shown, or which kind of empty this is.
      note: reply.note ?? null,
      // Which kind of empty, on an empty answer only: a search that could not conclude is not a
      // search that found nothing.
      recall: reply.recall?.result ?? null,
      results,
    });
  }));
}
