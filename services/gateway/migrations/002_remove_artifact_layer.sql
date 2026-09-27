-- 002_remove_artifact_layer — Phase 5 of the approved spec (`2026-09-21-schema-first-principles-review`):
-- the artifact/search layer's thirteen empty tables and their three default partitions go,
-- `knowledge_node` takes the shape the spec's Data model item 17 fixes, the evidence relation item 18
-- adds appears beside it, and the `pg_textsearch` extension leaves with the layer it was installed for.
--
-- The runner (`services/gateway/src/db.ts`) wraps this file in one transaction and records it in
-- `zz.schema_migration`; there is no `begin`/`commit` here and every name is schema-qualified.
--
-- WHY THE LAYER GOES. Every one of the thirteen tables is a projection of `.zz/commits/*.json` —
-- a file record that exists on no live store. Nothing in production reaches them: `applyCommit`
-- and `projectSearchAndPassages` are called only from tests and benchmarks, and `persist.ts`'s own
-- comment says its kernel adapters "are not wired into document_write/document_patch/
-- document_approve/source_add". They hold **zero rows in production**, so there is no data
-- disposition and nothing to archive. The guard below is what makes that a precondition rather
-- than an assumption: a single row anywhere refuses the migration instead of deleting it. The
-- design they implement (D1–D16 of the 2026-09-19 initiative) is not withdrawn — it stays
-- approved and restorable from git, and the day the data-migration initiative is opened it
-- becomes that initiative's plan.
--
-- WHY `knowledge_node` IS RESHAPED. Three of its relations are stored as text and one column
-- holds two facts. `team_slug` names a shelf by address where the shelf has an id; `superseded_by`
-- is a bare ordinal resolved by a `LIKE`; `evidence` is an array of initiative slugs — and a slug
-- is team-scoped, so of today's 944 citations 59 point at another shelf and one is ambiguous
-- across two. `path` is an address where the spec names a ordinal and a slug. The spec's item 17
-- is the authority for every column name below; the ledger's dissents (`content_hash` renamed to
-- `projection_hash`, `created_at` moved to `zz.event`, `updated_at` renamed to a date) are
-- recorded in the review rather than applied here, and `content_hash`, `created_at` and
-- `updated_at` are KEPT exactly as item 17 keeps them.
--
-- The two relations move in the order the data needs rather than the order they are declared:
-- `evidence` is expanded while `team_slug` is still readable, and `superseded_by` is resolved in a
-- SECOND pass after `node_ordinal` exists, because a node can be indexed before its successor.
--
-- WHAT THE PHASE ADDS FOR RETRIEVAL. `knowledge_node.body` and `doc.body` each gain a
-- `pg_trgm` GIN index. The Han clause of `knowledge_search` is `body ILIKE '%<clause>%'` today —
-- a literal substring match served by a sequential scan; the trigram index is what makes it an
-- index scan. `pg_trgm` therefore STAYS; `pg_textsearch` goes, because the only thing it was
-- installed for is the layer's BM25 index and no `bm25` index exists anywhere in `zz`.

-- ---------------------------------------------------------------------------------------------
-- (a) The thirteen tables and the three default partitions.
-- ---------------------------------------------------------------------------------------------
--
-- A row anywhere is a refusal, not a deletion. The tables are empty on every deployment the spec
-- was reviewed against, and the rehearsal re-proves it against the day's backup; this guard is
-- what makes "nothing to dispose of" a fact the migration checks rather than one it assumes.
-- Dropping `search_current`, `search_evidence` and `search_history` takes their `_default`
-- partitions with them, which is why the three are not named again below.

do $$
declare
  gone text[] := array[
    'artifact', 'artifact_revision', 'artifact_event', 'artifact_edge', 'artifact_passage',
    'artifact_identifier', 'artifact_projection_commit', 'artifact_projection_watermark',
    'doc_artifact', 'knowledge_node_artifact',
    'search_current', 'search_evidence', 'search_history'
  ];
  t text;
  n bigint;
  occupied text[] := '{}';
begin
  foreach t in array gone loop
    execute format('select count(*) from zz.%I', t) into n;
    if n > 0 then
      occupied := occupied || format('%s (%s row(s))', t, n);
    end if;
  end loop;
  if array_length(occupied, 1) > 0 then
    raise exception 'the artifact/search layer is not empty: % — these tables are projections of a '
      'file record no live store carries, so a row in one is evidence the projection ran and has to '
      'be disposed of deliberately rather than dropped. This migration refuses.', array_to_string(occupied, ', ');
  end if;
end $$;

drop table zz.artifact_edge, zz.artifact_identifier, zz.artifact_passage, zz.artifact_revision,
           zz.artifact_event, zz.artifact, zz.artifact_projection_commit,
           zz.artifact_projection_watermark, zz.doc_artifact, zz.knowledge_node_artifact,
           zz.search_current, zz.search_evidence, zz.search_history;

-- ---------------------------------------------------------------------------------------------
-- (b) `knowledge_node`: the shelf, the file's address, its successor and its citations.
-- ---------------------------------------------------------------------------------------------
--
-- Added null-tolerant first and made `NOT NULL` later, because each one is filled from a column
-- the same statement is about to drop: `team_id` from `team_slug`, `node_ordinal` and `slug` from
-- `path`, `superseded_by_id` from `superseded_by`. Nothing is guessed — a shelf that names no
-- team refuses, a path that is not `<nodes>/<ordinal>-<slug>.md` refuses, and a successor ordinal
-- that matches no node on the shelf is reported and left null.

alter table zz.knowledge_node
  add column team_id uuid,
  add column node_ordinal text,
  add column slug text,
  add column superseded_by_id uuid;

-- A `team_slug` that resolves to no team is a shelf that does not exist. Writing a null key, or a
-- key for the wrong team, would put the node on a shelf nobody can read it from, so it refuses.
do $$
declare
  n bigint;
  who text;
begin
  select count(*) into n
    from zz.knowledge_node k
   where not exists (select 1 from zz.team t where t.slug = k.team_slug);
  if n > 0 then
    select string_agg(distinct k.team_slug, ', ') into who
      from zz.knowledge_node k
     where not exists (select 1 from zz.team t where t.slug = k.team_slug);
    raise exception 'knowledge_node.team_slug names no team: % row(s) on %. The shelf is a relation '
      'to `team` now, and a slug that resolves to nothing has no id to write.', n, who;
  end if;
end $$;

update zz.knowledge_node k
   set team_id = t.id
  from zz.team t
 where t.slug = k.team_slug;

-- `path` held two facts: the shelf-local ordinal the file's name begins with, and the rest of it.
-- `nodes/0028-a-lesson.md` is ordinal `0028`, slug `a-lesson`. A path that is not that shape has
-- no honest split, so it refuses rather than inventing one.
update zz.knowledge_node
   set node_ordinal = substring(path from '^nodes/([0-9]+)-'),
       slug         = substring(path from '^nodes/[0-9]+-(.+)\.md$');

do $$
declare
  n bigint;
  samples text;
begin
  select count(*) into n
    from zz.knowledge_node
   where node_ordinal is null or node_ordinal = '' or slug is null or slug = '';
  if n > 0 then
    select string_agg(s.path, ', ') into samples from (
      select path from zz.knowledge_node
       where node_ordinal is null or node_ordinal = '' or slug is null or slug = ''
       order by path limit 5) s;
    raise exception 'knowledge_node.path is not <nodes>/<ordinal>-<slug>.md for % row(s): % — the '
      'ordinal and the slug are the file address now, and a path this migration cannot split has no '
      'honest pair to write.', n, samples;
  end if;
end $$;

-- `evidence` is a relation hidden in a slug array. A slug is team-scoped, so the node's own shelf
-- decides where the slug is ambiguous: `order by (t.slug = k.team_slug) desc` prefers the citing
-- node's team and falls back to the lowest id, which is a resolution rather than a guess about
-- which team a reader meant. A slug that resolves nowhere is reported below rather than dropped
-- silently.
create table zz.knowledge_node_evidence (
    node_id uuid NOT NULL,
    initiative_id uuid NOT NULL,
    CONSTRAINT knowledge_node_evidence_pkey PRIMARY KEY (node_id, initiative_id),
    CONSTRAINT knowledge_node_evidence_node_id_fkey FOREIGN KEY (node_id)
        REFERENCES zz.knowledge_node(id) ON DELETE CASCADE,
    CONSTRAINT knowledge_node_evidence_initiative_id_fkey FOREIGN KEY (initiative_id)
        REFERENCES zz.initiative(id)
);

insert into zz.knowledge_node_evidence (node_id, initiative_id)
select k.id, i.id
  from zz.knowledge_node k
  cross join lateral unnest(k.evidence) as e(slug)
  cross join lateral (
    select i.id
      from zz.initiative i
      join zz.team t on t.id = i.team_id
     where i.slug = e.slug
     order by (t.slug = k.team_slug) desc, i.id
     limit 1
  ) i;

do $$
declare
  n bigint;
  who text;
begin
  select count(*), string_agg(distinct u.slug, ', ') into n, who
    from (select e.slug
            from zz.knowledge_node k
            cross join lateral unnest(k.evidence) as e(slug)
           where not exists (select 1 from zz.initiative i where i.slug = e.slug)) u;
  if n > 0 then
    raise warning 'knowledge_node.evidence: % citation(s) name an initiative slug no shelf carries '
      'and were not carried: %', n, who;
  end if;
end $$;

-- The successor is resolved in a SECOND pass, after `node_ordinal` exists, because a node can be
-- indexed before its successor: the recorded ordinal was the only handle, and it only became a
-- join key in the statement above. Same shelf, same ordinal.
update zz.knowledge_node k
   set superseded_by_id = s.id
  from zz.knowledge_node s
 where k.superseded_by is not null
   and s.team_id = k.team_id
   and s.node_ordinal = k.superseded_by;

do $$
declare
  n bigint;
  samples text;
begin
  select count(*) into n
    from zz.knowledge_node
   where superseded_by is not null and superseded_by_id is null;
  if n > 0 then
    select string_agg(s.ord, ', ') into samples from (
      select superseded_by as ord from zz.knowledge_node
       where superseded_by is not null and superseded_by_id is null
       order by superseded_by limit 5) s;
    raise warning 'knowledge_node.superseded_by: % successor ordinal(s) match no node on the same '
      'shelf and were left null: % — the lifecycle check below is on the resolved key, so a row '
      'whose ordinal did not resolve is reported here and refuses there.', n, samples;
  end if;
end $$;

-- The columns the three relations and the address were stored in. `team_slug` and `path` take the
-- unique constraint and the `(team_slug, lifecycle)` index with them.
alter table zz.knowledge_node
  drop column team_slug,
  drop column path,
  drop column superseded_by,
  drop column evidence;

alter table zz.knowledge_node
  alter column team_id set not null,
  alter column node_ordinal set not null,
  alter column slug set not null;

-- The lifecycle CHECK is on the RESOLVED key, which is the spec's wording and is stronger than one
-- on the recorded ordinal: a node that says it was superseded must name the row that superseded it.
alter table zz.knowledge_node
  add constraint knowledge_node_team_id_fkey foreign key (team_id) references zz.team(id),
  add constraint knowledge_node_team_id_id_key unique (team_id, id),
  add constraint knowledge_node_team_id_node_ordinal_key unique (team_id, node_ordinal),
  add constraint knowledge_node_superseded_by_id_fkey foreign key (team_id, superseded_by_id)
      references zz.knowledge_node(team_id, id),
  add constraint knowledge_node_lifecycle_superseded_check
      check ((lifecycle = 'superseded') = (superseded_by_id is not null));

create index knowledge_node_team on zz.knowledge_node using btree (team_id, lifecycle);

-- ---------------------------------------------------------------------------------------------
-- (c) The index Chinese retrieval needs, on both tables the search reads.
-- ---------------------------------------------------------------------------------------------
--
-- `knowledge_search` reads `zz.doc union all zz.knowledge_node` and matches a Han clause as
-- `body ILIKE '%<clause>%'`. Without a trigram index that is a sequential scan on both tables;
-- `pg_trgm` is installed and stays. Two characters or fewer still fall back to the scan — a floor
-- on speed, not on correctness.

create index knowledge_node_body_trgm on zz.knowledge_node using gin (body gin_trgm_ops);
create index doc_body_trgm on zz.doc using gin (body gin_trgm_ops);

-- ---------------------------------------------------------------------------------------------
-- (d) The extension the layer was installed for.
-- ---------------------------------------------------------------------------------------------
--
-- `pg_textsearch` shipped the layer's BM25 index. No `bm25` index exists in `zz` — the access
-- method was registered and never used — so the extension leaves with the tables. Dropped last, on
-- purpose: it is only safe once every relation that could have depended on it is gone. `pg_trgm`
-- and `citext` stay, and `001_init.sql` keeps its declarations for both; this file creates no
-- extension, so it declares no `-- requires-extension:` line.

drop extension if exists pg_textsearch;
