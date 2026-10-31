#!/usr/bin/env node
/**
 * checks/runs-repair.ts — the run repair recounts the runs it is asked to, and a pass with no bound recounts them all.
 *
 *   node checks/runs-repair.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `reconcileRuns` (services/gateway/src/runs.ts) recomputes a run's counters from the events that name it. The
 * gateway runs it over the whole log once at start, to cover whatever was written while it was down, and then every
 * five minutes over only the runs an event named since its bound. What it establishes, on two seeded runs whose
 * counters disagree with their events, one run's events written long ago and the other's just now:
 *
 *   - a bounded pass recounts the run with a recent event and leaves the other as it was, answering one run and that
 *     run's events;
 *   - a pass with no bound recounts the other too, answering it alone, because the first is already right;
 *   - a second pass with no bound rewrites nothing and answers nothing.
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
  `${NAME}: a bounded pass recounts only the runs an event named since its bound, an unbounded one recounts the rest, ` +
  "and a pass over runs that are right rewrites nothing: ok",
  async (client, url) => {
    const ids = await seedRuns(client);
    // r2 is seeded with 6 calls and r3 with 10; their events say 2 and 3.
    const event = (run: string, ts: string) => client.query(
      `insert into zz.event (team_id, run_id, kind, ok, tool_key, response_bytes, origin, ts)
       select r.team_id, r.id, 'tool_call', true, 'core:document_read', 100, 'work', $2::timestamptz
         from zz.skill_run r where r.id = $1`, [ids.get(run), ts]);
    for (const ts of ["2026-08-01T00:00:00Z", "2026-08-01T00:01:00Z"]) await event("r2", ts);
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) await event("r3", now);
    const calls = async () => Object.fromEntries((await client.query<{ key: string; calls: number }>(
      "select session as key, calls from zz.skill_run where session in ('session-r2', 'session-r3') order by session")).rows
      .map((r) => [r.key.replace("session-", ""), r.calls]));

    process.env.TEAM_DB_URL = url;
    const load = (p: string) => import(pathToFileURL(join(root, p)).href);
    const db = (await load("services/gateway/dist/db.js")) as { initPlatformDb: () => Promise<void>; platformDb: () => pg.Pool };
    await db.initPlatformDb();
    try {
      const { reconcileRuns } = (await load("services/gateway/dist/runs.js")) as { reconcileRuns: Reconcile };
      const steps: [string, string | null, { runs: number; linked: number }, Record<string, number>][] = [
        ["a pass bounded to the last hour", new Date(Date.now() - 60 * 60_000).toISOString(), { runs: 1, linked: 3 }, { r2: 6, r3: 3 }],
        ["a pass with no bound", null, { runs: 1, linked: 2 }, { r2: 2, r3: 3 }],
        ["a second pass with no bound", null, { runs: 0, linked: 0 }, { r2: 2, r3: 3 }],
      ];
      for (const [step, since, answer, want] of steps) {
        const got = await reconcileRuns(since);
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
