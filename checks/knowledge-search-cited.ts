#!/usr/bin/env node
/**
 * checks/knowledge-search-cited.ts — zz-core's `knowledge_search` names a lesson's cited initiatives of the team
 * the caller acts for alone, and counts the rest, without moving a result (AC-1.8, reconciliation 81).
 *
 *   node checks/knowledge-search-cited.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), seeds what
 * `scripts/schema/isolation-seed.ts` declares (`seedIsolation`, then `seedSharedCitations`: a lesson on the shared
 * shelf citing both teams' open initiatives, and a lesson on each team's shelf citing its own), indexes it as
 * zz-core indexes it, and asks `knowledge_search` for the shared lesson's word as each team's own admin. What it
 * establishes, for each:
 *
 *   - the results come back in the order the same seed and query gave at ef87d26e, before the citations were chosen:
 *     the shared lesson, found by its word and its tag, then the team's own lesson and its open initiative's
 *     document, both reached through the citations the shared lesson shares with them;
 *   - the shared lesson's `evidence` names the caller's own team's initiative alone and `cited_elsewhere` counts the
 *     other team's one; the team's own lesson names its own and counts none, and the document counts none;
 *   - the other team's initiative slug is nowhere in the answer.
 *
 * Breaking (reconciliation 81): an MCP client that read another team's slug in a shared lesson's `evidence` reads
 * only its own team's there now, and the count of the others in `cited_elsewhere`.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { Mcp } from "@zz/mcp-client";

import { seedIsolation, seedSharedCitations } from "../scripts/schema/isolation-seed.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "knowledge-search-cited";
const DONE = "knowledge-search-cited: knowledge_search names a shared lesson's cited initiatives of the caller's own team " +
  "alone and counts the other team's, in the order the same seed and query gave before, to each team's caller: ok";

type Row = { initiative: string; path: string; shelf: string; evidence: string[]; cited_elsewhere?: unknown };

async function run(c: Core): Promise<void> {
  const s = await seedIsolation(c.sql);
  const cited = await seedSharedCitations(c.sql, s);
  // The rows indexed as zz-core indexes them, so the lexical lane can find the shared lesson: the reindex is the
  // superadmin's, through the door's own admin headers.
  const admin = new Mcp(c.mcp.url, { client: NAME, timeoutMs: 60_000, headers: {
    "x-zz-user-email": s.superadmin, "x-zz-user-name": "Isolation superadmin", "x-zz-user-id": "",
    "x-zz-user-role": "admin", "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "" } });
  await c.ok("reindex", "knowledge_reindex", { force: true }, admin);

  for (const [mine, theirs] of [[s.one, s.two], [s.two, s.one]] as const) {
    const who = mine === s.one ? "the first team's caller" : "the second team's caller";
    const lesson = mine === s.one ? cited.own.one : cited.own.two;
    let step = `${who}: the order`;
    const raw = await c.ok(step, "knowledge_search", { query: cited.word }, c.client({ email: mine.email }));
    const reply = JSON.parse(raw) as { team: string; results: Row[] };
    if (reply.team !== mine.slug) c.fail(step, `the search ran as ${reply.team}, not ${mine.slug}`);
    // COUPLED: the order this seed and query gave at ef87d26e, recorded by running this check against that commit.
    const want = [`platform:_knowledge/${cited.node}`, `team:_knowledge/${lesson}`, `team:${mine.initiative}/${mine.docPath}`];
    const got = reply.results.map((r) => `${r.shelf}:${r.initiative}/${r.path}`);
    if (got.join(", ") !== want.join(", ")) c.fail(step, `the results came back ${got.join(", ")}, not ${want.join(", ")}`);
    c.pass(`${step}: ${got.join(", ")}, as at ef87d26e`);

    step = `${who}: the citations`;
    const [shared, own, document] = reply.results;
    const said = (r: Row) => `evidence ${JSON.stringify(r.evidence)}, cited_elsewhere ${JSON.stringify(r.cited_elsewhere)}`;
    if (JSON.stringify(shared.evidence) !== JSON.stringify([mine.initiative]) || shared.cited_elsewhere !== 1) {
      c.fail(step, `the shared lesson answered ${said(shared)}, not its own team's ${mine.initiative} and one elsewhere`);
    }
    if (JSON.stringify(own.evidence) !== JSON.stringify([mine.initiative]) || own.cited_elsewhere !== 0) {
      c.fail(step, `the team's own lesson answered ${said(own)}, not ${mine.initiative} and none elsewhere`);
    }
    if (document.cited_elsewhere !== 0) c.fail(step, `the document answered ${said(document)}, not none elsewhere`);
    if (raw.includes(theirs.initiative)) c.fail(step, `the answer names the other team's ${theirs.initiative} at character ${raw.indexOf(theirs.initiative)}`);
    c.pass(`${step}: the shared lesson names ${mine.initiative} and counts one elsewhere, and the other team's initiative is nowhere`);
  }
}

process.exitCode = await withThrowawayCore(NAME, DONE, run);
