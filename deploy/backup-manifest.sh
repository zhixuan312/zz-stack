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
# WHY THIS IS NOT PART OF backup.sh, which is the question to ask about any script that runs
# beside one.
#
# backup.sh is a nightly cron job on the production host, and its own header records two
# separate incidents where a step that failed took the good backups down with it — once a dead
# step for a removed service, once a hardcoded compose project. It writes the three volumes and
# the dump, which is what must happen every night at 03:17 whether or not anybody is
# rehearsing a restore. The git bundles below are a different job with a different failure
# profile: they run `git` inside a container, against every team's store, and a rehearsal is
# the only thing that needs them. Putting them on the cron path would add the most complex step
# in the set to the one script whose failure mode is deleting backups.
#
# So this runs on demand, against a COPY, and its failure destroys nothing.
#
# WHAT THE `git` COMPONENT ACTUALLY IS, said plainly because it would be easy to fake.
#
# Each team's store is a git repository (services/zz-core/src/persist.ts `commitStore` inits
# one on the first write), and those repositories live inside the artifacts volume — so
# zz-artifacts-<stamp>.tar.gz already contains their `.git` directories. A second archive of
# the same bytes would be ceremony. `git bundle --all` is not the same bytes: it asks git to
# verify and pack the reachable history, so it fails on a repository the tar captured
# mid-write, and it produces the portable history export the spec means by "Git remains the
# portable history/diff export" — a single file that clones on a laptop with nothing of ours
# installed. That is a fact the tar cannot establish about itself.
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
# THE COMPOSE PROJECT IS RESOLVED, NEVER TYPED — the same rule, read the same way, as
# backup.sh and issue-first-pat.sh. The manifest records it, and the validator refuses a
# locator carrying the literal `deploy_zz-artifacts`, because a volume name somebody typed is
# wrong on every host whose project is not `deploy` and silently wrong on the one where it is.
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

# ── the git component ──────────────────────────────────────────────────────────────────────
#
# Extract the artifacts archive into a scratch directory, bundle every store's history, and
# archive the bundles. Nothing here touches the live volume: the input is the tar, so this can
# run on any machine holding the off-host copy, which is the machine a rehearsal happens on.
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
    # --all, so every ref travels, not just the branch that happens to be checked out.
    # A repository the tar caught mid-write fails HERE, loudly, which is the point.
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

# ── the manifest ───────────────────────────────────────────────────────────────────────────
#
# A locator is `protected:` plus the bare filename. No path, no host, no credential — the
# validator refuses anything else, so a backup report cannot print a connection string on its
# way to reporting a hash mismatch.
hash_of() { sha256sum "$SET_DIR/$1" | cut -d' ' -f1; }

# The canonical .zz record must be IN the artifacts archive, and this asks rather than asserts.
# "Include the .zz record in protected backup/export rather than classifying it as disposable
# telemetry" is the spec's sentence; a manifest that declared it present without looking would
# be the fabrication the rehearsal is meant to catch.
art_listing="$(tar tzf "$SET_DIR/$art_file")"
canonical=false
grep -q '\.zz' <<<"$art_listing" && canonical=true
[ "$canonical" = true ] || {
  echo "FAIL: $art_file contains no .zz record. The manifest would have to declare" >&2
  echo "  artifacts_include_canonical_record:false, which validateBackupManifest refuses —" >&2
  echo "  correctly, because the canonical record is not reconstructible from anything else." >&2
  exit 1
}

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
