/**
 * The five reads the core door offers every caller, a member's token included: platform_status,
 * release_list, activity_refusals, run_summary and record_read. Each is a function of its caller and its
 * arguments that answers its page's DTO, by calling the body its page's route calls, so a tool's figures
 * are the page's by construction and nothing here counts anything:
 *
 *   platformStatus     statusOf (platform-status.ts), with one canonical tool's open reports
 *   releaseList        releasesOf (platform-releases.ts), each row with its upgrade notes
 *   activityRefusals   summaryOf (activity.ts), with the window's refusals by tool and its ten largest groups
 *   runSummary         runsAt (runs.ts)
 *   recordRead         recordOf (record.ts)
 *
 * The caller is the identity the gateway resolved: its address, whether it is the superadmin, and the team
 * it acts for, as platformPublic gives them. No function takes a team; the three Work reads are the active
 * team's and answer a caller in none the route's own no-team sentence.
 *
 * An argument outside its vocabulary or bounds, a malformed or future date and a version no release
 * records are an input error naming the argument, before anything is read; a read that fails keeps the
 * page's own unavailable parts, and one the page answers 500 throws.
 *
 * Absent, an argument means what the route means without it: since on Activity and Runs is the route's
 * whole window. The tools' own defaults are AGENT_READS': since seven local days before the read's cutoff
 * on activity_refusals and run_summary, and five releases a page on release_list, at most 50.
 *
 * DELIBERATE: no backticks in the comments of this file, as in the route files it calls: check:sql reads
 * the console's files as text.
 *
 * COUPLED: the core door's agent-read tools, registered by zz-core, declare the arguments AGENT_READS takes;
 * checks/console-agent-reads.ts compares each function's answer with its route's.
 */
import { NO_TEAM as NO_ACTIVITY_TEAM, cutoff, summaryOf, type ActivitySummary } from "./activity.js";
import type { Part } from "./figures.js";
import { canonicalSurface, vocabulary } from "./platform-bugs.js";
import { releasesOf, type ReleaseDetail, type Releases } from "./platform-releases.js";
import { statusOf, type PlatformStatus } from "./platform-status.js";
import { BAD_PAGE as BAD_RECORD_PAGE, NO_TEAM as NO_RECORD_TEAM, PERIODS, recordOf, type PeriodName, type RecordRead } from "./record.js";
import { refusalGroups, type RefusalGroup } from "./refusals.js";
import { BAD_PAGE, NO_TEAM, runsAt, type Runs } from "./runs.js";
import { ZZ_TZ } from "./shared.js";
import { addDays, isDate, localDay, midnight } from "./work-query-buckets.js";

/** Who asks: the identity's address, and the role and active team platformPublic resolves from it. */
export type Caller = { email: string; superadmin: boolean; activeTeam: string | null };
/** A refusal of the arguments, naming the one at fault. */
type InputError = { inputError: string };

type ReleaseList = Releases<Omit<ReleaseDetail, "changelog">>;
type ActivityRefusals = ActivitySummary & {
  byTool: Part<{ tool: string; count: number }[]>;
  messages: Part<RefusalGroup[]>;
};

/** How many releases a page of release_list holds when none is asked, and at most. */
const RELEASES = { default: 5, max: 50 };
/** How many local days before the cutoff the tools' since falls when none is asked. */
const SINCE_DAYS = 7;
/** How many groups activity_refusals answers as its messages. */
const MESSAGES = 10;

const SINCE = `since must be a date, YYYY-MM-DD, on or before today in ${ZZ_TZ}`;
const TOOL = "tool must name a tool one of the doors registers, a door (core, manage, eval) or console";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const whole = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
/** A local date on or before the cutoff's, or absent. */
const dateOk = (v: unknown, asOf: string): boolean => v === undefined || (typeof v === "string" && isDate(v) && v <= localDay(Date.parse(asOf)));
/** A page, or the sentence that refuses it. */
function pageOf(args: { limit?: unknown; offset?: unknown }, limit: { default: number; max: number }, bad: string): { limit: number; offset: number } | string {
  const page = { limit: args.limit ?? limit.default, offset: args.offset ?? 0 };
  return whole(page.limit, 1, limit.max) && whole(page.offset, 0, Number.MAX_SAFE_INTEGER) ? page as { limit: number; offset: number } : bad;
}

/** Status for the caller: with a canonical tool, that tool's open reports as anybody reads them in the queue. */
export async function platformStatus(caller: Caller, args: { tool?: string }): Promise<PlatformStatus | InputError> {
  if (args.tool === undefined) return statusOf(caller, null);
  const tool = typeof args.tool === "string" ? canonicalSurface(args.tool, await vocabulary()) : null;
  return tool === null ? { inputError: TOOL } : statusOf(caller, tool);
}

/** Releases, a page of the latest or of those recorded after since, each row with its upgrade notes. */
export async function releaseList(_caller: Caller, args: { limit?: number; offset?: number; since?: string }): Promise<ReleaseList | InputError> {
  const page = pageOf(args, RELEASES, `limit must be a whole number from 1 to ${RELEASES.max}, and offset one from 0`);
  if (typeof page === "string") return { inputError: page };
  if (args.since !== undefined && !text(args.since)) return { inputError: "since must name a recorded release's version" };
  const read = await releasesOf({ ...page, since: args.since ?? null });
  if (read === null) return { inputError: "since names no recorded release: name one release_list or Releases lists" };
  const { rows, ...rest } = read;
  return {
    ...rest,
    rows: rows.state === "ok" ? { state: "ok", data: { rows: rows.data.rows.map(({ changelog: _c, ...row }) => row), total: rows.data.total } } : rows,
  };
}

/** Activity's summary for the active team, from since and in the initiative when asked, with the window's
 *  refusals summed by tool and its ten largest groups. */
export async function activityRefusals(caller: Caller, args: { since?: string; initiative?: string }, asOf = cutoff()): Promise<ActivityRefusals | InputError> {
  if (caller.activeTeam === null) return { inputError: NO_ACTIVITY_TEAM };
  if (!dateOk(args.since, asOf)) return { inputError: SINCE };
  if (args.initiative !== undefined && !text(args.initiative)) return { inputError: "initiative must be the slug of one of your team's initiatives" };
  const team = caller.activeTeam, initiative = args.initiative ?? null;
  const summary = await summaryOf(team, asOf, { from: args.since === undefined ? null : iso(midnight(args.since)), initiative });
  let byTool: ActivityRefusals["byTool"];
  try {
    const all = await refusalGroups(team, { from: summary.meta.period.from, to: asOf }, asOf, Infinity, initiative);
    const sums = new Map<string, number>();
    for (const g of all.rows) sums.set(g.tool, (sums.get(g.tool) ?? 0) + g.count);
    byTool = { state: "ok", data: [...sums].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || (a.tool < b.tool ? -1 : 1)) };
  } catch (err) {
    console.error("console activity: the refusals by tool could not be read:", err);
    byTool = { state: "unavailable", reason: "query_failed" };
  }
  const messages: ActivityRefusals["messages"] = summary.groups.state === "ok"
    ? { state: "ok", data: summary.groups.data.rows.slice(0, MESSAGES) } : summary.groups;
  return { ...summary, byTool, messages };
}

/** Runs for the active team, from since when asked, narrowed to the skill. */
export async function runSummary(caller: Caller, args: { since?: string; skill?: string; limit?: number; offset?: number }, asOf = cutoff()): Promise<Runs | InputError> {
  if (caller.activeTeam === null) return { inputError: NO_TEAM };
  if (!dateOk(args.since, asOf)) return { inputError: SINCE };
  if (args.skill !== undefined && !text(args.skill)) return { inputError: "skill must be a skill's name" };
  const page = pageOf(args, { default: 10, max: 100 }, BAD_PAGE);
  if (typeof page === "string") return { inputError: page };
  return runsAt(caller.activeTeam, { skill: args.skill ?? null, ...page, since: args.since ?? null }, asOf);
}

/** Record for the active team over the period, the approvals in it the caller's. */
export async function recordRead(caller: Caller, args: { period?: string; limit?: number; offset?: number }, asOf = cutoff()): Promise<RecordRead | InputError> {
  if (caller.activeTeam === null) return { inputError: NO_RECORD_TEAM };
  const period = args.period ?? "all";
  if (!PERIODS.includes(period as PeriodName)) return { inputError: `period must be one of ${PERIODS.join(", ")}` };
  const page = pageOf(args, { default: 10, max: 100 }, BAD_RECORD_PAGE);
  if (typeof page === "string") return { inputError: page };
  return recordOf(caller.activeTeam, caller.email, period as PeriodName, page, asOf);
}

/** Each tool as the door calls it, with the tools' own defaults: since seven local days before the cutoff on
 *  activity_refusals and run_summary. Only the arguments the tool declares are read. */
export const AGENT_READS: Record<"platform_status" | "release_list" | "activity_refusals" | "run_summary" | "record_read",
  (caller: Caller, args: Record<string, unknown>) => Promise<object>> = {
  platform_status: (caller, { tool }) => platformStatus(caller, { tool: tool as string | undefined }),
  release_list: (caller, { limit, since }) => releaseList(caller, { limit: limit as number | undefined, since: since as string | undefined }),
  activity_refusals: (caller, { since, initiative }) => {
    const asOf = cutoff();
    return activityRefusals(caller, {
      since: (since as string | undefined) ?? addDays(localDay(Date.parse(asOf)), -SINCE_DAYS), initiative: initiative as string | undefined,
    }, asOf);
  },
  run_summary: (caller, { since, skill }) => {
    const asOf = cutoff();
    return runSummary(caller, { since: (since as string | undefined) ?? addDays(localDay(Date.parse(asOf)), -SINCE_DAYS), skill: skill as string | undefined }, asOf);
  },
  record_read: (caller, { period }) => recordRead(caller, { period: period as string | undefined }),
};
