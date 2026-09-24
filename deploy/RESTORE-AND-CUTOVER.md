# Restore and cutover rehearsal

How an operator stands up an isolated PostgreSQL 17 copy of this platform, restores a
protected backup into it, rehearses the eight-step cutover, and exports
`ZZ_TENANT_INFO_ISOLATED_DB_URL` so the verification suites that need a real database can run.

This is a **rehearsal** procedure. It never switches production. The real switch needs final
acceptance readiness and a separate operator release decision (spec, H3), and nothing in this
document grants it.

---

## 0. Where this runs, and where it must not

| Machine | Use it? |
|---|---|
| A throwaway host or VM you control, with Docker and ~2x the backup size free | **Yes. This is the machine.** |
| The production host | **No.** It holds the live data this rehearsal exists to protect. |
| A developer laptop | **No.** At least one laptop in this project runs a local container pointed at the *production* database; a `docker compose` invocation there can reach it. |

The rehearsal host must have **no network route to the production database** and must run with
outbound integrations disabled. Step 4 of the spec's procedure requires it, and it is also the
only thing that makes a mistake in this document survivable.

Everything below assumes you are on the rehearsal host.

---

## 1. Get a complete backup set off-host

`deploy/backup.sh` writes four files per run into `$BACKUP_DIR` (default `/root/zz-backups`)
on the production host:

```
zz-db-<stamp>.sql.gz            the zz schema — principals, teams, PATs, events and every other table
zz-artifacts-<stamp>.tar.gz     every team's documents and knowledge, plus the canonical .zz record once one exists (step 5a)
zz-credentials-<stamp>.tar.gz   the gateway's own data: events it could not write to the database
zz-config-<stamp>.tar.gz        deploy/.env, Caddyfile and docker-compose.yml
```

Copy one complete set — all four files, same stamp — to the rehearsal host:

```bash
STAMP=20260920T031700Z            # pick a set that exists
mkdir -p ~/rehearsal/backup
scp root@<production-host>:/root/zz-backups/zz-*-$STAMP.* ~/rehearsal/backup/
```

Copy, never move. The original set stays where it is; the spec's step 1 is explicit that the
source deployment is preserved unchanged.

> `zz-credentials-*.tar.gz` holds API keys in plaintext and `zz-config-*.tar.gz` holds the
> database password. Both are mode 600 on the source. Keep them that way, and do not put
> either on shared storage.

---

## 2. Build the manifest

```bash
cd <checkout>/zz-stack
./deploy/backup-manifest.sh ~/rehearsal/backup $STAMP
export ZZ_TENANT_INFO_BACKUP_MANIFEST=~/rehearsal/backup/zz-backup-manifest-$STAMP.json
```

This produces the fifth component — `zz-git-<stamp>.tar.gz`, a `git bundle --all` per team
store, extracted from the artifacts archive — and writes the manifest that lists all five with
their SHA-256 hashes.

It refuses, rather than writing a manifest, if:

- any of the four files is missing (an incomplete set is not a backup),
- a store's history does not bundle (the archive caught a repository mid-write), or
- the artifacts archive carries a `.zz/` layout that is missing `blobs/` or `commits/` — the
  half-initialised state, which restores a deployment that refuses every write (step 5a).

An archive in which *no* store carries a `.zz/` layout is **not** a refusal: that is the
expected state of every backup taken before cutover, and the script says so. See step 5a.

Each refusal is a real finding about the backup. None of them is a problem with the script.

---

## 3. Stand up the isolated PostgreSQL 17 database

> **The pins are resolved.** `deploy/postgres/versions.lock.json` carries eight of its nine
> `*_verified` flags `true` — the PostgreSQL
> version, the base image digest, the architecture, the `pg_textsearch` repository, commit and
> source digest, the built image digest, and the text-configuration fingerprint.
>
> The ninth, `okf_reference_digest_verified`, is `false` and its own `unverified_fields` entry
> argues it should be struck from the specification rather than filled: the specification asks
> for a vendored OKF reference digest, and **this repository vendors no OKF reference to
> digest**. It carries its own implementation and that implementation's tests, and nothing else
> named OKF exists in the tree. An unresolvable field is a finding about the specification, not
> a gap in this build, so it does not block the image.
>
> Read the lock file rather than this paragraph if the two ever disagree. The restore in
> step 4 depends on none of it and can proceed on a stock PostgreSQL 17 image; only the
> `pg_textsearch` half ever did.

```bash
cd <checkout>/zz-stack/deploy/postgres
docker build -t zz-postgres-rehearsal:17 .

docker network create zz-rehearsal
docker run -d --name zz-rehearsal-db --network zz-rehearsal \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  -e POSTGRES_USER=zz -e POSTGRES_DB=zz_rehearsal \
  -p 127.0.0.1:55432:5432 \
  zz-postgres-rehearsal:17
```

`-p 127.0.0.1:55432` binds to loopback only. A rehearsal database that anything else on the
network can reach is not isolated.

---

## 4. Restore

```bash
cd ~/rehearsal/backup
zcat zz-db-$STAMP.sql.gz | docker exec -i zz-rehearsal-db psql -U zz -d zz_rehearsal
```

**Logical restore into a new cluster — never mount a PostgreSQL 16 data directory into
PostgreSQL 17.** The dump is `pg_dump --clean --if-exists`, so it restores over an empty
database. Treat any error as fatal: step 1 of the procedure says so, and a partial restore
that looks finished is the failure this whole rehearsal exists to find.

Restore the artifacts onto a **separate new volume**, never the old one:

```bash
docker volume create zz-rehearsal-artifacts
docker run --rm -v zz-rehearsal-artifacts:/data -v ~/rehearsal/backup:/backup:ro alpine \
  tar xzf /backup/zz-artifacts-$STAMP.tar.gz -C /data
```

---

## 5. Apply the schema

```bash
docker exec -i zz-rehearsal-db psql -U zz -d zz_rehearsal \
  < <checkout>/zz-stack/services/gateway/migrations/001_init.sql
```

`001_init.sql` is the whole schema in one file; migrations 002..074, including the artifacts,
revisions, events and scoped-search tables this rehearsal needs, were squashed into it. Apply
every other file in `services/gateway/migrations/` after it, in filename order.

Its lines 26-28 are `create extension if not exists citext / pg_textsearch / pg_trgm`. Applied
through `psql` as above those run unconditionally — the `requires-extension:` directives in its
header are read by the gateway's own migration runner (`services/gateway/src/db.ts`), which
defers the file on a cluster that cannot supply them; piping it straight into `psql` bypasses
that and fails outright.

**So the schema applies in full on the step 3 image, and not at all on a stock PostgreSQL 17
one.** There is no partial path: `create extension` is the second statement in the file, so a
stock image gets none of the tables. This is the ordering that decides what step 7 can unblock.

---

## 5a. Initialise the `.zz/` record layout on the new artifact volume

**This step has no owner elsewhere in the delivery, and without it the cutover produces a
platform that refuses every write.**

### Why it exists

`services/zz-core/src/tenant-info/record.ts:271` refuses `STORE_UNAVAILABLE` when `.zz/`,
`.zz/blobs` or `.zz/commits` is missing, in its own words: *"a missing mount is refused, never
read as an empty tenant."* That refusal is correct and is not to be weakened — the alternative
is a failed volume mount being read as a tenant with no documents, and the next thing that
happens to an empty tenant is that something helpfully reconstructs them.

Nothing in the platform ever creates that layout. I-20's adoption path turns a document with no
commit into one that has a commit, but it runs *inside* the kernel, behind that same refusal —
which `a_store_with_no_record_layout_is_refused_not_initialised` in
`testing/tenant-info/migration-adoption.ts` pins deliberately. The live owner stores have no
`.zz/`. So the real order on cutover day is:

1. **initialise `.zz/{blobs,commits}` on each owner store** ← this step
2. the registered tools route through the kernel
3. the first write to each document adopts it (I-20)

Measured, against the real kernel on a store seeded the way a live store was seeded:

```
BEFORE init  — captureSource: false STORE_UNAVAILABLE
BEFORE init  — revise      : false STORE_UNAVAILABLE
AFTER  init  — captureSource: true
AFTER  init  — revise      : true (adopted and committed)
```

### Where it goes, and why here

**On the new artifact volume, after step 4's restore of it and before step 6's checks.** Not on
the live volume, at any point.

- **Not before the drain.** Initialising the live stores while the platform is serving is a
  write into a tenant's real store directory that buys nothing: the old code never reads
  `.zz/`. It is all risk and no benefit.
- **Not after step 7.** Step 6 keeps writes frozen *while checking* query and restore
  behaviour, and step 7 resumes writes. A layout created after either would mean the first
  write of the new deployment — the one step 8 records — hits `STORE_UNAVAILABLE`.
- **Here**, the old volume is never written to at all. The contract's "old volumes remain
  isolated/read-only" holds literally rather than by convention.

### The commands

`deploy/init-record-layout.sh` takes **exactly one directory, which must already exist**, and
acts on that alone. It never searches, has no recursive mode and no default: the set of things
it can touch is the set of paths you typed.

```bash
# List the owner stores on the NEW volume first, and read the list before acting on it.
docker run --rm -v zz-rehearsal-artifacts:/data:ro alpine ls -1 /data

# Then one invocation per store, with the path visible in each.
for store in team-alpha team-beta; do
  docker run --rm -v zz-rehearsal-artifacts:/data \
    -v "$PWD/deploy/init-record-layout.sh":/init.sh:ro \
    alpine sh /init.sh "/data/$store"
done
```

It is **idempotent**: a second run on a complete layout reports `already complete` and does
nothing.

It **repairs a partial layout rather than refusing it**, which is the state an interrupted
attempt leaves behind:

```
REPAIRING: /data/team-alpha has a PARTIAL .zz/ layout (2 of 3 directories present).
  A partial layout refuses every write exactly as a missing one does, while looking
  initialised to anybody who lists the directory. Completing it.
```

That state is worth naming: `preflightRefusal` requires all three directories, so a store with
`.zz/` and `.zz/blobs` but no `.zz/commits` refuses every write exactly as a store with nothing
does — while looking initialised to anybody who lists it.

The script creates **two empty directories and no record**. It writes, moves and rewrites no
document byte.

### Rollback if the cutover is abandoned

Nothing to undo. This step only ever touched the new volume, so abandoning the cutover is
step 8's ordinary "before any new write, rollback can return to the matched old app/DB/volume
snapshot" — the old volume is byte-identical to what it was, and the new one is discarded.

Were a layout ever created on a store that then went back to the old path, it would be two
empty directories that the old code never opens. Harmless. The procedure above avoids even
that, which is why it is worth following rather than improvising.

### What this means for the backup

**A backup taken before this step is still a complete restore target.** `.zz/blobs` and
`.zz/commits` are derived, not data: restore the pre-layout set, re-run this script, and you
are in the identical state. Nothing is lost by having backed a store up before it had a layout.

`deploy/backup-manifest.sh` knows the difference, and says which one it is reading:

```
zz-artifacts-<stamp>.tar.gz: no store carries a .zz/ layout — this set PREDATES the record layout.
  That is the expected state before cutover, and the set is still a complete restore
  target. Restoring it gives stores that refuse writes with STORE_UNAVAILABLE until
  deploy/init-record-layout.sh has run on each one (RESTORE-AND-CUTOVER.md step 5a).
```

What it *does* refuse is an archive carrying a `.zz/` with no `blobs/` or no `commits/` — a
backup of the half-initialised state, which would restore a deployment that looks initialised
and cannot be written to.

---

---

## 6. Export the URL

```bash
export ZZ_TENANT_INFO_ISOLATED_DB_URL="postgres://zz:<password>@127.0.0.1:55432/zz_rehearsal"
```

**What this variable may name, and what it may never name.**

- The isolated copy produced by this document, and nothing else.
- **Never** the live cluster.
- **Never** a value inferred, copied or derived from `TEAM_DB_URL` or `PLATFORM_DB_URL`. The
  suites refuse it outright if it equals either — see `isolatedDatabaseRefusal` in
  `testing/tenant-info/deployment-cutover.ts`.
- **Never** a database this repository's tooling provisioned on its own. No suite here creates
  a database; an operator does, on purpose, by running step 3.

Every case that reads this variable applies real DDL and writes real rows.

---

## 7. What setting it actually unblocks

Six cases across three suites are commonly described as waiting on this variable. That is true
of two of them. The other four need something else as well, and this document cannot supply
it.

> **Read this before the table.** Every row below assumes the schema applied, and step 5
> shows that needs the step 3 image, whose pins are resolved (see section 3).
> The variable is necessary for the two marked Yes and
> sufficient for neither pair marked No, for the reasons in their own rows — a missing verified
> BM25 DDL for the isolation pair, and no implementation at all for the migration pair.

| Suite | Case | Does step 6 unblock it? |
|---|---|---|
| `rebuild` | `atomic_apply_against_isolated_database` | **Yes**, once the schema is applied. It needs nothing but the URL — it creates its own store root with `mkdtemp` and its own rows. |
| `rebuild` | `real_rebuild_against_isolated_copy` | **Yes**, once the schema is applied. Same: URL only, own temporary store, own fixtures. |
| `isolation` | `real_pg17_statistical_isolation` | **No.** Needs step 3's image *and* verified `pg_textsearch` BM25 index and score-expression DDL, which this checkout does not carry. Stays `not_run` with that reason even when the variable is set. |
| `isolation` | `real_pg17_bm25_score_expression` | **No.** Same gap. |
| `migration` | `projection_parity_against_the_isolated_database` | **No.** These two are a hardcoded `NOT_RUN` map in `testing/tenant-info/migration.ts` and read no environment variable at all. They have no implementation behind them yet. |
| `migration` | `copied_multi_owner_store_projection_replay` | **No.** Same — unimplemented, not unconfigured. |

So: **2 of 6.** The image pins are resolved, so the two `rebuild` cases are reachable once the schema
is applied. The isolation pair is additionally blocked on the extension's verified BM25 DDL;
the migration pair is blocked on
code nobody has written. Neither of those is an environment problem and neither is closed by
running this document.

Run what step 6 does unblock:

```bash
export ZZ_TENANT_INFO_WORKSPACE=~/rehearsal/workspace   # must be outside the checkout
mkdir -p "$ZZ_TENANT_INFO_WORKSPACE"
npm run tenant-info -- verify --suite rebuild --profile integration --cases projection-schema
```

---

## 8. The cutover rehearsal

The eight steps are the spec's, and they are executed by an operator, not by a suite. What the
suite does is judge the record you make while executing them, and then check the one fact a
record cannot be trusted for.

Write your observations to a JSON file as you go:

```bash
export ZZ_TENANT_INFO_CUTOVER_OBSERVATIONS=~/rehearsal/cutover-observations.json
```

```json
{
  "drain": {
    "mutation_paths": [
      { "kind": "request",       "maintenance": true, "in_flight": 0 },
      { "kind": "background",    "maintenance": true, "in_flight": 0 },
      { "kind": "legacy_client", "maintenance": true, "in_flight": 0 }
    ],
    "active_writers": 0,
    "file_commit_watermark": "<40-hex git commit of the last write to each store>",
    "platform_snapshot_boundary": "<pg_current_wal_lsn() at the freeze>"
  },
  "matched_unit": {
    "old_unit": {
      "app_image_digest": "sha256:...",
      "database_identity": "zz-rehearsal-source",
      "artifact_volume": "<resolved from the Compose project>",
      "read_only": true
    },
    "new_unit": {
      "app_image_digest": "sha256:...",
      "database_identity": "zz-rehearsal-db",
      "artifact_volume": "zz-rehearsal-artifacts",
      "postgres_major": 17,
      "data_directory_reused": false
    },
    "volumes_resolved_from_compose_project": true,
    "outbound_integrations_disabled": true
  },
  "forward_recovery": {
    "strategy": "forward_recovery",
    "target_postgres_major": 17,
    "resume_boundary_at": "<ISO timestamp when you resumed writes>",
    "post_resume_write_ref": "<transaction_id of the first accepted write after resume>",
    "recovered_write_refs": ["<...>"],
    "new_file_commits": ["<...>"],
    "recovered_file_commits": ["<...>"],
    "platform_db_changes_preserved": true
  }
}
```

Filling the three fields that matter:

```bash
# the freeze boundary (step 3)
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc 'select pg_current_wal_lsn()'

# the first accepted write after you resume (step 8) — inject it deliberately,
# then record the transaction it stamped
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc \
  "select transaction_id from zz.artifact_event order by at desc limit 1"

# after forward recovery, every transaction that came back
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc \
  "select distinct transaction_id from zz.artifact_event where at > '<resume_boundary_at>'"
```

The `post_resume_write_ref` is a **`zz.artifact_event.transaction_id`**, because that is the
identity one accepted mutation actually has in this schema. `zz.artifact_revision` is keyed
`(owner_id, artifact_id, revision)` and carries no timestamp of its own.

Then run both live cases:

```bash
npm run tenant-info -- verify --suite deployment --profile integration --cases restore,cutover
```

`restore` re-hashes every file the manifest names and then interrogates the restored database:
security-table row counts, membership foreign keys as data rather than as catalog metadata, a
usable PAT token hash, and collation-dependent uniqueness on `zz.principal.email` (citext) and
`zz.team.slug`. `cutover` judges your three observation blocks and then reads the post-resume
transaction back out of the database itself — because "it survived" is the claim the whole
rehearsal turns on, and it is not one to take on trust.

---

## 9. Tear down

```bash
docker rm -f zz-rehearsal-db
docker volume rm zz-rehearsal-artifacts
docker network rm zz-rehearsal
```

Keep the backup set and the manifest. Delete neither the original history nor any credential
archive: the spec is explicit that backups and per-team Git survive the rehearsal, and the
source deployment is still the only place some of this exists.
