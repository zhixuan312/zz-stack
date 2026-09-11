-- zz.event gets COLUMNS for the things anybody groups by.
--
-- The table was `kind`, `subject` and a `detail` bag, which is right for an audit stream and
-- wrong for a measurement one: the three questions an improvement loop asks became
-- `detail->>'step'`, the first thing a reader saw was `{"status": 200}`, and nothing about a
-- row's shape said which of those two it was. Two earlier attempts were worse — a VIEW over
-- the bag was papering, and a SEPARATE table split one history in two, which is how two
-- records of the same thing come to disagree.
--
-- WHAT EARNS A COLUMN. One test: would somebody GROUP BY or WHERE on it. An earlier draft
-- promoted twenty-one fields, which is a schema built by moving every key it could find rather
-- than by asking what the table is for. `ms`, `bytes`, `args`, `shapes`, `step_sha` are read
-- once each by one report and never filtered on; they stay in `detail`, which is exactly what
-- jsonb is good at.
--
--   team_slug / initiative   THE JOIN KEYS. zz.doc and zz.decision are both keyed
--                            (team_slug, initiative, …), and without them a refusal cannot be
--                            connected to the document it was made for or the claim it was
--                            testing. This is the whole reason the loop never closed: of
--                            6,225 tool calls, 88 carried a team and 129 an initiative.
--   flow / step / step_version  which method, which of its steps, which revision of it.
--                            `flow` is kept even though most steps belong to one flow, because
--                            the shared ones do not: zz-backbone is loaded by EVERY flow.
--   block / block_version    which building block, and its own account of itself from the MCP
--                            handshake.
--   ok / refusal             whether it worked, and the platform's own sentence saying which
--                            rule was broken — the one thing a skill can be edited from.
--
-- NOTHING IS BACKFILLED AND THE OLD ROWS GO. 2,369 of them held `{"status": 200}` and nothing
-- else — and a refusing MCP tool answers HTTP 200 with ERROR: in its text, so a transport
-- status is blind to exactly the outcomes worth counting. The remaining 3,843 can say whether
-- a call worked and cannot say which step made it. Neither can answer the question this table
-- now exists to answer, and keeping them means every count silently mixes three eras. The
-- admin acts stay: they are the provenance record and they are already the right shape.
-- The view goes. It was the first attempt at this and it was papering: named columns over a
-- JSON bag that was still a JSON bag underneath, nothing sensibly indexable, and a second name
-- for one table. Real columns replace it.
drop view if exists zz.tool_call;

alter table zz.event add column if not exists initiative    text;
alter table zz.event add column if not exists flow          text;
alter table zz.event add column if not exists step          text;
alter table zz.event add column if not exists step_version  text;
alter table zz.event add column if not exists block         text;
alter table zz.event add column if not exists block_version text;
alter table zz.event add column if not exists ok            boolean;
alter table zz.event add column if not exists refusal       text;

create index if not exists event_kind_ts    on zz.event (kind, ts desc);
create index if not exists event_step       on zz.event (step, step_version)   where step  is not null;
create index if not exists event_block      on zz.event (block, block_version) where block is not null;
create index if not exists event_initiative on zz.event (team_slug, initiative) where initiative is not null;

delete from zz.event where kind = 'tool_call';

comment on column zz.event.ok is
  'Whether the call worked, in the platform''s own terms — never a transport status. An MCP
   tool that refuses answers HTTP 200 with ERROR: in its text.';
comment on column zz.event.initiative is
  'Join key to zz.doc and zz.decision. Carried forward per caller from the last call that named
   one, because most calls do not take it as an argument.';
