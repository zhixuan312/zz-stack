-- A person's OWN access to a building block, obtained by them and held for them.
--
-- WHAT THIS CHANGES ABOUT WHO IS ACTING. Today every call the platform makes to casebox carries one
-- shared API key, so casebox's audit log records `Zhixuan-STG` for every action by every person of
-- every team. The platform is multi-tenant and that tenancy stops at the block boundary: casebox
-- cannot tell two organisations apart, everybody inherits the key's full powers whatever their own
-- role allows, and one revocation stops everyone.
--
-- OAuth fixes that by changing the ACTOR rather than the credential. CaseBox's own words: it
-- "allows a third-party app to access a user's data ... or to perform action ... on behalf of a
-- user". The person signs in with their government identity, consents to what we may do, and
-- the token we hold acts as THEM -- bounded by their roles, attributable in casebox's audit log, and
-- revocable by them without touching anybody else.
--
-- WHAT IT DOES NOT REPLACE. Unattended work has no user to delegate from: scheduled sweeps, the
-- evaluation harness, anything running while nobody is present. Those keep the API key, and
-- deliberately so -- CaseBox's refresh tokens die after 30 days absolute, so a delegated token is
-- structurally unsuited to work that must not need a human.

create table if not exists zz.block_token (
  principal_id  uuid not null references zz.principal(id) on delete cascade,
  block         text not null,
  access_token  text not null,
  refresh_token text not null default '',
  expires_at    timestamptz,
  -- What they actually consented to. CaseBox lets a user pick their app and permissions at the
  -- consent screen rather than the client naming them up front, so this is discovered, not
  -- requested -- and it is the only record of what this token may do.
  scope         text not null default '',
  -- Who the block thinks this is. `sub` is pairwise, so it identifies them to US and cannot be
  -- correlated with any other client's view of the same person.
  subject       text not null default '',
  email         text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (principal_id, block)
);

-- One authorization in flight. Short-lived by design: it exists only between the redirect out
-- and the redirect back.
--
-- IT CARRIES THE BINDING, and that is its real job. The callback arrives as a plain browser
-- redirect with no platform token on it, so the request cannot say who it belongs to. `state` is
-- how the answer gets back to the person who started it -- which is also why it must be
-- unguessable and single-use: anything else lets one person's authorization be bound to another
-- person's account.
create table if not exists zz.block_oauth_state (
  state         text primary key,
  principal_id  uuid not null references zz.principal(id) on delete cascade,
  block         text not null,
  -- PKCE. The code is exchanged from our server, but the redirect passes through a browser we do
  -- not control, and S256 is the only challenge method CaseBox offers.
  code_verifier text not null,
  redirect_uri  text not null,
  created_at    timestamptz not null default now()
);

create index if not exists block_oauth_state_age on zz.block_oauth_state (created_at);
