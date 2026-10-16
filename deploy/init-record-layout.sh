#!/usr/bin/env bash
# Initialise one owner store's `.zz/` record layout, so a write to it can be adopted.
#
#   ./deploy/init-record-layout.sh /path/to/one/owner/store
#
# RETIRED: the file store and its `.zz/` layout are gone (0.86.0) and nothing in the platform
# reads either, so this script has no step left. It stays in the tree as the script that did the
# job, because the runbooks that describe the step still point at it — both of them say it is
# retired (`deploy/ACTIVATION.md`'s section 4, `deploy/RESTORE-AND-CUTOVER.md`).
#
# Everything below is what it did while the store existed. `record.ts`'s `preflightRefusal`
# refused `STORE_UNAVAILABLE` when `.zz/`, `.zz/blobs` or `.zz/commits` was absent — a missing
# mount was never read as an empty tenant — and nothing in the platform created that layout.
#
# DELIBERATE: one explicit path, never a search. It takes exactly one existing directory and
# acts on it alone: no volume walk, no default, no recursive mode, so what it can touch is what
# an operator typed. RESTORE-AND-CUTOVER.md's step 5a showed the loop.
#
# Idempotent, and it completes a half-initialised layout rather than refusing it: a store with
# some but not all three directories refused every write while looking initialised.
set -euo pipefail

ROOT="${1:-}"
if [ -z "$ROOT" ] || [ "$#" -ne 1 ]; then
  echo "usage: $0 <owner-store-root>" >&2
  echo "  Exactly one directory, which must already exist. This script never searches." >&2
  exit 2
fi
[ -d "$ROOT" ] || {
  echo "FAIL: $ROOT is not an existing directory." >&2
  echo "  This script will not create the store root itself — only its .zz/ layout inside an" >&2
  echo "  existing one. A typo that creates a whole new tree somewhere is the failure that" >&2
  echo "  refusing here prevents." >&2
  exit 1
}

# The three paths record.ts checked, spelled the way it spelled them (STORE_DIR = ".zz",
# BLOBS_SUBDIR = "blobs", COMMITS_SUBDIR = "commits").
zz="$ROOT/.zz"
blobs="$zz/blobs"
commits="$zz/commits"

present=0
for d in "$zz" "$blobs" "$commits"; do [ -d "$d" ] && present=$((present + 1)); done

case "$present" in
  3) echo "already complete: $ROOT has .zz/blobs and .zz/commits — nothing to do"; exit 0 ;;
  0) echo "initialising: $ROOT has no .zz/ layout" ;;
  *) echo "REPAIRING: $ROOT has a PARTIAL .zz/ layout ($present of 3 directories present)."
     echo "  A partial layout refuses every write exactly as a missing one does, while looking"
     echo "  initialised to anybody who lists the directory. Completing it." ;;
esac

mkdir -p "$blobs" "$commits"

# Verify the directories exist rather than trusting mkdir's status.
for d in "$zz" "$blobs" "$commits"; do
  [ -d "$d" ] || { echo "FAIL: $d was not created" >&2; exit 1; }
done
echo "ready: $ROOT now carries .zz/blobs and .zz/commits"
echo "NOTE: this creates EMPTY directories and no record. The first write to each document is"
echo "  what adopts it. Nothing here writes, moves or rewrites a single document byte."
