#!/usr/bin/env bash
# For every step that owes a document: write the expected answer BLIND, diff the real one against
# it, classify each deviation as the skill's habit or this document's own problem, and rank what
# recurs.
#
#   ZZ_URL=… ZZ_TOKEN=… SP=… ./testing/deviate-all.sh
#
# This is the half that says WHY. A rubric score says a document is a 3.4; only the diff against
# an expectation written without seeing it says which 1.6 went missing and whether the same 1.6
# goes missing on requirements that share no subject matter.
set -euo pipefail
{
J=packages/tools/dist/testing/eval-judge.js
run() {   # step, rundir
  node "$J" --flow sm/ops-flow --step "$1" --expect                       > "$SP/evals/$2/expect.log"  2>&1 || true
  node "$J" --flow sm/ops-flow --step "$1" --out "$SP/evals/$2" --compare  > "$SP/evals/$2/compare.log" 2>&1 || true
  node "$J" --flow sm/ops-flow --step "$1" --out "$SP/evals/$2" --pattern  > "$SP/evals/$2/pattern.log" 2>&1 || true
  echo "  done: $1"
}
run sm-spec   spec-1.0   &
run sm-select select-1.1 &
wait
run sm-plan   plan-1.0   &
run sm-verify verify-1.0 &
wait
}
