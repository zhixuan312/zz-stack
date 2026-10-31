# Restore and cutover rehearsal

How an operator stands up an isolated PostgreSQL 17 copy of this platform and restores a protected
backup into it, so a cutover can be rehearsed against real data before it is performed.

This is a **rehearsal** procedure. It never switches production.

---

## 0. Where this runs, and where it must not

| Machine | Use it? |
|---|---|
| A throwaway host or VM you control, with Docker and ~2x the backup size free | **Yes. This is the machine.** |
| The production host | **No.** It holds the live data this rehearsal exists to protect. |
| A developer laptop | **No.** At least one laptop in this project runs a local container pointed at the *production* database; a `docker compose` invocation there can reach it. |

The rehearsal host must have **no network route to the production database** and must run with
outbound integrations disabled. It is also the only thing that makes a mistake in this document
survivable.

Everything below assumes you are on the rehearsal host.

---

## 1. Get a complete backup set off-host

`deploy/backup.sh` writes **three** files per run into `$BACKUP_DIR` (default `/root/zz-backups`)
on the production host:

```
zz-db-<stamp>.sql.gz            the `zz` schema — principals, teams, PATs, events, AND every team's
                                documents, revisions, citations and knowledge
zz-credentials-<stamp>.tar.gz   the gateway's own data volume: /data/events-unwritten.jsonl, the
                                events it could not write to the database
zz-config-<stamp>.tar.gz        deploy/.env, plus docker-compose.yml and a Caddyfile when either
                                sits beside backup.sh
```

Copy one complete set — all three files, same stamp — to the rehearsal host:

```bash
STAMP=20260927T085353Z            # pick a set that exists
mkdir -p ~/rehearsal/backup
scp root@<production-host>:/root/zz-backups/zz-*-$STAMP.* ~/rehearsal/backup/
```

Copy, never move. The original set stays where it is.

> `zz-config-*.tar.gz` holds `deploy/.env` in plaintext: the database password and every key set
> there. `zz-credentials-*.tar.gz` holds the events the gateway could not write, which name who
> did what. Both are mode 600 on the source. Keep them that way, and do not put either on shared
> storage.

### A set with a fourth file is an OLDER set

Until the artifacts volume was retired, `backup.sh` wrote a fourth member,
`zz-artifacts-<stamp>.tar.gz` — every team's file store. It is gone, and so is the volume: a
document, its revisions and its citations are `zz.doc`, `zz.doc_revision` and `zz.doc_link` rows,
which is what the `pg_dump` carries. **The store's every fact is in the dump, and the archive is a
second copy of it that went stale the moment a tool wrote a document.**

So a set holding `zz-artifacts-*.tar.gz` still restores — do not throw it away — but what it
restores is a database as of the day it was taken, and the archive beside it is a snapshot of the
store from the same day. Restoring only the database half is the correct thing to do with it.
Never restore the archive *over* the database: the dump already holds those documents.

There is one more archive that may be in that directory and is **not part of any nightly set**:
`zz-store-archive-<stamp>.tar.gz`, written once when the store was removed. It is the last copy of
the store's files AS FILES, `deploy/backup.sh` is given an
explicit exemption from pruning it, and it is the copy most worth carrying off the host. A
rehearsal does not need it.

---

## 2. Check the copy, if you want to

```bash
shasum -a 256 ~/rehearsal/backup/*$STAMP*
```

Run the same listing on the source and compare the two: the set is three files, and a missing
one or a different digest is a copy that did not arrive whole. Nothing else in this procedure
reads it.

---

## 3. Stand up the isolated PostgreSQL 17 database

```bash
cd <checkout>/zz-stack
IMAGE=$(node --input-type=module -e "import('./scripts/release/postgres-service.ts').then((m) => process.stdout.write(m.postgresService('.').image))")

docker network create zz-rehearsal
docker run -d --name zz-rehearsal-db --network zz-rehearsal \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  -e POSTGRES_USER=zz -e POSTGRES_DB=zz_rehearsal \
  -p 127.0.0.1:55432:5432 \
  "$IMAGE" \
  postgres -c shared_buffers=512MB -c maintenance_work_mem=128MB -c work_mem=16MB
```

`-p 127.0.0.1:55432` binds to loopback only. A rehearsal database that anything else on the
network can reach is not isolated.

The image and the command line are the ones `deploy/docker-compose.yml` gives the platform's
database: the official PostgreSQL 17 image, pinned by digest. Read compose rather than any prose
about it if the two ever disagree.

---

## 4. Restore

```bash
cd ~/rehearsal/backup
gzip -dc zz-db-$STAMP.sql.gz | docker exec -i zz-rehearsal-db psql -v ON_ERROR_STOP=1 -U zz -d zz_rehearsal
```

**Logical restore into a new cluster — never mount an older major version's data directory into a
newer one.** The dump is `pg_dump --clean --if-exists`, so it restores over an empty database.
`ON_ERROR_STOP` makes psql exit non-zero on the first error. Treat that as fatal: a partial restore
that looks finished is the failure this whole rehearsal exists to find.

**A backup taken before 0.86.0 does not restore here.** It still declares the `pg_textsearch`
extension, which 0.86.0 dropped and the official image does not carry, so the restore stops at
`create extension pg_textsearch`. Rehearse with a backup taken on 0.86.0 or later.

**There is no second restore.** No service in `deploy/docker-compose.yml` mounts a document volume:
documents are rows in the database this step just restored.

---

## 5. Apply the schema

A restored dump carries its own ledger, `zz.schema_migration`, and a migration is applied to it only
by the gateway's own runner, which applies what that ledger lacks. Never pipe `001_init.sql` into
it with `psql`: that re-creates what the dump already holds, and fails on it.

From a checkout with `npm install` done:

```bash
node scripts/rehearse.ts --dump ~/rehearsal/backup/zz-db-$STAMP.sql.gz
```

It restores the dump into a throwaway container of its own, lets the real migration runner apply
every pending file in `services/gateway/migrations/`, compares the result with the schema target and
reports what moved, ending `REHEARSAL OK` or with the lines that disagree. The database from step 4
stays as restored, for reading.

---

## 5a. The `.zz/` record layout — RETIRED

This step initialised `.zz/{blobs,commits}` on each owner store root on the new artifact volume, so
that the record store would stop refusing `STORE_UNAVAILABLE` and the first write to each document
could adopt it.

**It is retired, and there is nothing left for it to do.** The refusal, the module that enforced it
in `zz-core`'s `tenant-info`, and the whole artifact/search layer went in 0.86.0;
`.zz/{blobs,commits}` exists nowhere in this platform; and no service in `deploy/docker-compose.yml`
mounts an owner store, because there is no owner store — phase 6 moved every team's documents into
`zz.doc`, `zz.doc_revision` and `zz.doc_link`.

The script that did it is deleted.

**The rule it enforced outlives it, and is the part worth keeping.** A failed mount must never be
read as a tenant with no documents, because the next thing that happens to an empty tenant is that
something helpfully reconstructs them. In a store that is rows rather than files, that rule is
carried by `doc`'s non-null `initiative_id` and by the revision rows: a tenant with no rows is a
tenant the migration reported, never one the platform inferred.

---

## 6. The isolated database, and who reads it

```bash
export ZZ_REHEARSAL_DB_URL="postgres://zz:<password>@127.0.0.1:55432/zz_rehearsal"
```

What this may name, and what it may never name:

- The isolated copy produced by this document, and nothing else.
- **Never** the live cluster.
- **Never** a value inferred, copied or derived from `TEAM_DB_URL` or `PLATFORM_DB_URL`.

Nothing in this checkout consumes the URL. It is what an operator points a `psql` or a GUI client
at to read the restored copy; the migration rehearsal in step 5 starts its own container and
refuses to start with `TEAM_DB_URL` or `PLATFORM_DB_URL` in the environment.

---

## 7. Tear down

```bash
docker rm -f -v zz-rehearsal-db
docker network rm zz-rehearsal
```

`-v` removes the database's data volume with the container: the image declares one, and without
`-v` it is left behind where `docker ps` never shows it.

Keep the backup set. Do not delete the original set: the source deployment is still
the only place some of this exists.
