-- collaboration plane: comments on knowledge documents
set search_path to zz, public;

create table if not exists comment (
  id          uuid primary key default gen_random_uuid(),
  team_slug   text not null,
  initiative  text not null,
  path        text not null,
  author      text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  reply       text
);
create index if not exists comment_doc on comment (team_slug, initiative, path, created_at);
create index if not exists comment_open on comment (team_slug, resolved_at);
