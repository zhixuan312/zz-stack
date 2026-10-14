/**
 * /api/console/platform/status — the platform's own health, answered alike to everybody the console
 * lets in.
 *
 * As far as Phase 0 builds it: one measure, malformed calls per 1,000 real-work tool calls, week by
 * week. A malformed call is a `tool_call` whose `refusal_owner` is `ours` (refused for its shape,
 * which a skill or a tool description could have prevented); a real-work call is one whose `origin`
 * is `work`, so the platform's own maintenance clients and every other kind of event are outside the
 * population. Every other part of `PlatformStatus` is answered as unavailable, never as an empty part
 * that reads as "nothing to report".
 *
 * Public by route: it is mounted through `platformPublic`, takes no team and no scope, and reads
 * neither from the request. No figure names a team.
 *
 * COUPLED: the console's `PlatformStatus` in src/lib/platform-shapes.ts, and its fake answer in
 * scripts/fake-gateway/platform-status.ts, which `checks/console-platform-status.ts` compares this
 * route's answer with, key set by key set.
 */
import type { Express } from "express";

import { platformDb } from "../db.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** A weekly rate stands only on this many calls; fewer are drawn as `insufficient`, the value kept. */
const MIN_CALLS = 30;

/** What the measure counts, as `meta.population` says it. */
const POPULATION = "real-work tool calls";

const NOT_BUILT = { state: "unavailable", reason: "not_built" } as const;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Week {
  window: { from: string; to: string; observedFrom: string | null; observedThrough: string | null; complete: boolean };
  figure: { value: number | null; why: "no_data" | "insufficient" | null };
  numerator: number; denominator: number;
}

/** Last against previous, at the precision the page prints a rate per 1,000: one decimal. Fewer
 *  malformed calls is better, so a rise is `worsened`. A week under `MIN_CALLS` is drawn but not
 *  judged, so either one short of them, or missing, is `not_comparable`. */
function judge(last: Week | null, previous: Week | null): "improved" | "worsened" | "unchanged" | "not_comparable" {
  if (!last || !previous || last.denominator < MIN_CALLS || previous.denominator < MIN_CALLS
      || last.figure.value == null || previous.figure.value == null) return "not_comparable";
  const a = Math.round(last.figure.value * 10);
  const b = Math.round(previous.figure.value * 10);
  return a === b ? "unchanged" : a > b ? "worsened" : "improved";
}

export function mountPlatformStatus(app: Express): void {
  app.get("/api/console/platform/status", platformPublic("the platform's status", async (_req, res) => {
    const db = platformDb();
    // One instant for both statements, in whole seconds so the cutoff is the `asOf` the answer
    // states — see periodCutoff for why it is not a `now()` per statement.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = new Date(asOfMs).toISOString();

    // Where coverage begins: the first real-work call. Nothing before it was observed under this
    // definition, so no week that starts earlier is complete.
    const cov = await db.query<{ first_ms: number | null }>(
      `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms
         from zz.event e
        where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $1::timestamptz`, [asOf]);
    const coverageMs = cov.rows[0]?.first_ms ?? null;

    // Every Monday-to-Monday week of the reporting timezone from the one coverage begins in through
    // the running one, a week with no calls included: a missing week stays a no-data point rather
    // than closing the gap between its neighbours. Weeks are cut on local wall time, so a week a
    // daylight-saving change falls in is as long as the clock says.
    const rows = coverageMs === null ? [] : (await db.query<{ from_ms: number; to_ms: number; calls: number; malformed: number }>(
      `with buckets as (
         select date_trunc('week', e.ts at time zone $1::text) as week,
                count(*)::int as calls,
                (count(*) filter (where e.refusal_owner = 'ours'))::int as malformed
           from zz.event e
          where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $2::timestamptz
          group by 1
       )
       select (extract(epoch from (w at time zone $1::text)) * 1000)::float8 as from_ms,
              (extract(epoch from ((w + interval '1 week') at time zone $1::text)) * 1000)::float8 as to_ms,
              coalesce(b.calls, 0) as calls, coalesce(b.malformed, 0) as malformed
         from generate_series(date_trunc('week', $3::timestamptz at time zone $1::text),
                              date_trunc('week', $2::timestamptz at time zone $1::text),
                              interval '1 week') as w
         left join buckets b on b.week = w
        order by w`, [ZZ_TZ, asOf, new Date(coverageMs).toISOString()])).rows;

    const weeks: Week[] = rows.map((r) => {
      const ended = r.to_ms <= asOfMs;
      return {
        window: {
          from: iso(r.from_ms), to: iso(r.to_ms),
          observedFrom: iso(Math.max(r.from_ms, coverageMs!)),
          observedThrough: iso(Math.min(r.to_ms, asOfMs)),
          // Ended, and wholly inside known coverage.
          complete: ended && r.from_ms >= coverageMs!,
        },
        figure: r.calls === 0
          ? { value: null, why: "no_data" }
          : { value: (1000 * r.malformed) / r.calls, why: r.calls < MIN_CALLS ? "insufficient" : null },
        numerator: r.malformed, denominator: r.calls,
      };
    });

    // `last` is the last whole week and `previous` the one before it, whatever their counts: the
    // page draws `last` as last week, and a thin one is drawn as `insufficient` rather than skipped
    // for an older week. A record is drawn only from weeks that are complete and on enough calls.
    // The running week is never any of them.
    const whole = weeks.filter((w) => w.window.complete);
    const last = whole.at(-1) ?? null;
    const previous = whole.at(-2) ?? null;
    const comparable = whole.filter((w) => w.denominator >= MIN_CALLS);
    // Lowest rate is best; a tie keeps the earliest week.
    const best = comparable.reduce<Week | null>((b, w) => (b === null || w.figure.value! < b.figure.value! ? w : b), null);

    res.json({
      meta: {
        asOf: iso(asOfMs), timezone: ZZ_TZ,
        period: { from: weeks[0]?.window.from ?? iso(asOfMs), to: iso(asOfMs) },
        scope: "platform-public", population: POPULATION,
        coverageFrom: coverageMs === null ? null : iso(coverageMs),
      },
      needs: {
        state: "unavailable", rows: [], total: null, knownCount: 0,
        unavailableKinds: ["bugs", "evaluation", "approvals", "drift", "door"], overflowByKind: {},
      },
      measures: [{
        key: "malformed_per_1000", weeks,
        first: comparable[0] ?? null, best, last, previous,
        // Named for neutral measures only; this one has a direction.
        highest: null, lowest: null,
        better: "down", judgement: judge(last, previous),
      }],
      records: NOT_BUILT, doors: NOT_BUILT, running: NOT_BUILT, own: NOT_BUILT,
    });
  }));
}
