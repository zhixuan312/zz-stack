#!/usr/bin/env bash
# Put the evaluation team's store back to empty for a corpus, so the NEXT version answers the
# requirement instead of resuming the previous version's answer.
#
#   ./testing/reset-store.sh --team smoke-0828 --prefix 2026-08-3
#   ./testing/reset-store.sh --team smoke-0828 --prefix 2026-08-3 --dry-run
#
# WHY THIS HAS TO EXIST. sm-intent names its folder from the date and the title, and both
# zz-backbone and sm-intent instruct a step that finds an existing folder to RESUME it rather than
# create a duplicate — which is correct behaviour and the reason a second run of one corpus is not
# a second measurement. Eight held-out requirements at sm-intent 1.1 produced five documents;
# three resumed 1.0's initiatives, and the five that wrote could read 1.0's answer while writing.
# The delta that came out of that (0.000) measured nothing. See docs/findings/H9.md.
#
# IT ARCHIVES, IT DOES NOT DELETE. An earlier reset in this repository deleted zz.event and nine
# rounds erased each other's evidence. The documents a run produced ARE the evidence for that
# run's scores, and a reset that destroys them makes every past number unauditable. They move to
# /artifacts/archive/<team>/<stamp>/ and stay there.
#
# THEN REINDEX, because zz.doc and zz.decision are built from the filesystem and moving a folder
# out from under them leaves rows pointing at documents that no longer exist. reindex_knowledge
# is what reconciles the two.
set -euo pipefail

# READ WHOLE BEFORE RUN. bash reads a script incrementally by byte offset, so editing one while it
# runs shifts the text under the running shell and it resumes mid-line.
{
HOST="${ZZ_SSH_HOST:-root@100.67.161.15}"
# THROUGH COMPOSE, BY SERVICE NAME. `docker exec` needs a container name, and a container's name
# carries the compose project prefix — which is set per host in deploy/.env, so a name spelled
# here is correct on at most one deployment and silently wrong on the next.
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
echo "  now call reindex_knowledge so zz.doc and zz.decision stop pointing at documents that moved:"
echo "    the eval harness does this on its next run; do it by hand if you are not about to run one"
}
