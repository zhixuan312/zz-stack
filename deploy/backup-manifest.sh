#!/usr/bin/env bash
# Turn one completed backup set into the manifest a restore rehearsal validates before it
# touches a byte.
#
#   ./deploy/backup-manifest.sh /path/to/off-host/copy 20260920T031700Z
#
# It writes `zz-backup-manifest-<stamp>.json` beside the set, listing the three component kinds
# `backup.sh` writes — the database, the credentials volume and the configuration files — each
# with a locator and the SHA-256 of the actual file.
#
# DELIBERATE: three, not four. The set used to carry a fourth member, the `<p>_zz-artifacts`
# volume, and a fifth component built from it — a portable `git bundle` of every team store's
# history. Both are gone with the store (Task I-41): the store's every fact is inside the database
# component now, and its repository went into the archive
# `scripts/retire-file-store.ts` writes, which this manifest does not describe because that archive
# is not part of a nightly set and is never pruned with one. A required-member list left at four
# would refuse every set written from here on, and a manifest still naming an artifacts archive
# would describe a file that no longer exists.
#
# DELIBERATE: not part of backup.sh. backup.sh is the nightly cron job, and a failed step there can
# cost the night's backup. This runs on demand, against a copy, and its failure destroys nothing.
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
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
PROJECT="${PROJECT:-$(basename "$HERE")}"

db_file="zz-db-$STAMP.sql.gz"
cred_file="zz-credentials-$STAMP.tar.gz"
conf_file="zz-config-$STAMP.tar.gz"
manifest="$SET_DIR/zz-backup-manifest-$STAMP.json"

for required in "$db_file" "$cred_file" "$conf_file"; do
  [ -f "$SET_DIR/$required" ] || {
    echo "FAIL: $SET_DIR/$required is missing — this is not a complete backup set." >&2
    echo "  A set is the three files backup.sh writes. A manifest over two of them would" >&2
    echo "  describe a restore that leaves something behind, which is the whole thing" >&2
    echo "  validateBackupManifest exists to refuse." >&2
    exit 1
  }
done

# The configuration archive is the one the operator has to be told about by name: it holds
# deploy/.env, which carries the database password, so a restore rehearsal that fetched the set
# from somewhere public would open a database nobody meant to publish.
conf_listing="$(tar tzf "$SET_DIR/$conf_file")" || {
  echo "FAIL: $conf_file does not list — the archive is corrupt or truncated" >&2; exit 1; }
grep -qx '\(\./\)\?\.env' <<<"$conf_listing" || {
  echo "FAIL: $conf_file does not contain .env — the database password would not survive a restore" >&2
  exit 1; }

# The manifest. A locator is `protected:` plus the bare filename: no path, no host, no
# credential. COUPLED: the validator refuses anything else, so a backup report cannot print a
# connection string.
hash_of() { sha256sum "$SET_DIR/$1" | cut -d' ' -f1; }

cat > "$manifest" <<JSON
{
  "scope": "isolated-rehearsal",
  "compose_project": "$PROJECT",
  "components": [
    { "kind": "database",           "locator": "protected:$db_file",   "sha256": "$(hash_of "$db_file")" },
    { "kind": "credentials",        "locator": "protected:$cred_file", "sha256": "$(hash_of "$cred_file")" },
    { "kind": "configuration_keys", "locator": "protected:$conf_file", "sha256": "$(hash_of "$conf_file")" }
  ]
}
JSON
chmod 600 "$manifest"
echo "[$(date -u +%FT%TZ)] wrote $manifest"
echo "NOTE: the manifest names files and hashes only — never a credential value. Export"
echo "  ZZ_TENANT_INFO_BACKUP_MANIFEST=$manifest and see deploy/RESTORE-AND-CUTOVER.md."
