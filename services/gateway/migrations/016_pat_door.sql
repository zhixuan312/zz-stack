-- 016_pat_door.sql — a token an application obtained through OAuth answers on the door it was issued for.
--
-- A person authorises an application for one door: the consent names it, and the token endpoint's
-- answer carries it as `scope`. Until this file nothing stored it, and identity resolved a token
-- without asking where it was presented, so a connector allowed onto /core/mcp could call /manage/mcp
-- and, through `pat_issue` there, mint itself an unbound token that `client_revoke` never reaches.
-- `zz.pat.door` is that door; the gateway's `pat` adapter refuses the token on every other door
-- (`services/gateway/src/identity.ts`), and `pat_issue` refuses a caller holding one.
--
-- A token a person issues by hand, in Access or with `pat_issue`, has no door and reaches all of
-- them, as before.
--
-- The backfill reads the door out of the label `oauthTokenLabel` writes
-- (`mcp oauth — <application> — <door> — <email>`): the door is the path authorize recorded, and the
-- email after it carries no ` — `. An OAuth token whose label names no door is revoked rather than
-- left reaching every door; its application asks the person to reconnect, which mints a bound one.
--
-- `scripts/rehearse/expect.ts` declares what this file leaves on a production copy: every token row
-- still there, and its columns unchanged but for `revoked_at` on an unreadable OAuth label.
--
-- The release before this file can run on what it builds: it neither reads nor writes `door`, and a
-- token it mints takes null, which is what every token meant before. Rollback is therefore not
-- refused, and no line below declares it.

ALTER TABLE zz.pat ADD COLUMN door text
    CHECK (door IN ('/core/mcp', '/manage/mcp', '/eval/mcp'));

UPDATE zz.pat SET door = substring(label from '(/(?:core|manage|eval)/mcp) — [^ ]+$')
 WHERE oauth_client_id IS NOT NULL;

UPDATE zz.pat SET revoked_at = now()
 WHERE oauth_client_id IS NOT NULL AND door IS NULL AND revoked_at IS NULL;

COMMENT ON COLUMN zz.pat.door IS 'class=current_state; authority=this; question=which MCP door does this token answer on, the one an application was authorised for when it obtained the token through OAuth, and null for a token a person issued, which answers on every door?';

COMMENT ON TABLE zz.pat IS 'class=current_state; authority=this; question=which bearer credential does a program hold to act as a person, confined to which team, client and door, with what lifetime and revocation?; retention=kept as durable provenance until explicitly revoked or expired; a revoked row is never deleted, because pat_list and client_revoke read it';
