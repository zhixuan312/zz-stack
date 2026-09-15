/**
 * The bug tracker's operator half.
 *
 * FILING IS ON /core AND ANSWERING IS HERE, which is the split that matters. Anybody doing
 * anything might hit something broken, so `bug_report` is on the door everyone holds. Reading
 * every report on the deployment, deciding what came of one, and removing a row that was never
 * a report are acts ABOUT the platform rather than about the work somebody was doing when it
 * broke.
 *
 * THREE TOOLS, AND RESOLVE IS NOT DELETE. `bug_resolve` is how the platform knows what it has
 * FIXED — the row and its reasoning are the record, and closing one keeps both for ever.
 * `bug_delete` exists for one reason that has nothing to do with that: rows filed by a test
 * against a live deployment, which were never reports and make the tracker worse by being in
 * it. Anything a person filed gets resolved; only the fakes get deleted.
 *
 * SUPERADMIN, not team admin — the caller guards that, and this module is only reached when it
 * holds. A report is not team-scoped: the platform is one deployment, a defect one team hits is
 * one every team has, and the list is therefore everybody's reports. Handing that to a team's
 * own admin would show them every other team's, which is a wider reading of "admin" than a team
 * admin was given.
 *
 * Split out of access-door.ts when `bug_delete` joined the other two and that file reached the
 * 700-line ceiling. By subject, not by line count: a tracker is a different thing from keys,
 * teams and installs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { text } from "@zz/mcp-http";
import { z } from "zod";

import { caller } from "../credentials.js";
import { platformDb, platformDbReady } from "../db.js";
import { logEvent } from "../events.js";

/** `sup` is passed rather than assumed so every registration carries its own visible
 *  `if (sup)`, the way the other doors write it. The gate parses those gates out of the
 *  SOURCE to decide which role is offered what, so a module that guarded at its call site
 *  instead read to it as three tools handed to every member. */
export function registerBugAdminTools(server: McpServer, sup: boolean): void {
  // ── the bugs people report ─────────────────────────────────────────────────────────────
  //
  // FILING IS ON /core AND ANSWERING IS HERE, which is the split that matters. Anybody doing
  // anything might hit something broken, so `bug_report` is on the door everyone holds. Reading
  // every report on the deployment, and deciding what came of one, are acts ABOUT the platform
  // rather than about the work somebody was doing when it broke — the same reason
  // `knowledge_reindex` sits above this rather than on /core.
  //
  // SUPERADMIN, not team admin. A report is not team-scoped: the platform is one deployment, a
  // defect one team hits is one every team has, and the list is therefore everybody's reports.
  // Handing that to a team's own admin would show them every other team's, which is a wider
  // reading of "admin" than a team admin was given.
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
      if (!platformDbReady()) return text("ERROR: no platform database — bug reports live in it");
      const db = platformDb();
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
      // COUNTED SEPARATELY FROM WHAT IS SHOWN. A list capped at 25 that says nothing about the
      // cap reads as the whole answer, and "what is open before a release" is exactly the
      // question where that matters.
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
      if (!platformDbReady()) return text("ERROR: no platform database — bug reports live in it");
      const db = platformDb();
      const who = caller().email;
      // ONLY FROM open, so two operators closing the same report do not overwrite each other's
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
      logEvent({ actor: who, kind: "bug.resolve", subject: id, detail: { status } });
      return text(JSON.stringify({ id: rows[0].id, status, resolved_by: who, resolution: resolution.trim() }, null, 2));
    },
  );

  // ── removing a row that was never a report ─────────────────────────────────────────────
  //
  // RESOLVE IS NOT DELETE, and keeping them apart is the whole design. `bug_resolve` is how
  // this platform knows WHAT IT HAS FIXED: the row, its status and the sentence explaining the
  // decision are the record, and they are kept for ever — including `not_a_bug`, which is a
  // finding about something confusing rather than an admission that nothing happened.
  //
  // THIS IS PURELY FOR THE FAKES. chain-check walks the tracker end to end against a live
  // deployment — file, find, close, refuse a second close — and every run leaves a real row
  // saying "Safe to close; it reports nothing real." Five accumulated beside two genuine
  // reports before anybody looked. Those were never anybody's report, resolving them would put
  // a fake decision in the record of what this platform has fixed, and a tracker whose open
  // list is mostly probes is a tracker people stop reading. Until now the only way out was
  // psql; this makes the same act accountable — logged, attributed, and no database handed to
  // anyone.
  //
  // NOT AN UNDO for a decision you disagree with. bug_resolve already says to file what you now
  // know as a new report naming the old id rather than overwriting somebody's reasoning;
  // deleting the row is the louder version of that mistake. The tool cannot tell a fake from a
  // real report and the person calling it can, so the description says which is which.
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
      if (!platformDbReady()) return text("ERROR: no platform database — bug reports live in it");
      const db = platformDb();
      const who = caller().email;
      // RETURNING the row, not just the id: this is the last moment its content exists, and an
      // operator who removed the wrong one needs to read what it said in order to re-file it.
      const { rows } = await db.query<{ id: string; title: string; reported_by: string; status: string }>(
        `delete from zz.bug where id = $1::uuid
          returning id::text as id, title, reported_by, status`, [id]);
      if (!rows.length) return text(`ERROR: no bug with id ${id}`);
      logEvent({ actor: who, kind: "bug.delete", subject: id, detail: { title: rows[0].title } });
      return text(JSON.stringify({ deleted: rows[0], deleted_by: who }, null, 2));
    },
  );
}
