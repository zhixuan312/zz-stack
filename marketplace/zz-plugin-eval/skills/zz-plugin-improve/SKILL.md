---
name: zz-plugin-improve
version: 0.2
description: Stage 7 of zz-plugin-eval (IMPROVE). Search for a proven candidate patch against plugin-owned findings — propose, validate by replay, search to one deterministic winner, prove it sealed — then hand off to promotion for an owned subject or write an owner-facing proposal for one this team cannot release.
when_to_use: "The seventh stage of zz-plugin-eval, after EXPLAIN. Runs for every branch except one with no plugin-owned actionable finding at all, which skips it with one call and closes. REQUIRES a shell-capable runtime (Claude Code) that can run npm/zz-tool commands and launch isolated sessions — refuses to start anywhere else. Every stage before this one runs with no shell at all (FR-54)."
---

# zz-plugin-improve

**Stop here if your runtime cannot run a shell command.** Everything up through EXPLAIN is
MCP-only calls a bare client can make (FR-54). From here on, replay and candidate execution are
launched BY the agent running this stage — `npm run replay`, `zz-tool release-apply`, `zz-tool
release-rollback` — and none of that exists without a shell. If you are running in a context with
no shell access, stop and say so; do not simulate what these commands would do.

## First: is there anything to search for?

```
improvement_start(eval_run_id, finding_ids: [], skip: true, initiative, idempotency_key)
```

**No plugin-owned finding, or the only ones are not yet actionable:** call `skip: true` with no
`finding_ids`. This opens no improvement_run, records `improvement_mode: skip` and
`release_mode: not_applicable` as this initiative's durable branch facts in one call, and the
initiative closes on `findings.md` alone — `initiative_close(initiative, "finished", ...)`, no
`improvement.md`, no `proposal.md` invented. REFUSES a non-empty `finding_ids` alongside `skip`,
and REFUSES if a plugin-owned DEFECT or UNKNOWN for this `eval_run_id` is still `deferred` — name
it and open the run with it instead. **A plugin-owned STRENGTH never blocks skip** — EXPLAIN
records strengths with `owner_kind: plugin` too, but a strength carries no `expected_effect` and
could never seed a candidate, so leaving one `deferred` is not a reason this call refuses.

**Otherwise:**

```
improvement_start(eval_run_id, finding_ids: [...plugin-owned, deferred...], initiative, idempotency_key)
```

opens one durable `zz.improvement_run` and RETURNS `search_policy` (the protocol's own
liveness bound — `maxGenerations`, `maxCandidatesPerGeneration`, `wallClockHours` — FR-57's
bootstrap defaults are 5/8/24) plus `proposer_bundle`. Records `improvement_mode: search` when
the base subject records `release_owners`, `improvement_mode: proposal` when it does not — you
never choose which; the tool derives it from ownership. REFUSES a finding owned by anything but
`plugin`, a finding recorded against a different `eval_run_id`, and a protocol version whose
`improvement.search` is missing or malformed — there is no fallback policy.

## The proposer bundle — read this before proposing anything

`proposer_bundle` (from `improvement_start`, and read back again from every later
`candidate_search` call) is FR-37's own "actionable side information", assembled so the proposer
never guesses blind: `failing_traces` (measure key, subject ref, the detail that failed),
evaluator_critiques — a bounded_semantic/generative_critic's own note on why — `refusal_text`,
`corrections`, `errors`, `cost_latency`, and `prior_rejected_hypotheses` — every candidate this
plugin has already tried and lost, by hypothesis text, so a repeat idea is never proposed a
second time. `non_trivial: false` means every section is empty — a proposer reading that bundle
is reading nothing this run actually learned; say so rather than inventing a hypothesis from
nothing.

**Compose the actual patch yourself, as a unified diff.** Nothing here generates a patch for
you — you read the bundle, the findings, and (later) `explore_components`, and write the fix, in
whatever component the finding actually names: a skill, a prompt, a flow definition, a tool, code,
schema, configuration, tests or documentation (FR-35 — any component necessary, never limited to
`SKILL.md`).

## Recording a candidate — before anything about it executes

```
candidate_record(improvement_run_id, base_subject_version_id, parents: [], hypothesis, expected_effect, patchset: { diff }, idempotency_key)
```

`patchset.diff` is a unified diff — the file list and added/removed state are derived from it,
never supplied separately. RETURNS `{ candidate_id, generation, patch_digest, complexity_delta,
touched_components, touched_owners, status: 'recorded' }`. **REFUSES a hypothesis whose
normalised text already matches a candidate this plugin has already rejected (`rejected_precheck`,
`invalid`, `proof_failed`) or whose latest validation verdict was `not_improved`** — naming the
id and telling you which. That is FR-38's regularization working, not a bug to route around:
propose something genuinely different, or explain in the new hypothesis what changed.

`generation` is the search's own round, not lineage: a candidate joins the current generation
until every candidate in it has a validation verdict (or was rejected), then the next one.
`parents` (candidate ids) only records lineage. **REFUSES once the current generation already
holds `maxCandidatesPerGeneration` candidates** — validate them first — and once `maxGenerations`
generations hold a validated candidate (call `candidate_search` to select).

## Validating — build, gate, then replay against baseline

```
candidate_validate(candidate_id, idempotency_key)
```

**First call on a `recorded` candidate:** asks the leakage critic first (FR-38) — a patch that
reads as hard-coded against evidence it should not have, or a rejected hypothesis restated,
becomes `rejected_precheck` and the call REFUSES with the critic's reason. Otherwise it builds its
own worktree from this checkout, applies the patchset, runs the repository's build and gate in
isolation. **A build/gate failure moves the
candidate to `invalid` and REFUSES with the failing command's own output tail** — never
replayed, never partially scored; fix it and record a fresh candidate (`invalid` is not
re-triable in place).

**Once valid (or on a later call):** reads every completed, scored validation-split
`zz.replay_run`, pairs candidate against baseline by case, and — once every case has at least
`minRepeats` completed runs on BOTH sides — computes the paired bootstrap verdict. Otherwise
RETURNS `{ candidate_evaluation_id: null, verdict: null, runs_required: [{case_id, side,
count}] }` — the exact `(case, side)` pairs still short. **This tool never launches a replay
itself.** For each `runs_required` entry:

```
replay_start(case_set_id, subject_version_id? | candidate_id?, split: "validation", case_id, repeats, context: "search", idempotency_key)
```

— `subject_version_id` for the `baseline` side, `candidate_id` for the `candidate` side, never
both — then, for the `worktree_ref`/`replay_run_id` it returns:

```
REPLAY_TOKEN=<token> npm run replay -- --run <replay_run_id> --repo <path-to-a-checkout>
```

`REPLAY_TOKEN` is the `token` `replay_start` returned, passed in the environment and never as an
argument. The launcher marks the run `running`, clones `--repo` standalone at the subject's own
release tag (`v<declared_version>`) and refuses — closing the run `failed` — when that tag's
plugin digest is not the one the subject was captured at. It installs the subject plugin into a
session-local `CLAUDE_CONFIG_DIR` under a temporary `HOME`, with none of your own credentials in
the sessions' environment, and runs every session inside an OS sandbox (`sandbox-exec` on macOS,
`bwrap` on Linux) that cannot read your home directory or write outside its own. **With no
working sandbox it refuses to start** — install bubblewrap, or run it outside any enclosing
sandbox; there is no unsandboxed mode. It then runs the candidate/baseline session against `actor` events and a simulated
person against `actor`+`user_oracle` events, scores it, and calls `replay_close` itself — you do
not close a run the launcher already ran. Repeat `candidate_validate` once enough runs land; it
plans, it never executes.

## No case set yet? Build one before validating

```
replay_case_set_build(subject_version_id, protocol_version_id, source_scope: {initiatives: [...]} | {flow, closed_between: [from, to]}, idempotency_key)
```

Derives FR-60's chronological cases from real closed initiatives — classifying each source
person_statement/`agent_record`, building actor/`user_oracle`/evaluation_oracle timelines,
splitting every replayable case `evolve`/`validation`/`proof` by `sha256(seed, case_digest)`.
RETURNS `{ case_set_id, version, counts: {evolve, validation, proof, not_replayable},
minimums_met, source_kind_qualification }`. FR-57's bootstrap minimums are 5 evolve, 10
validation, 10 proof — below a minimum, search may still run, but `candidate_prove` will record
`not_established, reason: insufficient_proof_cases` and the candidate is not release-eligible.
Build this once per plugin version's own material; unchanged source reuses the existing case set
rather than minting a redundant one.

## Advancing the search

```
candidate_search(improvement_run_id, idempotency_key, initiative?)
```

Call this to move the search forward once you have proposed/validated what you can this
generation. It composes at most one new child per call from two disjoint-file `valid`
candidates, reduces everything with a validation evaluation to the Pareto frontier over
(per-case pass vector, cost), and — once the protocol's own liveness bound is reached — selects
exactly one final candidate by the protocol's deterministic selection policy, from the frontier
members validation found `improves` (or an accepted pruning). It asks no model; the leakage
screen already ran in `candidate_validate`. RETURNS `{
generation, frontier_ids, rejected, selected_id, status, explore_components, edit_budget,
proposer_bundle, next }`.

**Read `next` and `explore_components` to decide what to do next**, not your own judgement of
"enough": `next` says propose more (steered at `explore_components` — the base subject's own
manifest components no candidate this run has touched yet, FR-38's own exploration
requirement), validate what is already recorded, or stop. `edit_budget` is
`maxCandidatesPerGeneration` — how many candidates this generation may still record.

**`status: closed` with `selected_id: null` means no guardrail-passing, improving candidate was
on the frontier by the bound.** On an OWNED subject that is genuinely nothing left — pass `initiative` on
this call (or the one that produced this outcome) and `release_mode: not_applicable` is recorded
for you; `initiative_close` then closes on `findings.md` alone, same as a `skip`. On a NON-owned
subject, nothing is recorded here even with `initiative` passed — `proposal_prepare` below can
still write up whatever candidates reached `valid`, selected or not; do not treat this as the
end of the road for that branch.

## Proving the selected candidate — sealed, opened once

```
candidate_prove(candidate_id, idempotency_key, abandon?, initiative?)
```

Only the candidate `candidate_search` left `selected` may open this, and only once (FR-28). A
FIRST call mints a `verifier_token` bound to this one allocation (this candidate, this case
set, the proof split), moves the candidate to `proving`, spends the case set's proof cases, and
RETURNS `{ proof_status: null, verifier_token, runs_required: { case_set_id, baseline,
candidate }, status: 'proving' }` — never resolving in the same call. `runs_required` is COUNTS
per side, never case ids: you never learn which proof case a run used. Run them one at a time:

```
replay_start(case_set_id, candidate_id | subject_version_id, split: "proof", context: "verifier", verifier_token, repeats, idempotency_key)
REPLAY_TOKEN=<token> VERIFIER_TOKEN=<verifier_token> npm run replay -- --run <replay_run_id> --repo <path>
```

`candidate_id` for the candidate side, the candidate's `base_subject_version_id` for the
baseline side. **Never pass `case_id`** — the proof case is drawn server-side, and a verifier
`replay_start` naming one REFUSES; so does one outside the allocation (another case set,
candidate or subject). Start the next run once the launcher returns: the draw skips a case with
a run still live, so starting many at once runs out of cases. `VERIFIER_TOKEN` goes in the
environment, never on the command line, where `ps`, shell history and logs would keep it. The
launcher uses it for its own calls only; neither replay session sees it. Under the token,
`replay_read` of a proof run returns no case id, score or cost, and `replay_score` answers
`sealed: true` with no number — **do not use the token for anything but the launcher.**

**A LATER call** against the same `proving` candidate reads back whatever proof-split runs
completed and scored; once enough exist, it re-screens for leakage (an unclear or unavailable
answer is `not_established, reason: leakage_unresolved` — never a pass), computes the paired
verdict, and RETURNS `{ proof_status: proof_passed | proof_failed | not_established, reason,
release_eligible, candidate_evaluation_id, status }` — **never a per-case result; search never
sees a proof case or a proof result.** release_eligible is additionally true only when the base
subject records release owners (FR-47).

**Every terminal outcome spends the allocation, and opening it spent the case set:** proving
again needs a new case set (new evidence), whichever candidate. On an OWNED candidate, a
`proof_failed` outcome leaves nothing left to promote or propose — pass `initiative` and
`release_mode: not_applicable` is recorded for you. A `not_established` outcome records nothing:
it is an evidence gap a fresh `improvement_start` in this initiative may resume from. On a NON-owned candidate, nothing is
recorded even with `initiative` passed: the candidate already reached `valid` before proof ever
opened, so `proposal_prepare` below can still report it, whatever proof said. A `proof_passed`
candidate with NO release owners reaches `status: closed` (a proposal-eligible outcome, not
nothing-to-promote) either way — leave that one for `proposal_prepare` below.

**`abandon: true`** recovers an allocation stuck `proving` because you lost the response that
opened it — no `verifier_token` holder, nothing else can resolve it. It revokes the token,
cancels whatever proof runs it spawned (the case set stays spent), and resolves
`proof_not_established, reason: abandoned`
(an evidence gap, not a rejected hypothesis — the SAME hypothesis may be proposed again under a
fresh `improvement_start`). A second `abandon` call is a no-op read-back, never a refusal.

## Owned subject, proof passed: promotion

`release_eligible: true` is the handoff to PROMOTE/VERIFY (`zz-plugin-promote-verify`) —
`release_prepare`, `improvement.md`, `release_apply` (`zz-tool release-apply`), `release_record`,
`release_verify` (`zz-tool release-rollback`). Read that skill for the exact sequence; this stage
ends once you call `release_prepare`, which records `release_mode: promotable`.

## Non-owned subject: write the proposal instead

```
proposal_prepare(improvement_run_id, initiative, idempotency_key)
```

**WHEN the base subject records no release owners** — a third-party or other-team plugin
`plugin_register` captured. Writes `<initiative>/proposal.md`, ungated, always regenerated FRESH
from the run's current findings and candidates: Subject, Findings, Candidates (every candidate
that reached validation or later, with its hypothesis, patch digest and the diff itself as inert
fenced markdown, when the subject's own source is readable — findings-only prose, no diff fence,
when it is not), Ownership and promotion. RETURNS `{ document, candidates_included }`; on a
refused write, `document: null` with document_refused naming why. **REFUSES `promotable` — a
subject that DOES record release owners** (use `release_prepare` instead) — and records
`release_mode: proposal_only`. Applies no patch and touches no real repository, ever, on this or
any subject: it is a database read and a document write, nothing else. Like `findings.md`,
`proposal.md` is ungated and regenerated by the tool itself — it does not paste through
`document_present`, because nobody's approval is asked before it stands. Once written, the
initiative closes on `proposal.md` — no promotion, ever, through this platform, for a subject
this team does not own. `initiative_close(initiative, "finished", ...)` closes it; `zz-handover`
is what writes cold afterwards, the same as every other close this flow reaches.

## Pitfalls

❌ **Trying to run this stage with no shell.** Stop and say so; nothing here simulates what a
launcher command would have done.

❌ **Skipping `replay_case_set_build` and calling `candidate_validate` cold.** It refuses a case
set with no replayable validation-split case.

❌ **Closing a replay_run the launcher already closed.** `npm run replay` always calls
`replay_close` itself, success or failure.

❌ **Re-proposing a hypothesis `candidate_record` already refused.** It is regularization
working, not a bug — the message names the earlier candidate; propose something genuinely
different.

❌ **Reading a proof result back into the search session.** Proof is sealed by design (FR-28); a
`not_established` proof cannot be fed back into the same generation's search — a fresh
`candidate_record`/`candidate_search` cycle is the only way forward.

❌ **Forgetting `initiative` on the call that resolves nothing-to-promote.** release_mode stays
undetermined and a finished close hits `branch_undetermined` forever.

❌ **Calling `release_prepare` for a subject with no release owners.** It refuses
`no_release_owners` and names `proposal_prepare` instead.

## Skill contract

**Outcome:** one of three: an owned subject with a sealed, proof-passed candidate handed to
PROMOTE/VERIFY; a non-owned (or exhausted) subject with an owner-facing `proposal.md`; or a
subject with nothing plugin-owned to search, closed on `findings.md` alone. Every candidate this
run tried, durably recorded with its hypothesis, patch digest, validation and (where reached)
proof evidence — nothing about a search invisible to the next one.

**Required evidence:** every terminal tool response read verbatim — `candidate_record`'s
`patch_digest`/`complexity_delta`, `candidate_validate`'s verdict or `runs_required`,
`candidate_search`'s `frontier_ids`/`selected_id`/`next`, `candidate_prove`'s `proof_status`/
release_eligible. A launcher run's own exit status and output, for whether it actually ran the
session it was asked to.

**Allowed unknowns:** which hypothesis will prove out — that is what the search is for. What
`explore_components`/`next` will say next generation — read fresh each `candidate_search` call,
never assumed from the last one.

**Action and exit paths:** the action is propose from the bundle, record, validate by replay,
search to a selection, prove it sealed. Three exits: PROMOTE/VERIFY for a proved, owned
candidate; a written `proposal.md` for a non-owned or exhausted one; a close on `findings.md`
alone for nothing plugin-owned to search at all. `initiative` on the terminal call is what
decides which document — `improvement.md` or `proposal.md` or neither — a finished close will
later require.

**Degraded behaviour:** a case set below FR-57's own minimums still runs search and validation;
only proof records `insufficient_proof_cases` and the candidate stops short of release-eligible.
A liveness bound reached with no candidate cleared the equivalence band is a real, reportable
`closed, selected_id: null` — not a reason to keep proposing past the protocol's own bound.
