/**
 * Reporting a bug.
 *
 * WHY ON /core. zz-core owns "the record every flow writes into… a capability belongs here when
 * every flow needs it and no flow owns it". Anybody, in any flow, can hit something broken, and
 * no flow owns the act of saying so. It is not a credential or a question of authority, so it is
 * not /manage; it is not an evaluation, so it is not /eval.
 *
 * WHY NOT A KNOWLEDGE NODE. `knowledge_add` refuses an entry that cannot point at the initiative
 * it came from, and it is right to: a node without evidence is an opinion. A bug report is the
 * opposite shape — it arrives mid-task from somebody who was trying to do something else, usually
 * before anyone knows the cause, and its whole value is that it was captured at all. Held to the
 * journal's bar, most reports would be refused.
 *
 * WHY NOT AN EVENT. zz.event is telemetry: machine-written, never authored, and carrying no actor
 * on a tool_call by design — "no address on a measurement". A bug report is authored, and it
 * belongs to the person who took the trouble to write it.
 *
 * READING AND CLOSING ARE NOT HERE, and that is the whole shape of it. Filing a report is
 * something anybody doing anything might need to do, which is what puts it on this door.
 * Reading every report on the deployment and deciding what came of one are operator acts — they
 * are about the platform rather than about the work somebody was doing when it broke — so they
 * live on /manage behind superadmin, beside `knowledge_reindex`, which is there for exactly the
 * same reason. A day-to-day caller files; an operator answers.
 *
 * The table is still read: `bug_list` and `bug_resolve` in the gateway's access door are its
 * readers, so this is not the write-only shape `zz.decision` was for months.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { db, teamFor } from "../platform-db.js";

const json = (v: unknown): ReturnType<typeof text> => text(JSON.stringify(v, null, 2));
const noDb = (): ReturnType<typeof text> =>
  text("ERROR: no platform database — bug reports are stored in it, so there is nowhere to put this one");

/** The impact vocabulary, closed and enforced by 056's CHECK constraint.
 *
 *  `z.enum` rather than `z.string`, so a caller is refused at the door with the list rather
 *  than by Postgres with a constraint name. The database still checks: a schema that trusts its
 *  callers is a schema that holds whatever the next caller sends. */
const IMPACT = ["blocks_work", "wrong_result", "confusing", "cosmetic"] as const;

export function registerBugTools(server: McpServer, platformVersion: string): void {
  server.registerTool(
    "bug_report",
    {
      description:
        "WHEN somebody using this platform hits something broken, surprising, or wrong — a tool " +
        "that refused what should have worked, an answer that disagrees with itself, a step no " +
        "instruction prepared them for. Report it as they describe it; do not diagnose first. " +
        "RETURNS the id it was filed under, which is what `bug_resolve` takes. Only `title` and " +
        "`detail` are required: somebody who has just hit a wall should not be interviewed, and " +
        "every other field narrows a search later without blocking a report now. The platform " +
        "version is recorded from the service answering this call rather than asked, because a " +
        "version somebody guesses at sends the next reader to the wrong diff.",
      inputSchema: {
        title: z.string().min(1).describe("One line, in their words. What went wrong, not what you think caused it."),
        detail: z.string().min(1).describe(
          "What happened, what they expected instead, and what they were doing. Their words are " +
          "worth more than a tidy summary — a report is evidence, and paraphrase loses it."),
        impact: z.enum(IMPACT).optional().describe(
          "What it COST them, not how hard it looks to fix — a reporter knows the first and " +
          "cannot know the second. `blocks_work` means they stopped. Defaults to wrong_result."),
        surface: z.string().optional().describe("The door or tool it happened on, if they know — e.g. `/core/mcp` or `document_approve`."),
        initiative: z.string().optional().describe("What they were working on when it happened."),
      },
    },
    async ({ title, detail, impact, surface, initiative }) => {
      const p = db();
      if (!p) return noDb();
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      const { rows } = await p.query<{ id: string }>(
        `insert into zz.bug (reported_by, team_slug, title, detail, impact, surface, initiative,
                             platform_version)
         values ($1, $2, $3, $4, coalesce($5, 'wrong_result'), $6, $7, $8)
         returning id::text as id`,
        [who, team, title.trim(), detail.trim(), impact ?? null,
         surface?.trim() || null, initiative?.trim() || null, platformVersion]);
      // RECORDED, because this changes something. Filed against the initiative they name when
      // they name one, so the report shows up beside the work it interrupted.
      logActivity(await userRoot(), initiative?.trim() ? `${initiative.trim()}/_open.json` : null,
        { user: who, action: "bug_report", bug: rows[0].id, title: title.trim() });
      return json({
        id: rows[0].id,
        reported_by: who,
        platform_version: platformVersion,
        status: "open",
        note: "Filed. Nothing else is needed from them — say it is recorded and carry on with " +
              "what they were doing, which is the thing the bug interrupted.",
      });
    },
  );
}
