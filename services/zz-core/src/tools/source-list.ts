/**
 * `source_list` — what evidence an initiative already has.
 *
 * Beside `artifacts.ts` rather than in it: that file carries the document tools and `source_add`,
 * and this is the one tool past what it holds. Registered from `artifacts.ts`, the way
 * `initiative-open.ts` and `initiative-close.ts` are registered from `initiative-acts.ts`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { READS, requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { safeName } from "../paths.js";
import { db, teamFor } from "../platform-db.js";
import { dayOf } from "../versions.js";

export function registerSourceListTool(server: McpServer): void {
  server.registerTool(
    "source_list",
    {
      annotations: READS,
      description:
        "The immutable inputs attached to an initiative (minutes, emails, call notes) with their " +
        "titles and what each supports. Read these before judging a document: they are the " +
        "evidence behind it. Use source_add to attach a new one.",
      inputSchema: { initiative: z.string() },
    },
    async ({ initiative }) => {
      const bad = safeName(initiative, "initiative");
      if (bad) return text(bad);
      const p = db();
      const team = await teamFor(parseCaller(requestHeaders()).email);
      if (!p || !team) return text(JSON.stringify({ initiative, sources: [] }));
      // ONE statement, not four per source. This was `documentPaths` then `documentAt`,
      // `revisionsOf` and `supportsOf` for each one — roughly 120 sequential round trips on an
      // initiative with forty sources, on the read a caller runs just before judging a document —
      // and `revisionsOf` detoasts every revision's body to answer about one, so the cost grew with
      // the history as well. COUPLED: the shape this prints, which callers already read.
      const { rows } = await p.query<{
        path: string; type: string | null; title: string | null;
        written_at: string | null; written_by: string | null; supports: string | null;
      }>(
        `select d.path, d.type, r.title, r.written_at::text as written_at, w.email as written_by,
                string_agg(distinct t.path, ', ') as supports
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team tm on tm.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
           left join zz.principal w on w.id = r.written_by
           left join zz.doc_link l on l.from_doc_id = d.id and l.from_revision = d.current_revision
                                 and l.kind = 'supports'
           left join zz.doc t on t.id = l.to_doc_id
          where tm.slug = $1 and i.slug = $2 and d.path like 'sources/%' and d.path like '%.md'
          group by d.path, d.type, r.title, r.written_at, w.email
          order by d.path`,
        [team, initiative]);
      const sources = rows.map((row) => ({
        path: `${initiative}/${row.path}`,
        title: row.title || row.path.split("/").pop() || row.path,
        supports: row.supports ?? "",
        // A source has no flow role, and the round it was recorded as is kept on the row's `type`.
        stage: !row.type || row.type === "source" ? "" : row.type,
        contributed_by: row.written_by ?? "",
        added_at: row.written_at ? dayOf(row.written_at) : "",
      }));
      return text(JSON.stringify({ initiative, sources }, null, 2));
    },
  );
}
