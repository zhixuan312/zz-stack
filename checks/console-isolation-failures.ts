/**
 * checks/console-isolation-failures.ts — the isolation harness's failure round: the table each read is failed by, and the
 * round's part at the member's own addresses. Not a check of its own: `checks/console-isolation.ts` imports `tableFor`
 * for the round it runs with the second team's addresses, and calls `ownFailures` once that round is done, on the same
 * seeded database, zz-core and gateway, so no file passes the 700-line ceiling.
 *
 * Why a part of its own: a read asked with the second team's addresses can answer before it reads anything (Work's
 * initiative and document answer 404 for another team's), so renaming its table proves nothing about its error body.
 * `ownFailures` asks Work's initiative and document, the shared lesson, the shelf, the search and each `settings/*` read
 * that reads a table of its own at the member's own addresses, where each reaches its read, and establishes:
 *
 *   - with each one's table renamed, it answers its own error body, the one its handler writes for a read that failed;
 *   - every other read asked beside it whose statements read no such table, `/api/console/me` among them, answers
 *     exactly as it did with the table in place, instants masked: the failure is that read's alone;
 *   - every `settings/*` read the router answers is one of those or is listed unreachable with why, as `live` is.
 */
import type pg from "pg";

import type { Isolation, SharedCitations } from "../scripts/schema/isolation-seed.ts";

import { send, type Answer, type Route } from "./console-isolation-work.ts";

/** The table a read is answered from, renamed for its failure round, or null for a read the map does not
 *  name: `zz.event` for the status, releases, bugs list, usage and audit reads, Teams and the Work pages,
 *  Activity's summary and log, Plugins and skills among them, `zz.initiative` for Work's prepared queries,
 *  `zz.doc` for an initiative and a document, `zz.eval_run` for evaluation, `zz.bug` for a report and its
 *  duplicates, `zz.knowledge_node` for Knowledge health and Knowledge's summary, so one part fails and the rest
 *  stand, and for its list and a lesson, which read no event, `zz.passkey` for People, `zz.skill_run` for Runs,
 *  `zz.pat` for Access, whose read fails whole, and for the caller's tokens, and `zz.event` for the platform
 *  query. A table the identity gate reads for a session (`zz.team`, `zz.principal`, `zz.membership`,
 *  `zz.console_session`) would fail every request before its read. */
export function tableFor(path: string, platformQuery: string): string | null {
  if (/^\/api\/console\/platform\/(status|releases|releases\/:version|bugs|usage|audit)$/.test(path)) return "event";
  if (/^\/api\/console\/teams(\/:slug)?$/.test(path)) return "event";
  if (path === "/api/console/people") return "passkey";
  if (path === "/api/console/platform/knowledge" || /^\/api\/console\/knowledge(\/summary|\/:team\/\*)?$/.test(path)) return "knowledge_node";
  if (path === "/api/console/access" || path === "/api/console/settings/me/tokens") return "pat";
  if (path === "/api/console/platform/evaluation") return "eval_run";
  if (/^\/api\/console\/platform\/bugs\/:id(\/duplicates)?$/.test(path)) return "bug";
  if (path === "/api/console/work/query") return "initiative";
  if (path === "/api/console/runs") return "skill_run";
  if (path === "/api/console/initiatives/:team/:slug" || path === "/api/console/document/:team/:initiative/*") return "doc";
  if (path === platformQuery) return "event";
  if (/^\/api\/console\/(platform|settings)\//.test(path) || path === "/api/console/live") return null;
  return "event";
}

/** The reads `ownFailures` cannot reach, and why: none reads a table renaming could fail it by alone. */
const UNREACHABLE: Record<string, string> = {
  "/api/console/settings/me/teams": "built from the identity alone, which the gate resolved before the route ran",
  "/api/console/live": "a held-open stream, answered 200 before any read beneath it can fail",
  "/api/console/settings/me/client-setup": "reads no table: the setup is rendered from the catalog and the gateway's address",
  "/api/console/settings/team/members": "reads only the memberships, people and teams the identity gate reads for every request",
  "/api/console/settings/platform/people": "reads only the people, memberships and teams the identity gate reads for every request",
};

/** One read asked at the member's own address: the table it is failed by, the body its handler answers then, and every
 *  table its statements read, the identity gate's excepted. A control reads nothing renamed here. */
interface Target { path: string; url: string; table: string | null; status?: number; error?: string; reads: string[] }

/** Work's detail routes and the knowledge reads a member reaches with their own team's addresses and the shared lesson's,
 *  the search, and their own tokens; `/api/console/me` beside them as a control. COUPLED: the statements of
 *  services/gateway/src/console/initiatives.ts, knowledge.ts and search.ts (through zz-core's knowledge_search), and
 *  myAccessTokensFor in credentials.ts. */
function targets(s: Isolation, cited: SharedCitations): Target[] {
  const work = ["doc", "doc_revision", "doc_link", "initiative", "team", "principal"];
  const shelf = ["knowledge_node", "knowledge_node_evidence", "initiative", "team"];
  return [
    { path: "/api/console/initiatives/:team/:slug", url: `/api/console/initiatives/${s.one.slug}/${s.one.initiative}`,
      table: "initiative_fact", status: 500, error: "could not read the initiative", reads: [...work, "initiative_fact"] },
    { path: "/api/console/document/:team/:initiative/*", url: `/api/console/document/${s.one.slug}/${s.one.initiative}/${s.one.docPath}`,
      table: "doc", status: 500, error: "could not read the document", reads: work },
    { path: "/api/console/knowledge/:team/*", url: `/api/console/knowledge/zz-platform/${cited.node}`,
      table: "knowledge_node_evidence", status: 500, error: "could not read the node", reads: shelf },
    { path: "/api/console/knowledge", url: "/api/console/knowledge?limit=100",
      table: "knowledge_node_evidence", status: 500, error: "could not read the knowledge base", reads: shelf },
    { path: "/api/console/search", url: `/api/console/search?q=${cited.word}`,
      table: "knowledge_node_evidence", status: 502, error: "zz-core returned an unreadable search result", reads: [...work, ...shelf, "event"] },
    { path: "/api/console/settings/me/tokens", url: "/api/console/settings/me/tokens",
      table: "pat", status: 500, error: "could not list tokens", reads: ["pat"] },
    { path: "/api/console/me", url: "/api/console/me", table: null, reads: [] },
  ];
}

/** What the round is handed by the harness. */
interface FailureContext {
  s: Isolation; cited: SharedCitations; base: string; sql: pg.Client; reads: Route[];
  found: string[]; pass: (line: string) => void;
}

/** An answer with every instant masked. */
const masked = (a: Answer): string => `${a.status} ${a.text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<instant>")}`;

/** The failure round's part at the member's own addresses. */
export async function ownFailures(c: FailureContext): Promise<void> {
  const all = targets(c.s, c.cited);
  const ask = async (t: Target): Promise<Answer> => send(c.base, c.s.cookies.one, { method: "get", url: t.url, body: null });
  const bad: string[] = [];
  for (const t of all.filter((x) => x.table !== null && !c.reads.some((r) => r.path === x.path))) bad.push(`${t.path} is not mounted`);
  const before = new Map<string, string>();
  for (const t of all) {
    const a = await ask(t);
    if (a.status !== 200) bad.push(`${t.url} answered ${a.status} with every table in place: ${a.text.slice(0, 200)}`);
    before.set(t.url, masked(a));
  }
  for (const t of all.filter((x): x is Target & { table: string } => x.table !== null)) {
    await c.sql.query(`alter table zz.${t.table} rename to ${t.table}_isolation_hidden`);
    // The gateway logs each failed read's cause; what matters here is what the member was answered.
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const mine: string[] = [];
      const a = await ask(t);
      if (a.status !== t.status || a.text !== JSON.stringify({ error: t.error })) {
        mine.push(`${t.path} with zz.${t.table} renamed answered ${a.status} ${a.text.slice(0, 200)}, not ${t.status} ${JSON.stringify({ error: t.error })}`);
      }
      const controls = all.filter((x) => x !== t && !x.reads.includes(t.table));
      for (const x of controls) {
        const now = masked(await ask(x));
        if (now !== before.get(x.url)) mine.push(`${x.path} moved while zz.${t.table} was renamed for ${t.path}: ${now.slice(0, 200)}`);
      }
      if (mine.length) bad.push(...mine);
      else c.pass(`the failure round at the member's own address: ${t.path} with zz.${t.table} renamed answers ${t.status} ` +
        `"${t.error}", and ${controls.map((x) => x.path).join(", ")} answer as before`);
    } finally {
      console.error = quiet;
      await c.sql.query(`alter table zz.${t.table}_isolation_hidden rename to ${t.table}`);
    }
  }
  // Every settings/* read is reached or said unreachable, with live: one added later fails here until it is named.
  const settings = c.reads.map((r) => r.path).filter((p) => p.startsWith("/api/console/settings/") || p === "/api/console/live");
  const unnamed = settings.filter((p) => !all.some((t) => t.path === p && t.table !== null) && !(p in UNREACHABLE));
  if (unnamed.length) bad.push(`${unnamed.join(", ")} neither failed by a table of its own nor listed unreachable`);
  if (bad.length) c.found.push(...bad.map((b) => `the failure round at the member's own address: ${b}`));
  else c.pass(`the failure round cannot reach ${settings.filter((p) => p in UNREACHABLE).map((p) => `${p} (${UNREACHABLE[p]})`).join("; ")}`);
}
