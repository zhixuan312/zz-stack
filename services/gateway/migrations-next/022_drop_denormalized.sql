-- THE DENORMALIZED COLUMNS GO. Ships only with the read-path refactor in both services.
--
-- Everything here is reachable through the keys added in 016-018: an event's skill version
-- through its run, a document's team and flow through its initiative, a decision's blocks
-- through the junction. Leaving them would guarantee that one day the two copies disagree, and
-- the copy a reader happens to pick decides what it believes.
--
-- WHAT MUST BE TRUE BEFORE THIS RUNS -- all of it, or the platform answers errors:
--   zz-core     indexDoc writes initiative_id + produced_by_run_id, never team_slug/initiative/flow
--               reindexTeam, search_knowledge, recall and reconcile read through the new keys
--   gateway     events.ts writes team_id/run_id/block_version_id
--               kb.ts reads through initiative and run
--   tools       ladder-score, tool-report, flow-compare, watch-results



-- ── events ──
alter table zz.event drop column if exists team_slug;
alter table zz.event drop column if exists initiative;
alter table zz.event drop column if exists flow;
alter table zz.event drop column if exists step;
alter table zz.event drop column if exists step_version;
alter table zz.event drop column if exists block;
alter table zz.event drop column if exists block_version;

drop index if exists zz.event_step;
drop index if exists zz.event_block;
drop index if exists zz.event_initiative;
drop index if exists zz.event_team_ts;

create index if not exists event_run   on zz.event (run_id) where run_id is not null;
create index if not exists event_block on zz.event (block_version_id) where block_version_id is not null;
create index if not exists event_team_ts on zz.event (team_id, ts desc);
-- Response size is how the expensive tools were found (casebox:read_api_spec, a very large payload bytes average).
-- Indexed so that stays a cheap question rather than a full scan.
create index if not exists event_bytes on zz.event (((detail->>'bytes')::bigint) desc)
  where detail ? 'bytes';


-- ── documents ──
alter table zz.doc drop constraint if exists doc_pkey;
alter table zz.doc add primary key (id);
create unique index if not exists doc_initiative_path on zz.doc (initiative_id, path);

-- Reachable through the initiative now.
alter table zz.doc drop column if exists team_slug;
alter table zz.doc drop column if exists initiative;
alter table zz.doc drop column if exists flow;

create index if not exists doc_produced_by on zz.doc (produced_by_run_id) where produced_by_run_id is not null;


-- ── decisions ──
alter table zz.decision drop constraint if exists decision_pkey;
alter table zz.decision drop column if exists team_slug;
alter table zz.decision drop column if exists initiative;
alter table zz.decision drop column if exists path;
alter table zz.decision drop column if exists blocks;
alter table zz.decision drop column if exists block_versions;
alter table zz.decision alter column doc_id set not null;
alter table zz.decision add primary key (doc_id, key);
