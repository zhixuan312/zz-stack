#!/usr/bin/env bash
# AC-2.1: the chassis carries no slides; the guidebook carries all of them and the manifest.
# RESOLVED FROM THIS SCRIPT, not from the caller's directory — see deck-destination.sh for
# why. Same defect, same fix, and the two are registered in the gate together.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
d="$here/../skills/zz-deck"
fail=0
for f in "$d/deck-chassis.html" "$d/deck-guidebook.html"; do
  if [ ! -f "$f" ]; then echo "FAIL: $f not found"; exit 1; fi
done
# deck-template.html was deliberately NOT asserted absent here while Task I-5 left it in place
# so the gate stayed green. Task I-7 has now deleted it and added the assertion below.
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
# The manifest BLOCK, not the bare id. The chassis legitimately keeps renderVersion()'s
# document.getElementById('housebook-manifest') lookup — that is a behaviour script, not
# manifest data, and a deck built from this chassis writes its own manifest into the same
# file for that lookup to find. Asserting on the bare substring made this check
# unsatisfiable against a correct chassis; asserting on the block is what AC-2.1 means.
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
if [ -f "$d/deck-template.html" ]; then
  echo "FAIL: deck-template.html still exists, expected deleted"
  fail=1
fi
[ "$fail" -eq 0 ] && echo "PASS: chassis clean, guidebook whole, manifest with the slides"
exit "$fail"
