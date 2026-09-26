---
name: zz-plugin-observe
version: 0.6
description: Stage 2 of zz-plugin-eval (OBSERVE). Compute the pre-protocol observation snapshot — production facts from this subject's real runs, in one resolved window — with its sufficiency verdict and the coverage it was derived from. No model touches any of it.
when_to_use: "The second stage of zz-plugin-eval, after IDENTIFY has settled subject_version_id. Also the stage that decides whether there is enough evidence for DISCOVER and EVALUATE to work from. No shell required."
---

# zz-plugin-observe

```
plugin_profile(subject_version_id, evidence_window, idempotency_key, initiative)   the observation snapshot
plugin_conform(plugin, version)                                       R1-R14, three-valued
```

Neither calls a model. Every fact is a count, a set, an ordering or a difference.

In a new conversation, `subject_version_id` is `initiative_status`'s
`records["zz-plugin-identify"].subject_version_id`. Pass `initiative` to `plugin_profile`: it
records `observation_snapshot_id` as this stage's record, which is how DISCOVER and EVALUATE find
this exact snapshot rather than minting another.

`plugin_profile` is a mutator: it writes exactly one immutable `zz.eval_observation_snapshot`
row and returns `observation_snapshot_id`. `evidence_window` is `{ from, to }` or
`{ last_runs: n }`; `{ last_runs: n }` resolves to the caller's most recent `n` runs at call
time and that RESOLVED range is what gets recorded, so a retry (same `idempotency_key`) replays
against the same window rather than sliding forward as new runs land. No protocol is required
to call this — OBSERVE runs before DEFINE/QUALIFY ever needs to (FR-8).

## One window, one sufficiency line

```
6 usable runs · coverage 198/510 events                sufficient
```

| sufficient at | why the line is there |
|---|---|
| **5 usable runs** | a floor for a signal to exist, not a claim about power |

**A thin window does not stop this flow.** Report it as thin and go on: `sufficient_for_judging:
false` still writes the snapshot, and DISCOVER still runs over it.

**A window with no run at all is refused**, and the refusal names this plugin's versions that do
have runs, with counts. The usual cause is evaluating the version just released: every platform
release gives every catalog plugin a new version, and nobody has used it yet. IDENTIFY one of the
named versions — `plugin_locate` with that `version` — and observe that, or wait for real use of
the new one — never carry an empty snapshot into DISCOVER.

**The evaluation is not evidence about what it evaluates.** Every population here leaves out
evaluations' own traffic — runs of this flow's skills, runs inside an evaluation initiative, and
an evaluation session's reads before it has one — except when the subject is zz-plugin-eval
itself, whose evidence is exactly that.

## What the response actually says

- `usable_run_count` / `total_run_count` — a usable run is one attached to an initiative, naming
  a skill version in this subject's membership, with at least one event carrying a step.
- `coverage.surface` — how many of this plugin's OWN tools were called in this window, out of
  how many it has: the tools its skills name, narrowed to the ones its own door serves when it
  has a door (a skill naming a tool another door serves does not make that tool this plugin's). `source`
  says where that door's list came from. `observed` never exceeds `total`.
- `facts` — a flat map, one entry per named fact: `{numerator, denominator, value, coverage}`
  when the population is non-empty, `{value: null, reason}` when it is not. **A missing input is
  never `0`.** Covers outcomes, stage returns, repeated document reads, tool-call volume, refusals (with a normalised-text
  and owner-attributed `detail` breakdown), latency p50/p90, request/response bytes, document
  approvals/revisions, never-called tools, and dependency failures (refusals owned by
  `theirs`). No fact covers a plugin's own model use: the platform cannot observe it, and the
  model calls it records are its own evaluation spend.
- `traces` — run/path/return/use detail, for the narration these facts summarise. A **return**
  is read off the documents, never off the step a caller's last `skill_read` set: a successful
  write to a stage's document after a later stage's document of that initiative already existed
  (`stage_return_rate` is returns over successful stage-document writes). A **repeated read** is
  a `document_read` of a path the same run already read with nothing written to it between
  (`repeat_read_rate`); a read of a section, an offset or an older version is never one.
  `traces.run_refs` lists the observed runs, newest first — each `run_id` with its `team` and
  `initiative`. A `run_id` is what EVALUATE takes as a run-kind `subject_ref`, and what a
  finding cites; never cite an initiative slug without its team.
- `environment_digest` / `evidence_digest` — the snapshot's own identity: deployed service
  versions, and a hash over the canonical facts.
  Two observations of the same release in two environments, or two windows, mint two snapshots.

## Read the coverage before you read anything else

`coverage.surface: { observed: 9, total: 12 }` means 9 of this plugin's 12 named tools were
actually called in this window. Say that out loud when you narrate the profile, and do the same
for every individual fact's own `coverage` — each one names the population it was drawn from,
and they are not all the same population. **A number without its denominator can be wrong by
three orders of magnitude and look fine.**

## A replayed call can report drift

Calling `plugin_profile` again with the same `idempotency_key` replays the same
`observation_snapshot_id` — the row is never updated — but the facts in the response are
recomputed fresh over that row's own stored window, so the reply can carry
`evidence_digest_drifted: true` if the underlying log has since changed (a correction, a
deletion). The snapshot row itself never changes; only report the drift, never treat it as a
new observation.

## Conformance, for a plugin with no history of its own

`plugin_conform` reports R1-R14 as `true`, `false` or **`not_measured`**. Five are always
`not_measured` because the contract itself refuses to score them — a battery that guessed would
hand out passes this standard never granted. Clauses that do not apply to a flow plugin come
back `not_measured` too, never `true`. Use it when a plugin is somebody else's and has no runs
here — a starting point DEFINE can read.

## Pitfalls

❌ **Stopping on a thin window.** Only a window with no run is refused — pick a version the
refusal names.

❌ **Reading a fact without its own `coverage`.** The top-level `coverage.surface` and a single
fact's `coverage` answer different questions.

❌ **Calling a return good or bad.** That is DEFINE/QUALIFY's job, over what DISCOVER mines from
this snapshot.

❌ **Passing a plugin name instead of a `subject_version_id`.** IDENTIFY first, always — an
evaluation cannot drift onto a different version of its own subject halfway through.

## Skill contract

**Outcome:** one immutable `observation_snapshot_id`, with its sufficiency verdict and every
fact's own coverage said out loud, ready for DISCOVER to mine and DEFINE/QUALIFY to read.

**Required evidence:** `plugin_profile`'s own response — `usable_run_count`, `total_run_count`,
`coverage`, `facts`, `environment_digest`, `evidence_digest`. Never a figure re-derived by hand
from `traces`; the facts map is the number, `traces` is only the narration underneath it.

**Allowed unknowns:** whether this evidence is enough to establish a score — that is
`evaluation_score`'s own `score_status`, three stages later. A thin window here is reported, not
resolved.

**Action and exit paths:** the action is call `plugin_profile` with the resolved
`subject_version_id` and window, read `sufficient_for_judging` and every fact's own coverage,
and say what the window shows. The exit is DISCOVER (`zz-plugin-discover`), always, whatever the
window's sufficiency — a thin window still has failure modes worth mining, even if few.

**Degraded behaviour:** a window with runs too few to judge still gets a snapshot, facts with
empty populations `{value: null, reason: "..."}` and `sufficient_for_judging: false`. A window
with no run is refused by name, with the versions that have runs; a plugin with no run in any
version is reported as unused, which is a complete outcome, not a failure.
