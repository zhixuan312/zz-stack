-- zz platform tables — live in the `zz` SCHEMA of the existing database
-- The migrations in this directory ARE the schema: there is no separate design document,
-- because one would drift from them. (Schema decision 2026-08-22.)
create schema if not exists zz;
set search_path to zz, public;
create extension if not exists citext;

create table if not exists principal (
  id           uuid primary key default gen_random_uuid(),
  email        citext not null unique,
  display_name text not null default '',
  role         text not null default 'member'
               check (role in ('superadmin','member')),
  status       text not null default 'active'
               check (status in ('active','deactivated')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists team (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  status     text not null default 'active'
             check (status in ('active','archived')),
  created_by uuid not null references principal(id),
  created_at timestamptz not null default now()
);

create table if not exists membership (
  team_id      uuid not null references team(id),
  principal_id uuid not null references principal(id),
  role         text not null default 'member'
               check (role in ('admin','member')),
  added_by     uuid references principal(id),
  created_at   timestamptz not null default now(),
  primary key (team_id, principal_id)
);

create table if not exists pat (
  id           uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principal(id),
  token_hash   text not null unique,
  label        text not null default '',
  scope        text not null default 'member'
               check (scope in ('member','admin')),
  team_id      uuid references team(id),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists flow_install (
  team_id      uuid not null references team(id),
  flow         text not null,
  version      text not null default '',
  installed_by uuid references principal(id),
  created_at   timestamptz not null default now(),
  primary key (team_id, flow)
);

create table if not exists tool_grant (
  team_id    uuid not null references team(id),
  block      text not null,
  granted_by uuid references principal(id),
  created_at timestamptz not null default now(),
  primary key (team_id, block)
);

create table if not exists platform_credential (
  principal_id uuid not null references principal(id),
  block        text not null,
  secret_enc   text not null,
  updated_at   timestamptz not null default now(),
  primary key (principal_id, block)
);

create table if not exists event (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  actor     text not null,
  team_slug text,
  kind      text not null,
  subject   text not null default '',
  detail    jsonb not null default '{}'::jsonb
);
create index if not exists event_team_ts on event (team_slug, ts);
create index if not exists event_kind_ts on event (kind, ts);

create table if not exists doc (
  team_slug   text not null,
  initiative  text not null,
  path        text not null,
  flow        text not null default '',
  type        text not null default '',
  status      text not null default '',
  outcome     text,
  approved_by text,
  approved_at date,
  updated_at  timestamptz not null,
  body_tsv    tsvector,
  primary key (team_slug, initiative, path)
);
create index if not exists doc_type_status on doc (type, status);
create index if not exists doc_tsv on doc using gin (body_tsv);
