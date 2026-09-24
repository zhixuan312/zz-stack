#!/usr/bin/env bash
# Install the ZZ scheduled jobs: the nightly backup and a weekly restore drill.
# Idempotent: re-running replaces our own lines and touches nothing else.
#
# 03:17 and 04:37 Sunday are in the host's timezone, because that is what cron uses — not
# UTC. Anyone reasoning about how old a backup is must read the host's zone.
set -euo pipefail
# Where this script is, not where a deployment happens to live: a release bundle unpacked
# anywhere else must get cron lines pointing at its own directory.
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
tmp=$(mktemp)
# DELIBERATE: a failure to read the crontab is fatal. Treating it as "no crontab yet" would
# make our own lines the entire crontab and delete every unrelated job on the host.
err=$(mktemp)
existing=$(crontab -l 2>"$err") || rc=$?   # `|| rc=$?` because set -e would take the exit here
rc=${rc:-0}
# "This user has no crontab" is a normal first install; a failure to read one is not.
#
# Vixie cron (Debian, Ubuntu) exits 1 and prints `no crontab for root` to stderr, so that
# sentence is recognised and anything else on stderr is the failure it is.
if [ "$rc" -ne 0 ] && [ -s "$err" ] && ! grep -qi "no crontab for" "$err"; then
  echo "cannot read the current crontab — refusing to replace it:" >&2
  sed 's/^/  /' "$err" >&2
  rm -f "$err" "$tmp"
  exit 1
fi
rm -f "$err"
# Our lines are the ones carrying $TAG, which this script writes. A tag cannot drift from the
# lines it tags, because the same script writes both — a path pattern kept in step by hand
# does, and appends a duplicate job on every run.
TAG="# zz-cron"
printf '%s' "$existing" | grep -vF "$TAG" > "$tmp" || true
[ -s "$tmp" ] && [ "$(tail -c1 "$tmp")" != "" ] && echo >> "$tmp"
# The jobs, in one array, because the assertion at the end counts them: a job added or
# removed here is asserted by having been added or removed. Re-running this removes any
# tagged job no longer listed.
JOBS=(
  "17 3 * * * $REPO/deploy/backup.sh >> /var/log/zz-backup.log 2>&1 $TAG"
  "37 4 * * 0 $REPO/deploy/backup.sh --verify >> /var/log/zz-backup.log 2>&1 $TAG"
)
printf '%s\n' "${JOBS[@]}" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"
# Assert what is actually there, and assert the count: "are our lines present" stays true
# while a job is installed three times over.
echo "installed:"; crontab -l | grep -F "$TAG" | sed 's/^/  /'
n=$(crontab -l | grep -cF "$TAG")
[ "$n" -eq "${#JOBS[@]}" ] || { echo "expected ${#JOBS[@]} tagged jobs, found $n" >&2; exit 1; }
