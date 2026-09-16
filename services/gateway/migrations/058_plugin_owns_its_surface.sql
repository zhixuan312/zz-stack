-- The platform's own tool surface moves off the block model, which is the last of it.
--
-- 057 removed a THIRD PARTY's server. This removes the other thing "block" meant: the
-- registry of the platform's own releases and the tools each one served. `zz.block` holds one
-- row -- named `platform`, titled `zz-core` -- with `zz.block_version` for its releases and
-- `zz.block_tool` for the 926 tool rows across them. `zz.plugin` and `zz.plugin_version`
-- already hold that same subject, better: per plugin rather than per service, and joined to
-- the skills each version shipped.
--
-- WHAT IS CARRIED FORWARD, AND WHAT IS NOT. Of the 926 block_tool rows, 392 sit on 13 versions
-- that zz-core also has in the plugin registry, and those are the ones a surface diff can
-- actually use. The rest cannot be:
--
--   91 rows on 3 versions belonged to plugin `zz`, which was this platform before it split
--      into four. That row is gone: it was a SPLIT and not a rename -- three of its five
--      skills (zz-doctor, zz-migrate, zz-update) belong to zz-access today -- so folding its
--      history into zz-core would credit zz-core with skills it never shipped.
--   443 rows on 15 versions predate 0.34.0 and the plugin registry entirely. There is no
--      plugin version for them to hang off, and inventing one would be writing history.
--
-- A surface diff compares consecutive releases, so losing releases nothing can compare
-- against loses nothing a reader could have asked for.

create table if not exists zz.plugin_tool (
  plugin_version_id uuid not null references zz.plugin_version(id) on delete cascade,
  name              text not null,
  -- WHICH DOOR, in the same row as the name. Recorded because a surface of names alone
  -- answered NO CHANGE when ten tools moved between doors -- the largest surface change this
  -- platform has had -- which is the failure migration 052 was written for, kept here.
  door              text not null,
  primary key (plugin_version_id, name)
);

insert into zz.plugin_tool (plugin_version_id, name, door)
select pv.id, bt.name, bt.door
  from zz.block_tool bt
  join zz.block_version bv on bv.id = bt.block_version_id
  join zz.plugin p on p.name = 'zz-core'
  join zz.plugin_version pv on pv.plugin_id = p.id and pv.version = bv.version
 where bt.door is not null
on conflict do nothing;

-- A SKILL BELONGS TO A FLOW, OR IT IS STANDALONE CAPABILITY. Which PLUGIN ships it is
-- `zz.plugin_version_skill`, which records it per version and is what plugin_locate and
-- plugin_profile already read. `zz.skill.block_id` was a second, less precise copy of that
-- membership -- every one of its 9 rows pointed at the single `platform` block, so it could
-- not tell zz-core's skills from zz-access's -- and a second copy of a fact is a copy that
-- can disagree.
alter table zz.skill drop constraint if exists skill_belongs_correctly;
alter table zz.skill drop constraint if exists skill_block_id_fkey;
alter table zz.skill drop column if exists block_id;
update zz.skill set kind = 'plugin_skill' where kind = 'block_usage';
alter table zz.skill add constraint skill_belongs_correctly
  check ((kind = 'flow_step' and flow is not null) or (kind = 'plugin_skill' and flow is null));

-- `zz.event.block_version_id` references block_version and has never been written: 0 of 5,187
-- rows carry one. 057 removed the `block` text column beside it and left this, which would
-- refuse the drop below.
alter table zz.event drop column if exists block_version_id;

drop table if exists zz.block_tool;
drop table if exists zz.block_version;
drop table if exists zz.block;
