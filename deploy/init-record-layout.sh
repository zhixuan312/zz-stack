#!/usr/bin/env bash
# Initialise one owner store's `.zz/` record layout, so a write to it can be adopted.
#
#   ./deploy/init-record-layout.sh /path/to/one/owner/store
#
# `record.ts`'s `preflightRefusal` refuses `STORE_UNAVAILABLE` when `.zz/`, `.zz/blobs` or
# `.zz/commits` is absent — a missing mount is never read as an empty tenant — and nothing in the
# platform creates that layout. This script is the one thing that does.
#
# DELIBERATE: one explicit path, never a search. It takes exactly one existing directory and
# acts on it alone: no volume walk, no default, no recursive mode, so what it can touch is what
# an operator typed. RESTORE-AND-CUTOVER.md step 5a shows the loop.
#
# Idempotent, and it completes a half-initialised layout rather than refusing it: a store with
# some but not all three directories refuses every write while looking initialised.
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

# The three paths record.ts checks, spelled the way record.ts spells them (STORE_DIR = ".zz",
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
