#!/usr/bin/env bash
# Clear the evaluation team's store of one corpus's initiatives, so the next version answers
# each requirement instead of resuming the previous version's answer.
#
#   ./testing/reset-store.sh --team <slug> --prefix 2026-08-3
#   ./testing/reset-store.sh --team <slug> --prefix 2026-08-3 --dry-run
#
# A step that finds an existing initiative folder resumes it rather than creating a duplicate,
# so a second run of one corpus against an unreset store is not a second measurement.
#
# DELIBERATE: it archives and never deletes. The documents a run produced are the evidence for
# its scores; they move to /artifacts/archive/<team>/<stamp>/ and stay there.
#
# Afterwards call knowledge_reindex: zz.doc and zz.decision are built from the filesystem, and
# moving a folder leaves rows pointing at documents that no longer exist.
set -euo pipefail

# DELIBERATE: the body is one brace group, so bash reads it whole before running. It otherwise
# reads by byte offset, and editing the file mid-run resumes the shell mid-line.
{
HOST="${ZZ_SSH_HOST:?set it to the host this should reset}"
# Through compose, by service name: a container name carries the compose project prefix, which
# is set per host in deploy/.env.
COMPOSE="${ZZ_COMPOSE_DIR:-/root/zz-parent/zz-stack/deploy}"
SVC="${ZZ_CORE_SERVICE:-zz-core}"
IN_CORE="cd $COMPOSE && docker compose exec -T $SVC"
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

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LIST="$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST" \
  "$IN_CORE sh -c 'ls /artifacts/teams/$TEAM 2>/dev/null'" | grep "^$PREFIX" || true)"

if [ -z "$LIST" ]; then
  echo "  nothing in $TEAM matches $PREFIX — the store is already clean for this corpus"
  exit 0
fi
N="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
echo "  $N initiative(s) in $TEAM matching $PREFIX"
printf '%s\n' "$LIST" | sed 's/^/    /' | head -6
[ "$N" -gt 6 ] && echo "    … and $((N - 6)) more"

if [ -n "$DRY" ]; then
  echo "  --dry-run: nothing moved"
  exit 0
fi

ssh -o BatchMode=yes -o ConnectTimeout=60 "$HOST" \
  "$IN_CORE sh -c 'mkdir -p /artifacts/archive/$TEAM/$STAMP && cd /artifacts/teams/$TEAM && for d in $PREFIX*; do [ -e \"\$d\" ] && mv \"\$d\" /artifacts/archive/$TEAM/$STAMP/; done; ls /artifacts/archive/$TEAM/$STAMP | wc -l'"

echo "  archived to /artifacts/archive/$TEAM/$STAMP — nothing was deleted"
echo "  now call knowledge_reindex so zz.doc and zz.decision stop pointing at documents that moved"
}
