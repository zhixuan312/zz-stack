/**
 * `zz.event_work_week` — the read model the whole-history real-work reductions are answered from,
 * and the three statements that keep it: the backfill a rebuild runs, the write the event log
 * makes in its own transaction, and the read that unions the model with the raw calls it has not
 * absorbed yet.
 *
 * ONE GRAIN, and every statement below states it in full rather than sharing a fragment: the
 * console's gate refuses SQL whose text is assembled at runtime, so a hole in the statement is a
 * hole check:sql cannot PREPARE. The grain is `(team_slug, week_start, tool_key, refusal_owner)`,
 * and an event contributes to exactly one row of it:
 *
 *   team_slug      the event's team resolved to its slug, or '' when nothing resolved — never
 *                  null, because `zz.event.team_id` is nullable and a null key would either fail
 *                  a legal event write or drop that event from the count.
 *   week_start     the Monday of the week the event's `ts` falls in, cut inside the deployment's
 *                  `ZZ_TZ` — the same `date_trunc('week', … at time zone …)` every reader writes,
 *                  so the bucket a reader names is the bucket this row sits in.
 *   tool_key       the event's own `tool_key`, or '' for a call that named no tool.
 *   refusal_owner  the event's own `refusal_owner`, or '' for a call that was not a refusal.
 *
 * What follows from that, and what the checks hold it to: summing `calls` over the rows of a team
 * is the calls of that team, grouping by a non-empty `refusal_owner` is the refusals of that
 * owner, and no bucket is counted twice. `ms` holds the recorded durations that both medians are
 * taken over — the calls whose `batched` is false and whose `duration_ms` is not null — ascending,
 * so a median or a 95th percentile is the exact merge of sorted arrays rather than an estimate.
 *
 * DELIBERATE: `ms` is sorted on write, not on read. An append that left it unsorted would push
 * the sort onto every page load that takes a median, which is the cost the model exists to remove.
 *
 * DELIBERATE: `source_revision` is the id of the newest `zz.event` row the bucket absorbed — a
 * watermark the writing transaction can state, never a listener's count, because PostgreSQL
 * delivers a notification after the commit that made it true.
 */
import type pg from "pg";

export type WorkWeekBucket = {
  team_slug: string;
  /** `YYYY-MM-DD`, the Monday the bucket is dated by. Formatted in SQL, so no driver turns a
   *  `date` into an instant in the reading process's own zone. */
  week_start: string;
  tool_key: string;
  refusal_owner: string;
  calls: number;
  refusals: number;
  failed: number;
  /** Ascending, the `duration_ms` of the calls whose `batched` is false and whose duration exists. */
  ms: number[];
};

/**
 * The whole table from `zz.event`, in ONE `insert … select`, as `011_event_work_week.sql` backfills
 * it and `scripts/rebuild-event-work-week.ts` rebuilds it. `$1` is the deployment's reporting zone
 * (`ZZ_TZ`); the migration carries this statement with the zone written out literally, because a
 * migration file is not handed parameters.
 *
 * DELIBERATE: it upserts rather than inserting. A rebuild that could only run on an empty table
 * would be a rebuild nobody dares run twice, and this one has to be able to repair a drifted row
 * in place. Each update REPLACES the row with what the source says, rather than adding to it, so
 * running it twice on an unchanged source leaves the same rows.
 *
 * DELIBERATE: the per-event grain is computed in `work` and aggregated from it, rather than over
 * `zz.event` in the select itself — the same shape `weekBuckets` writes below, and for a second
 * reason. `zz.event` carried a `team_slug` column until the phase that renamed it to `team_id`,
 * so a bare `team_slug` in a statement binding both `zz.event` and a table that carries that name
 * today is one `checks/dropped-columns.ts` cannot attribute to either. It reports such a statement
 * rather than guessing, and this is the statement shape that does not produce one.
 */
export const WEEK_BACKFILL = `
    with work as (
      select coalesce(t.slug, '') as team_slug,
             (date_trunc('week', e.ts at time zone $1::text))::date as week_start,
             coalesce(e.tool_key, '') as tool_key,
             coalesce(e.refusal_owner, '') as refusal_owner,
             e.refusal_owner as owner, e.id, e.ts, e.ok, e.duration_ms, e.batched
        from zz.event e
        left join zz.team t on t.id = e.team_id
       where e.kind = 'tool_call' and e.origin = 'work'
    )
    insert into zz.event_work_week
      (team_slug, week_start, tool_key, refusal_owner,
       calls, refusals, failed, ms, through_ts, built_at, source_revision)
    select team_slug, week_start, tool_key, refusal_owner,
           count(*)::int,
           (count(*) filter (where owner is not null))::int,
           (count(*) filter (where ok is false))::int,
           coalesce(array_agg(duration_ms order by duration_ms)
                    filter (where batched = false and duration_ms is not null), '{}'::integer[]),
           max(ts),
           now(),
           max(id)::text
      from work
     group by 1, 2, 3, 4
    on conflict (team_slug, week_start, tool_key, refusal_owner) do update
       set calls = excluded.calls,
           refusals = excluded.refusals,
           failed = excluded.failed,
           ms = excluded.ms,
           through_ts = excluded.through_ts,
           built_at = excluded.built_at,
           source_revision = excluded.source_revision`;

/**
 * The row one just-written event contributes, keyed by that event's own id: the third statement of
 * the transaction in `events.ts`, after the run and the event itself.
 *
 * It reads the event it was handed rather than rebuilding the grain from the writer's parameters,
 * so the key it files the event under is the key the row actually carries — a team slug that
 * stopped resolving, a tool key the writer did not know, a `ts` the column defaulted, all of them
 * taken from the row. `$1` is the event id and `$2` the reporting zone. A row that is not a
 * real-work tool call selects nothing, so the page view and the maintenance call write no model row
 * without a second test in TypeScript.
 *
 * DELIBERATE: the increments are additions here and replacements in `WEEK_BACKFILL`. An event is
 * new information about a bucket, and the rebuild is the same information recounted from the
 * source; both reach the same row, and only the rebuild can lower a count.
 */
export const WEEK_RECORD = `
    with work as (
      select coalesce(t.slug, '') as team_slug,
             (date_trunc('week', e.ts at time zone $2::text))::date as week_start,
             coalesce(e.tool_key, '') as tool_key,
             coalesce(e.refusal_owner, '') as refusal_owner,
             e.refusal_owner as owner, e.id, e.ts, e.ok, e.duration_ms, e.batched
        from zz.event e
        left join zz.team t on t.id = e.team_id
       where e.id = $1::bigint and e.kind = 'tool_call' and e.origin = 'work'
    )
    insert into zz.event_work_week
      (team_slug, week_start, tool_key, refusal_owner,
       calls, refusals, failed, ms, through_ts, built_at, source_revision)
    select team_slug, week_start, tool_key, refusal_owner,
           1,
           case when owner is not null then 1 else 0 end,
           case when ok is false then 1 else 0 end,
           case when batched = false and duration_ms is not null
                then array[duration_ms] else '{}'::integer[] end,
           ts,
           now(),
           id::text
      from work
    on conflict (team_slug, week_start, tool_key, refusal_owner) do update
       set calls = zz.event_work_week.calls + excluded.calls,
           refusals = zz.event_work_week.refusals + excluded.refusals,
           failed = zz.event_work_week.failed + excluded.failed,
           ms = coalesce((select array_agg(x order by x)
                            from unnest(zz.event_work_week.ms || excluded.ms) x), '{}'::integer[]),
           through_ts = greatest(zz.event_work_week.through_ts, excluded.through_ts),
           built_at = excluded.built_at,
           source_revision = case
             when excluded.source_revision::bigint > zz.event_work_week.source_revision::bigint
             then excluded.source_revision else zz.event_work_week.source_revision end`;

/**
 * The model and the raw table as one answer: every bucket of `zz.event_work_week`, plus the calls
 * of the same key with `ts > through_ts`. The two halves meet at exactly that instant, so neither
 * can omit an event the other dropped and no event is counted twice — which a boundary drawn by
 * bucket age cannot promise, because a bucket with steady traffic never turns old.
 *
 * DELIBERATE: the raw half is read per bucket and inside that bucket's own week, not as one scan
 * of the history. A bucket is keyed by the week its calls fall in, so every event of that key is
 * inside that week by construction, and `ts > through_ts` inside a week the row has already
 * absorbed is an empty range — which is what makes this a read of the tail rather than a re-read
 * of every call the model exists to stop reading. Measured on a local copy of 50,000 real-work
 * calls: this read answered its 126 buckets in 30 ms, where bounding the same union only by the
 * oldest watermark in the table read all 48,432 of those calls and took 65 ms.
 *
 * DELIBERATE: a key with no model row at all is not reconstructed here. Nothing this platform does
 * can produce one — `WEEK_RECORD` writes the row in the transaction that writes the call, and
 * `011_event_work_week.sql` backfilled every call that existed before it — so a key without a row
 * is a damaged table, and `scripts/rebuild-event-work-week.ts` is what repairs it. Answering it
 * from a scan of the whole history would cost every page load the read this table exists to make
 * short.
 */
export async function weekBuckets(db: pg.Pool | pg.Client, zone: string): Promise<WorkWeekBucket[]> {
  const { rows } = await db.query(`
    with model as (
      select m.team_slug, m.week_start, m.tool_key, m.refusal_owner,
             m.calls, m.refusals, m.failed, m.ms, m.through_ts,
             (select t.id from zz.team t where t.slug = m.team_slug) as team_id
        from zz.event_work_week m
    ),
    tail as (
      select m.team_slug, m.week_start, m.tool_key, m.refusal_owner,
             count(e.*)::int as calls,
             (count(*) filter (where e.refusal_owner is not null))::int as refusals,
             (count(*) filter (where e.ok is false))::int as failed,
             coalesce(array_agg(e.duration_ms order by e.duration_ms)
                      filter (where e.batched = false and e.duration_ms is not null),
                      '{}'::integer[]) as ms
        from model m
        left join lateral (
          select e.ts, e.ok, e.refusal_owner, e.duration_ms, e.batched
            from zz.event e
           where e.kind = 'tool_call' and e.origin = 'work'
             and e.team_id is not distinct from m.team_id
             and e.tool_key is not distinct from nullif(m.tool_key, '')
             and e.refusal_owner is not distinct from nullif(m.refusal_owner, '')
             and e.ts > m.through_ts
             and e.ts >= ((m.week_start)::timestamp at time zone $1::text)
             and e.ts <  ((m.week_start + 7)::timestamp at time zone $1::text)
        ) e on true
       group by 1, 2, 3, 4
    )
    select m.team_slug,
           to_char(m.week_start, 'YYYY-MM-DD') as week_start,
           m.tool_key, m.refusal_owner,
           (m.calls + t.calls)::int as calls,
           (m.refusals + t.refusals)::int as refusals,
           (m.failed + t.failed)::int as failed,
           coalesce((select array_agg(x order by x)
                       from unnest(m.ms || t.ms) x), '{}'::integer[]) as ms
      from model m
      join tail t
        on t.team_slug = m.team_slug and t.week_start = m.week_start
       and t.tool_key = m.tool_key and t.refusal_owner = m.refusal_owner
     order by m.week_start, m.team_slug, m.tool_key, m.refusal_owner`, [zone]);
  return rows as WorkWeekBucket[];
}
