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
import { dayOf, documentAt, documentPaths, revisionsOf, supportsOf } from "../versions.js";

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
      const rows = [];
      for (const rel of await documentPaths(team, `${initiative}/sources`)) {
        if (!rel.endsWith(".md")) continue;
        const doc = await documentAt(p, team, rel);
        if (!doc) continue;
        const revs = await revisionsOf(p, doc.id);
        const rev = revs.find((r) => r.revision === doc.current_revision) ?? revs[0];
        // COUPLED: `contributed_by` is the address `written_by` holds, and `stage` the round
        // the source was recorded as — kept on the row's `type`, a source having no flow role.
        rows.push({
          path: rel,
          title: rev?.title || rel.split("/").pop() || rel,
          // DELIBERATE: the SUPPORTS links, not `citationsOf`. The two are different relations —
          // `cites` is what the source read, `supports` is the document it bears on — and reading
          // the first while labelling it the second showed a caller the wrong list under the right
          // name.
          supports: (await supportsOf(p, doc.id, rev?.revision ?? 0))
            .map((x) => x.split("/").pop() ?? x).join(", "),
          stage: doc.type === "source" ? "" : doc.type,
          contributed_by: rev?.written_by ?? "",
          added_at: rev?.written_at ? dayOf(rev.written_at) : "",
        });
      }
      return text(JSON.stringify({ initiative, sources: rows }, null, 2));
    },
  );
}
