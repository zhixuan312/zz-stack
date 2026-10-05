#!/usr/bin/env bash
# Reset one corpus: RENAME its initiatives, so the next run answers each requirement instead of
# resuming the previous version's answer. A step that finds an existing initiative resumes it, so a
# second run against an unreset corpus reports the first run's answers and is not a second
# measurement — which is the one thing this script exists to prevent.
#
# What it used to do, and why it could not: it moved initiative FOLDERS out of
# `/artifacts/teams/<team>`, and the store moved into the database — an initiative is a
# `zz.initiative` row, its documents are `zz.doc` and `zz.doc_revision` — so the move found nothing
# and printed "the store is already clean for this corpus" on every run.
#
# A slug is freed and everything else is kept. `zz.initiative.slug` is unique per team and that name
# is the only thing the next run looks for; the rows stay, under a suffixed name, so the previous
# version's answers remain the evidence they already are for the scores that name them. Nothing is
# deleted and nothing needs to be: a run reaches its initiative by id.
set -euo pipefail

# DELIBERATE: the body is one brace group, so bash reads it whole before running. It otherwise
# reads by byte offset, and editing the file mid-run resumes the shell mid-line.
{
HOST="${ZZ_SSH_HOST:?set it to the host this should reset}"
# Through compose, by service name: a container name carries the compose project prefix, which is
# set per host in deploy/.env. `postgres`, not `zz-core`: this renames a ROW, and the service that
# holds the database is the one that can.
COMPOSE="${ZZ_COMPOSE_DIR:-/root/zz-parent/zz-stack/deploy}"
SVC="${ZZ_POSTGRES_SERVICE:-postgres}"
PG_USER="${PG_USER:-${POSTGRES_USER:-zz}}"
PG_DB="${PG_DB:-${POSTGRES_DB:-zz}}"
IN_DB="cd $COMPOSE && docker compose exec -T $SVC psql -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1"
TEAM=""; PREFIX=""; DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --team) TEAM="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
[ -n "$TEAM" ] && [ -n "$PREFIX" ] || {
  echo "usage: $0 --team <slug> --prefix <initiative-prefix> [--dry-run]" >&2; exit 2; }

# DELIBERATE: `:'team'` is a psql VARIABLE, quoted by psql itself; the values never become part of
# the statement this shell writes. A slug interpolated into a SQL literal is a slug that can carry
# a statement, and the corpus this is pointed at is chosen by whoever runs it.
if [ -n "$DRY" ]; then
  "$IN_DB" -v team="$TEAM" -v prefix="$PREFIX" -c '
    select i.slug, i.slug || '"'"'--reset-YYYYMMDDHHMMSS'"'"' as would_become
      from zz.initiative i
      join zz.team t on t.id = i.team_id
     where t.slug = :'"'"'team'"'"' and i.slug like :'"'"'prefix'"'"' || '"'"'%'"'"'
     order by i.slug'
  echo "dry run: nothing renamed."
else
  # The suffix carries the second: two resets in one second would collide on the unique
  # (team_id, slug), and a corpus reset twice is left doubly suffixed rather than merged.
  "$IN_DB" -v team="$TEAM" -v prefix="$PREFIX" -v suffix="--reset-$(date -u +%Y%m%d%H%M%S)" -c '
    update zz.initiative i
       set slug = i.slug || :'"'"'suffix'"'"'
      from zz.team t
     where t.id = i.team_id and t.slug = :'"'"'team'"'"' and i.slug like :'"'"'prefix'"'"' || '"'"'%'"'"'
     returning i.slug'
  echo "renamed. The next run of this corpus starts from nothing; every row it settled is kept."
fi
}
