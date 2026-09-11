-- The password door is gone; so is the column behind it.
--
-- 037 added `password_verifier` for a second door beside the directory sign-in — something a
-- person could type when the identity provider was not an option. Nothing needs it now: a
-- browser signs in through the provider and a machine carries a PAT, and those two cover
-- every caller this platform has. A column no route writes and no route reads is a verifier
-- sitting in a table waiting to be leaked, so it goes rather than sitting closed.
--
-- Any row that carried one loses it. That is the intended effect: those people sign in the
-- same way everyone else already does, and there is nothing to migrate them to.
alter table zz.principal drop column if exists password_verifier;

-- 038's `door` recorded which of the two a session came through. One remains, so the column
-- keeps only the value it can still hold — a check constraint rather than a dropped column,
-- because the next door added here must be forced to name itself the way the second one was.
update zz.console_session set door = 'ssoauth' where door <> 'ssoauth';
alter table zz.console_session drop constraint if exists console_session_door_known;
alter table zz.console_session add constraint console_session_door_known check (door in ('ssoauth'));
