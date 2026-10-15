/**
 * GET /api/console/runs?skill&limit&offset: the active team's recorded skill runs, every one since its
 * first up to the cutoff, narrowed to one skill when asked. The cutoff is the read's moment rounded up
 * to a whole second, as Home rounds it.
 *
 * Work is the active team's, for the superadmin too: the team is the one the caller's identity acts
 * for, and nothing the request names widens it. A skill the team never ran answers nothing.
 *
 * Every figure is read from runsIn's rows, a run of the team being one zz.skill_run row from its first
 * call to its last, with the calls, the refusals and the observed output its own calls recorded:
 *
 *   tiles      the runs; the mean observed output over the runs that measured it, rounded to a byte,
 *              with how many did not; and the run with the most observed output, the newest of a tie
 *   coverage   the union of the runs' spans, time two runs share counted once, beside the summed
 *              length, which counts it once per run, the most open at one instant and the runs of one
 *              call, as observedRuns counts them over the same runs
 *   bySkill    each skill's runs, calls per run, the share of its calls refused, observed output per
 *              run over the runs that measured it, and its typical length: the median over its runs of
 *              more than one call, their count beside; the most output per run first, a skill nothing
 *              measured last, then by name
 *   recent     the runs newest first by their last call, the id breaking a tie, paged
 *
 * A run is active while its last call is within five minutes of the cutoff (isActive); otherwise it
 * reads one call when it made one, and its last call when it made more. Nothing is drawn as running
 * and no run is given an end beyond its last call. Observed output is the response bytes of a run's
 * own calls and nothing more: not what a model read, and not a price.
 *
 * Every part is read from one statement over one table, so when it fails the read fails whole and says
 * so; there is no part that could stand without it.
 *
 * DELIBERATE: no backticks in the comments of this file. check:sql reads it as text, and a backtick in
 * a comment opens a template literal it then parses as code.
 *
 * COUPLED: the console's Runs in src/lib/destination-shapes.ts, and its fake answer in
 * scripts/fake-gateway/work-runs.ts, which checks/console-work-runs.ts compares this route's answer
 * with, key set by key set.
 */
import type { Express } from "express";

import type { Figure, Part, ReadMeta } from "./figures.js";
import { isActive, overlapOf, runsIn } from "./runs-observed.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

type RunRow = {
  id: string; skill: string; initiative: string | null; startedAt: string; lastCallAt: string;
  calls: number; refusals: number; bytes: number | null; lengthMs: number;
  state: "active" | "last_call" | "one_call";
};
type SkillRunRow = {
  skill: string; runs: number; callsPerRun: number; shareRefused: number | null; outputPerRun: number | null;
  typicalMs: number | null; timed: number;
};
type Runs = {
  meta: ReadMeta; since: string | null;
  tiles: { runs: Figure; outputPerRun: Figure & { unmeasured: number }; largest: RunRow | null };
  coverage: { coverageMs: number; summedMs: number; peak: number; oneCall: number };
  bySkill: Part<{ rows: SkillRunRow[] }>;
  recent: Part<{ rows: RunRow[]; total: number }>;
};
type RunsParams = { skill: string | null; limit: number; offset: number };

/** Before every record: a window from here is the whole of it. */
const ALL_TIME = "1970-01-01T00:00:00Z";
const BAD_PAGE = "limit must be a whole number from 1 to 100, and offset one from 0";

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The skill and the page, each given at most once, or the sentence a 400 says. */
function runsParams(query: Record<string, unknown>): RunsParams | string {
  for (const name of ["skill", "limit", "offset"]) {
    if (query[name] !== undefined && typeof query[name] !== "string") return "each filter and the page are given at most once";
  }
  const limit = Number(query.limit ?? 10), offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return BAD_PAGE;
  return { skill: (query.skill as string | undefined) ?? null, limit, offset };
}

/** One skill's runs, as the table by skill reads them. */
function skillRow(skill: string, runs: RunRow[]): SkillRunRow {
  const calls = runs.reduce((n, r) => n + r.calls, 0);
  const timed = runs.filter((r) => r.calls > 1);
  return {
    skill, runs: runs.length, callsPerRun: calls / runs.length,
    shareRefused: calls ? runs.reduce((n, r) => n + r.refusals, 0) / calls : null,
    outputPerRun: mean(runs.flatMap((r) => (r.bytes === null ? [] : [r.bytes]))),
    typicalMs: median(timed.map((r) => r.lengthMs)), timed: timed.length,
  };
}

/** One of runsIn's runs as Runs draws its row: its length to its last call, and its state at the cutoff. Runs reads
 *  its rows through here, and Work's prepared queries their observed output. */
export function runRow(r: Awaited<ReturnType<typeof runsIn>>[number], asOfMs: number): RunRow {
  const startedMs = Date.parse(r.startedAt), lastMs = Date.parse(r.endedAt);
  return {
    id: r.id, skill: r.skill, initiative: r.initiative, startedAt: r.startedAt, lastCallAt: r.endedAt,
    calls: r.calls, refusals: r.refusals, bytes: r.bytes, lengthMs: lastMs - startedMs,
    state: isActive(lastMs, asOfMs) ? "active" : r.calls === 1 ? "one_call" : "last_call",
  };
}

/** Runs for the team at the cutoff, narrowed to the skill asked for. */
export async function runsAt(team: string, params: RunsParams, asOf: string): Promise<Runs> {
  const asOfMs = Date.parse(asOf);
  // The earliest first, as runsIn orders them.
  const runs = (await runsIn(team, { from: ALL_TIME, to: asOf }, asOf))
    .filter((r) => params.skill === null || r.skill === params.skill)
    .map((r) => runRow(r, asOfMs));
  const since = runs.length ? runs[0].startedAt : null;
  const newest = [...runs].sort((a, b) => b.lastCallAt.localeCompare(a.lastCallAt) || a.id.localeCompare(b.id));
  const measured = newest.filter((r) => r.bytes !== null);
  const output = mean(measured.map((r) => r.bytes!));
  const largest = measured.reduce<RunRow | null>((a, r) => (!a || r.bytes! > a.bytes! ? r : a), null);
  // Each span up to the cutoff, as observedRuns clips it.
  const spans = runs.map((r): [number, number] => [Date.parse(r.startedAt), Math.min(Date.parse(r.lastCallAt), asOfMs)]);
  const skills = [...new Set(runs.map((r) => r.skill))];

  return {
    meta: {
      asOf, timezone: ZZ_TZ, period: { from: since ?? asOf, to: asOf }, scope: "active-team",
      population: params.skill === null
        ? `${team}'s recorded skill runs, every one since its first`
        : `${team}'s recorded runs of ${params.skill}, every one since its first`,
      coverageFrom: since,
    },
    since,
    tiles: {
      runs: { value: runs.length, why: null },
      outputPerRun: {
        value: output === null ? null : Math.round(output), why: output === null ? "no_data" : null,
        unmeasured: runs.length - measured.length,
      },
      largest,
    },
    coverage: {
      ...overlapOf(spans),
      summedMs: spans.reduce((n, [s, e]) => n + Math.max(0, e - s), 0),
      oneCall: runs.filter((r) => r.calls === 1).length,
    },
    bySkill: {
      state: "ok",
      data: {
        rows: skills.map((s) => skillRow(s, runs.filter((r) => r.skill === s)))
          .sort((a, b) => (b.outputPerRun ?? -1) - (a.outputPerRun ?? -1) || a.skill.localeCompare(b.skill)),
      },
    },
    recent: { state: "ok", data: { rows: newest.slice(params.offset, params.offset + params.limit), total: runs.length } },
  };
}

export function mountRuns(app: Express): void {
  /** Runs, for the team the caller's identity acts for and no other. */
  app.get("/api/console/runs", platformPublic("runs", async (req, res, { activeTeam }) => {
    if (activeTeam === null) {
      res.status(400).json({ error: "no team: Work is the active team's, and you act for none" });
      return;
    }
    const params = runsParams(req.query as Record<string, unknown>);
    if (typeof params === "string") { res.status(400).json({ error: params }); return; }
    // The cutoff in whole seconds, rounded up, so a call recorded in the second the read began is inside it.
    res.json(await runsAt(activeTeam, params, iso(Math.ceil(Date.now() / 1000) * 1000)));
  }));
}
