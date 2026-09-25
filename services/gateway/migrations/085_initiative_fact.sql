-- Mirrors <initiative>/_facts.json (services/zz-core/src/initiative-record.ts, factsFor/
-- writeFacts) into the platform database (Task I-27, FR-58) so the console — which reads
-- zz.doc alone, never the filesystem the eval service writes to — can compute the same
-- documentApplies (packages/contracts/src/flow-when.ts) answer the store's own readers do.
--
-- The file stays authoritative; this is a read-side mirror, written alongside it by
-- writeBranchFacts (services/zz-core/src/eval/protocol.ts) the moment a fact is newly set.
-- Append-only there and here: a fact once recorded is never given a different value, which is
-- why `unique (team, initiative, fact)` is enforced rather than merely intended — an insert
-- for an unchanged (team, initiative, fact) does nothing (on conflict do nothing), and
-- writeBranchFacts never asks this table to overwrite a row, the same discipline the file
-- keeps.

create table zz.initiative_fact (
    id bigint generated always as identity primary key,
    team text not null,
    initiative text not null,
    fact text not null,
    value text not null,
    set_at timestamp with time zone not null default now(),
    unique (team, initiative, fact)
);

create index initiative_fact_lookup_idx on zz.initiative_fact (team, initiative);

comment on table zz.initiative_fact is
  'Mirror of <initiative>/_facts.json for the console. The file is authoritative; a row here is never updated once written for a given (team, initiative, fact).';
