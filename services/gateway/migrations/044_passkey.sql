-- The browser door is a passkey, and it is the only browser door.
--
-- WHAT THIS REPLACES. 022 built the console's sign-in around an OpenID provider: a
-- half-finished login held in `zz.console_login` between the redirect out and the redirect
-- back, and a `door` column on the session recording which of the two doors minted it. Both
-- described a shape that no longer exists. There is one browser door now and it never leaves
-- this origin, so there is no round trip to hold state across and nothing for `door` to
-- distinguish. `Identity.via === "session"` was always the authority check; the column beside
-- it only ever answered a question nobody asked.
--
-- WHY A PASSKEY RATHER THAN A PROVIDER. This platform has three people on it and creates
-- their principals from the back end. An external provider's whole value is telling us who
-- somebody is when we do not already know — we do know, so what it bought was a consent
-- screen, a test-user list and a client secret to rotate. A passkey asserts possession of a
-- private key this server holds the public half of, which is the fact we actually want, with
-- nothing to rotate and nobody else in the path.
--
-- THE ONE THING TO KNOW BEFORE RELYING ON THIS. A passkey is bound to the RP ID, which is
-- this console's hostname. Our hostname encodes the droplet's IP address, so changing the
-- droplet invalidates every credential in `zz.passkey` at once. That is not a lockout — a
-- superadmin holding a PAT mints fresh enrolment links from the host — but it is a
-- re-enrolment for everyone, and it is the reason this comment exists rather than a surprise.

-- A registered authenticator. One row per DEVICE, not per person: the same principal
-- enrolling a laptop and a phone gets two rows, and either one opens the door.
create table if not exists zz.passkey (
  -- The credential id the authenticator minted, base64url. Globally unique by construction,
  -- so it is the key: a login assertion names this and nothing else.
  id            text primary key,
  principal_id  uuid not null references zz.principal(id) on delete cascade,
  -- COSE-encoded public key. Bytes, not text — it is a key, not a string, and base64ing it
  -- into a text column would invite somebody to compare two spellings of the same key.
  public_key    bytea not null,
  -- The authenticator's signature counter, for cloned-device detection. Platform
  -- authenticators that sync through a keychain report 0 forever and that is legitimate;
  -- the verifier knows the difference and this column only records what it was told.
  counter       bigint not null default 0,
  -- How this authenticator can be reached next time ("internal", "hybrid", "usb"). A hint
  -- passed back to the browser so it offers the right prompt, never an authorisation input.
  transports    text[],
  -- What the person calls it. Set at enrolment from the user agent, so a list of three
  -- passkeys is a list of three recognisable devices rather than three base64url strings.
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists passkey_principal on zz.passkey (principal_id);

-- The invitation. This is the ONLY way a passkey is ever attached to a principal, and it is
-- what makes "users are added from the back end" structural rather than a convention.
--
-- An OpenID sign-in could create a principal it had never seen, because the provider vouched
-- for the email. Nothing vouches here: an authenticator asserts possession of a key, not an
-- identity, so a registration that carried its own email would let anyone with the URL mint
-- themselves a principal. The token names the principal instead. No token, no door — and the
-- principal it names was created by a superadmin before the token existed.
create table if not exists zz.passkey_enrolment (
  -- The hash, never the token. Same rule as zz.pat and zz.console_session: a database dump
  -- must not be a set of live invitations.
  token_hash    text primary key,
  principal_id  uuid not null references zz.principal(id) on delete cascade,
  -- Null when minted from the host by an operator with shell access, which is the bootstrap
  -- case: the first enrolment happens when nobody can sign in to authorise it.
  issued_by     uuid references zz.principal(id) on delete set null,
  expires_at    timestamptz not null,
  -- SINGLE USE. Stamped inside the same statement that reads the row, so two browsers
  -- racing on one link cannot both win.
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists passkey_enrolment_principal on zz.passkey_enrolment (principal_id);
create index if not exists passkey_enrolment_expiry on zz.passkey_enrolment (expires_at);

-- The challenge, held between "here is what to sign" and "here is the signature".
--
-- WebAuthn's replay defence is that the server chose the challenge and remembers choosing it.
-- Holding it in memory would work until the second gateway process, so it lives here, with
-- the same single-use `delete … returning` discipline the OpenID `state` row had.
--
-- `principal_id` is null for a login and set for a registration — a registration already
-- knows who it is for, because the enrolment token said so, and a login is the ceremony that
-- finds out. Nothing reads it from the request body in either case.
create table if not exists zz.passkey_challenge (
  id            uuid primary key default gen_random_uuid(),
  challenge     text not null,
  kind          text not null check (kind in ('register', 'login')),
  principal_id  uuid references zz.principal(id) on delete cascade,
  -- Where to send them once they are in, so a deep link survives the ceremony. Validated as
  -- a same-site path before it is stored AND before it is used.
  redirect_to   text,
  created_at    timestamptz not null default now()
);

create index if not exists passkey_challenge_age on zz.passkey_challenge (created_at);

-- The OpenID round trip has nowhere to happen now.
drop table if exists zz.console_login;

-- One browser door, so nothing left to distinguish. 043 had just constrained this column to
-- its single surviving value, which is the same finding one step short of acting on it.
alter table zz.console_session drop constraint if exists console_session_door_known;
alter table zz.console_session drop column if exists door;
