#!/usr/bin/env bash
# ZZ Stack backup — the platform database and the teams' documents.
#
# Three things, because losing any one of them loses something no restart brings back:
#
#   the `zz` schema   identity truth — principals, teams, PATs, flow installs, grants, events
#   <p>_zz-artifacts  every team's documents and knowledge
#   <p>_cred-data     each person's own building-block API keys
#
# THERE WAS A FOURTH — LibreChat's Mongo — and removing it is why this header changed. When
# that front end was removed on 2026-09-10 its dump step stayed, and `docker compose exec -T
# mongodb` against a service that is not running failed AFTER the three real backups had been
# written. The cleanup below then did exactly what it says: an incomplete run leaves no file
# that reads as a backup, so it deleted all three. Every nightly run since backed the platform
# up correctly and threw it away, and the only trace was a log nobody reads. A dead step in a
# backup script is not waste, it is the absence of backups.
#
# The third was missing for as long as this script existed. It is the one nobody can
# reconstruct: the platform can be reinstalled and documents can be re-indexed, but a
# person's key to another team's real platform exists only in that volume and in whatever
# they wrote it down on. Restoring the database and the documents while losing it would
# bring the platform back with every block quietly unauthenticated.
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

# THE COMPOSE PROJECT IS IN deploy/.env, WHICH COMPOSE READS AND A SHELL DOES NOT.
#
# This is the second time the project name has been got wrong here, and the second was worse
# than the first. It once hard-coded "zz-" and the comment recording the fix said that
# "silently backed up nothing on any host whose project differed". The fix derived the name
# from the deploy directory instead — which is what compose does ONLY when nothing sets
# COMPOSE_PROJECT_NAME. Production sets it, in deploy/.env: the project is `zz` and the
# directory is `deploy`.
#
# So from 2026-08-26 the nightly job ran `docker exec deploy-postgres-1`, got "No such
# container", and `set -e` stopped it after the redirect had already created the file. Four
# nights of 20-byte dumps, no artifacts archive and no credential archive, into a log nobody
# reads. The last good set was 2026-08-25.
#
# Two changes, and the second is what makes this stop recurring: the project is read from
# .env the way issue-first-pat.sh and smoke-env.sh already read that file, AND the containers
# are addressed through `docker compose exec` from this directory, which asks compose to
# resolve its own project instead of rebuilding its naming convention here. Only the VOLUME
# names still need the project, because compose does not offer them any other way.
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

# EVERY FILE THIS RUN WRITES, NAMED ONCE. Two things walk this list — the cleanup below and
# the prune at the end — and a fifth backup added above is covered by both by having been
# added, rather than by somebody remembering two more lines.
FILES=("$db_file" "$art_file" "$cred_file")

# A FAILED RUN MUST NOT LEAVE A FILE THAT READS AS A BACKUP.
#
# `cmd > "$db_file"` creates the file before cmd runs, and the container tars write straight
# to their final name too — so any failure from here on leaves files stamped with today's
# date, in $BACKUP_DIR, sorting NEWEST. That is not hypothetical: the header above records
# four nights in August 2026 of 20-byte dumps left behind by exactly this path, and those
# files were what "restore the latest backup" would have found.
#
# The failure is already loud in the log. What was missing is that the DIRECTORY still looked
# right, and the directory is what somebody reads at 3am while the platform is down. Deleting
# a partial set is what makes the last good one the newest again.
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

echo "[$(date -u +%FT%TZ)] backing up database -> $db_file"
# --clean --if-exists so the dump restores over an existing database
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
  | gzip -9 > "$db_file"

# Counted BEFORE the tar as well as after, because the platform is running while this does.
#
# check_archive compares the archive's entry count against the volume's, and both used to be
# taken after the fact — so any write landing between the tar and the count failed the whole
# backup with "holds N entries and volume holds M", on an archive that is a correct snapshot.
# A team's store is a git repository this release, so a single document write now creates
# several objects and a ref update where it used to create one file: the window is the same
# and what passes through it is several times larger. A nightly job that cries wolf is one
# people learn to ignore, which is the opposite of what a backup check is for.
count_volume() {
  docker run --rm -v "$1":/data:ro alpine sh -c 'find /data -mindepth 1 | wc -l'
}

# ASK WHETHER THE VOLUME EXISTS BEFORE MOUNTING IT, because mounting it is what makes it
# exist. `docker run -v name:/data` CREATES a named volume that is not there, empty, and
# says nothing — so a misnamed volume gives a count of 0, an archive of 0, a read-back of 0,
# and check_archive's own "archived as empty, which is correct on a fresh install". Every
# night, reporting success, having captured nothing.
#
# That is not hypothetical here. This script once hard-coded the `zz-` prefix and "silently
# backed up nothing on any host whose project differed"; PROJECT is derived now, and the day
# that derivation is wrong — a renamed directory, COMPOSE_PROJECT_NAME exported for a shell
# and not for cron — the database half fails loudly on a missing container and the VOLUME
# half goes quiet again. The comment on check_archive used to call a misnamed volume
# "indistinguishable from a fresh install by any means available here". It is distinguishable
# by exactly one question, and it has to be asked before anything mounts it.
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

# The umask above governs THIS shell. Both archives are created inside a container with a
# umask of its own, which is why the artifacts archive sat world-readable next to a
# database dump that was not — every team's documents, mode 644, in the same directory.
chmod 600 "$art_file" "$cred_file"

# A backup that was never read is a guess.
db_size=$(stat -c %s "$db_file")
art_size=$(stat -c %s "$art_file")
cred_size=$(stat -c %s "$cred_file")
[ "$db_size" -gt 10000 ] || { echo "FAIL: database dump is only ${db_size}B"; exit 1; }

# Each archive is read back and matched against the volume it came from, entry for entry.
#
# It used to be a size floor — artifacts over 1000 bytes, credentials over 100 — and that
# was wrong in both directions. A truncated archive stays far above the floor, and gzip
# only reveals truncation at the end of a stream nothing was reading, so a corrupt backup
# passed. Meanwhile an EMPTY volume tars to 87 bytes, which fails both floors: on a fresh
# install, where no team has written a document and nobody has stored a key yet, the
# nightly job aborted every night until somebody happened to create something. The floor's
# own comment called an empty credential store legitimate and then refused it.
#
# Counting against the source is honest about what can and cannot be detected. Truncation
# and corruption fail. An empty volume passes and says it was empty — and it really is a
# fresh install, because require_volume above has already refused a name that is not a
# volume. That sentence used to read "a misnamed volume ... is indistinguishable from a
# fresh install by any means available here", which was the one thing in this file that was
# not true: `docker volume inspect` distinguishes them, and had to be asked before the first
# mount, since mounting is what creates one.
check_archive() {  # volume, file, count-before-the-tar — the order both callers pass them
  local listing entries after lo hi
  listing=$(tar tzf "$2") || {
    echo "FAIL: $(basename "$2") does not list — the archive is corrupt or truncated"; exit 1; }
  # grep -c returns 1 on a count of zero, which is the empty case rather than an error, and
  # it reads its whole input — unlike the grep -q that lost the SIGPIPE race below.
  entries=$(grep -cv '^\./\?$' <<<"$listing" || true)
  after=$(count_volume "$1")
  # BETWEEN the two counts, not equal to one of them. The archive is a snapshot taken while
  # the platform was writing, so it legitimately holds anything from the count before the tar
  # to the count after it. Truncation and corruption are still caught: a broken archive is
  # short by far more than a night's writes, and an unreadable one fails to list at all.
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

# One decompression, one pass, no early exit.
#
# This was `zcat "$db_file" | grep -q "COPY zz.$t "` once per table. grep -q exits the
# instant it matches, zcat then takes SIGPIPE and returns 141, and `set -o pipefail` makes
# that the pipeline's status — so a check that FOUND the table reported it missing, whenever
# zcat happened to still be writing. It is a race, so it passed for weeks and then, on
# 2026-08-23, aborted a live backup with "FAIL: dump has no zz.membership data" against a
# dump that contains zz.membership. Reading the stream to the end cannot lose that race.
present="$(zcat "$db_file" | sed -n 's/^COPY zz\.\([a-z_]*\) .*/\1/p' | sort -u)"
for t in principal team membership pat flow_install; do
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

# Prune exactly what this script writes, derived from the names it wrote.
#
# This was `-name 'zz-*.gz'`, which silently did not match a dump whose name did not start
# with `zz-` — so that one accumulated until the disk did something about it. Each pattern
# now comes from the variable that named the file, with the stamp replaced by a glob, so a
# fourth backup added above is pruned by having been added and not by anybody remembering
# this line.
# Complete, and validated. Past this line the set is real and the cleanup trap must not
# touch it — a prune that fails is a full disk later, not a corrupt restore now.
ok=1
for kept in "${FILES[@]}"; do
  find "$BACKUP_DIR" -name "$(basename "${kept/$STAMP/*}")" -mtime "+$KEEP_DAYS" -delete
done
echo "[$(date -u +%FT%TZ)] done. db=$((db_size/1024))KB artifacts=$((art_size/1024))KB credentials=$((cred_size/1024))KB, keeping ${KEEP_DAYS}d"
echo "NOTE: $BACKUP_DIR is on the same host as the data it protects — copy it off-host to survive disk loss."
echo "NOTE: zz-credentials-*.tar.gz holds each person's building-block API keys in plaintext, exactly as the volume does. Treat a copy of it as you would the keys themselves."
