#!/usr/bin/env bash
# Which blocks does each requirement ACTUALLY need — decided from the brief alone.
#
#   ./testing/block-oracle.sh > catalog/sdlc/sdlc-flow/tests/blocks-oracle.txt
#
# WHY THIS IS NOT `exercises.blocks`. That field was authored by hand alongside the corpus, as a
# note on why each requirement earned its place in the set. Pressed into service as an answer key
# it reported eleven over-selections, and the first one checked was wrong: one brief asked for
# "a reminder the day before", BookIt cannot send one, and the selection that added
# RuleMill for it named the exact schedule that would do it. The hand-written hint said BookIt
# alone. The skill was right and the answer key was wrong.
#
# So the key gets derived the same way the answer does — by reading the brief — but BLIND: this
# never sees the selection it will be compared against, which is the only thing that keeps it an
# independent opinion rather than a rationalisation of whatever was chosen.
#
# It is still not an oracle in the strong sense. It is a second careful reader. Where it agrees
# with the selection, that is two independent readings agreeing. Where it disagrees, that is a
# question for a person, not a verdict.
set -euo pipefail
{
CAP="$(cat blocks/CAPABILITIES.md)"
for id in $(node -e 'console.log(Object.keys(require("./catalog/sdlc/sdlc-flow/tests/requirements.json").requirements).join(" "))'); do
  BRIEF="$(node -e 'const r=require("./catalog/sdlc/sdlc-flow/tests/requirements.json").requirements[process.argv[1]];process.stdout.write(r.requester+" — "+r.title+"\n\n"+r.brief)' "$id")"
  ANS="$(printf '%s\n\n%s\n\nTHE REQUIREMENT\n\n%s\n' \
"Decide which building blocks this requirement needs, from the sheet below. Answer with the
smallest set that covers it: name a block only if removing it would leave something in the brief
undeliverable. If the brief needs a capability none of the blocks has, answer NONE — do not
assemble the nearest available combination.

Read for the quiet requirements. A reminder, a notification, a nightly sweep, or anything that
must join two systems is automation even when the brief mentions it in passing.

Answer with one line and nothing else: the block names separated by +, or NONE." "$CAP" "$BRIEF" \
    | claude -p --model sonnet --output-format json --disallowed-tools '*' 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).result||"").trim().split("\n").pop().trim())}catch{console.log("?")}})')"
  echo "$id ${ANS:-?}"
done
}
