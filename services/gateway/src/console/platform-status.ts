/**
 * /api/console/platform/status — the platform's own health, answered alike to everybody the console
 * lets in.
 *
 * As far as Phase 0 builds it: one measure, malformed calls per 1,000 real-work tool calls, week by
 * week. A malformed call is a `tool_call` whose `refusal_owner` is `ours` (refused for its shape,
 * which a skill or a tool description could have prevented); a real-work call is one whose `origin`
 * is `work`, so the platform's own maintenance clients and every other kind of event are outside the
 * population. This read counts the weeks; `summarise` in console/figures.ts names its weeks, judges
 * them and says its finding, as it does for every platform read. Every other part of `PlatformStatus`
 * is answered as unavailable, never as an empty part that reads as "nothing to report".
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
import { summarise, type Measure, type Part, type ReadMeta } from "./figures.js";
import { platformPublic, ZZ_TZ } from "./shared.js";

/** A weekly rate stands only on this many calls; fewer are drawn as `insufficient`, the value kept. */
const MIN_CALLS = 30;

/** What the measure counts, as `meta.population` says it. */
const POPULATION = "real-work tool calls";

const NOT_BUILT = { state: "unavailable", reason: "not_built" } as const;

/** An instant as the gateway spells one: ISO 8601 in UTC, whole seconds, with the Z. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The answer as far as this phase builds it: every part the spec names, the unbuilt ones unavailable. */
type PlatformStatus = {
  meta: ReadMeta;
  needs: { state: "unavailable"; rows: []; total: null; knownCount: 0; unavailableKinds: string[]; overflowByKind: object };
  measures: Measure[];
  records: Part<never>; doors: Part<never>; running: Part<never>; own: Part<never>;
};

export function mountPlatformStatus(app: Express): void {
  app.get("/api/console/platform/status", platformPublic("the platform's status", async (_req, res) => {
    const db = platformDb();
    // One instant for both statements, in whole seconds so the cutoff is the `asOf` the answer
    // states — see periodCutoff for why it is not a `now()` per statement.
    const asOfMs = Math.floor(Date.now() / 1000) * 1000;
    const asOf = new Date(asOfMs).toISOString();

    // Where coverage begins: the first real-work call. Nothing before it was observed under this
    // definition, so no week that starts earlier is complete. Its local date is what a finding names;
    // with no call yet, the record begins today.
    const cov = await db.query<{ first_ms: number | null; first_day: string }>(
      `select (extract(epoch from min(e.ts)) * 1000)::float8 as first_ms,
              to_char(coalesce(min(e.ts), $1::timestamptz) at time zone $2::text, 'YYYY-MM-DD') as first_day
         from zz.event e
        where e.kind = 'tool_call' and e.origin = 'work' and e.ts < $1::timestamptz`, [asOf, ZZ_TZ]);
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

    const malformed = summarise({
      key: "malformed_per_1000", better: "down", minSamples: MIN_CALLS, precision: 1, definedFrom: null,
      label: "malformed-call rate", countLabel: "calls refused for their shape",
      coverageFrom: cov.rows[0].first_day, timezone: ZZ_TZ,
      weeks: rows.map((r) => ({
        from: iso(r.from_ms), to: iso(r.to_ms),
        observedFrom: iso(Math.max(r.from_ms, coverageMs!)),
        observedThrough: iso(Math.min(r.to_ms, asOfMs)),
        numerator: r.malformed, denominator: r.calls,
        value: r.calls === 0 ? null : (1000 * r.malformed) / r.calls, samples: r.calls,
        // Ended, and wholly inside known coverage.
        complete: r.to_ms <= asOfMs && r.from_ms >= coverageMs!,
        available: true,
      })),
    });

    const answer: PlatformStatus = {
      meta: {
        asOf: iso(asOfMs), timezone: ZZ_TZ,
        period: { from: malformed.weeks[0]?.window.from ?? iso(asOfMs), to: iso(asOfMs) },
        scope: "platform-public", population: POPULATION,
        coverageFrom: coverageMs === null ? null : iso(coverageMs),
      },
      needs: {
        state: "unavailable", rows: [], total: null, knownCount: 0,
        unavailableKinds: ["bugs", "evaluation", "approvals", "drift", "door"], overflowByKind: {},
      },
      measures: [malformed],
      records: NOT_BUILT, doors: NOT_BUILT, running: NOT_BUILT, own: NOT_BUILT,
    };
    res.json(answer);
  }));
}
