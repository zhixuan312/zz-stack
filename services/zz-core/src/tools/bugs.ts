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
import { DESTROYS, READS, WRITES, requestHeaders, text } from "@zz/mcp-http";
import type pg from "pg";
import { z } from "zod";

import { platformEvent } from "../indexing.js";
import { db as db_, teamFor } from "../platform-db.js";

const json = (v: unknown): ReturnType<typeof text> => text(JSON.stringify(v, null, 2));
const noDb = (): ReturnType<typeof text> =>
  text("ERROR: no platform database — bug reports are stored in it, so there is nowhere to put this one");

/** A row's query surface, so these resolvers take the pool or a client already held. */
type Db = Pick<pg.Pool, "query">;

/** The principal id an address names, or null.
 *
 * `zz.bug.reported_by` and `resolved_by` are principal uuids — the migration resolved every
 * historical address to one — so an address is resolved here, once, and a caller nothing carries
 * is refused by address rather than handed to Postgres to fail on a type. */
async function principalId(db: Db, email: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id::text as id from zz.principal where lower(email) = lower($1)", [email]);
  return rows[0]?.id ?? null;
}

/** The refusal for an address no principal carries — reported_by is NOT NULL, so there is
 *  nowhere honest to put this report. */
const noPrincipal = (who: string): ReturnType<typeof text> => text(
  `ERROR: no principal for ${who} — a report is attributed to the person who filed it, and ` +
  "`zz.bug.reported_by` is a principal id. Nothing on this platform carries that address, so " +
  "nothing was written.");

/** The id of the initiative a team holds under `initiative`, or null.
 *
 * Resolved THROUGH the team, never by the slug alone: two teams' initiatives may share a slug, and
 * pairing one team's id with another team's initiative is exactly what
 * `bug_team_id_initiative_id_fkey` refuses. Doing the same lookup here refuses it by name, before
 * the database has to. */
async function initiativeIdIn(db: Db, team: string | null, initiative: string): Promise<string | null> {
  if (!team) return null;
  const { rows } = await db.query<{ id: string }>(
    `select i.id::text as id from zz.initiative i join zz.team t on t.id = i.team_id
      where t.slug = $1 and i.slug = $2`, [team, initiative]);
  return rows[0]?.id ?? null;
}

/** The impact vocabulary, closed and enforced by the schema's own CHECK constraint. `z.enum`
 *  rather than `z.string`, so a caller is refused at the door with the list rather than by Postgres with a
 *  constraint name. The database still checks. */
const IMPACT = ["blocks_work", "wrong_result", "confusing", "cosmetic"] as const;

export function registerBugTools(server: McpServer, platformVersion: string): void {
  server.registerTool(
    "bug_report",
    {
      annotations: WRITES,
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
        initiative: z.string().optional().describe("What they were working on when it happened — the initiative's own name, resolved in your team."),
      },
    },
    async ({ title, detail, impact, surface, initiative }) => {
      const p = db_();
      if (!p) return noDb();
      const who = parseCaller(requestHeaders()).email;
      const team = await teamFor(who);
      const reporter = await principalId(p, who);
      if (!reporter) return noPrincipal(who);
      // The initiative is optional; a name that resolves to nothing is refused rather than
      // dropped, because the report is the only place the interruption is written down and a
      // silently unattached one loses the initiative it interrupted.
      const named = initiative?.trim() || null;
      const initiativeId = named ? await initiativeIdIn(p, team, named) : null;
      if (named && !initiativeId) {
        return text(
          `ERROR: no initiative named "${named}" that you can report against — initiatives are ` +
          `resolved through the team that owns them, and ${team ? `yours is ${team}` : "you belong to none"}. ` +
          "Nothing was written. Leave `initiative` out to file the report with nothing " +
          "against it, which is what a report that interrupted no initiative is.");
      }
      const { rows } = await p.query<{ id: string }>(
        `insert into zz.bug (reported_by, team_id, initiative_id, title, detail, impact, surface,
                             platform_version)
         values ($1::uuid, (select id from zz.team where slug = $2), $3::uuid, $4, $5,
                 coalesce($6, 'wrong_result'), $7, $8)
         returning id::text as id`,
        [reporter, team, initiativeId, title.trim(), detail.trim(), impact ?? null,
         surface?.trim() || null, platformVersion]);
      // Recorded, because this changes something. Filed against the initiative they name when they
      // name one, so the report shows up beside the work it interrupted.
      platformEvent({ actor: who, kind: "bug_report", initiative: named,
        bug: rows[0].id, title: title.trim() });
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
      annotations: READS,
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
      const where = ["b.status = $1"];
      const put = (v: unknown): string => { args.push(v); return `$${args.length}`; };
      if (impact) where.push(`b.impact = ${put(impact)}`);
      // Through the principal, because the column is an id now and nobody searches for one. COUPLED:
      // the same join below hands the address back, so what is filtered on and what is shown are
      // one thing.
      if (reported_by) where.push(`lower(rp.email) = ${put(reported_by.toLowerCase())}`);
      // Both halves: somebody searching for "approve" means the thing they were doing, and
      // which field that word landed in is an accident of how the reporter wrote it.
      if (query?.trim()) {
        const q = put(`%${query.trim()}%`);
        where.push(`(b.title ilike ${q} or b.detail ilike ${q})`);
      }
      // The ids are selected, and the slugs joined back beside them: the id is what every other
      // reader of this row joins on, and the slug is what a person reading the answer recognises.
      // A bug with no team or no initiative has none — left joins, so the row is still returned.
      const { rows } = await db.query(
        `select b.id::text as id,
                b.reported_by::text as reported_by_id, rp.email as reported_by,
                b.resolved_by::text as resolved_by_id, rs.email as resolved_by,
                b.team_id::text as team_id, t.slug as team_slug,
                b.initiative_id::text as initiative_id, i.slug as initiative,
                b.duplicate_of::text as duplicate_of,
                b.title, b.detail, b.impact, b.surface, b.platform_version, b.status, b.resolution,
                to_char(b.reported_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as reported_at
           from zz.bug b
           left join zz.principal rp on rp.id = b.reported_by
           left join zz.principal rs on rs.id = b.resolved_by
           left join zz.team t on t.id = b.team_id
           left join zz.initiative i on i.id = b.initiative_id
          where ${where.join(" and ")}
          order by b.reported_at desc limit ${limit ?? 25}`, args);
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
      annotations: WRITES,
      description:
        "Close a report with what was decided. `fixed` when it is; `not_a_bug` when the " +
        "behaviour is intended; `duplicate` when it is already filed — pass the id of the report " +
        "it duplicates as `duplicate_of`, which is required for that status and refused for every " +
        "other. REQUIRES a resolution in every case, including the two that are not fixes: " +
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
        duplicate_of: z.string().uuid().optional().describe(
          "The report this one duplicates, for a `duplicate` resolution. Required for it and " +
          "refused without it: a duplicate that names no target is a close nobody can follow, " +
          "and the two are one fact the schema itself keeps in step. The target is a report in " +
          "your own team that is not this one — a duplicate is read by the team that filed it."),
      },
    },
    async ({ id, status, resolution, duplicate_of }) => {
      const db = db_();
      if (!db) return noDb();
      // Both directions refused before the database sees the statement: `status = 'duplicate'` and
      // a target are one fact, and the CHECK constraint is the backstop for a writer that is not
      // this one rather than the door a caller reaches.
      if (status === "duplicate" && !duplicate_of) {
        return text(
          `ERROR: a \`duplicate\` resolution has to name the report it duplicates — pass the other ` +
          "id as `duplicate_of`. A duplicate pointing at nothing records no finding: the next " +
          "reader cannot tell it from a report somebody closed with no reason. Nothing was written.");
      }
      if (status !== "duplicate" && duplicate_of) {
        return text(
          `ERROR: \`duplicate_of\` is only for a \`duplicate\` resolution, and this one is ` +
          `\`${status}\`. Nothing was written. To record that this report duplicates another, ` +
          "close it as `duplicate`; to close it as this status, leave the target out.");
      }
      const who = parseCaller(requestHeaders()).email;
      const resolver = await principalId(db, who);
      if (!resolver) return noPrincipal(who);
      if (duplicate_of) {
        const { rows: target } = await db.query<{ id: string; team_id: string | null; is_self: boolean }>(
          "select id::text as id, team_id::text as team_id, (id = $2::uuid) as is_self " +
          "from zz.bug where id = $1::uuid", [duplicate_of, id]);
        if (!target.length) {
          return text(`ERROR: no bug with id ${duplicate_of} — ` +
            "`duplicate_of` names the report this one duplicates, and nothing carries that id.");
        }
        if (target[0].is_self) {
          return text(`ERROR: bug ${id} cannot duplicate itself — ` +
            "`duplicate_of` names the OTHER report this one duplicates, and a close saying " +
            "\"same as this one\" records nothing a reader can follow. Nothing was written.");
        }
        const { rows: mine } = await db.query<{ team_id: string | null }>(
          "select team_id::text as team_id from zz.bug where id = $1::uuid", [id]);
        if (mine.length && mine[0].team_id !== target[0].team_id) {
          return text(`ERROR: bug ${id} cannot duplicate bug ${duplicate_of} — a duplicate is read ` +
            "by the team that filed the report, and `bug_list` answers for one team, so the report " +
            "it points at has to be one of yours. Nothing was written.");
        }
      }
      // Only from open, so two operators closing the same report do not overwrite each other's
      // reasoning — the second is told what the first decided instead of silently replacing it.
      const { rows } = await db.query<{ id: string }>(
        `update zz.bug set status = $2, resolution = $3, resolved_by = $4::uuid,
                           duplicate_of = $5::uuid, resolved_at = now()
          where id = $1::uuid and status = 'open' returning id::text as id`,
        [id, status, resolution.trim(), resolver, duplicate_of ?? null]);
      if (!rows.length) {
        const { rows: had } = await db.query<{ status: string; resolution: string | null; resolved_by: string | null }>(
          `select b.status, b.resolution, p.email as resolved_by from zz.bug b
             left join zz.principal p on p.id = b.resolved_by where b.id = $1::uuid`, [id]);
        if (!had.length) return text(`ERROR: no bug with id ${id}`);
        return text(
          `ERROR: that report was already closed as \`${had[0].status}\` by ${had[0].resolved_by} — ` +
          `"${had[0].resolution}". If that decision was wrong, file what you now know as a new ` +
          "report naming this id, rather than overwriting somebody's reasoning.");
      }
      platformEvent({ actor: who, kind: "bug.resolve", subject: id, team: null, detail: { status } });
      return text(JSON.stringify({
        id: rows[0].id, status, resolved_by: who, resolution: resolution.trim(),
        duplicate_of: duplicate_of ?? null,
      }, null, 2));
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
      annotations: DESTROYS,
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
      // `using` rather than a second read, so the reporter's address comes back from the row being
      // removed and not from one a concurrent close could have changed.
      const { rows } = await db.query<{ id: string; title: string; reported_by: string; status: string }>(
        `delete from zz.bug b using zz.principal p
          where b.reported_by = p.id and b.id = $1::uuid
          returning b.id::text as id, b.title, p.email as reported_by, b.status`, [id]);
      if (!rows.length) return text(`ERROR: no bug with id ${id}`);
      platformEvent({ actor: who, kind: "bug.delete", subject: id, team: null, detail: { title: rows[0].title } });
      return text(JSON.stringify({ deleted: rows[0], deleted_by: who }, null, 2));
    },
  );
}
