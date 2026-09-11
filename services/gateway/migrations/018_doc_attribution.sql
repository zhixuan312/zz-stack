-- zz.doc gets a surrogate key, an initiative, and the run that produced it.
--
-- THE MISSING LINK THIS CLOSES. zz.doc recorded `flow` but never which SKILL VERSION wrote the
-- document. So "evaluate everything ops-intent 1.0 ever produced" -- the question the whole
-- re-evaluation framework is built on -- had to be inferred by joining through zz.event and
-- guessing from `type`, which cross-products: one such query reported 351 documents across 10
-- initiatives.
--
-- ONE FOREIGN KEY ANSWERS IT. produced_by_run_id gives the run, and through it the skill, the
-- version, the flow, the initiative and the team. Two denormalized text columns would have given
-- less and could drift from the event log; this cannot.
--
-- SAFE TO RESTRUCTURE. zz.doc is a DERIVED index -- reindexTeam rebuilds every row from the
-- files on disk, and the file plus its git history is the tenant's actual asset. Nothing here is
-- a last copy of anything.
--
-- THIS MIGRATION ONLY ADDS. The old columns stay, and every read path in both services keeps
-- working untouched, because attribution is worth having on the next document written and the
-- read-path refactor is a separate piece of work. 021 removes them once that lands. Splitting it
-- this way is release sequencing, not a compatibility shim: the end state is identical and there
-- is no branch anywhere choosing between old and new.

alter table zz.doc add column if not exists id                 uuid not null default gen_random_uuid();
alter table zz.doc add column if not exists initiative_id      uuid references zz.initiative(id) on delete set null;
alter table zz.doc add column if not exists produced_by_run_id uuid references zz.run(id) on delete set null;

-- The surrogate key needs to be unique NOW, not when 021 makes it the primary key: zz.decision
-- references it in this same migration, and a foreign key demands a unique target. The existing
-- (team_slug, initiative, path) primary key stays untouched until the read paths move.
create unique index if not exists doc_id_unique on zz.doc (id);

update zz.doc d set initiative_id = i.id
  from zz.team t join zz.initiative i on i.team_id = t.id
 where d.initiative_id is null and t.slug = d.team_slug and i.slug = d.initiative;

-- Attach each document to the run of the step that OWES it. The join is on the document's role,
-- which the flow manifest defines, rather than on timing -- a document written late in one run
-- and revised in another belongs to whichever step owes that role.
update zz.doc d set produced_by_run_id = r.id
  from zz.run r
  join zz.skill_version sv on sv.id = r.skill_version_id
  join zz.skill s on s.id = sv.skill_id
 where d.produced_by_run_id is null
   and r.initiative_id = d.initiative_id
   and d.type = case s.name
                  when 'ops-intent' then 'intent'
                  when 'ops-spec'   then 'agreement'
                  when 'ops-select' then 'selection'
                  when 'ops-plan'   then 'plan'
                  when 'ops-verify' then 'verification'
                  else '\x00' end;

-- ── a decision's blocks become foreign keys ──
--
-- `zz.decision.blocks` was a text[] filled from a free-text `server:` line, and it accumulated
-- seventeen spellings for three blocks. Normalising at index time stopped new bad rows; a
-- junction table makes them IMPOSSIBLE, because a block that is not in zz.block cannot be
-- inserted at all. That is the fix a parser can never be.
--
-- Additive here for the same reason as the rest of this migration: the old columns stay until
-- the read paths move.

create table if not exists zz.decision_block (
  doc_id           uuid not null,
  key              text not null,
  block_version_id uuid not null references zz.block_version(id),
  primary key (doc_id, key, block_version_id)
);

alter table zz.decision add column if not exists doc_id uuid references zz.doc(id) on delete cascade;

update zz.decision dc set doc_id = d.id
  from zz.doc d
  join zz.initiative i on i.id = d.initiative_id
  join zz.team t on t.id = i.team_id
 where dc.doc_id is null and t.slug = dc.team_slug
   and i.slug = dc.initiative and d.path = dc.path;

insert into zz.decision_block (doc_id, key, block_version_id)
select dc.doc_id, dc.key, bv.id
  from zz.decision dc
  cross join lateral unnest(dc.blocks) as bn(name)
  join zz.block b on b.name = bn.name
  join zz.block_version bv on bv.block_id = b.id
   and bv.version = coalesce(nullif(dc.block_versions->>bn.name, ''), 'unknown')
 where dc.doc_id is not null
on conflict do nothing;
