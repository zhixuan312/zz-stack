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
zz-db-<stamp>.sql.gz            the zz schema — principals, teams, PATs, installs, grants, events
zz-artifacts-<stamp>.tar.gz     every team's documents and knowledge, including the canonical .zz record
zz-credentials-<stamp>.tar.gz   each person's building-block API keys
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
- the artifacts archive holds no `.zz` record.

Each refusal is a real finding about the backup. None of them is a problem with the script.

---

## 3. Stand up the isolated PostgreSQL 17 database

> **Blocked today.** `deploy/postgres/versions.lock.json` still carries placeholder pins —
> every `*_verified` flag is `false`, and the build below will produce an image nobody
> resolved. Resolving those pins is I-5's remaining work, not something to guess here. Until
> it is done, `verify --suite deployment --cases extension` reports `not_run` and names every
> unresolved field. The restore in step 4 does not depend on it and can proceed on a stock
> PostgreSQL 17 image; only the `pg_textsearch` half does.

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

## 5. Apply migration 070

```bash
docker exec -i zz-rehearsal-db psql -U zz -d zz_rehearsal \
  < <checkout>/zz-stack/services/gateway/migrations/070_artifacts_revisions_events_and_scoped_search.sql
```

070's line 88 is `create extension if not exists pg_textsearch;` and line 89 the same for
`pg_trgm`. Applied through `psql` as above, those run unconditionally — the `requires-extension:`
directives in its header are read by the gateway's own migration runner
(`services/gateway/src/db.ts`), which defers the file on a cluster that cannot supply them;
piping the file straight into `psql` bypasses that and fails outright.

**So 070 applies in full on the step 3 image, and not at all on a stock PostgreSQL 17 one.**
There is no partial path: `create extension` is the eighth statement in the file, so a stock
image gets none of the tables. This is the ordering that decides what step 7 can unblock.

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

> **Read this before the table.** Every row below assumes migration 070 applied, and step 5
> shows that needs the step 3 image, which needs `deploy/postgres/versions.lock.json`'s pins
> resolved. **Until those pins are resolved, the answer in every row is "no" — including the
> two marked Yes.** The variable is necessary for those two and is not sufficient for any of
> them. Resolving the pins is the first domino, not this document.

| Suite | Case | Does step 6 unblock it? |
|---|---|---|
| `rebuild` | `atomic_apply_against_isolated_database` | **Yes**, once 070 is applied. It needs nothing but the URL — it creates its own store root with `mkdtemp` and its own rows. |
| `rebuild` | `real_rebuild_against_isolated_copy` | **Yes**, once 070 is applied. Same: URL only, own temporary store, own fixtures. |
| `isolation` | `real_pg17_statistical_isolation` | **No.** Needs step 3's image *and* verified `pg_textsearch` BM25 index and score-expression DDL, which this checkout does not carry. Stays `not_run` with that reason even when the variable is set. |
| `isolation` | `real_pg17_bm25_score_expression` | **No.** Same gap. |
| `migration` | `projection_parity_against_the_isolated_database` | **No.** These two are a hardcoded `NOT_RUN` map in `testing/tenant-info/migration.ts` and read no environment variable at all. They have no implementation behind them yet. |
| `migration` | `copied_multi_owner_store_projection_replay` | **No.** Same — unimplemented, not unconfigured. |

So: **2 of 6 once the image pins are resolved, and 0 of 6 before that.** The isolation pair is
additionally blocked on the extension's verified BM25 DDL; the migration pair is blocked on
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
