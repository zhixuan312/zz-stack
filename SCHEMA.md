# Schema standard

This is the rule the schema is judged by, and the target it is judged against.
`schema-target.ts` is the exact machine-readable inventory; `checks/schema-inventory.ts`
imports it and fails the gate on any drift. This document states the standard that
inventory implements — the five questions every table and column must answer, the six
classes a row can belong to, the twelve rules the schema follows, and the structured
comment every table and column carries so a reader never has to ask a person.

## The five questions

**The five questions**, asked of every table and every column, in order:

1. **Fact** — what durable fact does it represent?
2. **Authority** — where is that fact authoritative?
3. **Class** — `current_state`, `immutable_history`, `state_machine`, `relation`, `ephemeral` (including secrets) or `projection` (rebuildable).
4. **Reconstruction** — if it were removed, could the answer be rebuilt unambiguously from the authority? If it is duplicated, is the duplicate declared as a projection with a rebuild path?
5. **Asker** — who needs the answer: a product surface, security, audit, a query that runs, or an agreed capability?

A missing reader or writer is evidence of an implementation gap. On its own it is not a reason to delete. A field with no asker in any agreed capability and no writer is deleted.

## The six classes

Every table and every column belongs to exactly one of these six classes, named in its
structured comment.

`current_state` — the row says what is true now for its subject. It is overwritten in
place as the fact changes, and a reader asking "what is true right now" reads this table
and nothing else.

`immutable_history` — the row is insert-only. It records that something happened, once,
and is never updated or deleted; history explains how state changed, it does not hold
the current state itself.

`state_machine` — the row has a lifecycle. Its payload fields are frozen once written;
only its lifecycle fields may change, and only through the transitions its own comment
names. A terminal published result is never rewritten.

`relation` — the row exists to join two identities by id. It carries no fact of its own
beyond the relationship, and its keys are foreign keys, never slugs or paths standing in
for them.

`ephemeral` (including secrets) — the row has a bounded lifetime by design: a challenge,
a code, a token that expires or gets swept. Its table comment states the retention or
sweep rule that bounds it.

`projection` (rebuildable) — the row is a declared copy of a fact whose authority lives
elsewhere. It names what it is rebuilt from, so a reader can tell it is a duplicate
rather than a second authority.

## The twelve rules

1. One authoritative fact, one place. A copy exists only as a declared projection with a rebuild source.
2. Relations use ids and foreign keys. Slugs and paths are external addresses or declared historical snapshots.
3. Current state is never reconstructed from telemetry. History explains how state changed; state tables say what is true now.
4. Immutable history is insert-only. A `state_machine` record freezes its payload and may change only lifecycle fields through declared transitions; a terminal published result is never rewritten.
5. Bearer secrets are stored hashed; expiry and consumption are explicit columns.
6. Sparse is not dead: null and zero are judged by meaning, not frequency.
7. A field may lack its reader or writer only while a named capability owns it, and that capability cannot close with the gap open.
8. jsonb holds genuinely open payloads or closed value snapshots that are never independently joined. Relational identities and keys queried independently are columns/FKs, even when today they are rendered as one JSON object.
9. Every unbounded or ephemeral table declares its retention or sweep.
10. The database enforces every invariant it can know.
11. A destructive change lands in the same release as every reader and writer that names what it drops.
12. Tenant scope is structural: whenever a row stores both team and initiative identity, a composite FK proves the initiative belongs to that team; the same rule applies to other tenant-scoped parent/child identities such as event→skill_run.

## The comment contract

Every table and every column carries a structured `COMMENT` in this exact shape. A
`projection` always adds `rebuilt_from`; a `state_machine` table comment always names its
`transitions`; an unbounded or ephemeral table's comment always names its `retention`.

```
COMMENT ON TABLE  zz.<table>        IS 'class=<current_state|immutable_history|state_machine|relation|ephemeral|projection>; authority=this; question=<one sentence>[; transitions=<from->to,...>][; rebuilt_from=<source>][; retention=<rule>]';
COMMENT ON COLUMN zz.<table>.<col>  IS 'class=<…>; authority=<this|zz.<table>.<column>>; question=<one sentence>[; rebuilt_from=<source>]';
```

## The inventory

`schema-target.ts` is the one machine-readable target inventory — the exact executable
description of the schema as delivered through the current phase. Nothing else defines
the schema a second time: `checks/schema-inventory.ts` imports `schema-target.ts`, reads
`pg_catalog` of a database migrated from `services/gateway/migrations/001_init.sql`, and
fails the gate on any difference — a table or column absent from or extra to the target;
a type, nullability, primary key, foreign key (including delete action and
deferrability), unique, check or required index that differs; a missing or malformed
comment; a `projection` without `rebuilt_from`; a `state_machine` without `transitions`;
or an unbounded/ephemeral table without `retention`. Source-code grep is never the proof
of any of this — only the comparison against `schema-target.ts` is.

## Adding a table or column

Declare the target first, then write the migration. Add the table or column to
`schema-target.ts` — its columns, types, nullability, keys, constraints, indexes and its
structured comment — before any migration file references it. Then write the release's
`002_<name>.sql` migration that makes the live catalog match what `schema-target.ts` now
declares. `checks/schema-inventory.ts` is what proves the two agree; a migration written
before the target is a migration nothing has checked.
