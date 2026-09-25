---
name: zz-plugin-improve
version: 0.10
description: Stage 7 of zz-plugin-eval (IMPROVE). Turn plugin-owned findings into one candidate patch, build and gate it locally, and hand it to promotion for an owned subject — or write an owner-facing proposal for one this team cannot release. A released improvement is judged on real use afterwards, never by replaying past initiatives first.
when_to_use: "The seventh stage of zz-plugin-eval, after EXPLAIN. Runs for every branch except one with no plugin-owned actionable finding at all, which skips it with one call and closes. REQUIRES a shell-capable runtime (Claude Code) that can run npm/zz-tool commands — refuses to start anywhere else. Every stage before this one runs with no shell at all (FR-54)."
---

# zz-plugin-improve

**Stop here if your runtime cannot run a shell command.** Everything up through EXPLAIN is
MCP-only calls a bare client can make (FR-54). From here on, a candidate is built by the agent
running this stage — `npm run candidate-build`, and later `zz-tool release-apply` and
`zz-tool release-rollback` — and none of that exists without a shell. If you have no shell
access, stop and say so; do not simulate what these commands would do.

**No replay, no proof, no search.** A candidate that applies, builds and passes the repository's
own gate is releasable. Whether it is actually better is decided after release, on real use
(`release_verify`, PROMOTE/VERIFY), and a release that measures worse is rolled back.

## First: is there anything to improve?

`eval_run_id` and every finding's id are in `<initiative>/findings.md` — the run's id under
`## Score`, each finding's `id` beside it — so this stage can open in a fresh conversation.

```
improvement_start(eval_run_id, finding_ids: [], skip: true, initiative, idempotency_key)
```

**No plugin-owned finding, or the only ones are not yet actionable:** call `skip: true` with no
`finding_ids`. This opens no improvement_run, records `improvement_mode: skip` and
`release_mode: not_applicable` as this initiative's durable branch facts in one call, and the
initiative closes on `findings.md` alone — `initiative_close(initiative, "finished", ...)`, no
`improvement.md`, no `proposal.md` invented. REFUSES a non-empty `finding_ids` alongside `skip`,
and REFUSES if a plugin-owned DEFECT or UNKNOWN for this `eval_run_id` is still `deferred` — name
it and open the run with it instead. **A plugin-owned STRENGTH never blocks skip** — it carries
no `expected_effect` and could never seed a candidate.

**Otherwise:**

```
improvement_start(eval_run_id, finding_ids: [...plugin-owned, deferred...], initiative, idempotency_key)
```

opens one durable `zz.improvement_run` and RETURNS `improvement_run_id`,
`base_subject_version_id` (the subject every candidate is a patch against) and `proposer_bundle`.
Keep the first two: every later call in this stage names them. Records `improvement_mode:
release` when the base subject records `release_owners`, `improvement_mode: proposal` when it
does not — you never choose which; the tool derives it from ownership. REFUSES a finding owned by
anything but `plugin`, and a finding recorded against a different `eval_run_id`.

## The proposer bundle — read this before proposing anything

`proposer_bundle` is FR-37's own "actionable side information", assembled so the proposer never
guesses blind: `failing_traces` (measure key, subject ref, the detail that failed),
evaluator_critiques, `refusal_text`, `corrections`, `errors`, and `prior_rejected_hypotheses` —
every candidate of this plugin that failed its build or gate, or was released and rolled back,
by hypothesis text, so a repeat idea is never proposed a second time. `non_trivial: false` means
every section is empty — say so rather than inventing a hypothesis from nothing.

**Compose the actual patch yourself, as a unified diff.** Nothing here generates a patch for
you — you read the bundle and the findings and write the fix, in whatever component the finding
actually names: a skill, a prompt, a flow definition, a tool, code, schema, configuration, tests
or documentation (FR-35 — any component necessary, never limited to `SKILL.md`). Keep it to the
smallest change the finding asks for: it will be judged on real use, where a broad change is
hard to attribute.

## Recording a candidate — before anything about it executes

```
candidate_record(improvement_run_id, base_subject_version_id, hypothesis, expected_effect, patchset: { diff }, idempotency_key)
```

`patchset.diff` is a unified diff against the base subject's own release — the file list and
added/removed state are derived from it, never supplied separately. RETURNS `{ candidate_id,
patch_digest, complexity_delta, touched_components, touched_owners, status: 'recorded' }`.
**REFUSES a hypothesis whose normalised text already matches a candidate of this plugin that is
`invalid` or `rolled_back`**, naming it. That is FR-38's regularization working, not a bug to
route around: propose something genuinely different.

## Building and gating it — locally, never on the platform

```
candidate_validate(candidate_id, idempotency_key)
```

**First call on a `recorded` candidate** moves it to `awaiting_build` and RETURNS `{
candidate_id, status: 'awaiting_build', build_required: { patch_digest, lease_expires_at, command
} }`. **The platform never builds a candidate** — you do, locally, with the command it printed:

```
npm run candidate-build -- --candidate <candidate_id> --repo <path-to-a-checkout>
```

It needs the gateway (`ZZ_URL` or `--gateway <url>`) and your own platform token (`$ZZ_TOKEN`,
`$ZZ_TOKEN_FILE` or `~/.zz/token`) — nothing on the command line. It reads the candidate
(`candidate_read`), fetches the base subject (a catalog plugin: `--repo` cloned at
`v<declared_version>`; a third-party one: its captured source, checked against the digests it was
captured at), applies the patch, and for a catalog plugin installs the clone's own locked
dependencies (`npm ci`) and runs the repository's build and gate in that clone inside an OS
sandbox (`sandbox-exec` on macOS, `bwrap` on Linux) with none of your credentials in reach; for a
third-party plugin the check is that the patch applies cleanly. Before cloning it checks this
host can run every tool the build and gate need. It records the result itself
(`candidate_build_record`) and exits 0 on a passed build, 1 on a failed one it recorded, 2 when it
recorded nothing — no working sandbox, a tool the host check could not run, a release tag `--repo`
lacks, or a refusal; fix that and run it again. Only you — the principal whose
`candidate_validate` asked — can record the build, and only within the lease (60 minutes); a lease
that ends with nothing recorded returns the candidate to `recorded`. Calling `candidate_validate`
before the build is recorded prints the same `build_required` again.

**Then call `candidate_validate` again.** It consumes the recorded build:

- **passed** → `valid`, and it RETURNS `{ candidate_id, status: 'valid', patch_digest,
  releasable: true, build, next }`. That candidate is releasable.
- **a failed apply, install, build or gate** → `invalid`, and the call REFUSES with the failing
  command's own output tail. `invalid` is not re-triable in place: fix the patch and record a new
  candidate with a different hypothesis.
- **a timeout, or a problem on this host** (`stage: host` — a docker daemon or registry out of
  reach) → back to `recorded`: nothing about the patch was judged. Fix the host and validate
  again.

## Where this stage ends

**Owned subject, a candidate is valid:** the handoff to PROMOTE/VERIFY
(`zz-plugin-promote-verify`). This stage ends once you call `release_prepare(initiative, ...)` —
it finds the valid candidate from the initiative (pass `candidate_id` when more than one is
valid) and records `release_mode: promotable`. Read that skill for the rest.

**Owned subject, no candidate worth releasing** — every one failed its build or gate, or the
findings name nothing a patch could fix:

```
improvement_stop(initiative, idempotency_key)
```

records `release_mode: not_applicable`; `initiative_close(initiative, "finished", ...)` then
closes on `findings.md` alone. REFUSES while a candidate is `valid` (prepare it instead) and on a
subject with no release owners (write its proposal instead).

**Non-owned subject — write the proposal:**

```
proposal_prepare(initiative, idempotency_key)
```

**WHEN the base subject records no release owners** — a third-party or other-team plugin
`plugin_register` captured. It finds the newest improvement run on the eval_run `findings.md`
records and writes `<initiative>/proposal.md`, ungated, always regenerated FRESH from the run's
current findings and candidates: Subject, Findings, Candidates (every valid candidate, with its
hypothesis, patch digest, build result and the diff itself as inert fenced markdown, when the
subject's own source is readable — findings-only prose, no diff fence, when it is not),
Ownership and promotion. RETURNS `{ document, candidates_included }`; on a refused write,
`document: null` with document_refused naming why. **REFUSES `promotable` — a subject that DOES
record release owners** (use `release_prepare` instead) — and records `release_mode:
proposal_only`. Applies no patch and touches no real repository, ever. Like `findings.md`,
`proposal.md` is ungated and regenerated by the tool itself — it does not paste through
`document_present`, because nobody's approval is asked before it stands. Once written, the
initiative closes on `proposal.md` — `initiative_close(initiative, "finished", ...)`;
`zz-handover` writes cold afterwards, as after every other close.

## Pitfalls

❌ **Trying to run this stage with no shell.** Stop and say so.

❌ **Waiting for `candidate_validate` to build the candidate.** It never does; run the
`npm run candidate-build` command its `build_required` prints, then call it again.

❌ **Re-proposing a hypothesis `candidate_record` already refused.** The message names the
earlier candidate; propose something genuinely different.

❌ **Leaving an owned subject with nothing releasable open.** Without `improvement_stop`,
release_mode stays undetermined and a finished close hits `branch_undetermined`.

❌ **Calling `release_prepare` for a subject with no release owners.** It refuses
`no_release_owners` and names `proposal_prepare` instead.

## Skill contract

**Outcome:** one of four: an owned subject with a built, gated candidate handed to
PROMOTE/VERIFY; an owned subject with nothing worth releasing, stopped with `improvement_stop`; a
non-owned subject with an owner-facing `proposal.md`; or a subject with nothing plugin-owned to
improve, closed on `findings.md` alone. Every candidate tried, durably recorded with its
hypothesis, patch digest and build result.

**Required evidence:** every terminal tool response read verbatim — `candidate_record`'s
`patch_digest`/`complexity_delta`, `candidate_validate`'s `status` and `build` or its refusal
tail. The build command's own exit status and output.

**Allowed unknowns:** whether the candidate improves the plugin — real use after release answers
that, not this stage.

**Action and exit paths:** propose from the bundle, record, build and gate locally, then hand
off. The four exits above; `initiative` on the terminal call is what decides which document —
`improvement.md`, `proposal.md` or neither — a finished close will later require.

**Degraded behaviour:** a host that cannot build (no sandbox, no docker) records nothing and
judges nothing — fix the host, never record a build by hand. A patch that keeps failing its gate
is an honest `improvement_stop`, not a reason to weaken the gate.
