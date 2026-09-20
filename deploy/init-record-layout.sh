#!/usr/bin/env bash
# Initialise one owner store's `.zz/` record layout, so a write to it can be adopted.
#
#   ./deploy/init-record-layout.sh /path/to/one/owner/store
#
# WHAT THIS IS FOR. `services/zz-core/src/tenant-info/record.ts:271` refuses `STORE_UNAVAILABLE`
# when `.zz/`, `.zz/blobs` or `.zz/commits` is absent, in its own words: "a missing mount is
# refused, never read as an empty tenant". That refusal is correct and deliberate — a store
# whose volume failed to mount must never be read as a tenant who has no documents, because the
# next thing that happens to an empty tenant is that something helpfully reconstructs them.
#
# The consequence is that nothing in the platform ever creates that layout. `record.ts` refuses;
# I-20's adoption path turns a document with no commit into one that has a commit, but it runs
# INSIDE the kernel, behind that same refusal. So a store with no `.zz/` cannot be adopted, and
# the live owner stores have no `.zz/`. Somebody has to create it once, deliberately, and that
# is this script and nothing else.
#
# ONE EXPLICIT PATH, NEVER A SEARCH. This script takes exactly one directory, which must
# already exist, and acts on that directory alone. It does not walk a volume, does not discover
# stores, has no default and has no recursive mode. That is the whole safety design: the set of
# things it can touch is the set of paths an operator typed. `deploy/RESTORE-AND-CUTOVER.md`
# step 5a shows the loop, where the operator can see which stores are in it before it runs.
#
# IDEMPOTENT, AND IT REPAIRS RATHER THAN REFUSES. Run it twice and the second run does nothing.
# Run it on a store left half-initialised by an interrupted attempt — `.zz/` present but
# `.zz/commits` missing — and it completes the layout. That partial state is not hypothetical
# and it is not harmless: `preflightRefusal` requires all THREE directories, so a store with
# `.zz/` and `.zz/blobs` but no `.zz/commits` refuses every write exactly as a store with
# nothing does, while looking initialised to anybody who lists it.
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

# Verify what was asked for, rather than trusting that mkdir returned 0. A store this script
# reported as ready and which still refuses writes is the one outcome worth a second syscall.
for d in "$zz" "$blobs" "$commits"; do
  [ -d "$d" ] || { echo "FAIL: $d was not created" >&2; exit 1; }
done
echo "ready: $ROOT now carries .zz/blobs and .zz/commits"
echo "NOTE: this creates EMPTY directories and no record. The first write to each document is"
echo "  what adopts it (I-20). Nothing here writes, moves or rewrites a single document byte."
