# Restore and cutover rehearsal

How an operator stands up an isolated PostgreSQL 17 copy of this platform and restores a protected
backup into it, so a cutover can be rehearsed against real data before it is performed.

This is a **rehearsal** procedure. It never switches production. `deploy/ACTIVATION.md` is the
switch, and it says in its own preamble that nothing authorises executing it.

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
zz-credentials-<stamp>.tar.gz   the gateway's own data: events it could not write to the database
zz-config-<stamp>.tar.gz        deploy/.env, Caddyfile and docker-compose.yml
```

Copy one complete set — all three files, same stamp — to the rehearsal host:

```bash
STAMP=20260927T085353Z            # pick a set that exists
mkdir -p ~/rehearsal/backup
scp root@<production-host>:/root/zz-backups/zz-*-$STAMP.* ~/rehearsal/backup/
```

Copy, never move. The original set stays where it is.

> `zz-credentials-*.tar.gz` holds API keys in plaintext and `zz-config-*.tar.gz` holds the
> database password. Both are mode 600 on the source. Keep them that way, and do not put
> either on shared storage.

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
`zz-store-archive-<stamp>.tar.gz`, written once by `scripts/retire-file-store.ts` when the store
was removed. It is the last copy of the store's files AS FILES, `deploy/backup.sh` is given an
explicit exemption from pruning it, and it is the copy most worth carrying off the host. A
rehearsal does not need it.

---

## 2. Build the manifest

```bash
cd <checkout>/zz-stack
./deploy/backup-manifest.sh ~/rehearsal/backup $STAMP
```

It writes `zz-backup-manifest-<stamp>.json` beside the set, listing the three components `backup.sh`
writes — the database, the credentials volume and the configuration files — each with a locator and
the SHA-256 of the actual file.

It refuses, rather than writing a manifest, if any of the three is missing. An incomplete set is not
a backup, and a manifest over two of them would describe a restore that leaves something behind,
which is the whole thing the rehearsal exists to refuse.

Each refusal is a real finding about the backup. None of them is a problem with the script.

---

## 3. Stand up the isolated PostgreSQL 17 database

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

`deploy/postgres/versions.lock.json` carries the pins for this image; read the lock file rather
than any prose about it if the two ever disagree.

---

## 4. Restore

```bash
cd ~/rehearsal/backup
gzip -dc zz-db-$STAMP.sql.gz | docker exec -i zz-rehearsal-db psql -U zz -d zz_rehearsal
```

**Logical restore into a new cluster — never mount an older major version's data directory into a
newer one.** The dump is `pg_dump --clean --if-exists`, so it restores over an empty database.
Treat any error as fatal: a partial restore that looks finished is the failure this whole rehearsal
exists to find.

**There is no second restore.** This step used to extract the artifacts archive onto a separate new
volume beside the database. The deployment has no artifact volume any more — no service in
`deploy/docker-compose.yml` mounts one — and the documents the archive held are rows in the database
this step just restored.

---

## 5. Apply the schema

```bash
docker exec -i zz-rehearsal-db psql -U zz -d zz_rehearsal \
  < <checkout>/zz-stack/services/gateway/migrations/001_init.sql
```

`001_init.sql` is every migration its `-- absorbs:` lines name, squashed into one file. Apply every
other file in `services/gateway/migrations/` after it, in filename order.

**The line above is for a DATABASE THAT HAS NO LEDGER, and a restored dump has one.** The gateway's
runner records each file it applies in `zz.schema_migration` by name and skips what that table
already lists, so piping a restore's own ledger back through the platform leaves `001_init.sql`
unapplied wherever the dump already carries its row — which every production dump does. The schema
still ends up where it should: `001_init.sql` is every migration its `-- absorbs:` lines name, so a
deployment that ran them has the schema this head reaches, and the ledger's own rows are the record
of that. What the paragraph above is for is the case the commands beside it describe — a new cluster
with no ledger, where `001_init.sql` is what builds the whole schema in one file. Read the ledger
back and compare it against the `-- absorbs:` list before deciding which case you are in.

Just after its header come `create extension if not exists` lines for `citext`, `pg_trgm` and the
rest. Applied through `psql` as above those run unconditionally — the `requires-extension:`
directives in its header are read by the gateway's own migration runner
(`services/gateway/src/db.ts`), which defers the file on a cluster that cannot supply them; piping
it straight into `psql` bypasses that and fails outright.

**Read the applied head back and compare it against the highest-numbered file in
`services/gateway/migrations/`.** A rehearsal that stops short of the tree's head has rehearsed a
schema nobody is going to deploy.

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

`deploy/init-record-layout.sh` is kept in the tree as the script that did it. Nothing in this
procedure calls it, and no deployment target needs it.

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

This used to be `ZZ_TENANT_INFO_ISOLATED_DB_URL`, and it used to unblock a set of verification
suites. **The `tenant-info` CLI and its corpora went with the artifact/search layer in 0.86.0**, so
nothing in this checkout consumes the URL any more. It is what an operator points a `psql` or a GUI
client at to read the restored copy; the rehearsal that runs automatically is
`node scripts/rehearse.ts --dump <zz-db-*.sql.gz>` (`--artifacts <archive>` as well, for a set old
enough to carry one), which starts its own container and refuses to be handed a URL.

---

## 7. The cutover rehearsal

The steps are `deploy/ACTIVATION.md`'s twelve, and they are executed by an operator, not by a suite.
What an operator does here is judge the record they made while executing them, and then check the
one fact a record cannot be trusted for: that the writes accepted after the resume are really there.

Write your observations to a JSON file as you go:

```bash
export ZZ_CUTOVER_OBSERVATIONS=~/rehearsal/cutover-observations.json
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
    "platform_snapshot_boundary": "<pg_current_wal_lsn() at the freeze>"
  },
  "matched_unit": {
    "old_unit": {
      "app_image_digest": "sha256:...",
      "database_identity": "zz-rehearsal-source",
      "read_only": true
    },
    "new_unit": {
      "app_image_digest": "sha256:...",
      "database_identity": "zz-rehearsal-db",
      "postgres_major": 17,
      "data_directory_reused": false
    },
    "outbound_integrations_disabled": true
  },
  "forward_recovery": {
    "strategy": "forward_recovery",
    "target_postgres_major": 17,
    "resume_boundary_at": "<ISO timestamp when you resumed writes>",
    "post_resume_write_ref": "<zz.event.id of the first accepted write after resume>",
    "recovered_write_refs": ["<...>"],
    "platform_db_changes_preserved": true
  }
}
```

> **Two fields are gone from this record.** `drain.file_commit_watermark` was the last commit of each
> team's store repository, and `forward_recovery.new_file_commits` / `recovered_file_commits` were
> the commits a recovery replayed. There are no store repositories: the documents are rows, and
> `platform_snapshot_boundary` plus `platform_db_changes_preserved` are the whole of that claim now.
> A record that still carries them is recording something this platform does not have.

Filling the two fields that matter:

```bash
# the freeze boundary
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc 'select pg_current_wal_lsn()'

# the first accepted write after you resume — inject it deliberately, then read it back
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc \
  'select id from zz.event order by id desc limit 1'

# after forward recovery, every write that came back
docker exec zz-rehearsal-db psql -U zz -d zz_rehearsal -tAc \
  "select id from zz.event where id > <boundary id> order by id"
```

`post_resume_write_ref` is a **`zz.event.id`**. That is the identity one accepted write actually has
in this schema — every door call, every document write and every close records one — and it is what
"it survived" can be checked against rather than taken on trust. The `zz.artifact_event` table this
document used to read it from went with the artifact/search layer in 0.86.0.

---

## 8. Tear down

```bash
docker rm -f zz-rehearsal-db
docker network rm zz-rehearsal
```

Keep the backup set and the manifest. Do not delete the original set: the source deployment is still
the only place some of this exists.
