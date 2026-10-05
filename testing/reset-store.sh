#!/usr/bin/env bash
# REFUSES. This cleared one corpus's initiatives so the next version answers each requirement
# instead of resuming the previous version's answer — a step that finds an existing initiative
# resumes it, so a second run against an unreset store is not a second measurement.
#
# It did that by moving initiative folders out of `/artifacts/teams/<team>`, and the store moved
# into the database: an initiative is a `zz.initiative` row, its documents are `zz.doc` and
# `zz.doc_revision`. Nothing here has anything to move, so it reported every corpus clean without
# resetting one. It says so and exits 2 until the reset is written against the database.
#
# Not deleted: the job is still wanted. See the body for what doing it means.
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
# REFUSED, not attempted. This read `/artifacts/teams/<team>` and moved the matching initiative
# folders into `/artifacts/archive/`. The volume that held them is retired — a document, its
# revisions and its citations are `zz.doc`, `zz.doc_revision` and `zz.doc_link` rows, and zz-core
# is given no volume at all — so the `ls` found nothing, the script printed "the store is already
# clean for this corpus", and exited 0 on every run. A corpus nobody reset is a second
# measurement that resumed the first, which is the one thing this script exists to prevent, and
# the archive it did write landed in the container's ephemeral layer.
#
# Left refusing rather than deleted: what it does is still wanted, and the way to do it is a
# decision. Resetting a corpus now means making its initiative slugs available again — renaming
# them keeps every row and frees the name, where deleting them would take the evidence the scores
# rest on. Nothing writes it yet; a file-based archive has nowhere to live, by design.
{
echo "REFUSED — this script resets a store that no longer exists." >&2
echo "  It archived initiative FOLDERS under /artifacts/teams/<team>, and the store moved into" >&2
echo "  the database: an initiative is a zz.initiative row, its documents are zz.doc and" >&2
echo "  zz.doc_revision. Nothing here has anything to move, so it would report the corpus clean" >&2
echo "  without resetting it — and a corpus that is not reset measures the previous run's" >&2
echo "  answers. Doing it properly means renaming the corpus's initiative slugs, which keeps" >&2
echo "  every row and frees the names; that is not written yet." >&2
exit 2
}
