-- What a block IS, in a person's words, kept where the block is.
--
-- The console carried a hand-written map of four blocks: `casebox` → "CaseBox, Case
-- management", and so on. It is the same fault as drawing every flow as ops-flow, one level
-- down — a fifth block gets its bare id for a title and "reached over MCP" for a kind, and
-- nothing on the platform says the map exists to be updated. The stakeholder's words for the
-- flow version of this were "we will have many many more, we cannot hardcode one by one".
--
-- The registry is where a block's facts live: `origin` is already here, and a display name
-- belongs beside it. Both columns are optional — a block that has not been described yet
-- reads as its id, which is honest and is what the console already falls back to.
alter table zz.block add column if not exists title text not null default '';
alter table zz.block add column if not exists kind  text not null default '';

comment on column zz.block.title is
  'The block''s name for a person — "CaseBox". Empty means nobody has described it, '
  'and the console shows the id.';
comment on column zz.block.kind is
  'What the block is for, in three or four words — "Case management". Empty means unknown.';

-- The four the console named by hand, moved rather than retyped. A block absent from this
-- list keeps its empty strings, which is the state every future block starts in.
update zz.block set title = 'CaseBox',  kind = 'Case management'      where name = 'casebox'        and title = '';
update zz.block set title = 'BookIt',       kind = 'Appointment booking'  where name = 'bookit' and title = '';
update zz.block set title = 'RuleMill',            kind = 'Workflow automation'  where name = 'rulemill'      and title = '';
update zz.block set title = 'zz-core',         kind = 'The platform itself'  where name = 'platform'  and title = '';
