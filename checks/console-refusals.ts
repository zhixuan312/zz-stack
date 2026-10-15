#!/usr/bin/env node
/**
 * checks/console-refusals.ts — a team's refusals are counted once, under one of four owners, by week, and
 * its messages grouped by owner, tool and normalised text (AC-6.3).
 *
 *   node checks/console-refusals.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL migrated by the real runner (`withThrowawayDb`), seeds what
 * `scripts/schema/refusals-seed.ts` declares, and calls the gateway's own built `refusalWeeks` and
 * `refusalGroups` (`services/gateway/dist/console/refusals.js`). What it establishes, with the expected
 * values written in the seed:
 *
 *   - by week, the four owners of the team's real-work refused calls sum to the week's refused total, and
 *     the weeks sum to the window's, read as one month; the calls each week are the real-work calls,
 *     refused or not; the weeks are cut in the reporting timezone, and what
 *     lies before the window or after the cutoff is in none of them;
 *   - a refused row with no owner counts as `other`;
 *   - a `theirs` refusal and an `other` refusal added to a week raise that week's total and their own
 *     owner's count by one each, its calls by two, and change no other owner and no other week;
 *   - a maintenance refusal changes no count and is counted apart, and so is the maintenance call beside it;
 *   - another team's refusals change nothing, and their text is in no answer;
 *   - groups are by owner, tool and normalised message: two messages differing only in a number, or only in
 *     an id, fall into one group, answered as its most recent text; one text under two tools is two groups;
 *     a refusal with no text is its own group, its message null, in its owner's count; each group answers
 *     its count and last-seen time, the largest first and then the most recent;
 *   - the 20 largest groups are answered and the rest folded with its count, and a smaller limit folds the
 *     same way;
 *   - the gateway's grouping statement spells the normaliser @zz/contracts exports, normalizedRefusalSql,
 *     the one zz-core's evaluation interpolates.
 *
 * DELIBERATE: the reporting timezone is Asia/Singapore, eight hours ahead of UTC, and the first call is
 * 07:30 on a Monday locally, 23:30 on the Sunday before in UTC: a week cut on UTC's calendar moves it.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import {
  AS_OF, EXPECTED, MANY, MANY_RULES, OTHER, SENTINEL, TEAM, TIMEZONE, WINDOW, seedRefusals,
} from "../scripts/schema/refusals-seed.ts";
import { withThrowawayDb } from "../scripts/schema/throwaway.ts";

const NAME = "console-refusals";
const DONE = "console-refusals: a team's real-work refusals are counted once under one of four owners by week, summing to " +
  "the refused total and the weeks to the window's, a theirs or an other added moving only its own owner, maintenance and " +
  "another team apart; and grouped by owner, tool and normalised message, the 20 largest answered and the rest folded: ok";

type Span = { from: string; to: string };
type Owners = Record<"guardrail" | "ours" | "theirs" | "other", number>;
type Period = { window: Record<string, unknown>; complete: boolean; calls: number; refused: number; owners: Owners };
type Weeks = { periods: Period[]; maintenance: { calls: number; refused: number } };
type Group = { owner: string; tool: string; message: string | null; count: number; lastSeen: string };
type Groups = { rows: Group[]; groups: number; rest: { groups: number; count: number } | null };
type Reads = {
  refusalWeeks: (team: string, window: Span, asOf: string, grain: string) => Promise<Weeks>;
  refusalGroups: (team: string, window: Span, asOf: string, limit?: number) => Promise<Groups>;
};

class CaseFailure extends Error {}
function fail(step: string, detail: string): never {
  throw new CaseFailure(`${NAME}: FAILED at "${step}": ${detail}`);
}
const pass = (line: string): void => console.log(`  ok  ${line}`);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 900);
const same = (step: string, found: unknown, want: unknown): void => {
  if (!isDeepStrictEqual(found, want)) fail(step, `found ${show(found)}, expected ${show(want)}`);
};
const sum = (o: Owners): number => o.guardrail + o.ours + o.theirs + o.other;

async function cases(db: pg.Client, read: Reads, add: () => Promise<void>): Promise<void> {
  const weeks = () => read.refusalWeeks(TEAM, WINDOW, AS_OF, "week");
  const groups = (limit?: number) => read.refusalGroups(TEAM, WINDOW, AS_OF, limit);

  let step = "the four owners by week, summing to the refused total and the weeks to the window's";
  const before = await weeks();
  same(step, before.periods, EXPECTED.weeks);
  for (const p of before.periods) if (sum(p.owners) !== p.refused) fail(step, `${show(p.window)}'s owners sum to ${sum(p.owners)}, not ${p.refused}`);
  const month = await read.refusalWeeks(TEAM, WINDOW, AS_OF, "month");
  same(step, month.periods, EXPECTED.month);
  const total = before.periods.reduce((n, p) => n + p.refused, 0), calls = before.periods.reduce((n, p) => n + p.calls, 0);
  if (total !== month.periods[0].refused || calls !== month.periods[0].calls) fail(step, `the weeks sum to ${total} of ${calls}, the window ${show(month.periods[0])}`);
  pass("W1 8 calls, 4 refused (guardrail 2, ours 1, other 1); W2 10, 6 (3, 2, 0, 1); the running W3 4, 2 (2, 0, 0, 0); " +
       "each week's owners sum to its refused total and the weeks to the window's 12 of 22, read as one month");
  pass("the Monday 07:30 call counts in W1, and what lies before the window or after the cutoff counts nowhere");
  pass("a refused row with no owner is counted as other");

  step = "maintenance is counted apart";
  same(step, before.maintenance, EXPECTED.maintenance);
  pass("team one's three maintenance calls and two refusals, one of them PLAN under document_write, are counted apart and in no owner or group");

  step = "groups by owner, tool and normalised message";
  const all = await groups();
  same(step, all, { rows: EXPECTED.groups, groups: EXPECTED.groups.length, rest: null });
  pass("two messages differing only in a number (section 4, section 7) and two only in an id (in either case) are one group, " +
       "answered as its newest text; PLAN under two tools is two groups; the refusal with no text is its own group, message null, " +
       "in other's count; each answers its count and last-seen time, the largest first and then the most recent");

  step = "the rest folded with its count";
  same(step, await groups(4), { rows: EXPECTED.groups.slice(0, 4), groups: 9, rest: { groups: 5, count: 5 } });
  const many = await read.refusalGroups(MANY, WINDOW, AS_OF);
  const doubled = MANY_RULES.slice(0, 20).reverse().map((r) => `ERROR: rule ${r} is broken`);
  same(step, [many.rows.map((g) => [g.message, g.count]), many.groups, many.rest], [doubled.map((m) => [m, 2]), 23, { groups: 3, count: 3 }]);
  pass("of 23 groups the 20 largest are answered and the other 3 folded with their 3 refusals; asked for 4 of team one's 9, the other 5 fold the same way");

  step = "another team's refusals change nothing";
  const text = JSON.stringify([before, month, all, await groups(4)]);
  if (text.includes(SENTINEL)) fail(step, "an answer holds team two's refusal text");
  await db.query("delete from zz.event e using zz.team t where t.id = e.team_id and t.slug = $1", [OTHER]);
  same(step, await weeks(), before);
  same(step, await groups(), all);
  pass("team two's GATE under document_write in W1 and its own text in W2 are in no count, no group and no answer: deleting them changes nothing");

  step = "a theirs and an other added to a week";
  await add();
  const after = await weeks();
  same(step, [after.periods[0], after.periods[1], after.periods[2], after.maintenance], [EXPECTED.weeks[0], EXPECTED.added, EXPECTED.weeks[2], EXPECTED.maintenance]);
  pass("W2 reads 12 calls and 8 refused, theirs 1 and other 2, its guardrail and ours unchanged, and W1, W3 and the maintenance as before");

  step = "a maintenance refusal changes no count";
  await db.query("delete from zz.event e using zz.team t where t.id = e.team_id and t.slug = $1 and e.origin <> 'work'", [TEAM]);
  const unkept = await weeks();
  same(step, [unkept.periods, unkept.maintenance], [after.periods, { calls: 0, refused: 0 }]);
  pass("deleting the maintenance changes no week and no owner, and only the maintenance count beside them");

  step = "the gateway spells the normaliser @zz/contracts exports";
  const { normalizedRefusalSql } = (await import(pathToFileURL(join(root, "packages/contracts/dist/index.js")).href)) as
    { normalizedRefusalSql: (column: string) => string };
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const source = flat(readFileSync(join(root, "services/gateway/src/console/refusals.ts"), "utf8"));
  if (!source.includes(flat(normalizedRefusalSql("e.refusal")))) fail(step, `refusals.ts does not hold ${normalizedRefusalSql("e.refusal")}`);
  const { rows: [folded] } = await db.query<{ a: string; b: string }>(
    `select ${normalizedRefusalSql("$1::text")} as a, ${normalizedRefusalSql("$2::text")} as b`,
    ["Invalid arguments: section 4 has no check", "INVALID ARGUMENTS: section 17 has no check"]);
  if (folded.a !== folded.b || folded.a !== "invalid arguments: section # has no check") fail(step, show(folded));
  pass("refusals.ts groups by normalizedRefusalSql(\"e.refusal\") as @zz/contracts spells it, which folds case and digits");
}

async function run(db: pg.Client, url: string): Promise<void> {
  const { add } = await seedRefusals(db);
  // DELIBERATE: set before the gateway's modules load, which read both once.
  process.env.TEAM_DB_URL = url;
  process.env.ZZ_TZ = TIMEZONE;
  const load = (p: string) => import(pathToFileURL(join(root, "services/gateway/dist", p)).href);
  const dbModule = (await load("db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
  await dbModule.initPlatformDb();
  try {
    await cases(db, (await load("console/refusals.js")) as Reads, add);
  } finally {
    await dbModule.platformDb().end().catch(() => undefined);
    delete process.env.TEAM_DB_URL;
    delete process.env.ZZ_TZ;
  }
}

async function main(): Promise<number> {
  let dbUrl = "";
  try {
    await withThrowawayDb((db) => run(db, dbUrl), async (u) => { dbUrl = u; });
  } catch (err) {
    if (err instanceof Error && /Docker is not running/.test(err.message)) {
      console.error(`${NAME}: Docker is not available — the check could not run, which is not a pass`);
      return 2;
    }
    console.error(err instanceof CaseFailure ? err.message : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
    return 1;
  }
  console.log(DONE);
  return 0;
}

process.exitCode = await main();
