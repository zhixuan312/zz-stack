-- The knowledge base could say that an answer existed. It could not say what it was.
--
-- `search_knowledge` returned metadata rows — initiative, path, type, status, dates — and
-- nothing else, because `doc` stored a tsvector and threw the text away. A caller had to
-- read_file every candidate to learn what any of them said. Ranking was `order by
-- updated_at desc`, which is recency, not relevance: the best answer to a question sorted
-- below an unrelated document edited yesterday.
--
-- These columns are what a journal engine's ranking needs, translated to Postgres.
--
--   body          the indexed text itself. ts_headline cannot cut an excerpt and ts_rank_cd
--                 cannot score without the source text; storing only the tsvector made both
--                 impossible.
--   title         the document's own title from frontmatter, so a result is nameable before
--                 anyone opens it — and so the title can carry more ranking weight than the
--                 body, which is how a node about a topic outranks one that mentions it.
--   tags          tag overlap with the query's tokens is an independent ranking signal. The
--                 old schema had no way to see it.
--   evidence      the initiatives a journal node came from. This is the graph edge: the prior system's
--                 engine expands from top hits to their typed-edge neighbours, and evidence
--                 is the edge this store actually has.
--   superseded_by the id of the node that replaced this one. A superseded decision is the
--                 most valuable thing a recall can surface — "we tried this and moved on" —
--                 so it has to be visible as a first-class field rather than parsed out of
--                 a body by whoever happens to read it.
--
-- Existing rows get empty defaults and re-populate on their next write. That is deliberate:
-- a backfill would re-read every file through the same path that indexes them, and doing it
-- lazily costs one stale-until-touched window against a store whose documents are rewritten
-- constantly.

alter table doc add column if not exists body          text   not null default '';
alter table doc add column if not exists title         text   not null default '';
alter table doc add column if not exists tags          text[] not null default '{}';
alter table doc add column if not exists evidence      text[] not null default '{}';
alter table doc add column if not exists superseded_by text;

-- Ranking filters on team + type + status on nearly every query: journal nodes are selected
-- by type, and superseded nodes are separated from adopted ones. The existing
-- doc_type_status index does not cover the team scoping that always accompanies them, so
-- every such query fell back to a scan of the team's documents.
create index if not exists doc_team_type on doc (team_slug, type, status);

-- Tag overlap and evidence expansion both test array containment. GIN makes `tags && $n`
-- and `evidence && $n` indexed rather than a scan over the candidate pool's source.
create index if not exists doc_tags     on doc using gin (tags);
create index if not exists doc_evidence on doc using gin (evidence);
