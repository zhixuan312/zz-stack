-- An initiative and a run get a home, so `flow` and `step_version` stop being copied onto
-- every row that mentions them.
--
-- WHAT WAS WRONG. `flow` sat on zz.doc AND on every zz.event row. It is a property of the
-- INITIATIVE -- one piece of work, run by one method -- so it was stored once per document and
-- once per tool call instead of once. Same for the skill version: 5,487 events each carried
-- `step` and `step_version` as text, when what they actually belong to is a RUN of one skill
-- version on one initiative.
--
-- NOTHING IS LOST DOING THIS. zz.event.detail already carries `run` -- the platform has been
-- emitting a run identifier per call all along, on 3,679 rows -- so zz.run backfills from
-- history rather than starting empty.
--
-- THESE TWO TABLES ARE OURS AND REINDEX MUST NEVER TOUCH THEM. reindexTeam walks the team's
-- filesystem and deletes zz.doc and zz.decision rows with no matching file, which is right:
-- those are a cache of their documents. It must not reconcile initiative or run against
-- anything. A team archiving their work is a statement about their workspace, not permission to
-- erase our record of how our skill performed while doing it. The guard is written here, before
-- there is anything to lose.

create table if not exists zz.initiative (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references zz.team(id),
  slug       text not null,
  flow       text not null default '',
  created_at timestamptz not null default now(),
  closed_at  timestamptz,
  -- Set when the documents stop existing on disk. NOT a delete: the runs and evaluations
  -- hanging off this row stay readable, and a report can say "4 of these the team has since
  -- deleted" instead of silently showing 26 where there were 30.
  deleted_at timestamptz,
  unique (team_id, slug)
);

create table if not exists zz.run (
  id               uuid primary key default gen_random_uuid(),
  -- SET NULL, never cascade. See the header: their deletion is not our data loss.
  initiative_id    uuid references zz.initiative(id) on delete set null,
  skill_version_id uuid references zz.skill_version(id),
  -- The identifier the platform emits in zz.event.detail->>'run'. It is a CALLER SESSION, not a
  -- run of one skill, and the column is named for what it is because the first version of this
  -- migration was named for what it was assumed to be. One session value was found carrying
  -- eight different steps inside a single initiative; keying runs on it collapsed every step of
  -- an initiative into one row and left 29 of 71 runs attached to no skill at all.
  caller_session   text not null default '',
  -- THE STATISTICS, summarised once per run rather than aggregated over millions of events
  -- every time somebody asks how a skill is doing.
  turns            int not null default 0,
  calls            int not null default 0,
  refusals         int not null default 0,
  -- Context spent. Kept beside refusals because a usage skill can be clean on refusals and
  -- still be wrong: a usage skill can take a single refusal across all its calls -- clean -- while
  -- a run of calls to one documentation tool burns tens of MB of context, and nothing in a refusal count could see it.
  -- A loop that measures only refusals optimises the half it can see.
  bytes_total      bigint not null default 0,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  outcome          text not null default ''
                   check (outcome in ('', 'accepted', 'delivered', 'open', 'abandoned')),
  -- THE GRAIN: one run per skill version per caller session per initiative. A step that runs
  -- twice in one session is one run; two different steps are never one run.
  unique (initiative_id, skill_version_id, caller_session)
);

create index if not exists run_skill_version on zz.run (skill_version_id, started_at desc);

-- BACKFILL, from the history that already exists.
--
-- Teams first: every initiative that appears in the event stream or the document index.
insert into zz.initiative (team_id, slug, flow, created_at)
select t.id, x.initiative, coalesce(max(x.flow), ''), min(x.ts)
  from (
    select team_slug, initiative, flow, ts from zz.event
     where initiative is not null and initiative <> ''
    union all
    select team_slug, initiative, flow, created_at from zz.doc
     where initiative is not null and initiative <> ''
  ) x
  join zz.team t on t.slug = x.team_slug
 group by t.id, x.initiative
on conflict (team_id, slug) do nothing;

-- Then the runs. One per (initiative, detail->>'run'), which is the grain the platform was
-- already emitting. Events with no run identifier are left unattached rather than invented --
-- an event that cannot be placed in a run is data about a call, not a reason to fabricate one.
insert into zz.run (initiative_id, skill_version_id, caller_session,
                    calls, refusals, bytes_total, started_at, ended_at)
select i.id,
       sv.id,
       e.detail->>'run',
       count(*),
       count(*) filter (where e.ok is false),
       coalesce(sum((e.detail->>'bytes')::bigint), 0),
       min(e.ts),
       max(e.ts)
  from zz.event e
  join zz.team t       on t.slug = e.team_slug
  join zz.initiative i on i.team_id = t.id and i.slug = e.initiative
  left join zz.skill s        on s.name = e.step
  left join zz.skill_version sv on sv.skill_id = s.id and sv.version = e.step_version
 where e.detail ? 'run' and e.initiative is not null and e.initiative <> ''
 group by i.id, sv.id, e.detail->>'run'
on conflict (initiative_id, skill_version_id, caller_session) do nothing;
