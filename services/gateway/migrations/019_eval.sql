-- How good it was. These tables are OURS and no tenant action may delete a row in them.
--
-- THE RULE, AND WHY IT IS NOT OBVIOUS. reindexTeam deletes zz.doc rows whose files are gone --
-- correct, since zz.doc is a cache of a team's files. An earlier draft of this schema hung
-- zz.eval_score off zz.doc(id). That would have meant a team archiving an initiative silently
-- destroyed our measurement of how our own skill performed. It nearly happened: resetting the
-- evaluation store archived 37 initiatives and reindex removed 132 rows.
--
-- A team deleting their work is a statement about their workspace. It is not permission to erase
-- our record.
--
-- SO A SCORE POINTS AT A SUBJECT, NOT AT A DOCUMENT. zz.eval_subject captures what was scored --
-- team, initiative slug, path, content hash, git commit -- at the moment of scoring. The link to
-- zz.doc is a convenience that goes null when the document does.
--
-- IT ALSO FIXES A QUIETER PROBLEM. Documents change after being scored: one initiative here holds
-- spec.v1, spec.v2 and spec.v4. Joining a score to "the document" means it silently becomes a
-- score about text nobody ever judged. content_hash makes that impossible.
--
-- AND IT KEEPS THE TEXT WITHOUT HOARDING IT. We store the git commit, not a body copy. The team's
-- store IS a git repository -- 271 commits on the evaluation team alone -- and a file archived
-- out of the working tree is still readable by sha. So "why did r07 score 3.2" is answerable
-- without us holding a second copy of tenant content that outlives their deletion.

create table if not exists zz.eval (
  id               uuid primary key default gen_random_uuid(),
  skill_version_id uuid not null references zz.skill_version(id),
  -- The ruler. Two evaluations are comparable IFF they share a rubric and their subjects
  -- overlap -- which is now a predicate a reader can check, rather than a habit. A dashboard
  -- can refuse to draw a trend line across a rubric change instead of drawing a misleading one.
  rubric_id        uuid not null references zz.rubric(id),
  judge_model      text not null default '',
  selection_note   text not null default '',
  doc_count        int  not null default 0,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create table if not exists zz.eval_subject (
  id               uuid primary key default gen_random_uuid(),
  eval_id          uuid not null references zz.eval(id) on delete cascade,
  team_id          uuid references zz.team(id),
  initiative_slug  text not null,
  path             text not null,
  content_hash     text not null default '',
  git_commit       text not null default '',
  skill_version_id uuid references zz.skill_version(id),
  -- A SOFT POINTER, DELIBERATELY NOT A FOREIGN KEY. Every other link in this schema is a real
  -- constraint; this one must not be. A foreign key -- even ON DELETE SET NULL -- makes our
  -- measurement structurally dependent on a row that reindexTeam deletes whenever a team's file
  -- goes away, and the whole point of this table is that it does not care. It also lets these
  -- tables exist before zz.doc has a surrogate key at all.
  --
  -- What identifies the subject is the four columns above: team, initiative slug, path, and the
  -- content hash of the exact text scored. Those never dangle.
  doc_id           uuid,
  evaluated_at     timestamptz not null default now(),
  unique (eval_id, initiative_slug, path)
);

create table if not exists zz.eval_score (
  eval_id      uuid not null references zz.eval(id) on delete cascade,
  subject_id   uuid not null references zz.eval_subject(id) on delete cascade,
  dimension_id uuid not null references zz.rubric_dimension(id),
  score        smallint not null check (score between 1 and 5),
  -- The judge must cite the document verbatim: a score whose evidence cannot be found is a
  -- score nobody can check. Short excerpts of tenant text, kept deliberately -- the alternative
  -- is unauditable measurement.
  quote        text not null default '',
  reason       text not null default '',
  -- The scrambled twin: the same document marked against a NEIGHBOUR's requirement. It sits in
  -- the primary key so it can never be quietly dropped, because a quality score without one
  -- cannot be told apart from a judge rewarding confident prose. Every control run so far has
  -- collapsed to the floor with every document caught as off-topic.
  is_control   boolean not null default false,
  primary key (eval_id, subject_id, dimension_id, is_control)
);

-- ONE ROW PER SUBJECT PER DIMENSION, NEVER AN AVERAGE. This is what lets 30 pieces of work grow
-- to 3,000 and still support "compare these two versions on the subjects they both cover" -- a
-- set intersection rather than an impossibility. An average collapsed at write time can never be
-- un-collapsed at read time.

create table if not exists zz.eval_finding (
  id                          uuid primary key default gen_random_uuid(),
  eval_id                     uuid not null references zz.eval(id) on delete cascade,
  pattern                     text not null,
  docs_affected               int not null default 0,
  -- generic: recurs across unrelated tenants and subject matter, so it is the SKILL's habit and
  --   worth changing a skill over.
  -- specific: one piece of work's own problem, fixed by writing that document better. A rule
  --   written for a fault seen once is read on every run forever and fires on almost none.
  scope                       text not null check (scope in ('generic', 'specific')),
  proposed_change             text not null default '',
  decision                    text not null default 'deferred'
                              check (decision in ('applied', 'rejected', 'deferred')),
  -- Closes the loop: the version cut to address this finding, so the NEXT evaluation can ask
  -- whether it actually worked rather than assuming it did.
  resulted_in_skill_version_id uuid references zz.skill_version(id) on delete set null,
  created_at                  timestamptz not null default now()
);

create index if not exists eval_by_version  on zz.eval (skill_version_id, started_at desc);
create index if not exists eval_subject_doc on zz.eval_subject (initiative_slug, path);
