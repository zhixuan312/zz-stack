#!/usr/bin/env bash
# AC-2.1: the chassis carries no slides; the guidebook carries all of them and the manifest.
# Paths resolve from this script, not the caller's directory, as in deck-destination.sh.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
d="$here/../skills/zz-deck"
fail=0
for f in "$d/deck-chassis.html" "$d/deck-guidebook.html"; do
  if [ ! -f "$f" ]; then echo "FAIL: $f not found"; exit 1; fi
done
chassis=$(grep -c "<section" "$d/deck-chassis.html" || true)
if [ "$chassis" -ne 0 ]; then
  echo "FAIL: chassis carries $chassis section openings, expected 0"
  fail=1
fi
book=$(grep -c "<section" "$d/deck-guidebook.html" || true)
if [ "$book" -ne 53 ]; then
  echo "FAIL: guidebook carries $book sections, expected 53"
  fail=1
fi
# DELIBERATE: the manifest block, not the bare id. The chassis keeps renderVersion()'s
# document.getElementById('housebook-manifest') lookup, which finds the manifest a deck built
# from it writes into the same file.
if ! grep -q '<script id="housebook-manifest"' "$d/deck-guidebook.html"; then
  echo "FAIL: the manifest block did not travel with the guidebook"
  fail=1
fi
if grep -q '<script id="housebook-manifest"' "$d/deck-chassis.html"; then
  echo "FAIL: the manifest block is in the chassis and must not be"
  fail=1
fi
# Sentinels that prove each kept part actually survived: the style layer, pagination,
# the self-QA and the dock's version renderer. All four are absent from the guidebook, so
# they also prove the cut did not carry them off in the wrong direction.
for must in "<style" "fillFeet" "renderQA" "renderVersion"; do
  grep -q "$must" "$d/deck-chassis.html" || { echo "FAIL: chassis lost $must"; fail=1; }
done
[ "$fail" -eq 0 ] && echo "PASS: chassis clean, guidebook whole, manifest with the slides"
exit "$fail"
