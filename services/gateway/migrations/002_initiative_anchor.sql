-- 002_initiative_anchor.sql — zz.initiative becomes the platform's one state-machine anchor for
-- a piece of delivery work: opened, and — with this migration — closed, with its outcome and
-- sign-off carried on the row itself instead of scattered across a team's own document store.
--
-- `created_at` is renamed `opened_at`: it already meant "when this initiative's lifecycle
-- began", and the rename says so. `flow` loses its `''` default and its NOT NULL — a caller
-- that opens no flow now leaves it null rather than writing an empty string that reads as "has
-- a flow" until you check its length; every existing `''` is rewritten to null so the column
-- means the same thing before and after.
--
-- New columns: `opened_by`/`closed_by` (uuid, FK `zz.principal`) name who drove each end of the
-- lifecycle; `closed_at`/`outcome` record when and how it ended; `accepted_by` (text — the name
-- as given, not a login) and `no_signoff_reason` carry the sign-off an `accepted` outcome
-- needs. Every existing row is additive-only and stays open: this migration writes nothing into
-- any of the six new columns, which already satisfies every CHECK below (closed_at, outcome and
-- closed_by all null together, on every row).
--
-- CHECKs: the slug pattern already holds for every row rehearsed against this migration; the
-- other four enforce the lifecycle envelope — closed_at/outcome/closed_by move together,
-- outcome is one of three values, an 'accepted' outcome always names an accepted_by, and
-- accepted_by and no_signoff_reason are never both set.
--
-- `unique (team_id, id)` lets a future FK from another team-scoped table enforce rule 12's
-- composite tenant-scope join against `initiative` without a second lookup.

ALTER TABLE zz.initiative RENAME COLUMN created_at TO opened_at;

ALTER TABLE zz.initiative
    ALTER COLUMN flow DROP DEFAULT,
    ALTER COLUMN flow DROP NOT NULL;

UPDATE zz.initiative SET flow = NULL WHERE flow = '';

ALTER TABLE zz.initiative
    ADD COLUMN opened_by uuid REFERENCES zz.principal(id),
    ADD COLUMN closed_at timestamptz,
    ADD COLUMN closed_by uuid REFERENCES zz.principal(id),
    ADD COLUMN outcome text,
    ADD COLUMN accepted_by text,
    ADD COLUMN no_signoff_reason text;

ALTER TABLE zz.initiative
    ADD CONSTRAINT initiative_slug_check
        CHECK (slug ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'),
    ADD CONSTRAINT initiative_closed_envelope_check
        CHECK ((closed_at IS NULL) = (outcome IS NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
    ADD CONSTRAINT initiative_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('accepted', 'delivered', 'abandoned')),
    ADD CONSTRAINT initiative_accepted_by_check
        CHECK (outcome <> 'accepted' OR accepted_by IS NOT NULL),
    ADD CONSTRAINT initiative_signoff_check
        CHECK (accepted_by IS NULL OR no_signoff_reason IS NULL);

ALTER TABLE zz.initiative ADD CONSTRAINT initiative_team_id_id_key UNIQUE (team_id, id);

COMMENT ON TABLE zz.initiative IS 'class=state_machine; authority=this; question=what is the lifecycle state of one piece of delivery work, from opened to its outcome?; transitions=open->accepted,open->delivered,open->abandoned';
COMMENT ON COLUMN zz.initiative.id IS 'class=state_machine; authority=this; question=what is this initiative''s own identity?';
COMMENT ON COLUMN zz.initiative.team_id IS 'class=relation; authority=this; question=which team owns this initiative?';
COMMENT ON COLUMN zz.initiative.slug IS 'class=state_machine; authority=this; question=what is this initiative''s stable, human-chosen identifier within its team?';
COMMENT ON COLUMN zz.initiative.flow IS 'class=state_machine; authority=this; question=which flow does this initiative run, if any?';
COMMENT ON COLUMN zz.initiative.opened_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle begin?';
COMMENT ON COLUMN zz.initiative.opened_by IS 'class=state_machine; authority=this; question=which principal opened this initiative?';
COMMENT ON COLUMN zz.initiative.closed_at IS 'class=state_machine; authority=this; question=when did this initiative''s lifecycle end, if it has?';
COMMENT ON COLUMN zz.initiative.closed_by IS 'class=state_machine; authority=this; question=which principal closed this initiative, if it has?';
COMMENT ON COLUMN zz.initiative.outcome IS 'class=state_machine; authority=this; question=what did this initiative''s lifecycle conclude, if it has closed?';
COMMENT ON COLUMN zz.initiative.accepted_by IS 'class=state_machine; authority=this; question=who is recorded as having signed off on this initiative''s accepted outcome, if it was accepted?';
COMMENT ON COLUMN zz.initiative.no_signoff_reason IS 'class=state_machine; authority=this; question=why was this initiative''s accepted outcome accepted without a named sign-off, if so?';
