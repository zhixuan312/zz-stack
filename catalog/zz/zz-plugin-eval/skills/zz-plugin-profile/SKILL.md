---
name: zz-plugin-profile
version: 0.3
description: Stage 2 of plugin evaluation. Compute the two evidence blocks — traces from real runs and cases from the ablation suite — each with its own sufficiency verdict and the coverage it was derived from. No model touches any of it.
when_to_use: "The second stage of zz-plugin-eval, after locate has settled the plugin and version. Also the stage that decides whether there is enough to judge."
---

# zz-plugin-profile

```
plugin_profile(plugin, version)     the two evidence blocks
plugin_conform(plugin, version)     R1–R14, three-valued
```

Neither calls a model. Every field is a count, a set, an ordering or a difference.

## Two blocks, two sufficiency lines, and only both empty is a stop

```
CASES     4 · mean Δ +0.62 · last run 2026-09-13          sufficient
TRACES    6 usable runs · coverage 198/510                sufficient
```

| block | sufficient at | why the line is there |
|---|---|---|
| cases | **1 case** | cases need no history; one real counterfactual beats none |
| traces | **5 usable runs** | a floor for a signal to exist, not a claim about power |

**A thin trace block does not stop this flow.** Report it as thin and go on to `define` with the
cases. The stop condition is `sufficient_for_judging: false`, which means *both* are empty —
and even then, `locate` and `profile` still ran and still reported. **A plugin nobody has used
is a correct and complete outcome**, not a failure. Say so plainly rather than treating the
refusal as an error, or the next agent starts inventing data to get past it.

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

**CASES** — from the recorded ablation run:

Every case ran twice, once with the plugin and once without, and the delta is the difference. A
delta is a **counterfactual**: it says the plugin caused the outcome, which no score can.

- `discriminating` per case: `strong`, `weak`, `dead` or `harmful`. A `dead` case is one both
  arms pass or both arms fail — it does not test the plugin, and it is noise in the mean. A
  `harmful` one is the opposite of noise: the arm WITH the plugin did worse. Never average a
  `harmful` case away — say which case it was and what it asked.
- `last_run` — **always report the date.** A three-week-old delta read as today's is worse than
  no delta.

## Read the coverage before you read anything else

`coverage: { events: 510, with_step: 198, resolvable: 198 }` means every figure above rests on
198 of 510 events. Say that out loud when you narrate the profile.

This rule was bought expensively. The run table once reported 1805 rows when four were real, for
weeks, and every query that read it read a healthy-looking table. **A number without its
denominator can be wrong by three orders of magnitude and look fine.**

## If the case block is empty and somebody wants one

Running the suite is a deliberate act and nothing here does it for you: it is a CLI on this
machine spending this account's own credential, roughly $0.40 a case.

```
claude plugin eval <plugin>@zz-stack --json <path>
plugin_cases_record(plugin, version, result: "<the JSON at that path, verbatim>")
```

Recording is what gives a delta a timestamp. Ask before spending; do not run it because a
profile looked thin.

**The target is ONE built plugin directory: `marketplace/<plugin>`.** From a checkout of this
repository that is `marketplace/sdlc`, `marketplace/zz-access`, `marketplace/zz-plugin-eval` or
`marketplace/zz-core` — not the `@zz-stack` form, and above all **not the repository root.**

The root resolves too, which is the trap. It resolves ALL FOUR plugins at once and runs every
case in the repository as a single suite: measured 2026-09-13, that ran for two hours and twenty
minutes over twelve cases, never reached a single baseline arm, and had to be killed — and what
it wrote was `partial: true` carrying with-arm scores only, which reads like a suite where the
plugin helped with nothing. 89MB of repository against 144KB of built plugin. Point it at one
plugin.

The other way to get it wrong is quieter: point it somewhere with no `evals/` below it and it
reports "no eval cases found", which reads exactly like a plugin that has none.

**Every plugin's MCP servers are absent from BOTH arms** unless you pass `--allow-real-servers`,
which starts them as you, outside the sandbox. Do not. A case that grades whether a tool was
actually CALLED therefore reads zero on both sides and contributes nothing; grade what the
skill makes the agent say, name and decline. Every case in this repository is written that way.

**A grader that measures zero is a result, not a broken case.** zz-access's
`kills-it-first` predicted ~0.8 and measured 0.00 — a bare agent revokes a leaked credential
first as readily as the plugin does. It is left exactly as written, with the measurement
recorded beside the prediction. Editing a case until it flatters its plugin ends the series:
nothing after it can be compared with anything before it.

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

❌ **Averaging a `dead` case into the mean without saying so.**

❌ **Running the case suite to fill a gap nobody asked about.** It costs money.
