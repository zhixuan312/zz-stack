-- 005_page_view_no_hint.sql — a console event hints only the collections a tab follows, and a page view hints none.
--
-- `003_console_live.sql` tells every open console tab when `zz.event` changes, naming `activity`,
-- `runs` and `overview` for each team a statement touched. Two of those are wrong now:
--
--   - `overview` is no collection a tab may follow (`services/gateway/src/console/live-revision.ts`,
--     `COLLECTIONS`): its page and its read are gone, so the hint reached no stream.
--   - A `console.page_view` row changes nothing a tab reads: the activity feed and its summary
--     (`services/gateway/src/console/activity.ts`) leave it out by kind, and every other event a
--     console read counts is a `tool_call` or another kind it names. The hint it raised made every tab
--     of the team read its collections again for an answer that had not moved, the tab that had just
--     opened the page included.
--
-- This file restates the function those three triggers call: `activity` and `runs` alone, with page
-- views left out of the rows it reads teams from; nothing else about it changes, and the triggers stay
-- as `003_console_live.sql` declared them.
--
-- `scripts/schema/compare.ts` does not model functions or triggers, so nothing in `schema-target/`
-- describes this file, and no table's rows move, so `scripts/rehearse/expect.ts` needs no entry: the
-- default assertion — row count unchanged, content hash unchanged — is the one this file must pass.
--
-- The release before this file can run on what it builds: its own function raised a hint for a page
-- view and one for `overview`, which cost a tab one needless read and a stream nothing. Rollback is
-- therefore not refused, and no line below declares it.

CREATE OR REPLACE FUNCTION zz.console_change_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slugs text[]; s text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM new_rows d JOIN zz.team t ON t.id = d.team_id
     WHERE d.kind <> 'console.page_view';
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT t.slug) INTO slugs
      FROM (SELECT team_id FROM new_rows WHERE kind <> 'console.page_view'
            UNION SELECT team_id FROM old_rows WHERE kind <> 'console.page_view') d
      JOIN zz.team t ON t.id = d.team_id;
  ELSE
    SELECT array_agg(DISTINCT t.slug) INTO slugs FROM old_rows d JOIN zz.team t ON t.id = d.team_id
     WHERE d.kind <> 'console.page_view';
  END IF;
  FOREACH s IN ARRAY coalesce(slugs, '{}') LOOP
    PERFORM zz.console_hint(s, 'activity');
    PERFORM zz.console_hint(s, 'runs');
  END LOOP;
  RETURN NULL;
END $$;
