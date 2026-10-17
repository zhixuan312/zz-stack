/**
 * skeleton-agents.ts — the walking skeleton's agent reads: `platform_status`, `release_list`, `activity_refusals`,
 * `run_summary` and `record_read` on the real core door, each answering the lead figures the same person's console
 * page draws (AC-7.1, AC-7.5). Not a script of its own: `scripts/skeleton.ts` mounts the gateway's agent door, starts
 * zz-core pointed at it (`startCore`, scripts/skeleton-work.ts), and calls `agentReads` once the built console has
 * drawn every page, so no file passes the 700-line ceiling.
 *
 * Each call goes through the gateway's `/core/mcp` door with the reader's own personal access token, as their
 * client calls it, so the answer is zz-core's tool reaching back through the agent door to the gateway's functions.
 * The client calls itself `skeleton-agents`, so none of these calls joins the run Phase 4's steps made.
 *
 * What it establishes, for the member and for the acting superadmin:
 *
 *   - `tools/list` names the five reads;
 *   - each tool answers structured content and one text part that is its JSON;
 *   - each lead figure, from the tool's structured content and from the page's own gateway read side by side,
 *     agrees, and the built console's page draws it, each compared at the page's own window: Status's verdict
 *     count and its headline; the latest release; Activity's last-week calls and refused tiles, the last whole
 *     week's whatever the tool's `since`; the runs, from `run_summary` with a `since` on the first recorded run's
 *     local date, so its window is Runs' all time; and Record's lead with `record_read` in the page's period, all;
 *   - none of the member's answers, in either half, holds the second team's sentinels, nor a Work read's the
 *     status seed's second team's slug.
 *
 * DELIBERATE: no seed records a release, so the latest release is none on both sides, "None recorded" on the page:
 * a seeded one would change what every platform read above it asserts.
 */
import { Mcp } from "@zz/mcp-client";
import type pg from "pg";

import { answer, count, lead, type PageContext } from "./skeleton-work.ts";

const NAME = "skeleton-agents";
const READS = ["platform_status", "release_list", "activity_refusals", "run_summary", "record_read"] as const;
/** The period Record's page reads when its address names none. COUPLED: RECORD_DEFAULTS in
 *  ../zz-stack-dashboard/src/views/record-context.ts. */
const RECORD_PERIOD = "all";

type Obj = Record<string, unknown>;
type Fig = { value: number | null };

/** What the skeleton hands the agent reads. */
interface AgentContext extends PageContext {
  sql: pg.Client;
  /** Each reader's personal access token, by address. */
  tokens: Map<string, string>;
  /** The reporting timezone the gateway cuts days in. */
  timezone: string;
}

/** The five reads on the core door, for each reader, against their console pages. */
export async function agentReads(ctx: AgentContext, readers: [string, string][]): Promise<void> {
  const { fail, pass } = ctx;
  const first = (await ctx.sql.query<{ day: string | null }>(
    "select to_char(min(started_at) at time zone $1::text, 'YYYY-MM-DD') as day from zz.skill_run", [ctx.timezone])).rows[0]?.day
    ?? fail("the first recorded run", "zz.skill_run holds no run, so Runs' all time is no window to compare");

  for (const [who, email] of readers) {
    const mcp = new Mcp(`${ctx.gateway}/core/mcp`, { client: NAME, pat: ctx.tokens.get(email), timeoutMs: 60_000 });
    const member = email === ctx.member;

    let step = `tools/list on /core/mcp as ${who}`;
    const listed = new Set((await mcp.tools()).map((t) => t.name));
    const missing = READS.filter((r) => !listed.has(r));
    if (missing.length) fail(step, `it does not name ${missing.join(", ")}, of ${listed.size} tools`);
    pass(`${step} names ${READS.join(", ")}`);

    /** One read's structured content, its text part its JSON, and for the member none of another team's words. */
    const read = async <T>(tool: (typeof READS)[number], args: Obj, work = false): Promise<T> => {
      const s = `${tool}(${JSON.stringify(args)}) as ${who}`;
      const env = await mcp.rpc("tools/call", { name: tool, arguments: args });
      if (env.error) fail(s, `it answered the error ${JSON.stringify(env.error).slice(0, 400)}`);
      const result = env.result as { content?: { text?: string }[]; structuredContent?: Obj };
      const text = (result.content ?? []).map((p) => p.text ?? "").join("");
      if (!result.structuredContent) fail(s, `it answered no structured content: ${text.slice(0, 400)}`);
      if (result.content?.length !== 1 || text !== JSON.stringify(result.structuredContent)) {
        fail(s, `its ${result.content?.length ?? 0} text part(s) are not the JSON of its structured content`);
      }
      const withheld = !member ? [] : work ? [...ctx.withheld, ctx.slug] : ctx.withheld;
      const held = withheld.filter((w) => text.includes(w));
      if (held.length) fail(s, `its answer holds ${held.map((w) => `${w} at ${text.indexOf(w)}`).join(", ")}`);
      return result.structuredContent as T;
    };
    /** The tool's figure and the page's read side by side: equal, or the step fails naming both. */
    const agree = (s: string, figure: string, tool: unknown, page: unknown): void => {
      if (JSON.stringify(tool) !== JSON.stringify(page)) {
        fail(s, `${figure} is ${JSON.stringify(tool)} from the tool and ${JSON.stringify(page)} from the page's read`);
      }
    };
    const said = (n: number | null, none: string): string => (n === null ? none : count(n));

    step = `platform_status as ${who}`;
    type Needs = { needs: { total: number | null; headline: string } };
    const status = await read<Needs>("platform_status", {});
    const statusPage = await answer(ctx, step, email, "/api/console/platform/status") as Needs;
    agree(step, "the verdict count", status.needs.total, statusPage.needs.total);
    agree(step, "the headline", status.needs.headline, statusPage.needs.headline);
    await lead(ctx, who, email, "/platform", "data-figures", [status.needs.headline], false);
    pass(`${step} answers ${String(status.needs.total)} as the verdict count, "${status.needs.headline}", as /platform reads and draws it`);

    step = `release_list as ${who}`;
    type Latest = { tiles: { releases: number; latest: { version: string } | null } };
    const releases = await read<Latest>("release_list", {});
    const releasesPage = await answer(ctx, step, email, "/api/console/platform/releases") as Latest;
    agree(step, "the latest release", releases.tiles.latest, releasesPage.tiles.latest);
    agree(step, "the releases", releases.tiles.releases, releasesPage.tiles.releases);
    const version = releases.tiles.latest?.version ?? "None recorded";
    await lead(ctx, who, email, "/platform/releases", 'data-protagonist="Releases"', [`Latest release ${version}`], false);
    pass(`${step} answers the latest release ${version} of ${releases.tiles.releases}, as /platform/releases reads and draws it`);

    step = `activity_refusals as ${who}`;
    type Tiles = { tiles: { calls: { figure: Fig }; refused: { figure: Fig } } };
    const activity = await read<Tiles>("activity_refusals", {}, true);
    const activityPage = await answer(ctx, step, email, "/api/console/activity/summary") as Tiles;
    const [calls, refused] = [activity.tiles.calls.figure.value, activity.tiles.refused.figure.value];
    // Its default window and one that starts after the last whole week alike: the tiles are that week's.
    for (const tiles of [activity.tiles, (await read<Tiles>("activity_refusals", { since: first }, true)).tiles]) {
      agree(step, "last week's calls", tiles.calls.figure.value, activityPage.tiles.calls.figure.value);
      agree(step, "last week's refused calls", tiles.refused.figure.value, activityPage.tiles.refused.figure.value);
    }
    await lead(ctx, who, email, "/activity", 'data-figures="read"',
      [`Calls last week ${said(calls, "Unavailable")}`, `Refused last week ${said(refused, "Unavailable")}`]);
    pass(`${step}, by default and since ${first}, answers last week's ${said(calls, "unavailable")} calls and ` +
      `${said(refused, "unavailable")} refused, as /activity reads and draws them`);

    step = `run_summary since ${first} as ${who}`;
    type Runs = { tiles: { runs: Fig } };
    const runs = await read<Runs>("run_summary", { since: first }, true);
    const runsPage = await answer(ctx, step, email, "/api/console/runs") as Runs;
    agree(step, "the runs", runs.tiles.runs.value, runsPage.tiles.runs.value);
    await lead(ctx, who, email, "/runs", 'data-figures="read"', [`Runs ${said(runs.tiles.runs.value, "Unavailable")}`]);
    pass(`${step}, the first recorded run's day, answers its runs, ${said(runs.tiles.runs.value, "unavailable")}, as /runs reads and draws them over all time`);

    step = `record_read in the period ${RECORD_PERIOD} as ${who}`;
    type Lead = { lead: { estimate: { words: number; assumedWordsPerHour: number } | null } };
    const record = await read<Lead>("record_read", { period: RECORD_PERIOD }, true);
    const recordPage = await answer(ctx, step, email, `/api/console/record?period=${RECORD_PERIOD}`) as Lead;
    agree(step, "the lead", record.lead.estimate, recordPage.lead.estimate);
    const e = record.lead.estimate ?? fail(step, "its lead has no estimate, though Work's steps wrote the team's documents");
    await lead(ctx, who, email, "/record", null, [`Estimated at ${count(e.assumedWordsPerHour)} words an hour, over ${count(e.words)} words`]);
    pass(`${step} answers its lead ${count(e.words)} words at ${count(e.assumedWordsPerHour)} an hour, as /record reads and draws it` +
      (member ? ", and none of the member's five answers holds another team's words" : ""));
  }
}
