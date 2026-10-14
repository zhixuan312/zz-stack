-- 004_event_origin.sql — every event says whether it was work or the platform maintaining itself.
--
-- `zz.event.origin` is `work` or `platform`, stamped by whichever process writes the row: the gateway
-- on a tool call and zz-core on its own acts, each from the `x-zz-client` name of the request it was
-- handling, through `eventOrigin` in `packages/contracts/src/event-origin.ts`. A reader that counts
-- real work filters on the column and derives nothing itself.
--
-- The second statement is the backfill, and it is the one statement that changes rows of this
-- insert-only table (`SCHEMA.md`, rule 4). It marks `platform` every row whose recorded client,
-- `detail->>'client'`, names one of the three maintenance clients, whatever its kind — the gateway
-- records a client on a tool call and zz-core on a presentation — and leaves every other row at the
-- default: a row from any other client, and a row that recorded none.
--
-- COUPLED: `eventOrigin` — the same three names and the same cut, the name lower-cased, cut at the
-- first `/` and then at the first space, and never trimmed, so a row older than the column and one
-- written after it read alike for one client. `checks/event-origin-db.ts` runs the backfill again
-- over rows it seeds and holds a live call to the same answer.
--
-- It is one statement, so the console's statement-level trigger on this table raises one hint for
-- each team whose rows it marked, and a tab that hears one reads its collection again.
--
-- `scripts/rehearse/expect.ts` declares what this file must leave on a production copy: every row
-- still there and unchanged in the columns it had, and `platform` on exactly the rows named above.
--
-- The release before this file can run on what it builds: its writers name no `origin`, so the rows
-- they write take the default. Rollback is therefore not refused, and no line below declares it.

ALTER TABLE zz.event ADD COLUMN origin text DEFAULT 'work'::text NOT NULL
    CHECK (origin IN ('work', 'platform'));

UPDATE zz.event SET origin = 'platform'
 WHERE lower(split_part(split_part(detail->>'client', '/', 1), ' ', 1))
       IN ('chain-check', 'zz-migrate', 'zz-doctor');

COMMENT ON COLUMN zz.event.origin IS 'class=immutable_history; authority=this; question=was this act the platform maintaining itself or work, platform when the lower-cased name the caller gave in x-zz-client, cut at the first / and then at the first space, is chain-check, zz-migrate or zz-doctor and work for every other name and for none, stamped by the writer of the row from the request it was handling and set once from detail.client on the rows older than the column, of any kind that recorded one, a caller''s own claim that sorts traffic for counting and decides no access?';
