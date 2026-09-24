#!/usr/bin/env bash
# ZZ Stack backup — everything no restart brings back:
#
#   the `zz` schema   identity truth — principals, teams, PATs, events
#   <p>_zz-artifacts  every team's documents and knowledge
#   <p>_cred-data     the gateway's own data: events it could not write to the database
#   deploy/.env       this deployment's configuration and the database password
#
#   ./deploy/backup.sh            # write one dated set into $BACKUP_DIR
#   ./deploy/backup.sh --verify   # also prove the dump restores into a
#                                 # throwaway database, then drop it
#
# Cron (installed by deploy/install-backup-cron.sh):
#   17 3 * * *  /root/zz-parent/zz-stack/deploy/backup.sh >> /var/log/zz-backup.log 2>&1
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/zz-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The compose project is in deploy/.env, which compose reads and a shell does not.
#
# DELIBERATE: read from .env, as issue-first-pat.sh does, and every container is addressed
# through `docker compose exec` from this directory so compose resolves its own project. Only
# the volume names still need the project, because compose offers them no other way.
env_get() {
  [ -f "$HERE/.env" ] || return 0
  sed -n "s/^$1=//p" "$HERE/.env" | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
PROJECT="${PROJECT:-$(basename "$HERE")}"
PG_USER="${PG_USER:-$(env_get POSTGRES_USER)}"; PG_USER="${PG_USER:-zz}"
PG_DB="${PG_DB:-$(env_get POSTGRES_DB)}"; PG_DB="${PG_DB:-zz}"
ARTIFACT_VOLUME="${ARTIFACT_VOLUME:-${PROJECT}_zz-artifacts}"
CRED_VOLUME="${CRED_VOLUME:-${PROJECT}_cred-data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Every container is addressed as a SERVICE from here, so compose resolves the project.
cd "$HERE"

mkdir -p "$BACKUP_DIR"
umask 077

db_file="$BACKUP_DIR/zz-db-$STAMP.sql.gz"
art_file="$BACKUP_DIR/zz-artifacts-$STAMP.tar.gz"
cred_file="$BACKUP_DIR/zz-credentials-$STAMP.tar.gz"
conf_file="$BACKUP_DIR/zz-config-$STAMP.tar.gz"

# Every file this run writes, named once: the cleanup and the prune both walk this list, so a
# backup added above is covered by both by having been added.
FILES=("$db_file" "$art_file" "$cred_file" "$conf_file")

# A failed run must not leave a file that reads as a backup. `cmd > "$db_file"` creates the
# file before cmd runs, so a failure leaves today's date sorting newest in $BACKUP_DIR — the
# file "restore the latest backup" would find. Deleting a partial set makes the last good one
# the newest again.
ok=""
cleanup() {
  [ -n "$ok" ] && return 0
  for f in "${FILES[@]}"; do
    [ -e "$f" ] || continue
    rm -f "$f"
    echo "  removed partial $(basename "$f") — an incomplete run must not leave a file that reads as a backup"
  done
}
trap cleanup EXIT INT TERM

# deploy/.env makes the other three usable: it holds POSTGRES_PASSWORD and
# COMPOSE_PROJECT_NAME, is gitignored, and exists on this host only.
#
# DELIBERATE: it runs first. It reads three local files while every other step talks to
# docker, so the cheapest step is the one that fails on a broken host, while the cleanup trap
# has nothing to delete yet.
#
# The archive is as secret as .env: mode 600, and the closing note says so.
echo "[$(date -u +%FT%TZ)] backing up configuration and keys -> $conf_file"
[ -f "$HERE/.env" ] || { echo "FAIL: $HERE/.env does not exist — it carries this deployment's database password and compose project, and a restore without it is a dump nobody can open"; exit 1; }
conf_members=(".env")
for optional in Caddyfile docker-compose.yml; do
  [ -f "$HERE/$optional" ] && conf_members+=("$optional")
done
tar czf "$conf_file" -C "$HERE" "${conf_members[@]}"
chmod 600 "$conf_file"
# Read back, like every other archive here: a backup that was never read is a guess.
#
# DELIBERATE: the listing is captured before it is searched. `tar tzf | grep -q` exits at the
# first match, tar takes SIGPIPE, and `set -o pipefail` makes that the pipeline's status — so a
# match intermittently reads as missing. A here-string reads the whole listing.
conf_listing="$(tar tzf "$conf_file")" || { echo "FAIL: $(basename "$conf_file") does not list — the archive is corrupt or truncated"; exit 1; }
grep -qx '\(\./\)\?\.env' <<<"$conf_listing" || { echo "FAIL: $(basename "$conf_file") does not contain .env"; exit 1; }
echo "  $(basename "$conf_file"): ${#conf_members[@]} configuration file(s) read back"

echo "[$(date -u +%FT%TZ)] backing up database -> $db_file"
# --clean --if-exists so the dump restores over an existing database
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
  | gzip -9 > "$db_file"

# Counted before the tar as well as after, because the platform is running while this does;
# check_archive accepts anything between the two counts.
count_volume() {
  docker run --rm -v "$1":/data:ro alpine sh -c 'find /data -mindepth 1 | wc -l'
}

# DELIBERATE: ask whether the volume exists before mounting it. `docker run -v name:/data`
# creates a missing named volume, empty and silently, so a misnamed volume would archive as
# an empty fresh install every night.
require_volume() {
  docker volume inspect "$1" >/dev/null 2>&1 && return 0
  echo "FAIL: there is no docker volume named $1, and mounting one would CREATE it —"
  echo "  empty, silently, so this backup would archive nothing and report success."
  echo "  Volumes on this host:"
  docker volume ls --format '    {{.Name}}' || true
  echo "  The compose project resolved to '$PROJECT'. It is read from COMPOSE_PROJECT_NAME"
  echo "  in this shell, then from $HERE/.env — the file COMPOSE reads and a cron shell does"
  echo "  not — and finally from this directory's name. Set it there, or set ARTIFACT_VOLUME"
  echo "  and CRED_VOLUME by hand."
  exit 1
}
require_volume "$ARTIFACT_VOLUME"
require_volume "$CRED_VOLUME"

art_before=$(count_volume "$ARTIFACT_VOLUME")

echo "[$(date -u +%FT%TZ)] backing up artifacts volume -> $art_file"
docker run --rm -v "$ARTIFACT_VOLUME":/data:ro -v "$BACKUP_DIR":/backup alpine \
  tar czf "/backup/$(basename "$art_file")" -C /data .

cred_before=$(count_volume "$CRED_VOLUME")

echo "[$(date -u +%FT%TZ)] backing up credential volume -> $cred_file"
docker run --rm -v "$CRED_VOLUME":/data:ro -v "$BACKUP_DIR":/backup alpine \
  tar czf "/backup/$(basename "$cred_file")" -C /data .

# The umask above governs this shell only. Both archives are created inside a container with
# a umask of its own, so their mode is set explicitly.
chmod 600 "$art_file" "$cred_file"

# A backup that was never read is a guess.
db_size=$(stat -c %s "$db_file")
art_size=$(stat -c %s "$art_file")
cred_size=$(stat -c %s "$cred_file")
[ "$db_size" -gt 10000 ] || { echo "FAIL: database dump is only ${db_size}B"; exit 1; }

# Each archive is read back and matched against the volume it came from, entry for entry.
# Truncation and corruption fail; an empty volume passes and says it was empty — a real fresh
# install, because require_volume has already refused a name that is not a volume.
check_archive() {  # volume, file, count-before-the-tar — the order both callers pass them
  local listing entries after lo hi
  listing=$(tar tzf "$2") || {
    echo "FAIL: $(basename "$2") does not list — the archive is corrupt or truncated"; exit 1; }
  # grep -c returns 1 on a count of zero, which is the empty case rather than an error, and it
  # reads its whole input.
  entries=$(grep -cv '^\./\?$' <<<"$listing" || true)
  after=$(count_volume "$1")
  # Between the two counts, not equal to one: the archive is a snapshot taken while the platform
  # was writing. A broken archive is short by far more than a night's writes, and an unreadable
  # one fails to list at all.
  lo=$3; hi=$after
  [ "$lo" -le "$hi" ] || { lo=$after; hi=$3; }
  [ "${entries:-0}" -ge "$lo" ] && [ "${entries:-0}" -le "$hi" ] || {
    echo "FAIL: $(basename "$2") holds ${entries:-0} entries and volume $1 held $3 before the archive and $after after"; exit 1; }
  if [ "$hi" -eq 0 ]; then
    echo "  $(basename "$2"): volume $1 is empty — archived as empty, which is correct on a fresh install"
  elif [ "$3" -eq "$after" ]; then
    echo "  $(basename "$2"): $entries entries read back, matching the volume"
  else
    echo "  $(basename "$2"): $entries entries read back, and the volume went $3 -> $after while it was archived"
  fi
}
check_archive "$ARTIFACT_VOLUME" "$art_file" "$art_before"
check_archive "$CRED_VOLUME" "$cred_file" "$cred_before"

# One decompression, one pass, no early exit. `zcat | grep -q` per table exits at the first
# match, zcat takes SIGPIPE, and `set -o pipefail` reports a table that is present as missing.
present="$(zcat "$db_file" | sed -n 's/^COPY zz\.\([a-z_]*\) .*/\1/p' | sort -u)"
for t in principal team membership pat; do
  grep -qx "$t" <<<"$present" || { echo "FAIL: dump has no zz.$t data"; exit 1; }
done

if [ "${1:-}" = "--verify" ]; then
  echo "[$(date -u +%FT%TZ)] restore drill into zz_restore_check"
  docker compose exec -T postgres psql -U "$PG_USER" -d postgres -c 'drop database if exists zz_restore_check' >/dev/null
  docker compose exec -T postgres psql -U "$PG_USER" -d postgres -c 'create database zz_restore_check' >/dev/null
  zcat "$db_file" | docker compose exec -T postgres psql -U "$PG_USER" -d zz_restore_check >/dev/null 2>&1 || true
  people=$(docker compose exec -T postgres psql -U "$PG_USER" -d zz_restore_check -tAc \
    'select count(*) from zz.principal' 2>/dev/null || echo 0)
  docker compose exec -T postgres psql -U "$PG_USER" -d postgres -c 'drop database zz_restore_check' >/dev/null
  [ "$people" -gt 0 ] || { echo "FAIL: restore drill found no principals"; exit 1; }
  echo "restore drill OK — $people principals came back"
fi

# Prune exactly what this script writes: each pattern comes from the variable that named the
# file, with the stamp replaced by a glob, so a backup added above is pruned by having been
# added.
#
# Complete, and validated. Past this line the set is real and the cleanup trap must not touch
# it — a prune that fails is a full disk later, not a corrupt restore now.
ok=1
for kept in "${FILES[@]}"; do
  find "$BACKUP_DIR" -name "$(basename "${kept/$STAMP/*}")" -mtime "+$KEEP_DAYS" -delete
done
conf_size=$(stat -c %s "$conf_file")
echo "[$(date -u +%FT%TZ)] done. db=$((db_size/1024))KB artifacts=$((art_size/1024))KB credentials=$((cred_size/1024))KB config=$((conf_size/1024))KB, keeping ${KEEP_DAYS}d"
echo "NOTE: $BACKUP_DIR is on the same host as the data it protects — copy it off-host to survive disk loss."
echo "NOTE: zz-config-*.tar.gz holds deploy/.env, which carries the database password. Same treatment."
echo "NOTE: ./deploy/backup-manifest.sh turns one dated set into the manifest a restore rehearsal validates before it touches a byte."
