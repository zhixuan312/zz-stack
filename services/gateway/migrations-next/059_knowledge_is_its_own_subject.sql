-- A knowledge node is not a document, and `adopted` is not a gate verdict.
--
-- NOT APPLIED YET, and this directory is why. The statement is correct and proven — run
-- against a copy of production inside a transaction that rolled back, it moves 853 rows,
-- leaves 0 nodes in zz.doc, carries every node's evidence, and keeps both lifecycles and all
-- six kinds. What has not moved is the CODE: indexDoc still writes a node into zz.doc,
-- knowledge_search still reads it there, and the console's knowledge routes still join it.
-- Applying this before they move would empty the knowledge index without emptying the store,
-- and a search would answer "nothing is known" about 853 nodes that are right there on disk.
--
-- zz.doc held three subjects: 376 initiative documents and sources, and 853 knowledge nodes.
-- They shared a `status` column in which `approved` means A PERSON AGREED and `adopted` means
-- THIS IS THE BEST WE CURRENTLY KNOW. Those are different questions with different lifecycles
-- and different owners, and a column that cannot tell them apart cannot answer either: every
-- query about gates had to remember to exclude `nodes/`, and every query about knowledge had
-- to remember to include only it. A predicate every caller must remember is a predicate some
-- caller will forget.
--
-- The separation is exact and needs no judgement: 853 rows carry `initiative = '_knowledge'`
-- and a `nodes/` path, and every other row carries neither. There is no row where the two
-- disagree.
--
-- SIX COLUMNS DO NOT COME WITH THEM, which is the other half of the argument. A node has never
-- had a flow, an outcome, an approver, an approval time, a closing actor or a supported
-- document -- 0 of 853 for each. They were on the row because documents need them.

create table if not exists zz.knowledge_node (
  id            uuid primary key default gen_random_uuid(),
  team_slug     text not null,
  -- `nodes/<NNNN>-<slug>.md`, relative to the team's `_knowledge/`. The file is the source of
  -- truth and this is the index of it, exactly as zz.doc is for documents.
  path          text not null,
  -- WHAT THE NODE IS ABOUT, and it is the same closed vocabulary knowledge_add enforces.
  kind          text not null
                check (kind in ('decision', 'design', 'process', 'knowledge', 'behavior', 'style')),
  -- NOT `status`, and that rename is the point of this migration. A node is adopted until
  -- something better replaces it; nobody approves one. Sharing a column with a gate verdict
  -- is what made "how many documents are waiting on a person" answerable only by remembering
  -- to exclude a thousand rows nobody was ever asked to approve.
  lifecycle     text not null default 'adopted' check (lifecycle in ('adopted', 'superseded')),
  superseded_by text,
  -- The initiative that minted it. Provenance, not ownership: the node outlives the work.
  initiative    text not null default '',
  title         text not null default '',
  body          text not null default '',
  body_tsv      tsvector,
  tags          text[] not null default '{}',
  -- A node with no evidence is an opinion, and knowledge_add refuses one. 853 of 853 carry it.
  evidence      text[] not null default '{}',
  content_hash  text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (team_slug, path)
);

create index if not exists knowledge_node_tsv  on zz.knowledge_node using gin (body_tsv);
create index if not exists knowledge_node_tags on zz.knowledge_node using gin (tags);
create index if not exists knowledge_node_team on zz.knowledge_node (team_slug, lifecycle);

insert into zz.knowledge_node
  (team_slug, path, kind, lifecycle, superseded_by, initiative,
   title, body, body_tsv, tags, evidence, content_hash, created_at, updated_at)
select d.team_slug, d.path, d.type,
       case when d.status = 'superseded' then 'superseded' else 'adopted' end,
       d.superseded_by, d.initiative, d.title, d.body, d.body_tsv, d.tags, d.evidence,
       d.content_hash, d.created_at, d.updated_at
  from zz.doc d
 where d.initiative = '_knowledge'
on conflict (team_slug, path) do nothing;

delete from zz.doc where initiative = '_knowledge';
