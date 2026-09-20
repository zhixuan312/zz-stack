-- Two spellings of "no step" become one, and the one is null.
--
-- WHAT WAS WRONG. `initiativeSeen` in step-trace.ts minted a trace for a caller that had named
-- an initiative and never read a skill, and seeded it with `step: ""`. Two hops downstream --
-- `tool-telemetry.ts`'s `owedBy ?? step?.step` and `events.ts`'s `e.step ?? null` -- both use
-- `??`, which coalesces null and does NOT coalesce the empty string, so the empty string
-- reached the column verbatim. `zz.event` therefore carried two spellings of nothing where
-- `event_step` indexes one: `create index ... where (step is not null)`.
--
-- WHAT IT COST. Nothing joins `s.name = e.step` to an empty string, so every one of these rows
-- is unreachable from `zz.skill`. Measured on this deployment 2026-09-20: 1,995 rows with
-- `step = ''` against 2,780 null and 2,974 real, and `count(*)` of those empties that resolve
-- to any skill is ZERO. The five-minute reconcile in runs.ts (the `l` linkback) read them as
-- candidates every pass -- an EXPLAIN on 2026-09-19 measured `SubPlan 1 ... loops=1695
-- rows=0`, 76 ms and 12,341 buffers to update no rows, re-scanning zz.skill and
-- zz.skill_version 1,695 times, 288 times a day, for as long as the rows exist.
--
-- `step_version` has the same defect from the same file: `stepLoaded` wrote "" for a skill
-- served as a supporting file rather than whole, and that column's own comment already records
-- what it cost -- seven casebox calls "matched no version and vanished from every per-version
-- report". 2,289 rows. Both columns are normalized here because they are one bug.
--
-- WHY DATA AND NOT A PREDICATE. Adding `and e.step <> ''` to the reconcile would make the query
-- fast and leave the column holding two spellings of nothing forever, which is the compatibility
-- shim this codebase does not write. The producer is fixed in the same change (step-trace.ts
-- now omits the field rather than emptying it, so `??` works on it the way it already worked on
-- stepVersion and stepSha); this makes the rows already written agree with it.
--
-- SAFE BY CONSTRUCTION. No foreign key references either column, `event_step` is a partial
-- index on `step is not null` and simply gets smaller and correct, and every consumer joins on
-- equality -- where '' matched nothing, null matches nothing, identically. In a transaction
-- regardless: a half-applied migration is the one state nobody can diagnose from the outside.

begin;

update zz.event set step = null where step = '';
update zz.event set step_version = null where step_version = '';

comment on column zz.event.step is
  'The skill this call was following, or NULL when none was. Never the empty string: `??` '
  'does not coalesce it, so an empty step reaches this column verbatim and is unjoinable to '
  'zz.skill while still looking like a value. Producers say unknown by omitting the field.';

-- AND THE RUN COLUMN GETS THE INDEX IT NEVER HAD. `zz.event` carries six indexes and none of
-- them is on `run_id`, so `judge-trace.ts` reads a run's transcript by scanning the whole
-- table -- measured 2026-09-19: Seq Scan, Rows Removed by Filter 6,146, 521 buffers, 2.5 ms,
-- twice per run and once per subject in a judging round, growing linearly with the event log.
-- Partial, because the column is null on every event that did not happen inside a run and an
-- index entry for those buys nothing.
create index if not exists event_run on zz.event (run_id) where run_id is not null;

comment on column zz.event.step_version is
  'The version declared by the skill that was served WHOLE, or NULL. A supporting file beside '
  'a skill carries no version, and that is recorded as NULL rather than as an empty string, '
  'for the same reason as step.';

commit;
