-- Task I-16: replay_start/replay_read/replay_close need two things 077 did not give
-- zz.replay_run — whose run this is and how long its sandbox lives — and a place candidate_prove
-- (Task I-21) will one day mint a verifier_token into, so a "verifier" context can be validated
-- against something real instead of a hardcoded stub. Additive only.

-- Every replay_run now names the principal who started it (replay_start's own expiry sweep reads
-- this to find and close ITS OWN caller's expired runs, AC-29.1 — never another caller's), the
-- reserved team it was provisioned into and the PAT issued for it
-- (packages/contracts/src/replay-team.ts's provisionReplayTeam/teardownReplayTeam, Task I-15 —
-- replay_close's teardown needs both to tear the right team down), and when that PAT expires (the
-- same value provisionReplayTeam was given, so "this run has expired" is a plain comparison
-- against now() rather than a second lookup through zz.pat). Written once by replay_start, read
-- by replay_start's own expiry sweep and by replay_close.
alter table zz.replay_run
    add column principal text not null,
    add column team_slug text not null,
    add column pat_id uuid not null references zz.pat(id),
    add column expires_at timestamp with time zone not null;

-- A verifier_token (the plan's own Errors clause): a `context: "verifier"` call to replay_start
-- or replay_read must present one, and until candidate_prove (Task I-21) exists nothing ever
-- mints one — so every proof request is refused by a real, permanently-empty lookup here, never
-- by a hardcoded check for a mode nobody can reach yet. Hashed the same way zz.pat is (sha256,
-- never the plaintext at rest): the plaintext is shown once by whichever tool eventually mints it
-- and never stored again.
create table zz.replay_verifier_token (
    id uuid primary key default gen_random_uuid(),
    token_hash text not null unique,
    candidate_id uuid not null references zz.candidate(id),
    expires_at timestamp with time zone not null,
    revoked_at timestamp with time zone null,
    created_at timestamp with time zone not null default now()
);
