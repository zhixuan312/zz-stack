---
name: zz-plugin-profile
version: 0.10
description: Stage 2 of plugin evaluation. Compute the pre-protocol observation snapshot — production facts from this subject's real runs, in one resolved window — with its sufficiency verdict and the coverage it was derived from. No model touches any of it.
when_to_use: "The second stage of zz-plugin-eval, after locate has settled the plugin and version. Also the stage that decides whether there is enough to judge."
---

# zz-plugin-profile

```
plugin_profile(subject_version_id, evidence_window, idempotency_key)   the observation snapshot
plugin_conform(plugin, version)                                       R1–R14, three-valued
```

Neither calls a model. Every fact is a count, a set, an ordering or a difference.

`plugin_profile` is a mutator: it writes exactly one immutable `zz.eval_observation_snapshot`
row and returns `observation_snapshot_id`. `subject_version_id` comes from `plugin_locate` (or
`plugin_register`) — never a bare plugin name. `evidence_window` is `{ from, to }` or
`{ last_runs: n }`; `{ last_runs: n }` resolves to the caller's most recent `n` runs at call
time and that RESOLVED range is what gets recorded, so a retry (same `idempotency_key`) replays
against the same window rather than sliding forward as new runs land.

## One window, one sufficiency line

```
6 usable runs · coverage 198/510 events                sufficient
```

| sufficient at | why the line is there |
|---|---|
| **5 usable runs** | a floor for a signal to exist, not a claim about power |

**A thin window does not stop this flow.** Report it as thin and go on. The stop condition is
`sufficient_for_judging: false` — and even then, `locate` and `profile` still ran and still
reported, and the snapshot is still written. **A plugin nobody has used is a correct and
complete outcome**, not a failure. Say so plainly rather than treating it as an error, or the
next agent starts inventing data to get past it. A ruler whose subject is the document or the
initiative may have subjects even when the trace history is thin; `protocol_read` says whether
this plugin already has a compatible protocol before the define stage writes a new one.

## What the response actually says

- `usable_run_count` / `total_run_count` — a usable run is one attached to an initiative, naming
  a skill version in this subject's membership, with at least one event carrying a step.
- `coverage.surface` — how many of the tools this plugin's skills name were actually called in
  this window, out of how many are reachable.
- `facts` — a flat map, one entry per named fact: `{numerator, denominator, value, coverage}`
  when the population is non-empty, `{value: null, reason}` when it is not. **A missing input is
  never `0`.** Covers outcomes, stage returns, tool-call volume, refusals (with a normalised-text
  and owner-attributed `detail` breakdown), latency p50/p90, request/response bytes, document
  approvals/revisions, never-called tools, tokens (cost is always `null` — nothing on this
  platform records a price), and dependency failures (refusals owned by `theirs`).
- `traces` — the same run/path/return/use detail `pluginTraces` has always computed, for the
  narration these facts summarise.
- `environment_digest` / `evidence_digest` — the snapshot's own identity: deployed service
  versions plus the models actually used in this window, and a hash over the canonical facts.
  Two observations of the same release in two environments, or two windows, mint two snapshots.

## Read the coverage before you read anything else

`coverage.surface: { observed: 9, total: 12 }` means 9 of this plugin's 12 named tools were
actually called in this window. Say that out loud when you narrate the profile, and do the same
for every individual fact's own `coverage` — each one names the population it was drawn from,
and they are not all the same population.

This rule was bought expensively. The run table once reported 1805 rows when four were real, for
weeks, and every query that read it read a healthy-looking table. **A number without its
denominator can be wrong by three orders of magnitude and look fine.**

## A replayed call can report drift

Calling `plugin_profile` again with the same `idempotency_key` replays the same
`observation_snapshot_id` — the row is never updated — but the facts in the response are
recomputed fresh over that row's own stored window, so the reply can carry
`evidence_digest_drifted: true` if the underlying log has since changed (a correction, a
deletion). The snapshot row itself never changes; only report the drift, never treat it as a
new observation.

## Conformance, for a plugin with no history of its own

`plugin_conform` reports R1–R14 as `true`, `false` or **`not_measured`**. Five are always
`not_measured` because the contract itself refuses to score them — *"a battery that guessed
would hand out passes this standard never granted."* Clauses that do not apply to a flow plugin
come back `not_measured` too, never `true`.

Use it as a starting ruler when a plugin is somebody else's and has no runs here.

## Pitfalls

❌ **Stopping on a thin window.** Only a subject with no runs recorded anywhere is a stop, and
even that still returns a snapshot — an empty one, with named reasons.

❌ **Reading a fact without its own `coverage`.** The top-level `coverage.surface` and a single
fact's `coverage` answer different questions.

❌ **Calling a return good or bad.** That is `define`'s job. See the entry skill.

❌ **Treating a thin window as a failure.** A plugin nobody has used yet is a plugin. Say so; do
not go looking for a second source of evidence to fill the gap.

❌ **Passing a plugin name instead of a `subject_version_id`.** `plugin_locate` first, always —
an evaluation cannot drift onto a different version of its own subject halfway through.
