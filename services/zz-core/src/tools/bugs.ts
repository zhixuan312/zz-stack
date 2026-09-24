/**
 * Reporting a bug.
 *
 * On /core because zz-core owns the record every flow writes into, and a capability belongs there
 * when every flow needs it and no flow owns it: anybody, in any flow, can hit something broken. It
 * is not a credential or a question of authority, so not /manage; not an evaluation, so not /eval.
 *
 * Not a knowledge node: `knowledge_add` refuses an entry that cannot point at the initiative it came
 * from, and a bug report is the opposite shape — it arrives mid-task from somebody who was trying to
 * do something else, usually before anyone knows the cause.
 *
 * Not an event: zz.event is telemetry, machine-written and carrying no actor on a tool_call by
 * design. A bug report is authored, and belongs to the person who wrote it.
 *
 * Filing is something anybody doing anything might need to do; reading every report on the
 * deployment and deciding what came of one are operator acts, so `registerBugAdminTools` offers
 * them to a superadmin only, as `knowledge_reindex` is.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCaller } from "@zz/contracts";
import { requestHeaders, text } from "@zz/mcp-http";
import { z } from "zod";

import { logActivity } from "../persist.js";
import { userRoot } from "../paths.js";
import { platformEvent } from "../indexing.js";
import { db as db_, teamFor } from "../platform-db.js";

const json = (v: unknown): ReturnType<typeof text> => text(JSON.stringify(v, null, 2));
const noDb = (): ReturnType<typeof text> =>
  text("ERROR: no platform database — bug reports are stored in it, so there is nowhere to put this one");

/** The impact vocabulary, closed and enforced by the schema's own CHECK constraint. `z.enum`
 *  rather than `z.string`, so a caller is refused at the door with the list rather than by Postgres with a
 *  constraint name. The database still checks. */
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
      const p = db_();
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
      // Recorded, because this changes something. Filed against the initiative they name when they
      // name one, so the report shows up beside the work it interrupted.
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


/** Answering a bug report, on the same door it was filed through.
 *
 * Splitting by role — filing is everybody's, answering is an operator's — puts the tools on
 * different doors, which is role deciding a door and what R8 forbids: apply the test and
 * `bug_report` and `bug_list` answer differently with nothing but the caller between them. A bug is
 * one subject and it lives where it is filed.
 *
 * `sup` is passed rather than assumed so every registration carries its own visible `if (sup)`: the
 * gate parses those gates out of the source to decide which role is offered what, and a module that
 * guarded at its call site would read to it as three tools handed to every member.
 *
 * Superadmin, not team admin. A report is not team-scoped — the platform is one deployment, and a
 * defect one team hits is one every team has — so the list is everybody's reports, and handing that
 * to a team's own admin shows them every other team's. */
export function registerBugAdminTools(server: McpServer, sup: boolean): void {
  // Reading every report on the deployment, and deciding what came of one, are acts about the
  // platform rather than about the work somebody was doing when it broke.
  if (sup) server.registerTool(
    "bug_list",
    {
      description:
        "Every bug reported on this deployment, newest first. WHEN somebody asks what is known " +
        "to be broken, whether a thing they hit is already filed, or what is still open before " +
        "a release. Defaults to OPEN, because the common question is what is wrong right now; " +
        "pass `status` to see what was decided. RETURNS the reports and a count by status, so a " +
        "capped list cannot read as the whole answer. Reported through `bug_report` on /core, " +
        "which anybody may call; this side is the operator's.",
      inputSchema: {
        status: z.enum(["open", "fixed", "not_a_bug", "duplicate"]).optional().describe("Defaults to open."),
        impact: z.enum(["blocks_work", "wrong_result", "confusing", "cosmetic"]).optional(),
        reported_by: z.string().optional().describe("Only this person's reports."),
        query: z.string().optional().describe("Match against the title and detail."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, impact, reported_by, query, limit }) => {
      const db = db_();
      if (!db) return noDb();
      const args: unknown[] = [status ?? "open"];
      const where = ["status = $1"];
      const put = (v: unknown): string => { args.push(v); return `$${args.length}`; };
      if (impact) where.push(`impact = ${put(impact)}`);
      if (reported_by) where.push(`lower(reported_by) = ${put(reported_by.toLowerCase())}`);
      // Both halves: somebody searching for "approve" means the thing they were doing, and
      // which field that word landed in is an accident of how the reporter wrote it.
      if (query?.trim()) {
        const q = put(`%${query.trim()}%`);
        where.push(`(title ilike ${q} or detail ilike ${q})`);
      }
      const { rows } = await db.query(
        `select id::text as id, reported_by, team_slug, title, detail, impact, surface,
                initiative, platform_version, status, resolution, resolved_by,
                to_char(reported_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as reported_at
           from zz.bug where ${where.join(" and ")}
          order by reported_at desc limit ${limit ?? 25}`, args);
      // Counted separately from what is shown: a list capped at 25 that says nothing about the cap
      // reads as the whole answer.
      const { rows: tally } = await db.query<{ status: string; n: string }>(
        "select status, count(*) as n from zz.bug group by status");
      return text(JSON.stringify({
        showing: rows.length,
        by_status: Object.fromEntries(tally.map((t) => [t.status, Number(t.n)])),
        bugs: rows,
      }, null, 2));
    },
  );

  if (sup) server.registerTool(
    "bug_resolve",
    {
      description:
        "Close a report with what was decided. `fixed` when it is; `not_a_bug` when the " +
        "behaviour is intended; `duplicate` when it is already filed — name the other id in the " +
        "resolution. REQUIRES a resolution in every case, including the two that are not fixes: " +
        "a report somebody took the trouble to make deserves a sentence, and a status with no " +
        "reason is a tracker nobody learns anything from. RETURNS the id, the status it now " +
        "carries and the resolution as stored, so the close can be read back rather than " +
        "assumed. REFUSES a second close, naming who decided and what they said. CLOSING NEVER " +
        "REMOVES THE ROW, and that is the point of it: `not_a_bug` and `duplicate` are findings, " +
        "and a report that turned out not to be a bug is still evidence that something was " +
        "confusing enough to file. `bug_delete` is not a stronger version of this — it is for " +
        "rows that were never anybody's report.",
      inputSchema: {
        id: z.string().uuid().describe("From bug_list, or from what bug_report handed the reporter."),
        status: z.enum(["fixed", "not_a_bug", "duplicate"]),
        resolution: z.string().min(1).describe(
          "What was decided and why, in a sentence the reporter would recognise as an answer."),
      },
    },
    async ({ id, status, resolution }) => {
      const db = db_();
      if (!db) return noDb();
      const who = parseCaller(requestHeaders()).email;
      // Only from open, so two operators closing the same report do not overwrite each other's
      // reasoning — the second is told what the first decided instead of silently replacing it.
      const { rows } = await db.query<{ id: string }>(
        `update zz.bug set status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
          where id = $1::uuid and status = 'open' returning id::text as id`,
        [id, status, resolution.trim(), who]);
      if (!rows.length) {
        const { rows: had } = await db.query<{ status: string; resolution: string | null; resolved_by: string | null }>(
          "select status, resolution, resolved_by from zz.bug where id = $1::uuid", [id]);
        if (!had.length) return text(`ERROR: no bug with id ${id}`);
        return text(
          `ERROR: that report was already closed as \`${had[0].status}\` by ${had[0].resolved_by} — ` +
          `"${had[0].resolution}". If that decision was wrong, file what you now know as a new ` +
          "report naming this id, rather than overwriting somebody's reasoning.");
      }
      platformEvent({ actor: who, kind: "bug.resolve", subject: id, team: null, detail: { status } });
      return text(JSON.stringify({ id: rows[0].id, status, resolved_by: who, resolution: resolution.trim() }, null, 2));
    },
  );

  // Removing a row that was never a report.
  //
  // Resolve is not delete. `bug_resolve` is how this platform knows what it has fixed: the row, its
  // status and the sentence explaining the decision are the record, kept for ever — including
  // `not_a_bug`, which is a finding about something confusing rather than an admission that nothing
  // happened.
  //
  // This is purely for the fakes. chain-check walks the tracker end to end against a live deployment
  // — file, find, close, refuse a second close — and every run leaves a real row saying "Safe to
  // close; it reports nothing real." Those were never anybody's report; resolving them would put a
  // fake decision in the record of what this platform has fixed, and a tracker whose open list is
  // mostly probes is one people stop reading. This makes the removal accountable — logged,
  // attributed, and no database handed to anyone.
  //
  // Not an undo for a decision you disagree with: file what you now know as a new report naming the
  // old id. The tool cannot tell a fake from a real report and the person calling it can, so the
  // description says which is which.
  if (sup) server.registerTool(
    "bug_delete",
    {
      description:
        "Remove a row permanently, for rows that were never a report. WHEN it was filed by a " +
        "test against a live deployment — a `chain-check probe` — and the tracker is the worse " +
        "for carrying it. RETURNS what was removed, so a deletion can be quoted rather than " +
        "being a silent gap. REFUSES anyone but a superadmin, and an id no report carries. " +
        "NOT THE SAME ACT AS `bug_resolve`, which is how this platform records what it has " +
        "FIXED and deliberately keeps every row it closes. Never delete a report a person " +
        "filed: if its resolution was wrong, file what you now know as a new report naming the " +
        "old id. Irreversible — nothing restores it but the backup.",
      inputSchema: {
        id: z.string().uuid().describe("From bug_list. The row to remove permanently."),
      },
    },
    async ({ id }) => {
      const db = db_();
      if (!db) return noDb();
      const who = parseCaller(requestHeaders()).email;
      // Returning the row, not just the id: this is the last moment its content exists, and an
      // operator who removed the wrong one needs to read what it said in order to re-file it.
      const { rows } = await db.query<{ id: string; title: string; reported_by: string; status: string }>(
        `delete from zz.bug where id = $1::uuid
          returning id::text as id, title, reported_by, status`, [id]);
      if (!rows.length) return text(`ERROR: no bug with id ${id}`);
      platformEvent({ actor: who, kind: "bug.delete", subject: id, team: null, detail: { title: rows[0].title } });
      return text(JSON.stringify({ deleted: rows[0], deleted_by: who }, null, 2));
    },
  );
}
