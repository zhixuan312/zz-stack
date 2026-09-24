---
name: zz-plugin-profile
version: 0.8
description: Stage 2 of plugin evaluation. Compute the evidence block — traces from this plugin version's real runs — with its sufficiency verdict and the coverage it was derived from. No model touches any of it.
when_to_use: "The second stage of zz-plugin-eval, after locate has settled the plugin and version. Also the stage that decides whether there is enough to judge."
---

# zz-plugin-profile

```
plugin_profile(plugin, version)     the two evidence blocks
plugin_conform(plugin, version)     R1–R14, three-valued
```

Neither calls a model. Every field is a count, a set, an ordering or a difference.

## One block, one sufficiency line

```
TRACES    6 usable runs · coverage 198/510                sufficient
```

| block | sufficient at | why the line is there |
|---|---|---|
| traces | **5 usable runs** | a floor for a signal to exist, not a claim about power |

**A thin trace block does not stop this flow.** Report it as thin and go on. The stop condition
is `sufficient_for_judging: false` — and even then, `locate` and `profile` still ran and still
reported. **A plugin nobody has used is a correct and complete outcome**, not a failure. Say so
plainly rather than treating it as an error, or the next agent starts inventing data to get
past it. A ruler whose subject is the document or the initiative may have subjects even when
the trace history is thin; `ruler_read` says what is there.

## What each block actually says

**TRACES** — from the event log:

- `runs` / `usable_runs` — a usable run is one attached to an initiative, naming a skill version
  in this plugin version's membership, with at least one event carrying a step.
- `returns` — a stage entered after a later stage already ran. **Counted, never classified.**
- `unplaced` — steps in the log that the manifest declares no stage for. Worth a person's eye:
  either a stage was removed and the log remembers, or a name has drifted.
- `use` — calls and refusals per tool.
- `never_called` — tools this plugin's skills name and no run ever called. This is the half of
  搭不搭 no static check can see.
- `coverage` — the denominator for all of it.

## Read the coverage before you read anything else

`coverage: { events: 510, with_step: 198, resolvable: 198 }` means every figure above rests on
198 of 510 events. Say that out loud when you narrate the profile.

This rule was bought expensively. The run table once reported 1805 rows when four were real, for
weeks, and every query that read it read a healthy-looking table. **A number without its
denominator can be wrong by three orders of magnitude and look fine.**

## Conformance, for a plugin with no history of its own

`plugin_conform` reports R1–R14 as `true`, `false` or **`not_measured`**. Five are always
`not_measured` because the contract itself refuses to score them — *"a battery that guessed
would hand out passes this standard never granted."* Clauses that do not apply to a flow plugin
come back `not_measured` too, never `true`.

Use it as a starting ruler when a plugin is somebody else's and has no runs here.

## Pitfalls

❌ **Stopping on a thin trace block.** Only both blocks empty is a stop.

❌ **Reading a number without its coverage.**

❌ **Calling a return good or bad.** That is `define`'s job. See the entry skill.

❌ **Treating a thin trace block as a failure.** A plugin nobody has used yet is a plugin. Say
so; do not go looking for a second source of evidence to fill the gap.
