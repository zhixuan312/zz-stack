#!/usr/bin/env bash
# Run every requirement in the corpus through ONE step, and keep what it produced.
#
#   ZZ_URL=… ZZ_TOKEN=… ./testing/eval-step.sh --step sm-intent --out evals/intent-1.0
#   ./testing/eval-step.sh --step sm-intent --out … --only r01,r02   # while iterating
#
# WHY A STEP AT A TIME. A full run scores one number after thirty minutes and gives no way to
# tell which of six steps caused it — an integration test standing in for a unit one. Thirty
# briefs through sm-intent gives that step thirty scored instances for a fraction of the cost,
# and the number that comes out is about the SKILL rather than about the flow.
#
# EACH REQUIREMENT GETS ITS OWN INITIATIVE, because that is how the step works and a step
# measured in a shape it does not run in is measuring something else. It also means the
# platform records everything the usual way: which step, which version, which block, what was
# refused. Nothing here needs its own telemetry.
#
# NO STAKEHOLDER. There is nobody to ask and the step is told so. sm-intent is the right place
# to start precisely because it has no interview — its own anti-pattern says ambiguity becomes
# an open question rather than a conversation, so running it without a person to ask is running
# it as designed rather than crippling it.
#
# IT WILL LEAVE THIRTY INITIATIVES BEHIND, in the eval team's store, on purpose: they are the
# artefacts being graded. Empty that store before a run, never during, and never point this at
# a team doing real work.
#
# NEVER TWO OF THESE AT ONCE against the same deployment. The platform attributes a call to the
# step whose skill was loaded most recently BY THAT CALLER, and a caller is the token plus the
# client name — so two runs under one token share a single trace slot. Interleave them and
# sm-spec's calls get filed under a block's usage skill and the block's under sm-spec, silently,
# with both measurements looking entirely normal. Serialise them.
set -euo pipefail

# READ WHOLE BEFORE RUN. bash reads a script incrementally by byte offset, so editing one while
# it runs shifts the text under the running shell and it resumes mid-line.
{

STEP=""; OUT=""; ONLY=""; FROM=""; MAXTURNS=8; MODEL="${LADDER_MODEL:-sonnet}"
# NO FLOW OF ITS OWN. These two were catalog/ops/ops-flow/... , which made the one script that
# PRODUCES a run directory the last ops-flow-locked link in the component depth: eval-judge,
# eval-grade and eval-store all resolve their corpus from --flow, so sdlc-flow could be judged
# but never driven, and the corpus authored for it had nothing that could run it.
# Derived from --flow below, after parsing, so --corpus can still override just the corpus.
FLOW=""; CORPUS=""; STEPS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flow) FLOW="$2"; shift 2;;
    --step) STEP="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --only) ONLY="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --corpus) CORPUS="$2"; shift 2;;
    --from) FROM="$2"; shift 2;;
    --max-turns) MAXTURNS="$2"; shift 2;;
    *) echo "unknown argument $1" >&2; exit 2;;
  esac
done
[ -n "$FLOW" ] && [ -n "$STEP" ] && [ -n "$OUT" ] || {
  echo "usage: $0 --flow <owner>/<flow> --step <skill> --out <dir> [--from <dir>] [--only r01,r02]" >&2
  echo "       --flow has no default: a defaulted flow is how this script stayed ops-flow's" >&2
  echo "       --from continues each requirement in the initiative the previous step wrote" >&2
  exit 2; }
[ -n "${ZZ_TOKEN:-}" ] || { echo "ZZ_TOKEN is required — the step calls the real platform" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
: "${CORPUS:=catalog/$FLOW/tests/requirements.json}"
STEPS="catalog/$FLOW/tests/steps.json"
[ -f "$HERE/catalog/$FLOW/flow.json" ] || { echo "no flow at catalog/$FLOW — --flow is <owner>/<flow>, e.g. sm/ops-flow" >&2; exit 2; }
[ -f "$HERE/$CORPUS" ] || { echo "no corpus at $HERE/$CORPUS" >&2; exit 2; }
[ -f "$HERE/$STEPS" ] || { echo "no steps file at $HERE/$STEPS" >&2; exit 2; }
mkdir -p "$OUT"

IDS="$(node -e '
  const r = require(process.argv[1]).requirements;
  const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
  process.stdout.write(Object.keys(r).filter((k) => !only || only.has(k)).join(" "));
' "$HERE/$CORPUS" "$ONLY")"
[ -n "$IDS" ] || { echo "no requirements selected" >&2; exit 2; }

# The version the step is at RIGHT NOW, recorded before anything runs. A score filed against
# the wrong version is worse than no score: it credits a change with results from before it
# existed, which is the failure the whole versioning scheme was built to stop.
SKILL_FILE="$(find "$HERE/catalog" "$HERE/skills" "$HERE/blocks" -name SKILL.md \
  -exec grep -l "^name: $STEP\$" {} + 2>/dev/null | head -1)"
[ -n "$SKILL_FILE" ] || { echo "no skill named $STEP" >&2; exit 2; }
VERSION="$(sed -n 's/^version: *//p' "$SKILL_FILE" | head -1)"
{
  echo "---"
  echo "step:     $STEP"
  echo "version:  $VERSION"
  echo "model:    $MODEL"
  echo "corpus:   $CORPUS"
  echo "gateway:  ${ZZ_URL:-(from the installed client)}"
  echo "started:  $(date -u +%FT%TZ)"
  echo "---"
} | tee "$OUT/run.txt"

# WHETHER THIS STEP INTERVIEWS, from the one place that says so. sm-intent has no interview —
# its own anti-pattern is that ambiguity becomes an open question rather than a conversation —
# so running it with nobody to ask is running it as designed. sm-spec is the opposite: "the
# interview exists to close the intent's open questions", and evaluating it without a
# stakeholder would measure a crippled version of the step rather than the step.
OWES="$(node -e '
  const s = require(process.argv[1]).steps[process.argv[2]];
  const m = require(process.argv[3]);
  const d = s && s.role ? (m.documents || []).find((x) => x.role === s.role) : null;
  process.stdout.write(d ? d.name : "");' "$HERE/$STEPS" "$STEP" "$HERE/catalog/$FLOW/flow.json")"
echo "  owes: ${OWES:-nothing}"

INTERVIEWS="$(node -e '
  const s = require(process.argv[1]).steps[process.argv[2]];
  if (!s) { console.error(`no entry for ${process.argv[2]} in steps.json`); process.exit(2); }
  process.stdout.write(s.interviews ? "yes" : "no");' "$HERE/$STEPS" "$STEP")"
echo "  interviews: $INTERVIEWS"

n=0
for id in $IDS; do
  n=$((n + 1))
  BRIEF="$(node -e '
    const r = require(process.argv[1]).requirements[process.argv[2]];
    process.stdout.write(r.brief);' "$HERE/$CORPUS" "$id")"
  AGENCY="$(node -e '
    const r = require(process.argv[1]).requirements[process.argv[2]];
    process.stdout.write(r.agency);' "$HERE/$CORPUS" "$id")"

  printf '\n──── %s (%d)\n' "$id" "$n"

  # WHERE TO CONTINUE. A later step does not start from a brief, it starts from the document the
  # step before it left — so the initiative is carried forward from that run rather than guessed
  # from a folder name the step chose for itself.
  CONTINUE=""
  if [ -n "$FROM" ]; then
    CONTINUE="$(sed -n "s|^$id \\([^/]*\\)/.*|\\1|p" "$FROM/produced.txt" 2>/dev/null | head -1)"
    [ -n "$CONTINUE" ] || { echo "  SKIPPED: $FROM recorded no initiative for $id"; continue; }
  fi

  # THE STEP IS LOADED THE WAY THE FLOW LOADS IT, through skill_view — that is what makes the
  # platform attribute everything after it to this step and this version. A prompt that pasted
  # the skill's text would exercise the same words and record them against nothing.
  if [ -n "$CONTINUE" ]; then
    PROMPT="Call the zz-core tool skill_view, passing zz-backbone as its name argument, and then
again passing ${STEP}. Follow those skills exactly — they are the method.

You are continuing the initiative ${CONTINUE}. Read what is already in it first.

For context, this is what the stakeholder originally sent, in their own words:

---
${BRIEF}
---

Do only what ${STEP} says to do, and stop when its document is written. Do not run any later
stage of the flow."
  else
    PROMPT="Call the zz-core tool skill_view, passing zz-backbone as its name argument, and then
again passing ${STEP}. Follow those skills exactly — they are the method.

A stakeholder has sent you this, and it is all you have. There is nobody to ask: work from
what is written.

---
${BRIEF}
---

Do only what ${STEP} says to do, and stop when its document is written. Do not run any later
stage of the flow."
  fi

  if [ "$INTERVIEWS" = "no" ]; then
    claude -p --model "$MODEL" --permission-mode bypassPermissions \
      --output-format stream-json --verbose \
      "$PROMPT" > "$OUT/$id.jsonl" 2>"$OUT/$id.err" < /dev/null || true
  else
    # A STAKEHOLDER WHO ANSWERS FROM THE BRIEF, because the brief is what a stakeholder actually
    # knows. Not a script: a script answers from a fixed list, and this repository has already
    # been bitten by one that approved a 12,479-character plan having been shown 11% of it. This
    # reads the question and answers it, and where the brief is silent it decides the way a
    # sensible manager would and then stays consistent — which is also what a real one does.
    #
    # NO TOOLS AT ALL. A stakeholder cannot call the platform, cannot see a block, and does not
    # know what MCP is. Handing the persona the agent's tools lets it do the agent's work, and
    # the round then scores the pair rather than the step.
    SID="$(uuidgen | tr 'A-Z' 'a-z')"
    echo '{"mcpServers":{}}' > "$OUT/$id.nomcp.json"
    PERSONA="You are the manager at ${AGENCY} who asked for this. In your own words, this is what
you want:

---
${BRIEF}
---

How you behave, without exception:

- You are NOT technical. You have never heard of the systems being used and you never use words
  like API, webhook, workflow engine or case management system. If told a technical detail you
  do not repeat it back — you say whether the OUTCOME is what you wanted.
- You answer questions from what you want, above. If asked something it does not cover, decide
  it yourself the way a sensible manager would, say it plainly, and stay consistent with that
  for the rest of the conversation.
  You NEVER say 'that is not in my brief' — a real manager just answers.
- You never suggest how to build anything and never diagnose a problem.
  Working out how is their job, not yours.
  You approve something when it says what you asked for, and you read it properly first.
- Keep replies short. A few sentences. You are busy."

    : > "$OUT/$id.jsonl"
    SAY="$PROMPT"
    NEW="--session-id $(uuidgen | tr 'A-Z' 'a-z')"
    for t in $(seq 1 "$MAXTURNS"); do
      # shellcheck disable=SC2086
      claude -p --model "$MODEL" --permission-mode bypassPermissions $NEW \
        --output-format stream-json --verbose \
        "$SAY" >> "$OUT/$id.jsonl" 2>>"$OUT/$id.err" < /dev/null || true
      NEW="--resume ${NEW##* }"

      REPLY="$(node -e '
        const fs = require("fs");
        let said = "";
        for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.type === "assistant") {
            for (const c of o.message?.content ?? []) if (c.type === "text" && c.text?.trim()) said = c.text.trim();
          }
        }
        process.stdout.write(said);' "$OUT/$id.jsonl")"
      [ -n "$REPLY" ] || break
      # An agent that has stopped asking has finished interviewing. Spending the rest of the
      # budget on a conversation nobody is having is how a cheap evaluation stops being cheap.
      printf '%s' "$REPLY" | grep -q '?' || break

      SAY="$(claude -p --model "$MODEL" --permission-mode bypassPermissions \
        --mcp-config "$OUT/$id.nomcp.json" --strict-mcp-config \
        --disallowedTools "Skill,Task,Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch" \
        --append-system-prompt "$PERSONA" \
        "They say:

$REPLY

Reply as yourself." < /dev/null 2>/dev/null || true)"
      [ -n "$SAY" ] || break
    done
  fi

  # WHICH INITIATIVE THIS REQUIREMENT PRODUCED, taken from the write_file call itself. The step
  # names its own folder from the title it wrote, so nothing about the name says which brief it
  # came from — and matching documents to requirements by content afterwards mis-attributed two
  # of them on the very first run, scoring requirements that had never been run at all.
  node -e '
    const fs = require("fs");
    let path = "";
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant") continue;
      for (const c of o.message?.content ?? []) {
        if (c.type === "tool_use" && /write_file$/.test(c.name ?? "")) {
          const p = c.input?.path;
          if (typeof p !== "string" || !p.includes("/")) continue;
          // THE DOCUMENT THIS STEP OWES, not simply the last thing written. Two sm-plan runs
          // carried on past their own stopping point and wrote sm-verify guide.md as well, and
          // taking the last write recorded the wrong document for both. Preferring the owed one
          // fixes the record; the crossing itself is a finding and is reported separately.
          if (p.endsWith("/" + process.argv[4])) path = p;
          else if (!path) path = p;
        }
      }
    }
    if (path) fs.appendFileSync(process.argv[3], `${process.argv[2]} ${path}\n`);
  ' "$OUT/$id.jsonl" "$id" "$OUT/produced.txt" "$OWES" || true

  node -e '
    const fs = require("fs");
    let cost = 0, said = "";
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === "result") cost += o.total_cost_usd ?? 0;
      if (o.type === "assistant") {
        for (const c of o.message?.content ?? []) if (c.type === "text" && c.text?.trim()) said = c.text.trim();
      }
    }
    console.log(`  $${cost.toFixed(3)}  ${said.split("\n")[0].slice(0, 110)}`);
  ' "$OUT/$id.jsonl" || echo "  (no result frame — the turn did not complete)"
done

printf '\n  %d requirement(s) through %s@%s. Grade them with:\n' "$n" "$STEP" "$VERSION"
printf '    npm run build && npm run eval-grade -- --flow %s --step %s --out %s\n\n' "$FLOW" "$STEP" "$OUT"
}
