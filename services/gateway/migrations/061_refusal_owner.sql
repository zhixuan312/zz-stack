-- A refusal has an OWNER, and four different facts stopped being one.
--
-- zz.event recorded every not-ok tool call the same way: ok = false and a sentence in
-- `refusal`. But a call comes back not-ok for four unrelated reasons — the platform said no
-- by name, the CALL was malformed, the TOOL failed, or the text says nothing useful — and the
-- console's lead tile counted all of them as "refused". Measured on this deployment: of 285
-- not-ok tool calls only 69 began with ERROR, the platform's own sentence. 185 were one client
-- sending a malformed enum argument over and over, and 29 were a client calling tools by their
-- pre-rename names. A "refusal rate" reading 285 answered "is the tool surface breaking" with
-- 76% schema-validation noise from one bug in one client.
--
-- The verdict is written at ingest by @zz/contracts' refusalOwner(), so every reader gets the
-- same answer and nobody has to re-derive it from the text. Null where ok is not false: an
-- answer that worked has no owner.
--
-- The backfill runs the same four patterns in SQL, in the same order the function applies
-- them, so history reads the way new rows will. It is the one place they are written twice,
-- and it runs once.

alter table zz.event add column if not exists refusal_owner text;

update zz.event
   set refusal_owner = case
         when coalesce(refusal, '') ~ '^ERROR[: ]' then 'guardrail'
         when coalesce(refusal, '') ~* 'status code [0-9]{3}|http [0-9]{3}|Error POSTing to endpoint|Unexpected content type|<html' then 'theirs'
         when coalesce(refusal, '') ~* 'Missing required argument|Invalid arguments|Input validation error|could not be parsed as JSON|validation error|not found|No such tool available' then 'ours'
         else 'other'
       end
 where ok = false and refusal_owner is null;

-- Read on every refusal panel and every refusal rate, always beside ok.
create index if not exists event_refusal_owner_idx on zz.event (refusal_owner) where ok = false;
