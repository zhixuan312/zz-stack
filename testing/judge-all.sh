#!/usr/bin/env bash
# Mark every step that owes a document, and mark each one AGAIN against the wrong requirement.
#
#   ZZ_URL=… ZZ_TOKEN=… ./testing/judge-all.sh
#
# The control is not optional and does not run separately. A quality score with no scrambled twin
# beside it cannot be told apart from a judge rewarding confident prose, so this produces both or
# neither. Two steps run at a time, four judgements inside each: sixteen at once saturates the
# same account the flow itself runs under.
set -euo pipefail

# READ WHOLE BEFORE RUN. bash reads a script incrementally by byte offset, so editing one while it
# runs shifts the text under the running shell and it resumes mid-line. This has already cost one
# run its last requirement.
{
SP="${SP:-$(pwd)}"
J=packages/tools/dist/testing/eval-judge.js

one() {  # step, rundir
  node "$J" --flow ops/ops-flow --step "$1" --out "$SP/evals/$2"           >  "$SP/evals/$2/judge.log"   2>&1 || true
  node "$J" --flow ops/ops-flow --step "$1" --out "$SP/evals/$2" --control >  "$SP/evals/$2/control.log" 2>&1 || true
  echo "  done: $1"
}

one ops-select select-1.1 &
one ops-intent intent-1.0 &
wait
one ops-spec spec-1.0 &
one ops-plan plan-1.0 &
wait

echo
for pair in "ops-intent:intent-1.0" "ops-spec:spec-1.0" "ops-select:select-1.1" "ops-plan:plan-1.0"; do
  d="$SP/evals/${pair##*:}"
  real=$(node -e 'try{console.log(require(process.argv[1]).overall.toFixed(2))}catch{console.log("—")}' "$d/judged.json" 2>/dev/null)
  ctl=$(node -e 'try{console.log(require(process.argv[1]).overall.toFixed(2))}catch{console.log("—")}' "$d/judged-control.json" 2>/dev/null)
  printf '  %-12s real %-5s control %-5s\n' "${pair%%:*}" "$real" "$ctl"
done
}
