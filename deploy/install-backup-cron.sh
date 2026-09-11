#!/usr/bin/env bash
# Install the ZZ scheduled jobs: the nightly backup, a weekly restore drill, and the turn
# collector.
# Idempotent: re-running replaces our own lines and touches nothing else.
#
# 03:17 and 04:37 Sunday are in the HOST's timezone, because that is what cron uses —
# not UTC. This host runs Asia/Singapore, so the nightly job actually fires at 19:17 UTC
# and its files are stamped that way. The header said UTC, which would put anyone
# reasoning about how old a backup is eight hours out.
set -euo pipefail
# WHERE THIS SCRIPT IS, not where this deployment happens to live. The default was the
# literal /root/zz-parent/zz-stack, which is right for the host a release deploys to and
# wrong for the install path the release bundle exists to serve: a recipient who unpacks it
# anywhere else got three cron lines pointing at a directory that does not exist on their
# machine, installed successfully, and reported three tagged jobs.
# The checkout resolves to exactly the same path it always did — release.mjs runs this as
# `cd /root/zz-parent/zz-stack && ./deploy/install-backup-cron.sh`.
REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
tmp=$(mktemp)
# `crontab -l || true` treated every failure as "no crontab yet". If it failed for any other
# reason — a locale problem, a transient permission error — $tmp would hold only our own
# lines, and the install below would make those the ENTIRE crontab, silently deleting every
# unrelated job on the host.
err=$(mktemp)
existing=$(crontab -l 2>"$err") || rc=$?   # `|| rc=$?` because set -e would take the exit here
rc=${rc:-0}
# "This user has no crontab" is a normal first install; a failure to READ one is not, and
# reading it is the entire basis for rewriting it.
#
# THE TEST USED TO BE "nothing on stderr", and that is not how every cron says it. Vixie cron
# — Debian's, Ubuntu's, so every host this platform has ever run on — exits 1 and prints
# `no crontab for root` TO STDERR. So the one case this guard was written to allow was the
# one it refused, and it refused it in the middle of a release, after the deploy had already
# succeeded. Recognise the sentence, and treat anything else on stderr as the failure it is.
if [ "$rc" -ne 0 ] && [ -s "$err" ] && ! grep -qi "no crontab for" "$err"; then
  echo "cannot read the current crontab — refusing to replace it:" >&2
  sed 's/^/  /' "$err" >&2
  rm -f "$err" "$tmp"
  exit 1
fi
rm -f "$err"
# OUR lines are the ones carrying $TAG, which this script writes. The filter used to be a
# path pattern — `zz-stack/deploy/(backup\.sh|collect-turns\.py)` — and it had to stay in
# step with the commands below by hand. It did not: the collector was installed as
# `cd $REPO/deploy && python3 collect-turns.py`, which contains "deploy && python3", never
# "deploy/collect-turns.py", so the pattern never matched its own line and every run appended
# a fourth, a fifth, a sixth collector — each firing the same hour. The host has one today
# only because the installer has succeeded exactly once since the collector was added.
# It also broke for any REPO not ending in zz-stack, which is a setting this script offers.
# A tag cannot drift from the lines it tags, because the same script writes both.
TAG="# zz-cron"
printf '%s' "$existing" | grep -vF "$TAG" > "$tmp" || true
[ -s "$tmp" ] && [ "$(tail -c1 "$tmp")" != "" ] && echo >> "$tmp"
# THE JOBS, IN ONE ARRAY, because the assertion at the end counts them. It used to be two
# `echo` lines and a hardcoded `-eq 3`, which is the same drift the tag comment above exists
# to prevent, one level up: removing a job left the installer refusing its own correct output.
# A job added or removed here is asserted by having been added or removed.
#
# THE HOURLY TURN COLLECTOR WAS HERE and is gone with the front end it read. It derived a turn
# from LibreChat's Mongo, the one store the platform did not own; when that front end was
# removed on 2026-09-10 the job stayed installed and kept firing, creating a container every
# hour to fail on `getaddrinfo EAI_AGAIN mongodb`. Nothing noticed, because a cron job that
# fails quietly into its own log looks exactly like an hour in which nothing happened — which
# is, word for word, what its own documentation warned about the collector NOT running.
# Re-running this script removes it from a host that still has it.
JOBS=(
  "17 3 * * * $REPO/deploy/backup.sh >> /var/log/zz-backup.log 2>&1 $TAG"
  "37 4 * * 0 $REPO/deploy/backup.sh --verify >> /var/log/zz-backup.log 2>&1 $TAG"
)
printf '%s\n' "${JOBS[@]}" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"
# Assert what is actually there, and assert the COUNT. "Are our lines present" was true
# while the collector was installed three times over; only counting catches that.
echo "installed:"; crontab -l | grep -F "$TAG" | sed 's/^/  /'
n=$(crontab -l | grep -cF "$TAG")
[ "$n" -eq "${#JOBS[@]}" ] || { echo "expected ${#JOBS[@]} tagged jobs, found $n" >&2; exit 1; }
