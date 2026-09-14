/**
 * Reporting a bug, reading what has been reported, and closing one.
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
 * THREE TOOLS, BECAUSE TWO WOULD BE A TABLE NOBODY READS. This repository has already learned
 * what a write-only table costs: zz.decision was derived on every index and read by nothing for
 * months, and nothing noticed it going wrong because nothing looked. A reporting tool with no
 * reader is that again by construction. `bug_resolve` is the third because a tracker where
 * nothing can be closed stops being a tracker within a week.
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

/** The two closed vocabularies, stated once here and enforced by 056's CHECK constraints.
 *
 *  Both are `z.enum` rather than `z.string`, so a caller is refused at the door with the list
 *  rather than by Postgres with a constraint name. The database still checks: a schema that
 *  trusts its callers is a schema that holds whatever the next caller sends. */
const IMPACT = ["blocks_work", "wrong_result", "confusing", "cosmetic"] as const;
const OUTCOME = ["fixed", "not_a_bug", "duplicate"] as const;

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

  server.registerTool(
    "bug_list",
    {
      description:
        "What has been reported, newest first. WHEN somebody asks what is known to be broken, " +
        "whether a thing they hit is already filed, or what is still open before a release. " +
        "Defaults to OPEN reports across the whole platform, because the common question is " +
        "'what is wrong right now'; pass `status` to see what was decided, or `mine` for the " +
        "caller's own. A bug is not team-private — the platform is one deployment and a defect " +
        "one team hits is one every team has.",
      inputSchema: {
        status: z.enum(["open", ...OUTCOME]).optional().describe("Defaults to open."),
        impact: z.enum(IMPACT).optional(),
        mine: z.boolean().optional().describe("Only the ones this caller reported."),
        query: z.string().optional().describe("Match against the title and detail."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, impact, mine, query, limit }) => {
      const p = db();
      if (!p) return noDb();
      const who = parseCaller(requestHeaders()).email;
      const args: unknown[] = [status ?? "open"];
      const where = ["status = $1"];
      const put = (v: unknown): string => { args.push(v); return `$${args.length}`; };
      if (impact) where.push(`impact = ${put(impact)}`);
      if (mine) where.push(`lower(reported_by) = ${put(who.toLowerCase())}`);
      // Matched on both halves: a person searching for "approve" means the thing they were doing,
      // and whether that word landed in the title or the body is an accident of how they wrote it.
      if (query?.trim()) {
        const q = put(`%${query.trim()}%`);
        where.push(`(title ilike ${q} or detail ilike ${q})`);
      }
      const { rows } = await p.query(
        `select id::text as id, reported_by, team_slug, title, detail, impact, surface,
                initiative, platform_version, status, resolution, resolved_by,
                to_char(reported_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as reported_at
           from zz.bug where ${where.join(" and ")}
          order by reported_at desc limit ${limit ?? 25}`, args);
      // COUNTED SEPARATELY FROM WHAT IS SHOWN. A list capped at 25 that says nothing about the
      // cap reads as the whole answer, and "what is still open before a release" is exactly the
      // question where that matters.
      const { rows: tally } = await p.query<{ status: string; n: string }>(
        "select status, count(*) as n from zz.bug group by status");
      return json({
        showing: rows.length,
        by_status: Object.fromEntries(tally.map((t) => [t.status, Number(t.n)])),
        bugs: rows,
      });
    },
  );

  server.registerTool(
    "bug_resolve",
    {
      description:
        "Close a report with what was decided. `fixed` when it is; `not_a_bug` when the " +
        "behaviour is intended; `duplicate` when it is already filed — name the other id in the " +
        "resolution. REQUIRES a resolution in every case, including the two that are not fixes: " +
        "a report somebody took the trouble to make deserves a sentence, and a status with no " +
        "reason is a tracker nobody learns anything from. Nothing is deleted — a report that " +
        "turned out not to be a bug is still evidence that something was confusing enough to file.",
      inputSchema: {
        id: z.string().uuid().describe("From bug_report or bug_list."),
        status: z.enum(OUTCOME),
        resolution: z.string().min(1).describe(
          "What was decided and why, in a sentence the reporter would recognise as an answer."),
      },
    },
    async ({ id, status, resolution }) => {
      const p = db();
      if (!p) return noDb();
      const who = parseCaller(requestHeaders()).email;
      // ONLY FROM open, so two people closing the same report do not overwrite each other's
      // reasoning — the second is told what the first decided instead of silently replacing it.
      const { rows } = await p.query<{ id: string }>(
        `update zz.bug set status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
          where id = $1::uuid and status = 'open' returning id::text as id`,
        [id, status, resolution.trim(), who]);
      if (!rows.length) {
        const { rows: had } = await p.query<{ status: string; resolution: string | null; resolved_by: string | null }>(
          "select status, resolution, resolved_by from zz.bug where id = $1::uuid", [id]);
        if (!had.length) return text(`ERROR: no bug with id ${id}`);
        return text(
          `ERROR: that report was already closed as \`${had[0].status}\` by ${had[0].resolved_by} — ` +
          `"${had[0].resolution}". If that decision was wrong, file what you now know as a new ` +
          "report naming this id, rather than overwriting somebody's reasoning.");
      }
      logActivity(await userRoot(), null,
        { user: who, action: "bug_resolve", bug: rows[0].id, status });
      return json({ id: rows[0].id, status, resolved_by: who, resolution: resolution.trim() });
    },
  );
}
