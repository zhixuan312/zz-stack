-- The things that repeat: what we OFFER a team, named once and referenced everywhere.
--
-- Until now a skill existed as two text columns on zz.event (`step`, `step_version`) and a block
-- as two more (`block`, `block_version`). That is not a schema, it is a spelling convention, and
-- it failed exactly the way spelling conventions fail: `zz.decision.blocks` accumulated
-- SEVENTEEN distinct spellings for three subjects -- the bare name, the name with each client's
-- own wrapper prefix, the name with a tool suffix, and two entries that were punctuation.
-- Reconcile joined on about a third of the rows it should have and reported the rest as
-- predictions about nothing, silently, for a day and a half.
--
-- A foreign key is the fix a parser cannot be: you cannot insert a block that does not exist.
--
-- WHAT IS OURS AND WHAT IS THEIRS. Everything in this file is the PLATFORM's. A team's documents
-- are theirs -- the file on disk and its git history -- and zz.doc is our derived index of them.
-- Skills, rubrics, blocks and the annotations we write about somebody else's tool surface are
-- ours outright, and nothing a tenant does may delete them. That rule is enforced in 021 where
-- the evaluation tables land; it is stated here because it is the reason these tables exist
-- separately at all.

create table if not exists zz.block (
  id    uuid primary key default gen_random_uuid(),
  name  text not null unique
);

-- A block's own account of itself, from the MCP handshake. Versioned because every claim we
-- make about a block -- a trap, a cost, a required argument -- is true of ONE version of it and
-- unverified against the next.
create table if not exists zz.block_version (
  id            uuid primary key default gen_random_uuid(),
  block_id      uuid not null references zz.block(id),
  version       text not null,
  first_seen_at timestamptz not null default now(),
  unique (block_id, version)
);

create table if not exists zz.skill (
  id       uuid primary key default gen_random_uuid(),
  name     text not null unique,
  -- flow_step: ours, sits in a flow, we edit the text directly.
  -- common: ours, loaded by every flow (zz-backbone).
  -- block_usage: written ABOUT somebody else's MCP server. We cannot change the block, so this
  --   is the only surface we have for what we learned by calling it.
  kind     text not null check (kind in ('flow_step', 'common', 'block_usage')),
  flow     text,
  block_id uuid references zz.block(id),
  ordinal  int,
  -- A flow step belongs to a flow; a block usage skill belongs to a block; a common skill to
  -- neither. Getting this wrong is how a usage skill ends up ranked as a step of a flow.
  constraint skill_belongs_correctly check (
    (kind = 'flow_step'   and flow is not null and block_id is null) or
    (kind = 'common'      and flow is null     and block_id is null) or
    (kind = 'block_usage' and flow is null     and block_id is not null))
);

-- THE DEFINITION OF GOOD, and it attaches to the SKILL rather than to a version of it.
--
-- That is deliberate and it is the whole basis of comparison. Scoring v1.0 and v1.1 against
-- different rubrics compares two things measured with two rulers. So a version that changes
-- nothing about what good means -- a typo, a clearer sentence -- keeps pointing at the same
-- rubric row, and that reuse IS the assertion that it stays comparable.
create table if not exists zz.rubric (
  id                  uuid primary key default gen_random_uuid(),
  skill_id            uuid not null references zz.skill(id),
  version             text not null,
  -- A rubric is DERIVED from real output rather than declared by whoever wrote the skill:
  -- otherwise it is an exam written by the candidate. This records which evaluation it came
  -- out of. Null for the first one, which had no prior evaluation to read.
  derived_from_eval   uuid,
  approved_by         text,
  created_at          timestamptz not null default now(),
  unique (skill_id, version)
);

create table if not exists zz.rubric_dimension (
  id         uuid primary key default gen_random_uuid(),
  rubric_id  uuid not null references zz.rubric(id),
  name       text not null,
  -- Both ends written out, because a dimension a marker cannot place is a dimension that gets
  -- placed by mood. Every one of these must need a READER: anything a script can check belongs
  -- in the mechanical pass, and a dimension that duplicates it wastes the only judge there is.
  five_means text not null,
  one_means  text not null,
  ordinal    int not null default 0,
  unique (rubric_id, name)
);

create table if not exists zz.skill_version (
  id           uuid primary key default gen_random_uuid(),
  skill_id     uuid not null references zz.skill(id),
  version      text not null,
  content_hash text not null default '',
  -- Which ruler judges this version. Cutting a version forces the choice -- reuse the existing
  -- rubric, or write a new one -- so "does this change what good means" is answered on purpose
  -- rather than by default.
  rubric_id    uuid references zz.rubric(id),
  released_at  timestamptz not null default now(),
  unique (skill_id, version)
);

-- A skill version is not only prose. It can carry mechanical helpers, versioned WITH it, so the
-- loop can measure whether attaching one improved anything.
--
-- The rule for reaching for an asset instead of a sentence: WHEN THE FAULT IS COMPLETENESS OVER
-- AN ENUMERABLE SET, BUILD AN ASSET; WHEN IT IS JUDGEMENT, WRITE WORDS. ops-select omits a
-- candidate block in nearly every document, and ops-intent silently settles an ambiguity in 13 of 30
-- -- both against rules those skills ALREADY STATE. That is the evidence that prose does not
-- hold for completeness.
create table if not exists zz.skill_asset (
  id               uuid primary key default gen_random_uuid(),
  skill_version_id uuid not null references zz.skill_version(id),
  -- script:     makes a guarantee the prose can only request.
  -- reference:  a block's real quirks, quoted from refusals we actually met.
  -- tool_index: the answer to a large tool surface. A block may advertise a couple of hundred
  --             tools and a few hundred KB of schema in every prompt, where a small one
  --             advertises a couple of dozen at a few KB. A caller cannot choose well from
  --             hundreds, and this narrows it. Generated from zz.block_tool, not typed.
  kind             text not null check (kind in ('script', 'reference', 'tool_index')),
  path             text not null,
  content_hash     text not null default '',
  description      text not null default '',
  unique (skill_version_id, path)
);

-- OUR ANNOTATIONS ON SOMEBODY ELSE'S TOOL SURFACE.
--
-- The block is not ours. We cannot page a response, add a filter argument, or make a guide
-- return one section. This table is where what we learned by calling it lives, so the next
-- caller does not learn it the same way.
--
-- Keyed to block_version_id and not block_id: casebox ships a new version and every annotation here
-- is a claim about the old one until somebody re-verifies it.
create table if not exists zz.block_tool (
  id                 uuid primary key default gen_random_uuid(),
  block_version_id   uuid not null references zz.block_version(id),
  name               text not null,
  verdict            text not null default 'preferred'
                     check (verdict in ('preferred', 'use_with_care', 'avoid')),
  -- MEASURED, NOT REMEMBERED. zz.event.detail already carries `bytes` and `ms` on every call,
  -- so these are derived by a query anybody can re-run rather than typed from an incident.
  -- casebox:read_api_spec averages a very large payload bytes and peaks larger still -- most of a
  -- context window, for the tool a caller reaches for to LEARN the API. casebox:read_user_guide
  -- returns a very large payload bytes every single time; its average equals its maximum.
  --
  -- Neither is a refusal. Both SUCCEED, which is why no error was ever recorded and why the
  -- refusal-based score called that usage skill clean while it burned tens of MB of context.
  observed_bytes_avg bigint,
  observed_bytes_max bigint,
  observed_ms_max    bigint,
  calls_observed     int not null default 0,
  note               text not null default '',
  -- A verdict must point at the call where we saw it. SET NULL rather than cascade: the
  -- annotation is ours and outlives any pruning of the event stream.
  evidence_event_id  bigint references zz.event(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  unique (block_version_id, name)
);

create index if not exists block_tool_expensive
  on zz.block_tool (observed_bytes_avg desc nulls last);

-- SEEDED FROM THE EVIDENCE, not from a list typed here.
--
-- zz.event still carries `step`, `step_version`, `block` and `block_version` as text at this
-- point -- 018 is what removes them -- so the set of skills and blocks that actually ran is
-- readable from history. A list hardcoded in a migration is a list that is wrong the first time
-- somebody adds a skill; this one cannot be, because it is derived from what happened.
--
-- The seed has to be HERE rather than later: 017 attaches every run to a skill version, and a
-- run with no skill version is a run nobody can evaluate.

insert into zz.block (name)
select distinct block from zz.event where block is not null and block <> ''
on conflict (name) do nothing;

insert into zz.block_version (block_id, version)
select distinct b.id, coalesce(nullif(e.block_version, ''), 'unknown')
  from zz.event e join zz.block b on b.name = e.block
 where e.block is not null and e.block <> ''
on conflict (block_id, version) do nothing;

-- A skill's kind is read off its name and how it was used, which is the only evidence there is.
-- `zz-` prefixed skills are the platform's own and are loaded by every flow. A name ending
-- `-usage` is written ABOUT a block, and its block is the first segment of its name
-- (casebox-stg-usage -> casebox). Everything else is a step of the flow it was seen running in.
insert into zz.skill (name, kind, flow, block_id)
select e.step,
       case when e.step like 'zz-%'    then 'common'
            when e.step like '%-usage' then 'block_usage'
            else 'flow_step' end,
       case when e.step like 'zz-%' or e.step like '%-usage' then null
            else nullif((array_agg(e.flow order by e.ts desc)
                          filter (where e.flow is not null and e.flow <> ''))[1], '') end,
       case when e.step like '%-usage'
            then (select b.id from zz.block b where b.name = split_part(e.step, '-', 1))
            else null end
  from zz.event e
 where e.step is not null and e.step <> ''
 group by e.step
on conflict (name) do nothing;

-- A flow step whose flow was never recorded cannot satisfy the kind constraint, and calling it
-- a flow step with no flow would be recording a guess. It becomes common, which is the honest
-- reading of "ran under no particular flow".
update zz.skill set kind = 'common' where kind = 'flow_step' and flow is null;

insert into zz.skill_version (skill_id, version)
select distinct s.id, coalesce(nullif(e.step_version, ''), 'unknown')
  from zz.event e join zz.skill s on s.name = e.step
 where e.step is not null and e.step <> ''
on conflict (skill_id, version) do nothing;
