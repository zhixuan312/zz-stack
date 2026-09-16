-- A third party's server is not a concept this platform has any more.
--
-- "Block" meant two unrelated things, and only one of them is being removed here.
--
--   REMOVED — A THIRD PARTY'S SERVER. `zz.tool_grant` said a team may reach one,
--   `zz.block_token` held a person's own key for it, `zz.block_oauth_state` its delegated
--   sign-in, and `zz.event.block` / `zz.doc.blocks` / `zz.decision.blocks` /
--   `zz.decision_block` recorded which one a call, a document or a decision was about.
--   That layer is gone: the stand-ins left with their repository on 2026-09-10, PLATFORMS
--   is unset on every deployment, and /p/<block>/mcp has answered "no such block" ever
--   since. Measured against production before writing this, all time, platform-wide:
--   0 grants, 0 tokens, 0 oauth states, 0 decision_block rows, 0 events naming a block,
--   0 documents and 0 decisions with a non-empty blocks array. Nothing is lost.
--
--   NOT TOUCHED HERE — THE PLATFORM'S OWN TOOL SURFACE. `zz.block` carries one row, named
--   `platform` and titled `zz-core`, with 32 `zz.block_version` rows (this platform's own
--   releases) and 926 `zz.block_tool` rows (the 30 tools each release exposes). It is the
--   same subject `zz.plugin` already holds as `zz-core` with 15 versions — the platform is
--   registered twice, in two models, and the block half is the older one. Folding them is a
--   data move rather than a rename: `zz.plugin_version` has no table for a version's tools,
--   so 926 rows need somewhere to land, and `zz.skill.block_id` plus the 9 skills with
--   `kind = 'block_usage'` have to repoint as they go. That is its own migration, with its
--   own end-to-end test against a copy of this database. Doing it in the same file as the
--   deletions above would put a data move nobody can verify behind seven drops anybody can.
--
-- NOT TOUCHED, and deliberately: `zz.bug.impact = 'blocks_work'`. That is the English verb,
-- not this noun, and it is the trap this migration is most likely to spring on a later reader.

drop table if exists zz.decision_block;
drop table if exists zz.block_oauth_state;
drop table if exists zz.block_token;
drop table if exists zz.tool_grant;

drop index if exists zz.event_block;
drop index if exists zz.decision_blocks;

alter table zz.event    drop column if exists block;
alter table zz.doc      drop column if exists blocks;
alter table zz.decision drop column if exists blocks;
