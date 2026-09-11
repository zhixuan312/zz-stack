#!/usr/bin/env bash
# AC-1.8: the deck skill names one destination, and never the platform's document-write tool.
# Run from the workspace root (zz-parent/).
set -u
skill="zz-stack/catalog/sdlc/sdlc-flow/skills/sdlc-deck/SKILL.md"
fail=0
if [ ! -f "$skill" ]; then echo "FAIL: $skill not found"; exit 1; fi
if grep -n "write_file" "$skill"; then
  echo "FAIL: SKILL.md still names the platform's document-write tool"
  fail=1
fi
if ! grep -q "decks/" "$skill"; then
  echo "FAIL: SKILL.md no longer names the decks/ destination"
  fail=1
fi
if grep -niE "if an initiative is in play|when there is one, and beside the source" "$skill"; then
  echo "FAIL: an initiative-conditional destination survives"
  fail=1
fi
[ "$fail" -eq 0 ] && echo "PASS: one destination, no platform document-write tool"
exit "$fail"
