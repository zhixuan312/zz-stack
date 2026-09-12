-- WHERE A BLOCK COMES FROM, and the end of the homeless skill.
--
-- Two facts the platform acted on and never recorded.
--
-- ONE. `zz.block` held bookit, casebox and RuleMill as three equal rows, and they are not three
-- of a kind. `casebox` stands for a block this platform did not write. `RuleMill` and `bookit` are OUR stand-ins,
-- served from the zz-blocks image, and they exist only until a real block is connected — at which
-- point the directory is deleted. Improving a stand-in's skills is improving a puppet, so
-- the console must be able to leave them out; averaging a refusal rate across a block another
-- team runs and a mock we wrote is not measuring one thing either.
--
-- The platform is the third kind. Our MCP is zz-core, in zz-stack, and it is not a block in
-- the zz-blocks sense and never will be — but it IS an MCP surface like any other, and our
-- own skills have to hang off something. This gives them that something without pretending
-- we are one of the mocks.
--
-- TWO. `zz.skill.kind` allowed 'common' — a skill belonging to no flow and no block. Five
-- rows sat there: zz-backbone, zz-distil, zz-evolve, zz-kb-usage, zz-learn. They are not
-- homeless; they are ours. With the platform recorded as a surface they become what they
-- are, and the constraint stops allowing a sixth to arrive with nowhere to be.
--
-- WHAT THIS DOES NOT DO: rewrite zz.event. A tool_call to our own MCP carries block = null,
-- and that is true — the call did not go to a block. The console reads it as 'platform' at
-- display time, which is a rendering convention, not a fiction. Events are the record.

alter table zz.block add column if not exists origin text not null default 'team';

-- Ordered deliberately: the row has to exist before skills can point at it, and the skills
-- have to have moved before the constraint that forbids 'common' is validated against them.
insert into zz.block (name, origin) values ('platform', 'platform')
  on conflict (name) do update set origin = 'platform';

-- BY NAME, not by id. This has to run against production's data sight unseen, where the
-- uuids differ and only the names are the same.
update zz.block set origin = 'stand_in' where name in ('rulemill', 'bookit');
update zz.block set origin = 'team'     where name not in ('rulemill', 'bookit', 'platform');

update zz.skill
   set kind = 'block_usage',
       flow = null,
       block_id = (select id from zz.block where name = 'platform')
 where kind = 'common';

alter table zz.skill drop constraint if exists skill_belongs_correctly;
alter table zz.skill add constraint skill_belongs_correctly check (
  (kind = 'flow_step'   and flow is not null and block_id is null) or
  (kind = 'block_usage' and flow is null     and block_id is not null)
);

alter table zz.block drop constraint if exists block_origin_known;
alter table zz.block add constraint block_origin_known
  check (origin in ('platform', 'team', 'stand_in'));
