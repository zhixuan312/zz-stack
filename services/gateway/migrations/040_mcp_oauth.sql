-- THE GATEWAY IS AN OAUTH AUTHORIZATION SERVER FOR ITS OWN MCP DOORS.
--
-- Until now a person reached an MCP door by pasting a platform token into a box in the front
-- end's settings, labelled "ask ZZ Access for one". That is a secret travelling through a
-- human and a clipboard to arrive somewhere it was always going to arrive, and it is the
-- reason the connection panel could never say anything true: LibreChat marks a server
-- `connected` when `initialize` returns 200, and a door with no credential answered 200 with
-- a one-tool stub, so every server showed green whether or not the person could use it.
--
-- With these tables the front end does what an MCP client is built to do: it is refused with
-- a 401 carrying a WWW-Authenticate challenge, discovers this server, registers itself,
-- sends the person here to sign in, and receives a token it holds itself. Nobody pastes
-- anything, and green means the handshake completed.

-- A CLIENT THAT REGISTERED ITSELF (RFC 7591).
--
-- Public clients only: no secret is issued and none is accepted, because the alternative is a
-- secret in a bind-mounted yaml on a deploy host. PKCE is what proves the exchange instead,
-- and it is mandatory below rather than optional.
create table if not exists zz.mcp_oauth_client (
  client_id     text primary key,
  -- Checked at /authorize byte for byte against what arrives, which is the whole reason to
  -- store them. See the origin allowlist in mcp-oauth.ts for what may be registered at all.
  redirect_uris jsonb not null,
  name          text not null default '',
  created_at    timestamptz not null default now()
);

-- AN AUTHORIZATION IN FLIGHT, AND THEN THE CODE IT BECOMES.
--
-- One row, two lives. It is created when /authorize starts, and its own id is handed back as
-- the authorization code — so there is no second table and no window where a code exists
-- without the request that justified it.
create table if not exists zz.mcp_oauth_authz (
  id             text primary key,
  client_id      text not null,
  -- Null until the person has signed in. A row with no principal is a request nobody has
  -- authorised yet, and /token refuses it.
  principal_id   uuid references zz.principal(id) on delete cascade,
  redirect_uri   text not null,
  -- PKCE S256 only. The redirect passes through a browser we do not control.
  code_challenge text not null,
  state          text not null default '',
  -- Which door this token is for, exactly as the client named it. Recorded so the token's
  -- label can say, and so a future narrowing of scope per door has somewhere to read from.
  resource       text not null default '',
  -- SINGLE USE. Set when /token exchanges it; a replay then finds a row it cannot use rather
  -- than a row that is gone, which is the difference between "already used" and "unknown".
  used           boolean not null default false,
  created_at     timestamptz not null default now()
);

create index if not exists mcp_oauth_authz_age on zz.mcp_oauth_authz (created_at);
