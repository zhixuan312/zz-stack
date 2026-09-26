-- 002_identity_access.sql — Phase 1: the ten identity and access tables match the target.
--
-- DELIBERATE: no `begin`/`commit` anywhere in this file. `services/gateway/src/db.ts` applies
-- the file and inserts its `zz.schema_migration` row in one transaction, so every `now()` below
-- is the same instant as the `applied_at` the ledger records. The rehearsal's first join
-- expectation reads exactly that equality; a transaction of this file's own would break it.
--
-- DELIBERATE: the data steps come before the constraints they make true — a row the new shape
-- cannot hold is removed or repaired while the old shape is still in force, so a failure to
-- conform is a failure to migrate rather than a half-applied schema.
--
-- COUPLED: rollback is not safe. 0.81.1 still writes `principal.updated_at`,
-- `passkey_enrolment.issued_by` and `mcp_oauth_authz.id/state/used`, so an image rollback breaks
-- sign-in, deactivation and OAuth. This is fixed forward with a new version, never by staying.


-- 1. One live token per purpose (AC-2.4). Every live labelled PAT that a newer live PAT of the
--    same principal and label has superseded is revoked, so the newest of each group survives.
--    Revoked, never deleted: the token it replaces is the provenance of what this one obtained.
--    The comparison is strict, so a group whose members share a `created_at` revokes none of them
--    and the unique index in step 8 then fails the migration rather than silently allowing two
--    live tokens.
update zz.pat p
set revoked_at = now()
where p.label <> ''
  and p.revoked_at is null
  and exists (
    select 1 from zz.pat q
    where q.principal_id = p.principal_id
      and q.label = p.label
      and q.revoked_at is null
      and q.created_at > p.created_at
  );

-- 2. The console carries its own team (AC-2.1): switching team in the console moves that browser
--    only, and the agents keep the principal's. A session starts in the team its principal
--    already acts for, where that team is a membership of theirs.
alter table zz.console_session add column team_id uuid;
update zz.console_session s
set team_id = p.active_team_id
from zz.principal p
where p.id = s.principal_id
  and p.active_team_id is not null
  and exists (
    select 1 from zz.membership m
    where m.team_id = p.active_team_id and m.principal_id = p.id
  );

-- 3. A principal's active team must be one of their own memberships before the composite FK in
--    step 9 can be added. Nothing is invented: a team that names no membership of that principal
--    is not one they act for, so the choice is cleared rather than a membership created.
update zz.principal p
set active_team_id = null
where p.active_team_id is not null
  and not exists (
    select 1 from zz.membership m
    where m.team_id = p.active_team_id and m.principal_id = p.id
  );

-- 4. Both tables are ephemeral by contract — a challenge lives five minutes, an authorization
--    code ten — so the rows a client is mid-ceremony or mid-handshake with are discarded rather
--    than aged: the new not-null columns below meet no old row, and nothing is backfilled from a
--    value only the ceremony could have supplied.
delete from zz.passkey_challenge;
delete from zz.mcp_oauth_authz;


-- 5. principal: `updated_at` has no reader and is written by two of its four writers; the
--    composite FK makes "the team a person acts for is one they belong to" a fact the database
--    knows. `on delete set null (active_team_id)` nulls the team choice alone — deleting a
--    membership must not delete the principal, whose `id` is the other referencing column.
alter table zz.principal drop column updated_at;
alter table zz.principal
  add constraint principal_active_membership_fkey
  foreign key (active_team_id, id) references zz.membership (team_id, principal_id)
  on delete set null (active_team_id);

-- 6. team: a slug is an external address, and one the platform hands out — the shape is fixed
--    here rather than left to whichever caller mints one next.
alter table zz.team
  add constraint team_slug_check check (slug ~ '^[a-z0-9][a-z0-9_-]{1,63}$');

-- 7. membership: the primary key leads with `team_id`, so every "which teams is this person in"
--    reads the whole table without one.
create index membership_principal on zz.membership (principal_id);


-- 8. pat: a token names the OAuth client that obtained it (AC-2.3), so provenance survives the
--    client's revocation; one live token per principal and label is a uniqueness the database
--    enforces (AC-2.4), with the empty label exempt because it is the label of every token
--    minted before labels existed.
alter table zz.pat add column oauth_client_id text;
alter table zz.pat
  add constraint pat_oauth_client_id_fkey
  foreign key (oauth_client_id) references zz.mcp_oauth_client (client_id);
create index pat_principal on zz.pat (principal_id);
create unique index pat_live_label on zz.pat (principal_id, label)
  where revoked_at is null and label <> '';

-- 9. console_session: the team this browser acts for, set by the console's own switch and by
--    nothing else. A session whose team is deleted keeps running in the principal's.
alter table zz.console_session
  add constraint console_session_team_id_fkey
  foreign key (team_id) references zz.team (id) on delete set null;

-- 10. passkey_challenge: `expires_at` is what bounds the row, so it is the column the sweep and
--     the consumption read — the index on `created_at` was an age proxy and is replaced by one
--     on the deadline itself. The kind/principal check makes "a registration challenge has no
--     principal yet, a login challenge has one" a fact the database knows.
alter table zz.passkey_challenge add column expires_at timestamp with time zone not null;
alter table zz.passkey_challenge
  add constraint passkey_challenge_kind_principal_check
  check ((kind = 'register') = (principal_id is not null));
drop index zz.passkey_challenge_age;
create index passkey_challenge_expiry on zz.passkey_challenge (expires_at);

-- 11. passkey_enrolment: the issuer is already recorded in `zz.event` as `admin.issue_enrolment`
--     and `created_at` had no reader; the row is swept within fourteen days, so neither is
--     durable enough to keep a column for.
alter table zz.passkey_enrolment drop column issued_by, drop column created_at;

-- 12. mcp_oauth_client: a registration is durable provenance until someone revokes it — being
--     unused never deletes one — so revocation is a recorded fact rather than an absence.
alter table zz.mcp_oauth_client add column revoked_at timestamp with time zone;

-- 13. mcp_oauth_authz: the raw code is replaced by its hash (AC-2.2), so a reader of the table
--     cannot replay a grant; `state` was never read back and `used` becomes the `used_at`
--     instant the exchange stamps. `principal_id` is not null because a code is only ever
--     issued for a signed-in principal.
alter table zz.mcp_oauth_authz
  drop column id,
  drop column state,
  drop column used;
alter table zz.mcp_oauth_authz
  add column code_hash text not null,
  add column expires_at timestamp with time zone not null,
  add column used_at timestamp with time zone;
alter table zz.mcp_oauth_authz alter column principal_id set not null;
alter table zz.mcp_oauth_authz add constraint mcp_oauth_authz_pkey primary key (code_hash);
alter table zz.mcp_oauth_authz
  add constraint mcp_oauth_authz_client_id_fkey
  foreign key (client_id) references zz.mcp_oauth_client (client_id) on delete cascade;
