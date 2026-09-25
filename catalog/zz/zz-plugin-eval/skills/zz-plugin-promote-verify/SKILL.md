---
name: zz-plugin-promote-verify
version: 0.4
description: Stage 8 of zz-plugin-eval (PROMOTE/VERIFY), the promotion boundary. Once IMPROVE has a proof-passed, owned candidate, prepare and gate the exact patch, apply it only after every required owner approves, record what happened, and run the automatic no-gate post-release check with its own objective rollback rule.
when_to_use: "The eighth and last stage of zz-plugin-eval, reached only when release_mode is promotable — a candidate IMPROVE selected reached proof_passed against an owned subject. REQUIRES a shell-capable runtime that can run zz-tool commands against a real repository checkout. Never reached on a proposal_only or not_applicable branch."
---

# zz-plugin-promote-verify

Nothing before this stage touches the real repository (FR-46). Everything from here on does,
and every step past `release_prepare` needs a person's approval first.

## Preparing the release — the one gate that authorizes it

```
release_prepare(candidate_id, initiative, idempotency_key)
```

**WHEN a candidate reached `proof_passed` with `release_eligible: true`** (IMPROVE's own
`candidate_prove`). Resolves required owners LIVE from the base subject's own `release_owners`
(never the release_eligible flag `candidate_prove` recorded at proof time — ownership is
re-checked, not cached), records the promotion package as a `zz.release_attempt` row
(`prepared`), and writes `<initiative>/improvement.md` — the authority-bearing gate FR-48 names,
naming the exact candidate/patch digest, proof evidence, score change, guardrails, affected
owners and the planned release/rollback:

```
## Candidate  · ## Base subject · ## Patch · ## Proof result · ## Score change
## Guardrails · ## Owners       · ## Release plan · ## Rollback plan
```

RETURNS `{ release_attempt_id, required_owners, document }` — `required_owners` and the attempt
id are always returned even when the document write is refused (an unopened/closed initiative, a
document already approved), which then answers `document: null` plus document_refused naming
why; retry with the SAME `idempotency_key` to write the document against the already-recorded
attempt, never a fresh one, which would record a second attempt. REFUSES a candidate that has
not itself reached `proof_passed` (`not_eligible`); a caller who is not a member of one of the
base subject's owner teams (`not_owner`); a base subject with NO recorded
`release_owners` — `no_release_owners`, naming `proposal_prepare` instead, back in IMPROVE; and
(FR-58, hard refusal) this initiative's release_mode already set to something other than
`promotable`. Records `release_mode: promotable` on success.

## The approval — a person, before anything real happens

`document_present` it, put it in front of every required owner, and `document_approve` it the
moment they agree — under their name, in the same turn. **`release_apply` reads the approved
document back and refuses without it**: the approval counts only when the document cites THIS
`release_attempt_id` in its frontmatter and quotes the exact `patch_digest`, and only for the
owner teams the approver is a MEMBER of. An approval of an earlier attempt's document, or by
somebody in no owner team, approves nothing. `document_approve` refuses `not_owner` on
`improvement.md` when the signer is in no owner team — and, with `on_behalf_of`, when the session
recording it is in none either.

## Applying it — the exact compare-and-swap

```
release_apply(candidate_id, approved_patch_digest, initiative, idempotency_key)
```

Only an owner-team member may call it. Takes an advisory lock on the candidate's own plugin,
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
candidate's own base — rebase, re-validate, re-prove and re-approve before trying again; a
changed patch needs the whole cycle again too). It also refuses when the current version is not
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
neither names a commit the clone has — runs the repository's own gate, then its own release
command, locates the new subject AT `--release-version`, and reports back with `release_ref` = the
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

## Verifying it — automatic, no gate, with its own rollback rule

```
release_verify(release_attempt_id, idempotency_key, initiative?)
```

**WHEN an attempt `release_record` already moved to `released` is ready for its automatic
post-release check (FR-50).** Replays the candidate's own proof-equivalent held cases — the same
proof split `candidate_prove` already sealed, reused here under a fresh `verifier_token` this
call mints — against the released subject and its prior version, and applies the protocol's own
rollback decision. RETURNS `{ verdict: established | rolled_back | not_established | null,
reason, evidence, rollback_plan, runs_required?, verifier_token?, status }` — like
`candidate_prove`, `runs_required` is `{ case_set_id, baseline, candidate }` while short — COUNTS,
never case ids: `baseline` replays of the prior subject (the candidate's base) and `candidate`
replays of the released one. Run each with `replay_start(context: "verifier", verifier_token,
split: "proof", case_set_id, subject_version_id: <prior or released>)` — no `case_id`; the server
draws the case, and the token is bound to this case set and these two subjects — plus `npm run
replay -- --run <id> --verifier-token <token>`, exactly as IMPROVE's own proof loop.

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
is deleted. It refuses `not_rolled_back` unless `release_verify` already decided `rolled_back`, and
`prior_not_current` — recording nothing — when, with that version retracted, the plugin's current
version is still not the prior one (a newer release stands over it). A required guardrail that
the runs collected so far already failed rolls back at once — while the interval is still
unresolved, while replays are still missing, and before the liveness bound. **No
rollback ever fires without evidence** (FR-50) — below the held-case minimum, or an interval that never
resolves by the liveness bound, `release_verify` answers `not_established` with a named reason
(`insufficient_proof_cases` / `replays_unavailable` / `verification_unresolved`), never a
rollback and never an indefinite wait.

Pass `initiative` on `release_verify`; on the `rolled_back` verdict it attempts to record
`release_mode: not_applicable` — in practice `release_prepare` already recorded `promotable` for
this initiative before this attempt could exist, so this is ordinarily a harmless no-op, kept for
symmetry with the other two branch-closing calls (candidate_search/candidate_prove).

## The close

`improvement.md` is this flow's gated, closing document on the `promotable` branch. Once it is
approved and (where the release actually went through) `release_record`/`release_verify` have
run, `initiative_close(initiative, "finished", ...)` closes the initiative on it. A `stale_baseline`
or `approval_required` refusal is not a close-worthy failure — it says what to do next (rebase,
or wait on approval); the initiative stays open until one of the two real outcomes is reached.
Nothing further is owed once it closes: `initiative_status` answers `action: handover` from that
moment, and `zz-handover` writes it cold, afterwards — the close ends this cycle, the handover
ends the initiative.

## Pitfalls

❌ **Calling `release_apply` before `improvement.md` is approved.** `approval_required` — wait,
do not route around it.

❌ **Retrying `release_apply` on `stale_baseline` with the same candidate.** Rebase, re-validate,
re-prove and re-approve first; the compare-and-swap exists precisely to refuse a stale one.

❌ **Treating `release_verify`'s `rolled_back` as already handled.** It records evidence and a
plan; the CLI and `release_record` are what actually restore the prior subject.

❌ **Running `zz-tool release-apply`/`release-rollback` against the primary checkout.** Both take
`--repo` for exactly this reason — a throwaway clone, never the primary one.

❌ **Skipping `release_verify` after a real release.** FR-50's post-release check is what a
regression would be caught by; a released candidate nobody verifies is a promise, not a proof.

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

**Allowed unknowns:** whether the released subject will regress under real replay — `release_verify`
answers that from evidence, never from confidence that a proven candidate must still be fine.

**Action and exit paths:** the action is prepare, get approved, apply through the CLI, record
what happened, verify, and roll back if the evidence says so. The exit is
`initiative_close` — `finished` once the outcome (released-and-verified, or a real, named
refusal the person accepted) is on the record.

**Degraded behaviour:** a `stale_baseline`/`approval_required` refusal is reported exactly as
that, with the concrete next step named — never silently retried past what the refusal actually
requires, and never reported as a release that happened.
