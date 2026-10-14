-- 006_release.sql — a table of the platform's releases, created empty.
--
-- `zz.release` holds one row per released platform version: when its tag was created, and what its
-- changelog section published and asked of a client. `scripts/release-record.ts` is its only
-- writer. The release writes its own row once its tag exists and passes every earlier `v*` tag with
-- it, so the first release that runs this file records the releases before it from their tags and
-- the changelog; no statement here inserts a row.
--
-- `schema-target/release.ts` declares the table, and `scripts/rehearse/expect.ts` declares it
-- created and empty, which is what this file must leave on a production copy.
--
-- The release before this file can run on what it builds: its code names no `zz.release`, so it
-- neither reads the table nor misses a row in it. Rollback is therefore not refused, and no line
-- below declares it.

CREATE TABLE zz.release (
    version text NOT NULL,
    console_version text,
    released_at timestamp with time zone NOT NULL,
    summary text NOT NULL,
    changelog text NOT NULL,
    upgrade_notes text,
    client_action text
);

ALTER TABLE zz.release OWNER TO zz;

ALTER TABLE ONLY zz.release
    ADD CONSTRAINT release_pkey PRIMARY KEY (version);

COMMENT ON TABLE zz.release IS 'class=current_state; authority=this; question=which platform versions were released, when were they tagged, and what did each one''s changelog publish and ask of a client, one row per version written by the release once its tag exists and rewritten only by an operator''s explicit correction?';

COMMENT ON COLUMN zz.release.version IS 'class=current_state; authority=this; question=which platform version this row records, the v-tag''s name without its v?';

COMMENT ON COLUMN zz.release.console_version IS 'class=current_state; authority=this; question=which console version shipped with it, from a console version in the changelog heading or a zz-stack-dashboard subsection, null when the section names none?';

COMMENT ON COLUMN zz.release.released_at IS 'class=current_state; authority=this; question=when was the version''s tag created, historical timing evidence for the release and not a measured deployment time, never moved by a retry?';

COMMENT ON COLUMN zz.release.summary IS 'class=current_state; authority=this; question=what one line says what the release did, read from its changelog section, or No changelog entry for a tag with no section?';

COMMENT ON COLUMN zz.release.changelog IS 'class=current_state; authority=this; question=what did the release publish, its changelog section as Markdown without its heading, or No changelog entry for a tag with no section?';

COMMENT ON COLUMN zz.release.upgrade_notes IS 'class=current_state; authority=this; question=what upgrade notes did the section publish, null when it has none?';

COMMENT ON COLUMN zz.release.client_action IS 'class=current_state; authority=this; question=what must a client do for this release, null when the section has no upgrade notes and so nothing is to be done, and Unknown — no recorded upgrade notes for a tag with no section?';
