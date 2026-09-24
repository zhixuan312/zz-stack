#!/usr/bin/env bash
# Turn one completed backup set into the manifest a restore rehearsal validates before it
# touches a byte — and produce the one component `backup.sh` cannot.
#
#   ./deploy/backup-manifest.sh /path/to/off-host/copy 20260920T031700Z
#
# It writes `zz-backup-manifest-<stamp>.json` beside the set, listing the five component kinds
# `validateBackupManifest` (testing/tenant-info/deployment.ts) requires, each with a locator
# and the SHA-256 of the actual file. `testing/tenant-info/deployment-cutover.ts`'s `restore`
# case reads that manifest, re-hashes every file it names, and only then looks at the restored
# database.
#
# DELIBERATE: not part of backup.sh. backup.sh is the nightly cron job, and a failed step there
# can cost the night's backup; the git bundles are the most complex step here and only a
# rehearsal needs them. So this runs on demand, against a copy, and its failure destroys
# nothing.
#
# The `git` component: each team's store is a git repository (persist.ts `commitStore` inits one
# on the first write) inside the artifacts volume, so the artifacts tar already holds the `.git`
# directories. `git bundle --all` is different: git verifies and packs the reachable history,
# so it fails on a repository the tar caught mid-write, and it yields a portable history export
# that clones with nothing of ours installed.
set -euo pipefail

SET_DIR="${1:-}"
STAMP="${2:-}"
if [ -z "$SET_DIR" ] || [ -z "$STAMP" ]; then
  echo "usage: $0 <directory holding one backup set> <stamp, e.g. 20260920T031700Z>" >&2
  exit 2
fi
[ -d "$SET_DIR" ] || { echo "FAIL: $SET_DIR is not a directory" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

env_get() {
  [ -f "$HERE/.env" ] || return 0
  sed -n "s/^$1=//p" "$HERE/.env" | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
# The compose project is resolved, never typed, as in backup.sh and issue-first-pat.sh. The
# manifest records it.
# COUPLED: the validator refuses a locator carrying the literal `deploy_zz-artifacts`.
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
PROJECT="${PROJECT:-$(basename "$HERE")}"

db_file="zz-db-$STAMP.sql.gz"
art_file="zz-artifacts-$STAMP.tar.gz"
cred_file="zz-credentials-$STAMP.tar.gz"
conf_file="zz-config-$STAMP.tar.gz"
git_file="zz-git-$STAMP.tar.gz"
manifest="$SET_DIR/zz-backup-manifest-$STAMP.json"

for required in "$db_file" "$art_file" "$cred_file" "$conf_file"; do
  [ -f "$SET_DIR/$required" ] || {
    echo "FAIL: $SET_DIR/$required is missing — this is not a complete backup set." >&2
    echo "  A set is the four files backup.sh writes. A manifest over three of them would" >&2
    echo "  describe a restore that leaves something behind, which is the whole thing" >&2
    echo "  validateBackupManifest exists to refuse." >&2
    exit 1
  }
done

# The git component: extract the artifacts archive into a scratch directory, bundle every
# store's history, and archive the bundles. The input is the tar, never the live volume, so this
# runs on any machine holding the off-host copy.
if [ ! -f "$SET_DIR/$git_file" ]; then
  echo "[$(date -u +%FT%TZ)] building portable git history -> $git_file"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$work/stores" "$work/bundles"
  tar xzf "$SET_DIR/$art_file" -C "$work/stores"
  found=0
  # `-name .git` at any depth: the store layout is the platform's business, not this script's.
  while IFS= read -r gitdir; do
    store="$(dirname "$gitdir")"
    name="$(basename "$store")"
    # --all, so every ref travels, not just the checked-out branch. A repository the tar caught
    # mid-write fails here.
    git -C "$store" bundle create "$work/bundles/$name.bundle" --all >/dev/null 2>&1 || {
      echo "FAIL: $name's history does not bundle — the archived repository is incomplete." >&2
      echo "  This is a real finding about the backup, not a problem with this script." >&2
      exit 1
    }
    found=$((found + 1))
  done < <(find "$work/stores" -name .git -type d)
  [ "$found" -gt 0 ] || {
    echo "FAIL: the artifacts archive contains no git repository at all." >&2
    echo "  Every team's store is one from its first write (commitStore, persist.ts). None" >&2
    echo "  means either the archive is wrong or history stopped being written — the second" >&2
    echo "  is a known silent failure on this platform and is worth checking before anything" >&2
    echo "  is restored from this set." >&2
    exit 1
  }
  tar czf "$SET_DIR/$git_file" -C "$work/bundles" .
  chmod 600 "$SET_DIR/$git_file"
  echo "  $found store(s) bundled"
fi

# The manifest. A locator is `protected:` plus the bare filename: no path, no host, no
# credential. COUPLED: the validator refuses anything else, so a backup report cannot print a
# connection string.
hash_of() { sha256sum "$SET_DIR/$1" | cut -d' ' -f1; }

# `artifacts_include_canonical_record` says the archive leaves no `.zz` record out, not that
# every store has one.
#
# DELIBERATE: an archive with no `.zz/` at all passes. A store has no record layout until an
# operator creates one (deploy/init-record-layout.sh, RESTORE-AND-CUTOVER.md step 5a), and
# `.zz/blobs` and `.zz/commits` are empty derived directories, so restoring such a set and
# re-running the init reaches the identical state. What fails is a `.zz/` missing `blobs` or
# `commits`: that half-initialised store refuses every write (record.ts's `preflightRefusal`
# requires all three) while looking initialised.
art_listing="$(tar tzf "$SET_DIR/$art_file")"
zz_roots="$(grep -c '/\.zz/\|^\./\?\.zz/' <<<"$art_listing" || true)"
if [ "${zz_roots:-0}" -eq 0 ]; then
  echo "  $art_file: no store carries a .zz/ layout — this set PREDATES the record layout."
  echo "    That is the expected state before cutover, and the set is still a complete restore"
  echo "    target. Restoring it gives stores that refuse writes with STORE_UNAVAILABLE until"
  echo "    deploy/init-record-layout.sh has run on each one (RESTORE-AND-CUTOVER.md step 5a)."
else
  for required in blobs commits; do
    grep -q "\.zz/$required" <<<"$art_listing" || {
      echo "FAIL: $art_file carries a .zz/ layout with no $required/ directory." >&2
      echo "  This is the half-initialised state. record.ts refuses every write to such a store" >&2
      echo "  (STORE_UNAVAILABLE, all three directories required), so restoring this set would" >&2
      echo "  produce a deployment that looks initialised and cannot be written to. Complete the" >&2
      echo "  layout with deploy/init-record-layout.sh and take the backup again." >&2
      exit 1
    }
  done
  echo "  $art_file: $zz_roots .zz/ path(s), with blobs/ and commits/ both present"
fi

cat > "$manifest" <<JSON
{
  "scope": "isolated-rehearsal",
  "compose_project": "$PROJECT",
  "artifacts_include_canonical_record": true,
  "components": [
    { "kind": "database",           "locator": "protected:$db_file",   "sha256": "$(hash_of "$db_file")" },
    { "kind": "artifacts",          "locator": "protected:$art_file",  "sha256": "$(hash_of "$art_file")" },
    { "kind": "git",                "locator": "protected:$git_file",  "sha256": "$(hash_of "$git_file")" },
    { "kind": "credentials",        "locator": "protected:$cred_file", "sha256": "$(hash_of "$cred_file")" },
    { "kind": "configuration_keys", "locator": "protected:$conf_file", "sha256": "$(hash_of "$conf_file")" }
  ]
}
JSON
chmod 600 "$manifest"
echo "[$(date -u +%FT%TZ)] wrote $manifest"
echo "NOTE: the manifest names files and hashes only — never a credential value. Export"
echo "  ZZ_TENANT_INFO_BACKUP_MANIFEST=$manifest and see deploy/RESTORE-AND-CUTOVER.md."
