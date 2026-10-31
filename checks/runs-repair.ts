#!/usr/bin/env node
/**
 * checks/runs-repair.ts — the run repair recounts the runs it is asked to, and a pass with no bound recounts them all.
 *
 *   node checks/runs-repair.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `reconcileRuns` (services/gateway/src/runs.ts) recomputes a run's counters from the events that name it, and
 * `runRepair` is the gateway's pass over it: the whole log on the first pass, to cover whatever was written while it
 * was down, and on each later one only the runs an event named since its bound. What it establishes, on three seeded
 * runs whose counters disagree with their events — r1's events one old and one written just now, r2's written long
 * ago, r3's just now:
 *
 *   - a bounded pass recounts r1 and r3 and leaves r2 as it was; r1 is recounted whole, its old event included,
 *     because a run is counted whole or not at all;
 *   - a pass with no bound recounts r2 too, answering it alone, because the other two are already right;
 *   - a second pass with no bound rewrites nothing and answers nothing;
 *   - with the three runs wrong again, runRepair's first pass recounts all three and its second only r1 and r3.
 *
 * It starts a throwaway PostgreSQL migrated by the real runner, seeds the runs `scripts/schema/runs-seed.ts`
 * declares, and calls the gateway's own built `reconcileRuns`. The only database it touches is the one it started.
 *
 * Exit 0: every case held. Exit 1: a case failed — the case and what was found. Exit 2: Docker is not available —
 * the check could not run, and that is not a pass.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { root } from "../scripts/deployment.ts";
import { seedRuns } from "../scripts/schema/runs-seed.ts";
import { failing, withThrowawayDbCheck, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "runs-repair";
const fail: Fail = failing(NAME);

type Reconcile = (since: string | null) => Promise<{ runs: number; linked: number }>;

process.exitCode = await withThrowawayDbCheck(NAME,
  `${NAME}: a bounded pass recounts, whole, only the runs an event named since its bound, an unbounded one recounts the rest, ` +
  "a pass over runs that are right rewrites nothing, and runRepair's first pass is unbounded and its next bounded: ok",
  async (client, url) => {
    const ids = await seedRuns(client);
    // r1 is seeded with 4 calls, r2 with 6 and r3 with 10; their events say 2, 2 and 3.
    const event = (run: string, ts: string) => client.query(
      `insert into zz.event (team_id, run_id, kind, ok, tool_key, response_bytes, origin, ts)
       select r.team_id, r.id, 'tool_call', true, 'core:document_read', 100, 'work', $2::timestamptz
         from zz.skill_run r where r.id = $1`, [ids.get(run), ts]);
    for (const ts of ["2026-08-01T00:00:00Z", "2026-08-01T00:01:00Z"]) await event("r2", ts);
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) await event("r3", now);
    await event("r1", "2026-08-01T00:00:00Z");
    await event("r1", now);
    const RUNS = "('session-r1', 'session-r2', 'session-r3')";
    const calls = async () => Object.fromEntries((await client.query<{ key: string; calls: number }>(
      `select session as key, calls from zz.skill_run where session in ${RUNS} order by session`)).rows
      .map((r) => [r.key.replace("session-", ""), r.calls]));
    const wrong = () => client.query(`update zz.skill_run set calls = 99 where session in ${RUNS}`);

    process.env.TEAM_DB_URL = url;
    const load = (p: string) => import(pathToFileURL(join(root, p)).href);
    const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
    await db.initPlatformDb();
    try {
      const { reconcileRuns, runRepair } = (await load("services/gateway/dist/runs.js")) as
        { reconcileRuns: Reconcile; runRepair: () => () => ReturnType<Reconcile> };
      const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const repair = runRepair();
      const steps: [string, () => ReturnType<Reconcile>, { runs: number; linked: number }, Record<string, number>][] = [
        ["a pass bounded to the last hour", () => reconcileRuns(hourAgo), { runs: 2, linked: 5 }, { r1: 2, r2: 6, r3: 3 }],
        ["a pass with no bound", () => reconcileRuns(null), { runs: 1, linked: 2 }, { r1: 2, r2: 2, r3: 3 }],
        ["a second pass with no bound", () => reconcileRuns(null), { runs: 0, linked: 0 }, { r1: 2, r2: 2, r3: 3 }],
        ["runRepair's first pass, every run wrong", async () => { await wrong(); return repair(); }, { runs: 3, linked: 7 }, { r1: 2, r2: 2, r3: 3 }],
        ["runRepair's second pass, every run wrong", async () => { await wrong(); return repair(); }, { runs: 2, linked: 5 }, { r1: 2, r2: 99, r3: 3 }],
      ];
      for (const [step, pass, answer, want] of steps) {
        const got = await pass();
        if (!isDeepStrictEqual(got, answer)) fail(step, `answered ${JSON.stringify(got)}, not ${JSON.stringify(answer)}`);
        const seen = await calls();
        if (!isDeepStrictEqual(seen, want)) fail(step, `left the runs counting ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`);
        console.log(`  ✓ ${step}`);
      }
    } finally {
      await db.platformDb().end().catch(() => undefined);
      delete process.env.TEAM_DB_URL;
    }
  });
