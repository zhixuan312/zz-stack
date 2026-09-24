#!/usr/bin/env bash
# Run every requirement in a flow's corpus through one step, and keep what it produced.
#
#   ZZ_URL=… ZZ_TOKEN=… ./testing/eval-step.sh --flow sdlc/sdlc-flow --step sdlc-explore --out evals/explore
#   ./testing/eval-step.sh --flow … --step … --out … --only r01,r02   # while iterating
#   ./testing/eval-step.sh --flow … --step sdlc-spec --out … --from evals/explore
#
# One step at a time, so the result is about the skill rather than the flow. Each requirement
# gets its own initiative, as the step does in real use, and the platform records the run the
# usual way; those events are the trace evidence a plugin evaluation reads. Nothing here keeps
# its own telemetry.
#
# It leaves one initiative per requirement in the caller's team store, on purpose: they are the
# artefacts being measured. Never point it at a team doing real work.
#
# DELIBERATE: never two runs at once against one deployment. The platform attributes a call to
# the step whose skill that caller loaded most recently, and a caller is the token plus the
# client name, so two runs under one token interleave their attribution without any error.
set -euo pipefail

# DELIBERATE: the body is one brace group, so bash reads it whole before running. It otherwise
# reads by byte offset, and editing the file mid-run resumes the shell mid-line.
{

STEP=""; OUT=""; ONLY=""; FROM=""; MAXTURNS=8; MODEL="${LADDER_MODEL:-sonnet}"
# The flow comes from --flow, and the paths are derived from it after parsing, so --corpus can
# still override just the corpus.
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
  echo "       --flow has no default" >&2
  echo "       --from continues each requirement in the initiative the previous step wrote" >&2
  exit 2; }
[ -n "${ZZ_TOKEN:-}" ] || { echo "ZZ_TOKEN is required — the step calls the real platform" >&2; exit 2; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
: "${CORPUS:=catalog/$FLOW/tests/requirements.json}"
STEPS="catalog/$FLOW/tests/steps.json"
[ -f "$HERE/catalog/$FLOW/flow.json" ] || { echo "no flow at catalog/$FLOW — --flow is <owner>/<flow>, e.g. sdlc/sdlc-flow" >&2; exit 2; }
[ -f "$HERE/$CORPUS" ] || { echo "no corpus at $HERE/$CORPUS" >&2; exit 2; }
[ -f "$HERE/$STEPS" ] || { echo "no steps file at $HERE/$STEPS" >&2; exit 2; }
mkdir -p "$OUT"

IDS="$(node -e '
  const r = require(process.argv[1]).requirements;
  const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
  process.stdout.write(Object.keys(r).filter((k) => !only || only.has(k)).join(" "));
' "$HERE/$CORPUS" "$ONLY")"
[ -n "$IDS" ] || { echo "no requirements selected" >&2; exit 2; }

# The version the step is at now, recorded before anything runs, so a result is never filed
# against a version that did not produce it.
SKILL_FILE="$(find "$HERE/catalog" "$HERE/skills" -name SKILL.md \
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

# Which document the step owes and whether it interviews, from the flow's tests/steps.json. A
# step that interviews gets a stakeholder below; one that does not runs with nobody to ask.
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
  REQUESTER="$(node -e '
    const r = require(process.argv[1]).requirements[process.argv[2]];
    process.stdout.write(r.requester);' "$HERE/$CORPUS" "$id")"

  printf '\n──── %s (%d)\n' "$id" "$n"

  # With --from, a later step continues the initiative the previous run recorded for this
  # requirement, rather than starting from the brief.
  CONTINUE=""
  if [ -n "$FROM" ]; then
    CONTINUE="$(sed -n "s|^$id \\([^/]*\\)/.*|\\1|p" "$FROM/produced.txt" 2>/dev/null | head -1)"
    [ -n "$CONTINUE" ] || { echo "  SKIPPED: $FROM recorded no initiative for $id"; continue; }
  fi

  # The step is loaded through skill_read, as the flow loads it: that is what makes the platform
  # attribute everything after it to this step and version. Pasting the skill's text would record
  # the run against nothing.
  if [ -n "$CONTINUE" ]; then
    PROMPT="Call the zz-core tool skill_read, passing zz-platform as its name argument, and then
again passing ${STEP}. Follow those skills exactly — they are the method.

You are continuing the initiative ${CONTINUE}. Read what is already in it first.

For context, this is what the stakeholder originally sent, in their own words:

---
${BRIEF}
---

Do only what ${STEP} says to do, and stop when its document is written. Do not run any later
stage of the flow."
  else
    PROMPT="Call the zz-core tool skill_read, passing zz-platform as its name argument, and then
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
    # A stakeholder persona that answers each question from the brief, and where the brief is
    # silent decides as a sensible manager would and stays consistent.
    #
    # DELIBERATE: no tools and no MCP servers. A persona with the agent's tools could do the
    # agent's work, and the run would then score the pair rather than the step.
    SID="$(uuidgen | tr 'A-Z' 'a-z')"
    echo '{"mcpServers":{}}' > "$OUT/$id.nomcp.json"
    PERSONA="You are the manager at ${REQUESTER} who asked for this. In your own words, this is what
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
      # A reply with no question ends the interview.
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

  # Which initiative this requirement produced, read from the document_write call itself: the
  # step names its folder from its own title, so the name cannot say which brief it came from.
  node -e '
    const fs = require("fs");
    let path = "";
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "assistant") continue;
      for (const c of o.message?.content ?? []) {
        if (c.type === "tool_use" && /document_write$/.test(c.name ?? "")) {
          const p = c.input?.path;
          if (typeof p !== "string" || !p.includes("/")) continue;
          // The document this step owes, not simply the last one written: a run that carries on
          // past its stopping point writes the document of a later stage too.
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

printf '\n  %d requirement(s) through %s@%s, kept in %s.\n\n' "$n" "$STEP" "$VERSION" "$OUT"
}
