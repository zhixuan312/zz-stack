/**
 * Rebuilding the knowledge index from the files, which are the source of truth.
 *
 * ITS OWN MODULE, not a fifth tool in knowledge.ts. The knowledge nouns — add, search,
 * supersede, reconcile — are what a flow does with what it learned. This is an OPERATOR act on
 * the index that stores them, reached after a restore, after a store was edited outside the
 * platform's tools, or after a release changed what a row means. Different subject, different
 * audience, and knowledge.ts was over the file ceiling holding both.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ARTIFACTS_DIR, reindexAllTeams, reindexTeam, type TeamReindex } from "@zz/indexing";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { db } from "../platform-db.js";

export function registerKnowledgeIndexTools(server: McpServer, sup: boolean): void {
  // IT WENT TO /manage AND HAS COME BACK, and both moves were about the same sentence.
  //
  // It left because on /core it was TEAM-SCOPED by construction — it rebuilt the caller's team
  // and could not reach anyone else's, so the one situation that actually produces it, a
  // restore across the whole deployment, meant asking one person from each team to run it.
  // That was a real defect and moving the tool fixed it. What moved with it was the reasoning:
  // "this is an operator's act, so it belongs on the operator's door", which is ROLE deciding a
  // door. Apply the superadmin test — every plugin installed, nothing to hide — and the
  // knowledge tools all answer /core, this one included.
  //
  // What actually fixed the scoping was the `team` argument, and that comes back with it. Role
  // still decides who SEES it: `if (sup)`, registered per request, exactly as before.
  if (sup) server.registerTool(
    "knowledge_reindex",
    {
      description:
        "Rebuild a team's knowledge index from its files, which are the source of truth. WHEN " +
        "a store has been restored from a backup, edited outside the platform's tools, or a " +
        "search returns a document whose file is gone — and after a release that changes what " +
        "an index row means, with force. RETURNS one line per team: files scanned, rows " +
        "re-indexed, stale rows removed. Omit `team` and it walks EVERY team on the " +
        "deployment, which is what a restore needs. REFUSES anyone but a superadmin, and " +
        "refuses a team slug no team on this deployment carries — naming the slug it was " +
        "given, because an unknown team is a typo and rebuilding nothing would look " +
        "identical to rebuilding a team that had nothing to do. Cheap: unchanged files are " +
        "skipped by content hash, so a walk over a settled corpus costs one SELECT per file.",
      inputSchema: {
        team: z.string().optional().describe(
          "The team slug to rebuild. Omit to rebuild every team on the deployment."),
        force: z.boolean().optional().describe(
          "Re-derive every row even where the stored hash says nothing changed. Needed when " +
          "the DERIVATION changed and left rows the current logic would not produce."),
      },
    },
    async ({ team, force }) => {
      if (!db()) return text("ERROR: knowledge index unavailable (no platform db)");
      // THE STORE HAS TO BE MOUNTED. The indexer treats a missing teams/ directory as "the
      // volume is not mounted, touch nothing" — deliberately, because the alternative is one
      // boot emptying the whole index — and returns the same shape it returns for a team that
      // had nothing to do. Without this line those two answers are the same sentence to the
      // person asking: "nothing had changed", on a service that could not see a single file.
      if (!existsSync(join(ARTIFACTS_DIR, "teams"))) {
        return text(`ERROR: the artifact store is not mounted at ${ARTIFACTS_DIR} on this ` +
                    "gateway, so there are no files to rebuild the index from and NOTHING WAS " +
                    "REBUILT. deploy/docker-compose.yml mounts it read-only on this service; " +
                    "a deployment that dropped that volume has to put it back.");
      }
      const line = (r: TeamReindex) =>
        (r.error
          ? `${r.team}: FAILED — ${r.error}`
          : `${r.team}: ${r.scanned} files scanned, ${r.indexed} re-indexed, ${r.removed} stale row(s) removed` +
            (r.indexed === 0 && r.removed === 0 ? " (nothing had changed)" : ""));
      // NO `team` MEANS EVERY TEAM, and the walk that finds them is the package's, not one
      // spelled again here: the list is the union of the store directories and the slugs the
      // index already believes in, and a team whose store was deleted appears only in the
      // second. Rebuilding from the directories alone would silently never visit the one team
      // that needs its rows cleaned.
      if (team === undefined) {
        const all = await reindexAllTeams(force === true);
        if (!all.length) return text("no team has a store on this deployment — nothing to rebuild");
        return text(`knowledge index rebuilt for ${all.length} team(s):\n` +
                    all.map(line).join("\n"));
      }
      // A SLUG THAT NAMES NO TEAM IS REFUSED BY NAME, and this is the guard that makes the
      // named form safe to run. reindexTeam's contract for a team with no store directory is
      // to DELETE that team's rows — correct for a team that was archived, and catastrophic
      // for a typo, which has no directory either. Without this the two are the same call.
      const slug = team.trim();
      const known = await db()!.query<{ slug: string }>(
        "select slug from zz.team where slug = $1", [slug]);
      if (!known.rowCount) {
        return text(`ERROR: no team on this deployment is called '${slug}' — ` +
                    "team_list shows the slugs. Omit `team` to rebuild every one of them.");
      }
      const r = await reindexTeam(slug, force === true);
      return text(`knowledge index rebuilt for ${line({ team: slug, ...r })}`);
    },
  );
}
