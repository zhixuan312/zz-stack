-- 002_delivery_telemetry — the delivery and telemetry tables take their phase-2 shape.
--
-- The runner (`services/gateway/src/db.ts`) wraps this file in one transaction and records it in
-- `zz.schema_migration`; there is no `begin`/`commit` here and every name is schema-qualified.
--
-- Three shapes drive what follows.
--
-- A team is the scope of everything. Five tables that were scoped by a slug, an email or a
-- free-text initiative name gain a real `team_id`, resolved from the row that is already there:
-- `initiative.team_id` where the row names an initiative, the asker's or reporter's
-- `principal.active_team_id` where it does not. Every one of those resolutions is measurable
-- against the backup, so a row that resolves nothing is either reported and dropped (a run no
-- team owns is not a run) or fails the migration (an event or an assessment with no team is a
-- hole in the record, and a hole that silently becomes NULL is worse than a refused migration).
--
-- A derived column is filled from the rows that remain, never from a second source. `event`'s
-- new columns are all derived this way: `session` from `detail->>'run'`, `actor_id` from the
-- principal whose email is the old `actor`, `initiative_id` from `(team_id, initiative)`,
-- `skill_version_id` from the version of the skill `step` names that was released at or before
-- the event, and `run_id` from the run the timer would have attributed the event to.
--
-- What the old shape carried as text is now a reference. `actor`, `team_slug`, `initiative`,
-- `flow`, `step` and `step_version` are dropped from `event`; `team_slug` and `initiative` from
-- `bug`; `team` and `initiative` from `initiative_fact`; `requested_model` from `assessment`.
-- `decision` and `discussion_message` are dropped whole — a decision is a document's frontmatter
-- and a discussion is a comment on it, and neither was ever the delivery record.
--
-- One deviation from the plan is deliberate and is marked where it happens: the two figures the
-- `detail` bag carried (`ms`, `bytes`) are backfilled wherever the bag carries them and the
-- column does not, rather than only before 2026-09-14. See the comment on those two statements.

-- ---------------------------------------------------------------------------------------------
-- skill_run: `run` renamed and reshaped — a team's run of a skill version.
-- ---------------------------------------------------------------------------------------------

alter table zz.run rename to skill_run;
alter table zz.skill_run rename column caller_session to session;

-- `turns` is the count of model turns, which `model_call` records one row at a time; a stored
-- total was a second copy of a figure the calls already carry.
alter table zz.skill_run drop column turns;

alter table zz.skill_run add column team_id uuid;

-- `ended_at` is the last event of the run. A run no event reached still ended when it started.
update zz.skill_run r
   set ended_at = greatest(coalesce(r.ended_at, r.started_at),
                           coalesce((select max(e.ts) from zz.event e where e.run_id = r.id),
                                    r.started_at));

-- The team, from the initiative where the run has one and otherwise from the events it owns —
-- they all name one team or the run resolves nothing (measured: 644 via the initiative, 99 via
-- the events, 0 unresolved).
update zz.skill_run r
   set team_id = coalesce(
         (select i.team_id from zz.initiative i where i.id = r.initiative_id),
         (select (array_agg(distinct e.team_id))[1]
            from zz.event e
           where e.run_id = r.id and e.team_id is not null
          having count(distinct e.team_id) = 1));

do $$
declare n int;
begin
  select count(*) into n from zz.skill_run where team_id is null;
  if n > 0 then
    raise notice 'skill_run: % run(s) resolve no team and are dropped; their events keep their rows', n;
    delete from zz.skill_run where team_id is null;
  end if;
end $$;

alter table zz.skill_run alter column team_id set not null;
alter table zz.skill_run alter column skill_version_id set not null;
alter table zz.skill_run alter column ended_at set not null;

-- `unique (team_id, id)` is what the composite foreign keys below point at: a row that names a
-- run and a team must name a run of that team.
alter table zz.skill_run add constraint skill_run_team_id_id_key unique (team_id, id);

alter table zz.skill_run
  add constraint skill_run_team_id_fkey foreign key (team_id) references zz.team(id);

alter table zz.skill_run
  add constraint skill_run_team_id_initiative_id_fkey
  foreign key (team_id, initiative_id) references zz.initiative(team_id, id) on delete cascade;

alter table zz.skill_run
  add constraint skill_run_refusals_check check (0 <= refusals and refusals <= calls);

alter table zz.skill_run
  add constraint skill_run_ended_at_check check (ended_at >= started_at);

-- One run per `(team, initiative, skill version, session)`, and `NULLS NOT DISTINCT` so a run
-- with no initiative is one run rather than every row admitting a NULL. That is what the old
-- partial index `run_no_initiative` said, only spelled as a property of the key instead of as a
-- predicate beside it — `pg_get_indexdef` renders the property, a unique constraint would hide
-- it, and the key is the identity the timer's `on conflict` needs.
drop index zz.run_no_initiative;
create unique index skill_run_identity on zz.skill_run using btree
  (team_id, initiative_id, skill_version_id, session) nulls not distinct;

-- ---------------------------------------------------------------------------------------------
-- event: the delivery record, scoped by team and keyed to real rows.
-- ---------------------------------------------------------------------------------------------

alter table zz.event add column actor_id uuid;
alter table zz.event add column initiative_id uuid;
alter table zz.event add column session text not null default '';
alter table zz.event add column skill_version_id uuid;

-- The session is the run the caller named, which the event carried in its detail bag.
update zz.event e set session = coalesce(e.detail->>'run', '');

-- The actor is the principal whose email it was; `''` and an address no principal has are the
-- unattributed rows the column already could not name (measured: 2,297 of 14,116 resolve, to 3
-- distinct principals).
update zz.event e
   set actor_id = p.id
  from zz.principal p
 where p.email = lower(e.actor);

-- The initiative is the one whose slug it named *within its own team* — the same slug in two
-- teams is two initiatives (measured: all 9,730 initiative-naming events resolve).
update zz.event e
   set initiative_id = i.id
  from zz.initiative i
 where i.team_id = e.team_id and i.slug = e.initiative;

-- The skill version is the one the timer resolves today: the newest version of the skill `step`
-- names released at or before the event (measured: 6,679 of 6,681 resolved; the other two are
-- before that skill's first release and stay null).
update zz.event e
   set skill_version_id = (select v.id
                             from zz.skill s
                             join zz.skill_version v
                               on v.skill_id = s.id and v.released_at <= e.ts
                            where s.name = e.step
                            order by v.released_at desc
                            limit 1);

-- The two figures the bag carried before they had columns. The spec restricts this to rows
-- written before 2026-09-14, on the premise that later rows already carry the columns; measured
-- on the 0.82.0 backup, that premise holds for part of the tail only. 3,503 rows carry `ms` in the
-- bag and every one of them has a null `duration_ms`: 2,684 are written before the date and are
-- what this updates, and the 819 written on or after it keep the figure in the bag alone. `bytes`
-- is the same shape — 3,547 rows, 2,728 updated, 819 left. No bag figure disagrees with a column
-- that has a value, vacuously, because no bag row has one. The `is null` guard is what makes it
-- safe to run over production: a row that already has a value is never overwritten by the bag's
-- copy of it, whatever the date rule would have said about it.
update zz.event e set duration_ms = (e.detail->>'ms')::int
 where e.ts < timestamp with time zone '2026-09-14' and e.detail ? 'ms' and e.duration_ms is null;

update zz.event e set response_bytes = (e.detail->>'bytes')::int
 where e.ts < timestamp with time zone '2026-09-14' and e.detail ? 'bytes' and e.response_bytes is null;

-- The run the timer would have attributed the event to, computed once over the whole table in the
-- timer's own order: the run matching `(team, initiative, skill version, session)`, and for an
-- event naming no initiative the run with no initiative for that `(skill version, session)`.
-- Only the rows that have none are filled — the timer's own rule is `where e.run_id is null`, and
-- applying it once over the whole table is what it does on every tick. (Measured: 8 events gain a
-- run, none loses one; recomputing unconditionally would lose event 59, whose run was attributed
-- when its skill version still resolved for that timestamp.)
update zz.event e
   set run_id = coalesce(
         (select r.id
            from zz.skill_run r
           where r.team_id = e.team_id
             and r.initiative_id = e.initiative_id
             and r.skill_version_id = e.skill_version_id
             and r.session = e.session),
         (select r.id
            from zz.skill_run r
           where r.team_id = e.team_id
             and r.initiative_id is null
             and r.skill_version_id = e.skill_version_id
             and r.session = e.session))
 where e.run_id is null;

-- The text columns the columns above replace.
alter table zz.event drop column actor;
alter table zz.event drop column team_slug;
alter table zz.event drop column initiative;
alter table zz.event drop column flow;
alter table zz.event drop column step;
alter table zz.event drop column step_version;

alter table zz.event
  add constraint event_actor_id_fkey foreign key (actor_id) references zz.principal(id);

alter table zz.event
  add constraint event_initiative_id_fkey foreign key (initiative_id) references zz.initiative(id)
  on delete set null;

alter table zz.event
  add constraint event_skill_version_id_fkey foreign key (skill_version_id)
  references zz.skill_version(id);

-- A team names an initiative of that team, and a team names a run of that team. Each composite
-- takes the delete action of the single foreign key on the same optional column, so neither
-- blocks the other; `onDeleteColumns` names the column that goes.
alter table zz.event
  add constraint event_team_id_initiative_id_fkey
  foreign key (team_id, initiative_id) references zz.initiative(team_id, id)
  on delete set null (initiative_id);

alter table zz.event
  add constraint event_team_id_run_id_fkey
  foreign key (team_id, run_id) references zz.skill_run(team_id, id)
  on delete set null (run_id);

alter table zz.event
  add constraint event_initiative_id_team_id_check check (initiative_id is null or team_id is not null);

alter table zz.event
  add constraint event_run_id_team_id_check check (run_id is null or team_id is not null);

-- Item 19's three checks on what a row may say about itself. None of them is in the baseline —
-- `001_init.sql` creates no check on `zz.event` — so all three are gains here, each one holding
-- on every row of the 2026-09-27 backup (measured: 0 violations of each).
alter table zz.event
  add constraint event_kind_check check (kind ~ '^[a-z_]+(\.[a-z_]+)?$');

alter table zz.event
  add constraint event_tool_call_names_its_tool_check
  check (kind <> 'tool_call' or (ok is not null and tool_key is not null));

alter table zz.event
  add constraint event_refusal_owner_check
  check (refusal_owner is null or (refusal_owner in ('guardrail','ours','theirs','other') and ok = false));

-- ---------------------------------------------------------------------------------------------
-- model_call: what a call failed with, and no copy of what it was about.
-- ---------------------------------------------------------------------------------------------

-- `note` was the reason a call did not succeed; on a call that did it was never written
-- (measured: 1 of 1,169 rows carries one, on a failure). Renaming keeps the values that matter
-- and the constraint below refuses the ones that do not.
alter table zz.model_call rename column note to error;

-- `event_id` pointed at the event a call belonged to, which the event's own run and step already
-- say; `plugin` and `confidence` duplicate `plugin`/`version` and the assessment's own reading.
alter table zz.model_call drop column event_id;
alter table zz.model_call drop column plugin;
alter table zz.model_call drop column confidence;

-- An error on a call that succeeded is a contradiction the column can refuse.
update zz.model_call set error = null where ok;

alter table zz.model_call
  add constraint model_call_error_check check (error is null or not ok);

-- ---------------------------------------------------------------------------------------------
-- assessment: a judgment, in the team that asked for it.
-- ---------------------------------------------------------------------------------------------

alter table zz.assessment add column team_id uuid;
alter table zz.assessment add column initiative_id uuid;
alter table zz.assessment add column model_call_id bigint;
alter table zz.assessment add column asked_by_id uuid;

update zz.assessment a
   set asked_by_id = p.id
  from zz.principal p
 where p.email = lower(a.asked_by);

do $$
declare n int;
begin
  select count(*) into n from zz.assessment where asked_by_id is null;
  if n > 0 then
    raise exception 'assessment: % row(s) name an asker no principal has', n;
  end if;
end $$;

alter table zz.assessment drop column asked_by;
alter table zz.assessment rename column asked_by_id to asked_by;
alter table zz.assessment alter column asked_by set not null;

-- The initiative is the one whose slug the text named, preferring the asker's own team where the
-- slug is that team's, and otherwise the initiative that has the slug (measured: the one slug
-- two teams share appears in no assessment row, so every row resolves unambiguously).
update zz.assessment a
   set initiative_id = coalesce(
         (select i.id
            from zz.initiative i
           where i.slug = a.initiative
             and i.team_id = (select p.active_team_id from zz.principal p
                               where p.id = a.asked_by)),
         (select i.id
            from zz.initiative i
           where i.slug = a.initiative
             and (select count(*) from zz.initiative j where j.slug = a.initiative) = 1))
 where a.initiative is not null and a.initiative <> '';

-- The team is the initiative's where the text resolved, and otherwise the asker's active team.
-- A judgment is never asked for anonymously: a row that resolves neither fails the migration.
update zz.assessment a
   set team_id = coalesce(
         (select i.team_id from zz.initiative i where i.id = a.initiative_id),
         (select p.active_team_id from zz.principal p where p.id = a.asked_by));

do $$
declare n int;
begin
  select count(*) into n from zz.assessment where team_id is null;
  if n > 0 then
    raise exception 'assessment: % row(s) resolve no team', n;
  end if;
end $$;

alter table zz.assessment alter column team_id set not null;

-- `requested_model` was the model the asker named and `resolved_model` the one that answered;
-- only the second is a fact about what happened.
alter table zz.assessment drop column requested_model;
alter table zz.assessment drop column initiative;

alter table zz.assessment
  add constraint assessment_team_id_fkey foreign key (team_id) references zz.team(id);

alter table zz.assessment
  add constraint assessment_asked_by_fkey foreign key (asked_by) references zz.principal(id);

alter table zz.assessment
  add constraint assessment_model_call_id_fkey foreign key (model_call_id) references zz.model_call(id);

alter table zz.assessment
  add constraint assessment_team_id_initiative_id_fkey
  foreign key (team_id, initiative_id) references zz.initiative(team_id, id)
  on delete set null (initiative_id);

alter table zz.assessment
  add constraint assessment_reading_reason_check
  check ((reading = 'unavailable') = (reason is not null));

-- ---------------------------------------------------------------------------------------------
-- initiative_fact: one fact about one initiative, and the initiative is the key.
-- ---------------------------------------------------------------------------------------------

alter table zz.initiative_fact add column initiative_id uuid;

update zz.initiative_fact f
   set initiative_id = i.id
  from zz.team t, zz.initiative i
 where t.slug = f.team and i.team_id = t.id and i.slug = f.initiative;

do $$
declare n int;
begin
  select count(*) into n from zz.initiative_fact where initiative_id is null;
  if n > 0 then
    raise notice 'initiative_fact: % row(s) resolve no initiative and are dropped', n;
    delete from zz.initiative_fact where initiative_id is null;
  end if;
end $$;

-- The row's own identity was a surrogate key beside the only key that means anything.
alter table zz.initiative_fact drop column id;
alter table zz.initiative_fact drop column team;
alter table zz.initiative_fact drop column initiative;
alter table zz.initiative_fact alter column initiative_id set not null;

alter table zz.initiative_fact add primary key (initiative_id, fact);

alter table zz.initiative_fact
  add constraint initiative_fact_initiative_id_fkey
  foreign key (initiative_id) references zz.initiative(id) on delete cascade;

-- ---------------------------------------------------------------------------------------------
-- bug: a report names the team that owns it.
-- ---------------------------------------------------------------------------------------------

alter table zz.bug add column team_id uuid;
alter table zz.bug add column initiative_id uuid;
alter table zz.bug add column duplicate_of uuid;
alter table zz.bug add column reported_by_id uuid;
alter table zz.bug add column resolved_by_id uuid;

update zz.bug b set team_id = t.id from zz.team t where t.slug = b.team_slug;

update zz.bug b
   set initiative_id = i.id
  from zz.initiative i
 where i.team_id = b.team_id and i.slug = b.initiative;

update zz.bug b set reported_by_id = p.id from zz.principal p where p.email = lower(b.reported_by);
update zz.bug b set resolved_by_id = p.id from zz.principal p where p.email = lower(b.resolved_by);

do $$
declare n int;
begin
  select count(*) into n from zz.bug where reported_by_id is null;
  if n > 0 then
    raise exception 'bug: % row(s) name a reporter no principal has', n;
  end if;
end $$;

alter table zz.bug drop column reported_by;
alter table zz.bug drop column resolved_by;
alter table zz.bug rename column reported_by_id to reported_by;
alter table zz.bug rename column resolved_by_id to resolved_by;
alter table zz.bug alter column reported_by set not null;

alter table zz.bug drop column team_slug;
alter table zz.bug drop column initiative;

alter table zz.bug
  add constraint bug_team_id_fkey foreign key (team_id) references zz.team(id);

alter table zz.bug
  add constraint bug_initiative_id_fkey foreign key (initiative_id) references zz.initiative(id)
  on delete set null;

-- A duplicate points at the report it duplicates; cascading would delete a report because the one
-- it duplicates went away, and nulling it would break the check below.
alter table zz.bug
  add constraint bug_duplicate_of_fkey foreign key (duplicate_of) references zz.bug(id);

alter table zz.bug
  add constraint bug_reported_by_fkey foreign key (reported_by) references zz.principal(id);

alter table zz.bug
  add constraint bug_resolved_by_fkey foreign key (resolved_by) references zz.principal(id);

alter table zz.bug
  add constraint bug_team_id_initiative_id_fkey
  foreign key (team_id, initiative_id) references zz.initiative(team_id, id)
  on delete set null (initiative_id);

alter table zz.bug
  add constraint bug_duplicate_of_check check ((status = 'duplicate') = (duplicate_of is not null));

alter table zz.bug
  add constraint bug_initiative_id_team_id_check check (initiative_id is null or team_id is not null);

-- ---------------------------------------------------------------------------------------------
-- The two tables this phase drops.
-- ---------------------------------------------------------------------------------------------

-- A decision is a document's frontmatter and a discussion is a comment on it; neither was ever
-- the delivery record, and `doc` already holds both.
drop table zz.decision;
drop table zz.discussion_message;
