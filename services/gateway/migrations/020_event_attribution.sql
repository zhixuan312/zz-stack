-- zz.event stops carrying seven repeated strings per row.
--
-- WHAT IT CARRIED. team_slug, initiative, flow, step, step_version, block, block_version -- all
-- text, all on every one of 5,487 rows, and this table only grows. Every one of them is a
-- property of something else: the flow belongs to the initiative, the skill version to the run,
-- the block version to the block. Storing them here meant an event could disagree with its own
-- run about which skill version was loaded, and nothing would notice.
--
-- WHAT REPLACES THEM. Two foreign keys, run_id and block_version_id. Everything else is
-- reachable through them: run -> skill_version -> skill, and run -> initiative -> team.
--
-- ONE DELIBERATE EXCEPTION: team_id STAYS on the row.
-- Not every event belongs to a run -- a token check, a knowledge read, an evaluation reading
-- documents back -- and tenancy has to be answerable for all of them without a join, because
-- every query in the system filters by it. That is the standard reason to denormalize a tenancy
-- key onto an audit stream, and it is a decision rather than an oversight.
--
-- NOTHING LOSES ITS ATTRIBUTION. 3,679 events carry detail->>'run' and were attached in 017.
-- The rest have a step and an initiative but no run identifier, so they get one run per
-- (initiative, skill version) named `unattributed:<skill>:<version>` -- which is exactly what is
-- known about them and no more. Inventing a finer grouping would be inventing data.

alter table zz.event add column if not exists run_id           uuid references zz.run(id) on delete set null;
alter table zz.event add column if not exists block_version_id uuid references zz.block_version(id) on delete set null;
alter table zz.event add column if not exists team_id          uuid references zz.team(id);

-- Runs for the events that had no run identifier of their own.
insert into zz.run (initiative_id, skill_version_id, caller_session, calls, refusals, bytes_total,
                    started_at, ended_at)
select i.id, sv.id,
       'unattributed:' || e.step || ':' || coalesce(nullif(e.step_version, ''), 'unknown'),
       count(*), count(*) filter (where e.ok is false),
       coalesce(sum((e.detail->>'bytes')::bigint), 0), min(e.ts), max(e.ts)
  from zz.event e
  join zz.team t       on t.slug = e.team_slug
  join zz.initiative i on i.team_id = t.id and i.slug = e.initiative
  left join zz.skill s          on s.name = e.step
  left join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version
 where not (e.detail ? 'run')
   and e.initiative is not null and e.initiative <> ''
   and e.step is not null and e.step <> ''
 group by i.id, sv.id, e.step, e.step_version
on conflict (initiative_id, skill_version_id, caller_session) do nothing;

update zz.event e set team_id = t.id
  from zz.team t where t.slug = e.team_slug and e.team_id is null;

update zz.event e set run_id = r.id
  from zz.run r
  join zz.initiative i on i.id = r.initiative_id
  join zz.team t on t.id = i.team_id
 where e.run_id is null and t.slug = e.team_slug and i.slug = e.initiative
   and r.caller_session = coalesce(
         e.detail->>'run',
         'unattributed:' || e.step || ':' || coalesce(nullif(e.step_version, ''), 'unknown'))
   -- The run must be the one for THIS event's skill, not merely the same session: one session
   -- carries every step of an initiative.
   and r.skill_version_id is not distinct from (
         select sv.id from zz.skill s join zz.skill_version sv on sv.skill_id = s.id
          where s.name = e.step and sv.version = coalesce(nullif(e.step_version, ''), 'unknown'));

update zz.event e set block_version_id = bv.id
  from zz.block b join zz.block_version bv on bv.block_id = b.id
 where e.block_version_id is null and b.name = e.block
   and bv.version = coalesce(nullif(e.block_version, ''), 'unknown');
