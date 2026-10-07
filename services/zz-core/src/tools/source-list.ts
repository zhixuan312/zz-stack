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
        written_at: string | null; written_by: string | null; supports: string | null; declared: string | null;
      }>(
        `select d.path, d.type, r.title, r.written_at::text as written_at, w.email as written_by,
                string_agg(distinct t.path, ', ') as supports, r.fields->>'supports' as declared
           from zz.doc d
           join zz.initiative i on i.id = d.initiative_id
           join zz.team tm on tm.id = i.team_id
           left join zz.doc_revision r on r.doc_id = d.id and r.revision = d.current_revision
           left join zz.principal w on w.id = r.written_by
           left join zz.doc_link l on l.from_doc_id = d.id and l.from_revision = d.current_revision
                                 and l.kind = 'supports'
           left join zz.doc t on t.id = l.to_doc_id
          where tm.slug = $1 and i.slug = $2 and d.path like 'sources/%' and d.path like '%.md'
          group by d.path, d.type, r.title, r.written_at, w.email, r.fields
          order by d.path`,
        [team, initiative]);
      // The documents the initiative holds, so a declared target is named plainly once it exists,
      // linked or not: a source and its target written at the same moment can leave no link.
      const written = new Set((await p.query<{ path: string }>(
        `select d.path from zz.doc d join zz.initiative i on i.id = d.initiative_id
           join zz.team tm on tm.id = i.team_id where tm.slug = $1 and i.slug = $2`, [team, initiative])).rows
        .map((r) => r.path));
      const sources = rows.map((row) => ({
        path: `${initiative}/${row.path}`,
        title: row.title || row.path.split("/").pop() || row.path,
        supports: supportsOf(row.declared, row.supports, written),
        // A source has no flow role, and the round it was recorded as is kept on the row's `type`.
        stage: !row.type || row.type === "source" ? "" : row.type,
        contributed_by: row.written_by ?? "",
        added_at: row.written_at ? dayOf(row.written_at) : "",
      }));
      return text(JSON.stringify({ initiative, sources }, null, 2));
    },
  );
}

/** What a source supports, in the order it declared them, each named once. A link needs its
 *  target's row, so a document not written yet has none until `saveDocument` files it at the
 *  document's first write; reading the links alone answered an empty `supports` for a source whose
 *  own text named one (bug e9d91c40). A declared target the initiative does not hold is named as
 *  not written yet; one it holds is named plainly, linked or not. A name is spelled as the store
 *  spells it — `.md` when it has no extension — so `spec` and `spec.md` are one document. A link
 *  with no declaration behind it (a source filed before declarations were kept) is still named. */
function supportsOf(declared: string | null, linked: string | null, written: Set<string>): string {
  const links = (linked ?? "").split(", ").filter(Boolean);
  const named = [...new Set((declared ?? "").split(",").map((n) => n.trim()).filter(Boolean)
    .map((n) => (/\.[^/]+$/.test(n) ? n : `${n}.md`)))];
  return [...named.map((n) => (written.has(n) || links.includes(n) ? n : `${n} (not written yet)`)),
          ...links.filter((l) => !named.includes(l))].join(", ");
}
