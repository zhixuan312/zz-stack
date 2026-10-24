-- 011_event_work_week.sql — the first read model: the whole-history real-work reductions, held as
-- rows rather than read as rows.
--
-- Usage, Record, Home and Status reduce `zz.event` from its first row on every load — calls by week
-- and team, by tool and week with the median duration, by refusal owner — and 010_event_work_agg.sql
-- measured that work at 158 to 222 ms a statement over this deployment's 40,287 real-work rows. Each
-- of those answers is a function of the calls themselves, so it can be held: `zz.event_work_week`
-- carries them one row per (team, week, tool, refusal owner), and a reader adds the raw calls newer
-- than the row's `through_ts` to what the row already counted.
--
-- The grain and why each key is what it is (FR-16). `team_slug` is the empty string, never NULL, for
-- an event whose team did not resolve: `services/gateway/src/events.ts` resolves a team by subquery
-- and writes NULL when nothing matches, and a nullable key column would either fail that legal event
-- write or drop it from the count. `week_start` is the Monday of the week in `ZZ_TZ`, because a week
-- cut in UTC moves a call between buckets for one team and not another. `refusal_owner` is part of
-- the grain, because one `refusals` count cannot reconstruct the per-owner breakdown Usage renders.
-- `tool_key` is the empty string for a call that named no tool — dormant today, since every one of
-- those 40,287 rows carries a tool key, and stated rather than left as a branch that would drop the
-- event if it ever woke.
--
-- `ms` holds the durations both medians are taken over — the calls whose `batched` is false and
-- whose `duration_ms` is not null — ascending, so a median or a 95th percentile is the exact merge
-- of per-bucket sorted arrays and never an estimate. A row whose `ms` were appended unsorted would
-- push the sort onto every page load that takes a median, which is the cost this table removes.
--
-- `through_ts` is the latest `ts` the row has absorbed and is the whole reason the model and the raw
-- table compose: a read takes the row's counts and adds the events of the same key with
-- `ts > through_ts`, so the two halves meet at exactly that instant. A boundary drawn by bucket age
-- cannot promise that — with one call at t=0 and another at t=100, a read at t=121 finds a bucket 21
-- seconds old holding nothing while a trailing window starts at t=1 and omits the call at t=0, and a
-- bucket receiving traffic every 30 seconds never turns old at all.
--
-- DELIBERATE: the zone is written out literally here, and this is the only place in the platform it
-- is. A migration file is not handed parameters, and the week a bucket is keyed by cannot be cut at
-- read time without reading every row. `ZZ_TZ` is `Asia/Singapore` in this deployment
-- (`deploy/.env.example`, and `console/shared.ts`'s fallback when the variable is unset), and the
-- write path and the rebuild both pass the variable instead of a literal. A deployment whose
-- `ZZ_TZ` is something else runs `node scripts/rebuild-event-work-week.ts --write` once after this
-- file: it recomputes every bucket with that deployment's own zone, so the backfilled rows and the
-- rows the live write path makes land in the same weeks.
--
-- DELIBERATE: the backfill is one `insert … select`, and it upserts. It runs against an empty table
-- here, and the same statement is what `scripts/rebuild-event-work-week.ts` runs to repair a table
-- that has drifted, so the two cannot disagree about the grain. Its update REPLACES each row with
-- what the source says rather than adding to it, which is what makes a second run a no-op.
--
-- The three checks hold the rest of it: one row per event, the sums against the raw statements on a
-- frozen input, and the composition at the seam. `schema-target/telemetry.ts` declares the table as
-- a projection rebuilt from `zz.event`, and `scripts/rehearse/expect.ts` declares it added with a
-- count of "any" and its content hash skipped, because a backfill's size is production's to decide.
--
-- The release before this file can run on what it builds: the table is new, so the previous image
-- neither reads nor writes it, and a rollback leaves it in place costing the old release nothing.
-- No line below declares a refusal.

CREATE TABLE zz.event_work_week (
    team_slug text NOT NULL,
    week_start date NOT NULL,
    tool_key text NOT NULL,
    refusal_owner text NOT NULL,
    calls integer NOT NULL,
    refusals integer NOT NULL,
    failed integer NOT NULL,
    ms integer[] NOT NULL,
    through_ts timestamp with time zone NOT NULL,
    built_at timestamp with time zone NOT NULL,
    source_revision text NOT NULL,
    CONSTRAINT event_work_week_failed_check CHECK ((failed <= calls)),
    CONSTRAINT event_work_week_ms_check CHECK ((cardinality(ms) <= calls)),
    CONSTRAINT event_work_week_refusals_check CHECK ((refusals <= failed))
);

ALTER TABLE zz.event_work_week OWNER TO zz;

ALTER TABLE ONLY zz.event_work_week
    ADD CONSTRAINT event_work_week_pkey PRIMARY KEY (team_slug, week_start, tool_key, refusal_owner);

COMMENT ON TABLE zz.event_work_week IS 'class=projection; authority=this; question=what did the real work calls of one team, in one week of the deployment calendar and under one refusal owner, add up to — how many calls, how many refusals, how many failures and which durations a median is taken over — with through_ts naming the latest zz.event.ts absorbed so that a read unions the raw calls after that instant and the two halves meet with no gap and no overlap?; rebuilt_from=zz.event';

COMMENT ON COLUMN zz.event_work_week.team_slug IS 'class=projection; authority=zz.event.team_id; question=which team made the calls counted here, zz.event.team_id resolved through zz.team to a slug and the empty string when no team resolved, because a key column that could be null would either drop a legal event or fail its write?; rebuilt_from=zz.event.team_id';

COMMENT ON COLUMN zz.event_work_week.week_start IS 'class=projection; authority=zz.event.ts; question=which Monday the calls counted here belong to, zz.event.ts cut into the week containing it inside the deployment zone ZZ_TZ, so this row lands in the bucket every reader already dates by date_trunc?; rebuilt_from=zz.event.ts';

COMMENT ON COLUMN zz.event_work_week.tool_key IS 'class=projection; authority=zz.event.tool_key; question=which alias-resolved door:tool the calls counted here named, zz.event.tool_key itself and the empty string for a call that named no tool?; rebuilt_from=zz.event.tool_key';

COMMENT ON COLUMN zz.event_work_week.refusal_owner IS 'class=projection; authority=zz.event.refusal_owner; question=whose refusal were the calls counted here, zz.event.refusal_owner of a call that did not work and the empty string for a call that was not a refusal, so summing calls over the rows of a team is the calls of that team and grouping by a non-empty value is the refusals of that owner with no bucket counted twice?; rebuilt_from=zz.event.refusal_owner';

COMMENT ON COLUMN zz.event_work_week.calls IS 'class=projection; authority=zz.event.id; question=how many zz.event rows of this key have been absorbed here, each real-work tool call counted once and only once?; rebuilt_from=zz.event.id';

COMMENT ON COLUMN zz.event_work_week.refusals IS 'class=projection; authority=zz.event.refusal_owner; question=how many of those calls came back as a refusal, the ones whose zz.event.refusal_owner is not null, so a row of one owner counts that owner and a call that is not a refusal adds none?; rebuilt_from=zz.event.refusal_owner';

COMMENT ON COLUMN zz.event_work_week.failed IS 'class=projection; authority=zz.event.ok; question=how many of those calls did not work at all, the ones whose zz.event.ok is false, which every refusal is and which a failed call no owner claims is too?; rebuilt_from=zz.event.ok';

COMMENT ON COLUMN zz.event_work_week.ms IS 'class=projection; authority=zz.event.duration_ms; question=which recorded durations the medians are taken over, zz.event.duration_ms of the calls whose zz.event.batched is false and whose duration is not null, held ascending so that a median or a 95th percentile is the exact merge of sorted arrays and never an estimate?; rebuilt_from=zz.event.duration_ms';

COMMENT ON COLUMN zz.event_work_week.through_ts IS 'class=projection; authority=zz.event.ts; question=which instant this row has absorbed every call of its key up to and no further, the latest zz.event.ts it holds, after which a read unions the raw calls and up to which it must not read them again?; rebuilt_from=zz.event.ts';

COMMENT ON COLUMN zz.event_work_week.built_at IS 'class=projection; authority=zz.event; question=when this row was last built from zz.event, the clock of the transaction that wrote it and no zz.event.ts among the calls it counts, so a rebuild moves it and a later call moves it too?; rebuilt_from=zz.event';

COMMENT ON COLUMN zz.event_work_week.source_revision IS 'class=projection; authority=zz.event.id; question=which zz.event row this row stands at, the id of the newest call it has absorbed, so that a reader can name the source revision the build reached?; rebuilt_from=zz.event.id';

with work as (
  select coalesce(t.slug, '') as team_slug,
         (date_trunc('week', e.ts at time zone 'Asia/Singapore'))::date as week_start,
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
       source_revision = excluded.source_revision;
