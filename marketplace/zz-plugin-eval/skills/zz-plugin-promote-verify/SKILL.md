---
name: zz-plugin-promote-verify
version: 0.9
description: Stage 8 of zz-plugin-eval (PROMOTE/VERIFY), the promotion boundary. Once IMPROVE has a built and gated candidate of an owned subject, prepare and gate the exact patch, apply it only after every required owner approves, record what happened, then judge the release on real use — and roll it back if it measures worse.
when_to_use: "The eighth and last stage of zz-plugin-eval, reached only when release_mode is promotable — a candidate IMPROVE built and gated (valid) against an owned subject. REQUIRES a shell-capable runtime that can run zz-tool commands against a real repository checkout. Never reached on a proposal_only or not_applicable branch."
---

# zz-plugin-promote-verify

Nothing before this stage touches the real repository (FR-46). Everything from here on does,
and every step past `release_prepare` needs a person's approval first.

## Preparing the release — the one gate that authorizes it

```
release_prepare(initiative, idempotency_key)
```

**WHEN a candidate is `valid`** — built and gated by IMPROVE's own `candidate_validate`. The
initiative is all this stage needs to start, in any conversation: the tool finds the candidate
itself — the one valid candidate of the initiative's improvement runs (on the `eval_run_id` its
`findings.md` records); pass `candidate_id` when more than one is valid. Resolves required
owners LIVE from the base subject's own `release_owners` (ownership is re-checked, not cached),
records the promotion package as a `zz.release_attempt` row (`prepared`), and writes
`<initiative>/improvement.md` — the authority-bearing gate FR-48 names, naming the exact
candidate/patch digest, how it was built, the base's own score and guardrails, the affected
owners, and how the release will be judged and rolled back:

```
## Candidate  · ## Base subject · ## Patch · ## Build · ## Baseline score
## Guardrails · ## Owners       · ## Release plan · ## Rollback plan
```

RETURNS `{ candidate_id, release_attempt_id, patch_digest, required_owners, document }` —
`candidate_id` and `patch_digest` are what `release_apply` and `zz-tool release-apply` take
(`patch_digest` as `approved_patch_digest`). The candidate, the digest, the owners and the attempt
id are always returned even when the document write is refused (an unopened/closed initiative, a
document already approved), which then answers `document: null` plus document_refused naming
why; retry with the SAME `idempotency_key` to write the document against the already-recorded
attempt, never a fresh one, which would record a second attempt. REFUSES an initiative whose
`findings.md` records no `eval_run_id` (`no_eval_run`), none of whose candidates is valid
(`not_eligible`), or more than one of whose are with no `candidate_id` naming one
(`ambiguous_candidate`, listing them); a protocol version with no usable `improvement.release`;
a caller who is not a member of one of the
base subject's owner teams (`not_owner`); a base subject with NO recorded
`release_owners` — `no_release_owners`, naming `proposal_prepare` instead, back in IMPROVE; and
(FR-58, hard refusal) this initiative's release_mode already set to something other than
`promotable`. Records `release_mode: promotable` on success.

## The approval — a person, before anything real happens

`document_present` it, put it in front of every required owner, and `document_approve` it the
moment they agree — under their name, in the same turn. **`release_apply` reads the approved
document back and refuses without it**: the approval counts only when the document cites THIS
`release_attempt_id` in its body and quotes the exact `patch_digest`, and only for the
owner teams the approver is a MEMBER of. An approval of an earlier attempt's document, or by
somebody in no owner team, approves nothing. `document_approve` refuses `not_owner` on
`improvement.md` when the signer is in no owner team — and, with `on_behalf_of`, when the session
recording it is in none either.

## Applying it — the exact compare-and-swap

```
release_apply(candidate_id, approved_patch_digest, initiative, idempotency_key)
```

**`zz-tool release-apply` (below) makes this call itself — do not make it first.** A
`release_apply` you call over MCP moves the attempt to `applying`, and the CLI's own call then
refuses release_in_progress against the attempt you just opened, which stays stranded until it
goes stale. What follows is what that call decides, so you can read the CLI's output. Only an
owner-team member may make it. Takes an advisory lock on the candidate's own plugin,
evaluates against the plugin's CURRENTLY released version (the newest, by semver, registered in
`zz.plugin_version`, leaving out any version a rollback retracted — a newer registered version is
`stale_baseline` even if nobody ever located it), and — only on apply — moves the `prepared`
attempt the approved `improvement.md` cites to `applying`. RETURNS `{
status: applying | refused, reason, release_attempt_id, patch: {diff, patch_digest} | null, plan:
{plugin, declared_version, base_subject_version_id, branch, base_ref} | null }` — `base_ref` is the
commit the base subject was released from, or null when nothing recorded one. **REFUSES**
`not_owner` (the caller is in no owner team); release_in_progress, when another attempt of
this plugin is applying — wait for it, or, once the refusal names it stale, run the `--reconcile`
command it prints; `no_release_owners`/`not_eligible` (recomputed live); `approval_required` (no
approved `improvement.md` citing this attempt and quoting this exact digest, signed by an
owner-team member — NOT terminal, try again once it is approved); `digest_mismatch` (the approved digest does not match the candidate's own recorded
one); **`stale_baseline`** (the plugin's currently released subject has moved since this
candidate's own base — rebase, rebuild and re-approve before trying again; a changed patch
needs the whole cycle again too). It also refuses when the current version is not
newer than the base but was never captured — call `plugin_locate` for it first. Nothing here applies a patch or runs a gate —
zz-core has no checkout of the plugin's own repository. That is the CLI, next:

```
zz-tool release-apply --candidate <id> --repo <throwaway-clone> --initiative <initiative> \
  --digest <approved_patch_digest> --release-cmd "<the repository's own release command>" \
  --release-version <the exact version that command publishes> \
  --release-tag <the git tag that command creates and pushes> [--base-ref <commit> [--base-tag <tag>]] \
  [--gate-cmd "<override, default is npm run gate>"] [--gateway <url>] [--idempotency-key <key>]
```

Applies exactly the approved patch on a fresh `plan.branch` created at the base subject's release
commit — `plan.base_ref`, else `--base-ref`; it records `failed` without touching anything when
neither names a commit the clone has — installs the clone's locked dependencies and builds it,
runs the repository's own gate, then its own release command, locates the new subject AT `--release-version`, and reports back with `release_ref` = the
commit `--release-tag` names — only once that tag is published (on origin, or local in a clone
with no remote) and contains the candidate's commit; otherwise the attempt stays applying and the
CLI prints the `--reconcile` command. The branch is kept on success; it holds the candidate's
commit.

**The release command must keep the candidate's commit in the tag's ancestry.** Merge
`plan.branch` or tag on top of it; never squash or rebase it. A tag that does not contain the
candidate's commit cannot be tied back to this candidate, so the attempt stays applying and blocks
every later release of the plugin until someone reconciles it (below).

What the CLI records:

```
release_record(release_attempt_id, status: released, release_ref, released_subject_version_id, idempotency_key)
release_record(release_attempt_id, status: failed, failure_tail, idempotency_key)
```

**When `--base-ref` is required:** whenever `plan.base_ref` is null — the base was released by an
ordinary catalog release outside this flow (only a git-sourced third-party subject, or a base this
flow itself released, records its commit), in which case name the commit whose catalog carries
`plan.declared_version`. Also when `plan.base_ref` is a ref the clone cannot resolve — fetch the
base's release tag, or pass `--base-ref` together with `--base-tag` naming the base version's
release tag, which must contain that commit. When both refs resolve they must name the same commit.

`released` moves the attempt (and the candidate) to `released`; it refuses `not_newer` when the
subject is not newer, by semver, than the base, and the attempt stays applying so it can be
retried. `failed` moves the attempt to `failed`; the CLI has already removed its worktree and
branch. Only the principal who applied the attempt, or an owner-team member, may record it
(`not_owner`). Once the release command has succeeded the CLI never records `failed`: if locating
or recording is refused, or the process dies, the attempt stays applying and
`zz-tool release-apply --reconcile <release_attempt_id> --candidate <id> --plugin <name>
--release-version <version> --release-tag <tag> --repo <clone> [--commit <sha>]` records the truth
later — `released` only if that version is registered AND the tag contains the candidate's branch
commit (a version another release published is not this one); `failed` only if the version was
never registered AND no tag carries that commit AND the release tag is not published (a release
that landed may register late). Anything else records nothing and says why. When the release
command did squash or rebase the candidate's commit, and you have confirmed the published tag is
this attempt's own release, add `--accept-tag-without-candidate-commit`: with the tag published and
the version registered, it records `released` by the tag's commit, and the record's `reason` says
the ancestry was accepted by the operator rather than proved. Never pass it for a tag you have not
checked — it is the one path that records a release nothing ties to the candidate. `release_ref` is
always a full 40-hex commit sha; anything else is refused. RETURNS `{ status, release_attempt_id,
released_subject_version_id, release_ref }`.

## Verifying it — on real use, no gate, with its own rollback rule

```
release_verify(release_attempt_id, idempotency_key)
```

**WHEN an attempt `release_record` already moved to `released` is ready for its automatic
post-release check (FR-50).** No replay: the release is judged by what it does in real use, with
the evaluation machinery EVALUATE already uses. The protocol's own `improvement.release` says how
much use is enough (`minPostReleaseRuns`) and how far below the base a score may land before it
counts as a regression (`regressionBand`). RETURNS `{ verdict: established | rolled_back |
not_established | null, reason, evidence, rollback_plan, released_subject_version_id,
runs_needed?, evaluation_required?, status }`. Call it again after each step below; a decided
verdict is recorded once and read back on every later call.

- **`reason: awaiting_post_release_runs`, `runs_needed: n`** — the released version has not been
  used enough yet. Nothing to do but wait for real use; call again later. Never manufacture runs
  to hurry it.
- **`reason: awaiting_evaluation`, `evaluation_required: { subject_version_id,
  protocol_version_id, evidence_window, steps }`** — enough real runs exist and nobody has
  evaluated them. Run the four EVALUATE calls with exactly those arguments, and **without
  `initiative` on any of them** — passing it would overwrite this initiative's own OBSERVE and
  EVALUATE records:

  ```
  plugin_profile(subject_version_id, evidence_window, idempotency_key)
  evaluation_start(subject_version_id, protocol_version_id, observation_snapshot_id, idempotency_key)
  evaluation_assess(eval_run_id, subject_refs, idempotency_key)
  evaluation_score(eval_run_id, idempotency_key)
  ```

  `subject_refs` are the run ids and documents the snapshot's own traces name, chosen the way
  EVALUATE's skill says. Then call `release_verify` again.
- **`reason: released_score_not_established`** — that evaluation scored no overall number; widen
  its `subject_refs` (evaluation_assess again) or evaluate a later window, then call again.
- **`verdict: rolled_back`** — a critical guardrail failed on the released subject
  (`guardrail_failed`), or its overall score landed more than `regressionBand` below the base
  subject's own (`regression_beyond_band`). `evidence` carries both scores, both eval_run ids,
  the delta and the run count.
- **`verdict: established`** — no regression beyond the band and no failed guardrail.
- **`verdict: not_established`, `reason: no_base_score`** — the base subject has no established
  or provisional score under the same protocol to compare against. No rollback without evidence.

**On `rolled_back`, this call records the verdict and a `rollback_plan` but applies NOTHING
itself** — it does not move `release_attempt.status`. Run the repository's own rollback next:

```
zz-tool release-rollback --release-attempt <id> --repo <throwaway-clone> \
  --rollback-cmd "<the repository's own rollback command, naming {version}>" [--gateway <url>] [--idempotency-key <key>]
```

`{version}` (and `{plugin}`) in the command become the version to restore; a command naming no
`{version}` is refused. Once it succeeds, the CLI confirms the restored version still locates to
the prior subject, and only then reports back itself:

```
release_record(release_attempt_id, status: rolled_back, reason, idempotency_key)
```

which marks the attempt and the candidate `rolled_back` and retracts the rolled-back version:
`plugin_locate`'s head and `release_apply`'s baseline both skip it from then on, so no registry row
is deleted, and `candidate_record` refuses the same hypothesis from then on. It refuses
`not_rolled_back` unless `release_verify` already decided `rolled_back`, and `prior_not_current`
— recording nothing — when, with that version retracted, the plugin's current version is still
not the prior one (a newer release stands over it).

## The close

`improvement.md` is this flow's gated, closing document on the `promotable` branch. Once it is
approved and (where the release actually went through) `release_verify` has decided a verdict —
and, on `rolled_back`, the rollback is recorded — `initiative_close(initiative, "finished", ...)`
closes the initiative on it. Waiting for real use can take days: the initiative stays open while
`release_verify` answers `awaiting_post_release_runs`, and any later conversation picks it up from
`improvement.md`'s own `release_attempt_id`. A `stale_baseline`
or `approval_required` refusal is not a close-worthy failure — it says what to do next (rebase,
or wait on approval); the initiative stays open until one of the two real outcomes is reached.
Nothing further is owed once it closes: `initiative_status` answers `action: handover` from that
moment, and `zz-handover` writes it cold, afterwards — the close ends this cycle, the handover
ends the initiative.

## Pitfalls

❌ **Calling `release_apply` before `improvement.md` is approved.** `approval_required` — wait,
do not route around it.

❌ **Retrying `release_apply` on `stale_baseline` with the same candidate.** Rebase, rebuild and
re-approve first; the compare-and-swap exists precisely to refuse a stale one.

❌ **Treating `release_verify`'s `rolled_back` as already handled.** It records evidence and a
plan; the CLI and `release_record` are what actually restore the prior subject.

❌ **Running `zz-tool release-apply`/`release-rollback` against the primary checkout.** Both take
`--repo` for exactly this reason — a throwaway clone, never the primary one.

❌ **Skipping `release_verify` after a real release.** FR-50's post-release check is what a
regression would be caught by; a released candidate nobody verifies is a promise, not a proof.

❌ **Passing `initiative` to the post-release evaluation calls.** It overwrites this initiative's
own OBSERVE/EVALUATE records, and the next conversation routes on the wrong snapshot.

## Skill contract

**Outcome:** either a real, gated release — approved `improvement.md`, applied patch, recorded
outcome, verified (and, if warranted, rolled back) — or an honest, named refusal at the exact
boundary that blocked it (`no_release_owners`, `approval_required`, `digest_mismatch`,
`stale_baseline`). The initiative closes on `improvement.md` only once one of those two states is
real, never on an assumption that it will be.

**Required evidence:** `release_prepare`'s `release_attempt_id`/`required_owners`. The recorded
`document_approve` on `improvement.md`, quoting the approved `patch_digest`. `release_apply`'s
own `status`/`reason`. The CLI's own exit status and output. `release_record`'s and
`release_verify`'s full responses, read verbatim — never a release reported as done because the
CLI was merely launched.

**Allowed unknowns:** whether the released subject will regress in real use — `release_verify`
answers that from evidence, never from confidence that a built candidate must be fine.

**Action and exit paths:** the action is prepare, get approved, apply through the CLI, record
what happened, verify, and roll back if the evidence says so. The exit is
`initiative_close` — `finished` once the outcome (released-and-verified, or a real, named
refusal the person accepted) is on the record.

**Degraded behaviour:** a `stale_baseline`/`approval_required` refusal is reported exactly as
that, with the concrete next step named — never silently retried past what the refusal actually
requires, and never reported as a release that happened.
