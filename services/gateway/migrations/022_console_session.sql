-- A browser sign-in, held as a session rather than as a pasted token.
--
-- WHY A THIRD CREDENTIAL EXISTS AT ALL. The platform already has two: a PAT, which a person
-- copies into a terminal, and a delegated block token, which acts as them at somebody else's
-- service. Neither fits a browser. A PAT in a browser means the person pastes a bearer token
-- into a login box and something stores it — which is what /app does today, and it is the
-- reason /app cannot be shown to anyone who is not already an operator. A session is the
-- credential a browser is actually built to hold: the server sets it, JavaScript never sees
-- it, and closing the tab does not leak it into a shell history.
--
-- IT IS THE SAME SHAPE AS zz.pat ON PURPOSE. Random token, sha256 in the column, an expiry,
-- a revocation stamp, a last-seen. Anything that reads `pat` and anything that reads this
-- answer the same question in the same way, and `resolveSession` is a copy of `resolvePat`
-- with one column renamed — which is what makes it reviewable. The token itself is returned
-- exactly once, in a Set-Cookie header, and never again.
--
-- WHAT IT DOES NOT CARRY. No scope column, and deliberately. A PAT's scope exists because a
-- token is handed to an agent that then acts unattended; a session belongs to a person who is
-- present, and the door it opens (/api/console) is read-only. Adding a scope here would be a
-- second authority model for a surface that has no writes to authorise.
create table if not exists zz.console_session (
  id            uuid primary key default gen_random_uuid(),
  principal_id  uuid not null references zz.principal(id) on delete cascade,
  -- The hash, never the token. A database dump must not be a set of live logins.
  token_hash    text not null unique,
  issued_at     timestamptz not null default now(),
  -- NOT NULL, unlike zz.pat.expires_at. A PAT may legitimately live forever because a
  -- long-running agent holds it; a browser session that never expires is a lost laptop that
  -- stays signed in. There is no shape of this row that means "no expiry".
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  -- Recorded so a person can be told where they are signed in, and so an unexpected session
  -- is recognisable as unexpected. Never used for authorisation: an IP is not an identity,
  -- and treating it as one breaks every legitimate reconnection.
  user_agent    text,
  ip            text
);

create index if not exists console_session_principal on zz.console_session (principal_id);
-- The sweeper's index. Expired rows are deleted on a schedule rather than at read time,
-- because a read that also writes turns every page load into a transaction.
create index if not exists console_session_expiry on zz.console_session (expires_at);

-- The half-finished sign-in, held between the redirect out and the redirect back.
--
-- IT CANNOT NAME A PRINCIPAL, and that is the whole difference from zz.block_oauth_state.
-- A block authorization is started by somebody the platform has already identified, so that
-- row carries their principal_id. This one starts at a login screen: nobody is signed in yet,
-- and who they turn out to be is the OUTPUT of the exchange. So `state` binds a browser to a
-- code_verifier and to nothing else — which means `state` must be unguessable and single-use,
-- or one person's callback could be replayed into another person's browser.
create table if not exists zz.console_login (
  state         text primary key,
  -- PKCE S256. The code is exchanged from this server, but the redirect travels through a
  -- browser we do not control, and SsoAuth requires S256 regardless.
  code_verifier text not null,
  -- Where to send them once they are in, so a deep link survives the round trip. Validated as
  -- a same-site path before it is stored AND before it is used — an open redirect here would
  -- turn our own login into a credible phishing hop.
  redirect_to   text,
  created_at    timestamptz not null default now()
);

create index if not exists console_login_age on zz.console_login (created_at);
