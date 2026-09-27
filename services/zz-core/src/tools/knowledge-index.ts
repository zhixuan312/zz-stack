/**
 * Re-deriving the knowledge index from the rows, which are the source of truth.
 *
 * Its own module rather than a fifth tool in knowledge.ts: the knowledge nouns — add, search,
 * supersede, reconcile — are what a flow does with what it learned, and this is an operator act
 * on the index that stores them, reached after a restore, or after a release that changes what
 * a row means.
 *
 * DELIBERATE: the rebuild re-derives the DERIVED columns — `body_tsv` and `analyzer_version` —
 * from each row's own `title`/`tags`/`body`. The store it used to re-read was the source of
 * truth when a node and a document were files; the rows are the record now, so there is nothing
 * else to read and the only thing a rebuild can mean is "produce the vector the current
 * analyzer would produce for what this row already holds".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reindexAllTeams, reindexTeam, type TeamReindex } from "@zz/indexing";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { db } from "../platform-db.js";

export function registerKnowledgeIndexTools(server: McpServer, sup: boolean): void {
  // Registered on /core, not /manage. The superadmin test — every plugin installed, nothing to
  // hide — puts the knowledge tools on /core, this one included. What makes it usable across
  // teams is the `team` argument, not the door; role still decides who sees it, through `if
  // (sup)`, registered per request.
  if (sup) server.registerTool(
    "knowledge_reindex",
    {
      description:
        "Re-derive a team's knowledge index from the database, which is the source of truth. " +
        "WHEN a release changes what an index row means, or a search returns a document whose " +
        "vector looks wrong — and with `force`, which re-derives every row rather than " +
        "skipping the ones whose analyzer generation already matches. RETURNS one line per " +
        "team: rows scanned, rows re-derived. Omit `team` and it walks EVERY team on the " +
        "deployment, which is what a restore needs. REFUSES anyone but a superadmin, and " +
        "refuses a team slug no team on this deployment carries — naming the slug it was " +
        "given, because an unknown team is a typo and rebuilding nothing would look " +
        "identical to rebuilding a team that had nothing to do. Cheap: a row already at the " +
        "current analyzer generation is skipped, so a pass over a settled corpus costs one " +
        "SELECT per table.",
      inputSchema: {
        team: z.string().optional().describe(
          "The team slug to rebuild. Omit to rebuild every team on the deployment."),
        force: z.boolean().optional().describe(
          "Re-derive every row even where the stored analyzer generation says nothing " +
          "changed. Needed when the DERIVATION changed and left rows the current logic would " +
          "not produce."),
      },
    },
    async ({ team, force }) => {
      if (!db()) return text("ERROR: knowledge index unavailable (no platform db)");
      const line = (r: TeamReindex) =>
        (r.error
          ? `${r.team}: FAILED — ${r.error}`
          : `${r.team}: ${r.scanned} row(s) scanned, ${r.indexed} re-derived` +
            (r.indexed === 0 ? " (nothing had changed)" : ""));
      // No `team` means every team, and the list is the roster rather than the rows: a team
      // holding nothing yet has nothing to rebuild, and a team with a stale vector is on it
      // either way.
      if (team === undefined) {
        const all = await reindexAllTeams(force === true);
        if (!all.length) return text("no team is on this deployment — nothing to rebuild");
        return text(`knowledge index rebuilt for ${all.length} team(s):\n` +
                    all.map(line).join("\n"));
      }
      // A slug that names no team is refused by name, and this guard is what makes the named
      // form safe to run: "rebuilt nothing" and "there is no such team" would otherwise read
      // identically to the person asking.
      const slug = team.trim();
      const known = await db()!.query<{ slug: string }>(
        "select slug from zz.team where slug = $1", [slug]);
      if (!known.rowCount) {
        return text(`ERROR: no team on this deployment is called '${slug}' — ` +
                    "team_list shows the slugs. Omit `team` to rebuild every one of them.");
      }
      const r = await reindexTeam(slug, force === true);
      return text(`knowledge index rebuilt for ${line(r)}`);
    },
  );
}
