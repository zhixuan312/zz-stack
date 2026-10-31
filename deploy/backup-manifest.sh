#!/usr/bin/env bash
# Write a JSON listing of one completed backup set: its three files and the SHA-256 of each, for
# comparing an off-host copy with its source by hand. Nothing in this repository reads the
# manifest, and no restore checks it.
#
#   ./deploy/backup-manifest.sh /path/to/off-host/copy 20260920T031700Z
#
# It writes `zz-backup-manifest-<stamp>.json` beside the set, listing the three component kinds
# `backup.sh` writes — the database, the credentials volume and the configuration files — each
# with a locator and the SHA-256 of the actual file. The store's retirement archive
# (`zz-store-archive-<stamp>`) is not part of a nightly set, so it is not listed.
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
    echo "  A set is the three files backup.sh writes, and a listing of two of them would" >&2
    echo "  describe a restore that leaves something behind." >&2
    exit 1
  }
done

# The configuration archive is the one the operator has to be told about by name: it holds
# deploy/.env, which carries the database password, and without it a restored dump cannot be
# opened.
conf_listing="$(tar tzf "$SET_DIR/$conf_file")" || {
  echo "FAIL: $conf_file does not list — the archive is corrupt or truncated" >&2; exit 1; }
grep -qx '\(\./\)\?\.env' <<<"$conf_listing" || {
  echo "FAIL: $conf_file does not contain .env — the database password would not survive a restore" >&2
  exit 1; }

# The manifest. A locator is `protected:` plus the bare filename: no path, no host, no
# credential, so the manifest can be shared without exposing where the set lives.
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
echo "NOTE: the manifest names files and hashes only — never a credential value."
