---
name: "eval"
description: "Run the ZZ Plugin Evaluation flow for your team."
when_to_use: "The person typed /zz-plugin-eval:eval. This is a command, not an auto-matched skill."
version: "0.77.4"
disable-model-invocation: true
---

# zz-plugin-eval

**A plugin is what a person installs**: a flow's skills plus the MCP servers those skills call,
arriving together and reached together. That is the unit this measures, and it is the unit the
platform ships at.

Two questions are only visible from the whole:

- **Recovery.** A stage goes wrong. Can the flow return to an earlier stage and re-ground, or
  does it plough on? That is a relation between stages, so no per-skill ruler contains it.
- **Use.** A tool is reachable, a skill names it, every gate check is green — and no agent has
  ever called it. Reachability is a property of the package and is already settled at release.
  Use is a property of the runs, and nothing reads it but this flow.

**Measurement never bends toward a change somebody already wanted.** EVALUATE and EXPLAIN score
and report from evidence alone; IMPROVE only ever starts from a `plugin`-owned finding EXPLAIN
already recorded, never from a hunch. **Promotion is authority-bound, not measurement-bound.**
A candidate may propose a fix to anything; only the plugin's own required owners, through the
platform's ordinary approval mechanism, ever let it touch a real repository. **A release is
judged on real use.** Nothing replays past initiatives to prove a candidate first: a candidate
that builds and gates is released once approved, evaluated on its own real runs afterwards, and
rolled back if it measures worse than the version it replaced.

**It is a platform capability, not a stage of anybody's delivery.** An agent in the middle of
shipping something does not stop and evaluate the plugin it is shipping with — that is a
separate piece of work with its own initiative.

**A PERSON OPENS THIS FLOW. NOTHING OPENS IT FOR THEM.** This skill is a flow's `entry`, so the
shelf renders it as the command `/zz-plugin-eval:eval` carrying `disable-model-invocation: true`
— a model cannot invoke it at all, whatever its `when_to_use` says. Each of the eight stage
skills beside it says "never on its own", which is right: a stage that fires out of order is
worse than one that does not fire.

The consequence: asked the questions this flow exists to answer in ordinary words, with the
plugin installed, nothing in it engages. That is not a defect — it is what "a person invokes
this on purpose" costs.

Load `zz-platform` first, as with every flow on this platform.

## One kind of evidence, three loops

| | where it comes from | needs | answers |
|---|---|---|---|
| **traces** | the event log, via `plugin_profile` | five usable runs | what did it actually do in real use? |

**A thin trace block is a real constraint, not a fact to report and route around.** A plugin
nobody has used cannot be judged on its runs. That is an honest `not measured`, and the
architecture carries that word all the way through — an OBSERVE snapshot, a `score_status`, a
`proposal.md`'s own findings-only section.

The eight stages sit in three nested loops and one promotion boundary:

```text
INSTRUMENT LOOP
IDENTIFY -> OBSERVE -> DISCOVER -> DEFINE/QUALIFY -> protocol.md [GATE, conditional]

EVALUATION LOOP
EVALUATE -> EXPLAIN -> findings.md [NO GATE, always]

IMPROVEMENT LOOP
IMPROVE -> proposal.md [NO GATE, conditional] or the promotion boundary below

PROMOTE/VERIFY -> improvement.md [GATE, conditional, closing] -> release -> verify on real use -> rollback if warranted
```

Three durable, deterministic branch facts drive which conditional stage runs and which document
applies (FR-52, FR-58) — never a model's confidence:

| fact | values | set by |
|---|---|---|
| protocol_action | `create` \| `reuse` \| `revise` | `protocol_read`, DEFINE/QUALIFY |
| improvement_mode | `skip` \| `release` \| `proposal` | `improvement_start`, IMPROVE |
| release_mode | `not_applicable` \| proposal_only \| `promotable` | `improvement_start(skip: true, ...)`, `improvement_stop` (nothing worth releasing), `release_prepare`, `proposal_prepare`, IMPROVE/PROMOTE-VERIFY |

`protocol.md` is gated only when protocol_action is `create`/`revise` — `reuse` skips
DEFINE/QUALIFY entirely. `findings.md` is always ungated and always written — every branch
reaches it. `proposal.md` is ungated and appears only when `release_mode: proposal_only`.
`improvement.md` is gated AND is this flow's `closing` document — but only on the `promotable`
branch. On every other branch, the initiative closes on `findings.md` or `proposal.md` instead:
the platform resolves this from release_mode through each document's own `when`, not from
which stage an agent happened to stop at.

**Every stage can start in a new conversation.** IDENTIFY, OBSERVE, DISCOVER and EVALUATE write
no document, so each records what it minted on the initiative instead — pass `initiative` to the
call that finishes the stage (`plugin_locate`/`plugin_register`, `plugin_profile`,
`failure_discover`, `evaluation_score`). `initiative_status` hands it back as `records`, keyed by
stage — `records["zz-plugin-identify"].subject_version_id`,
`records["zz-plugin-observe"].observation_snapshot_id`, `records["zz-plugin-evaluate"].eval_run_id`
— and while a record stage ahead of the next document has recorded nothing, `next_move` answers
`action: run_stage` naming it. From IMPROVE on, `findings.md` carries the eval run and the
tools resolve the rest from the initiative.

**Approved is not finished for DEFINE/QUALIFY.** Once `protocol.md` is approved, `next_move` stays
on `run_stage zz-plugin-define-qualify` — first until `protocol_affirm(protocol_version_id,
initiative, idempotency_key)` binds it, then until `evaluator_qualify` has been called for every measure key the
affirm returned as `qualify_owed` — and only then moves to EVALUATE. Its `why` names the call and
the keys still owed. Pass `initiative` to `protocol_read` so the stage records what it owes.

**A fact this flow has not yet decided reads `resolve_branch`, not an error.** Call
`initiative_status` after DISCOVER has recorded and before DEFINE/QUALIFY's own `protocol_read` and it answers
`resolve_branch: protocol.md` — protocol_action is not yet recorded, so the platform cannot yet
say whether protocol.md applies. That is expected, not a stall: run the stage `next_move` names
next and it resolves.

## The eight stages

| # | Stage | What it settles |
|---|---|---|
| 1 | `zz-plugin-identify` | which plugin, at which exact content — catalog release or third-party capture |
| 2 | `zz-plugin-observe` | the production evidence block, with its own sufficiency |
| 3 | `zz-plugin-discover` | candidate failure modes mined from real evidence, before any protocol exists |
| 4 | `zz-plugin-define-qualify` | **what good means for this plugin, and whether its judges can be trusted** — gated |
| 5 | `zz-plugin-evaluate` | the deterministic overall score, against the approved protocol |
| 6 | `zz-plugin-explain` | `findings.md` — ungated, and every branch reaches it |
| 7 | `zz-plugin-improve` | a built and gated candidate, an owner-facing proposal, or nothing plugin-owned to improve |
| 8 | `zz-plugin-promote-verify` | `improvement.md` — gated and closing on the promotable branch; release, verify on real use, roll back if warranted |

After a close, the close is an act rather than a stage — one `initiative_close()` call — and the
platform then reports `action: handover`, which `zz-handover` writes cold, afterwards. The close
ends the cycle this run went through; the handover ends the initiative.

## The one hard rule

**You are not the judge.** Scoring is `evaluation_score`, which reduces stored assessments
deterministically — no model supplies `overall_score` directly. A `bounded_semantic`/
`generative_critic` measure's own answer is evidence a qualified evaluator gave, recorded with
its provenance; it is never your own reading substituted in. Your own reading of an artifact
belongs in `findings.md` as an observation, never in the score.

## MCP-first, then a shell (FR-54)

IDENTIFY through EXPLAIN are runnable by any client with no shell — every durable state change
in those five stages goes through this door's own MCP tools alone. IMPROVE is where that
changes: a candidate is built and gated in a sandbox on the agent's own host (`npm run
candidate-build`), and released or rolled back through the repository's own procedures
(`zz-tool release-apply`, `zz-tool release-rollback`), so IMPROVE and PROMOTE/VERIFY need Claude
Code (or an equivalent shell-capable runtime) and refuse to start anywhere else. Load the stage skill for the one you are on; each says exactly which
tools to call, in what order, and what each refusal means.

## Legacy reader, still live

`round_scores` reads back a round a plugin version was marked in under the OLD five-stage
ruler, before this flow's own protocol lifecycle existed — its `zz.rubric*` dimensions, its
marks and its blind control, exactly as they were stored. It is history and nothing more:
nothing mints a new round, and no stage of this flow calls it. A plugin is scored through
`evaluation_start`/`evaluation_assess`/`evaluation_score`, against a protocol agreed through
`protocol_read`/`protocol_record`/`protocol_affirm`.

## Facts come from tools; meaning comes from you

Every number these tools return is a count, a set, an ordering or a difference. Not one of them
is a judgement, and that is deliberate.

`returns: 3` is a fact — a stage ran, a later stage ran, then the first ran again. Whether that
is a flow re-grounding well or one thrashing is **not in the data**. So: the tool produces the
fact, the protocol you agree in DEFINE/QUALIFY says where the line is, and code applies that
line. Where a threshold belongs is yours. What the number *is* is never yours.

## Pitfalls

❌ **Stopping because the trace block is thin.** A thin trace block is `not measured`, and that
is the honest answer — report it and move on.

❌ **Scoring before `protocol.md` is approved.** `protocol_affirm` refuses without an approved
document quoting the exact version's `content_digest`, and until it binds, `evaluator_qualify`
and `evaluation_start` refuse that protocol version by name — the refusal is the gate working.

❌ **Starting IMPROVE with no shell.** Nothing before it needs one; everything from it on does.

❌ **Comparing two plugins.** Every protocol is that plugin's own, so two scores are two things
measured with two protocols. There is no leaderboard here and there is not meant to be.

❌ **Assuming `improvement.md` is always the closing document.** It closes the `promotable`
branch only — `findings.md` or `proposal.md` closes every other one, and the platform resolves
which from release_mode, not from a guess about which stage an agent stopped at.

## Skill contract

**Outcome:** a plugin measured and, where a plugin-owned defect and an owned subject both exist,
a released improvement judged on real use — or an honest stop at whichever boundary the evidence
or the ownership actually drew: a thin trace block, an unqualified evaluator, nothing plugin-owned
to improve, a patch that never passed its gate, a subject this team cannot release. This skill
writes no document of its own; routing to the right stage skill is its whole product.

**Required evidence:** `initiative_status`'s own `next_move`, said out loud before routing on
it. Which durable branch facts (protocol_action, improvement_mode, release_mode) are already
set, read from the tool that set them, never assumed from which stage an agent happens to be on.
At each gate, the approval recorded on the document, never a recollection of the conversation.

**Allowed unknowns:** what DEFINE/QUALIFY will decide the protocol says; whether IMPROVE's
candidate will pass its gate, or real use will keep it; whether a subject is owned before
IDENTIFY has said so. None of
these has to be settled to route the next stage, and guessing at them is how a stage gets
skipped.

**Work roles:** a person opens this flow and approves `protocol.md`/`improvement.md` at their
gates — nothing substitutes for them there, and nothing opens the flow on their behalf
(`disable-model-invocation: true` is the platform's own enforcement of that). Choosing the stage
and calling its tools in order is this agent's own. Scoring, qualification and the release verdict are
code and typed evaluators, never the routing agent's own reading, per "the one hard rule" above.

**Action and exit paths:** the action is load the stage skill `initiative_status` names next,
follow it exactly, and return here to route once it finishes. The exits are the two closes:
`findings.md`/`proposal.md` alone (no plugin-owned finding, a non-owned subject, or nothing worth
releasing), or `improvement.md` (an owned, approved, released and verified candidate) — followed, either
way, by `zz-handover` once the cycle is closed.

**Degraded behaviour:** a plugin nobody has used, a protocol that cannot qualify its own
evaluators yet, a candidate that never passes its gate, a release real use rolls back — each is a real, complete outcome this flow
reports honestly at the stage that found it, never smoothed over by routing past it to the next
one.
