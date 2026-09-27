-- 003_a_run_the_timer_invented.sql — the runs whose attribution cannot be true, removed.
--
-- `002_delivery_telemetry.sql` made `skill_run` a row the door writes: `services/gateway/src/
-- events.ts` stamps it in the same transaction as the event that attributes it, and its guard
-- requires all four parts of the run's identity to resolve — `and id.skill_version_id is not
-- null` — so an event that names no skill version creates no run at all.
--
-- `zz.run` was written the other way. `reconcileRuns()` grouped events on a timer and stamped the
-- run from whatever the registry held when the timer happened to fire, so a carried-over run can
-- name a version released after the run began, or hold no evidence that names a version at all.
--
-- `doctor`'s data layer reads the first of those as a disagreement: `1 of 765 zz.skill_run rows
-- (0.1%) name a skill version released after the run started`. The two are one row. The only run
-- with no versioned event is the only run whose stamped version postdates it: its evidence is a
-- single `tool_call core:skill_view` at 2026-09-10 09:15:25 whose own `skill_version_id` is null,
-- stamped `sdlc-deck 1.0` — released 10:29:50 that same morning, and the earliest version that
-- skill ever had.
--
-- It is not repaired, because there is nothing true to point it at: `skill_version_id` is not
-- null, and no version of that skill existed when the call was made. It is deleted, which is what
-- `002_delivery_telemetry.sql:68` already does to a run it cannot make true — a run resolving no
-- team cannot satisfy `team_id not null`, and this one cannot satisfy the identity its own writer
-- requires. Its events keep their own rows: no event is touched, and what the call did is still on
-- the record.
--
-- On a database built from `001_init.sql` there are no runs to consider and this is a no-op.

do $$
declare n int;
begin
  select count(*) into n
    from zz.skill_run r
   where not exists (select 1 from zz.event e
                      where e.run_id = r.id and e.skill_version_id is not null)
      or exists (select 1 from zz.skill_version v
                  where v.id = r.skill_version_id and v.released_at > r.started_at);
  if n > 0 then
    raise notice '% run(s) name a skill version their own evidence does not, and are dropped; their events keep their rows', n;
    delete from zz.skill_run r
     where not exists (select 1 from zz.event e
                        where e.run_id = r.id and e.skill_version_id is not null)
        or exists (select 1 from zz.skill_version v
                    where v.id = r.skill_version_id and v.released_at > r.started_at);
  end if;
end $$;
