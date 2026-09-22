# Activation

How production is switched from the current deployment onto the new one: what must be true
first, the order it happens in, how each step is checked, and where each step is abandoned.

**Nothing here has been executed, and nothing here authorises executing it.** This document and
`deploy/activation-runbook.json` were written and rehearsed in part on copied fixtures. Every
one of the eight preconditions is blocked today, so the procedure's own first step refuses.

`deploy/RESTORE-AND-CUTOVER.md` is the rehearsal, and it says in its own preamble that it never
switches production. This is the switch it declines to perform. It borrows that document's step
order rather than inventing a second one, and it does not replace it.

---

## 0. The two things this document will not do

**It does not name an operator, and it does not grant authorisation.**

Both fields exist in the runbook. Both are objects carrying an explicit `null` where a name or a
grant would go. That is not an omission and it is not a placeholder waiting to be tidied away.

This procedure was written by a model. Naming who may switch production is an authority
decision, and a plausible opinion about who should hold it is not accountability — it is a name
that every later reader takes for an assignment somebody made. A runbook that quietly names
somebody is worse than no runbook at all, because the second one stops the switch and the first
one launders it.

The literal string `unassigned` is not used either. It reads as a settled administrative status,
as though the vacancy had been reviewed and deliberately left open. What is true is narrower and
worse: the decision has not been made, and this repository cannot make it.

So `preconditions.operator` and `preconditions.switch_authorization` each record the same three
things — that no name or grant has been given, who must give it, and what the record would have
to say. A program reading the file sees `state: "blocked"` and a `would_unblock` somebody can
pick up. A person reading it sees why the field is empty.

---

## 1. The gate, and why it has no override

Activation is permitted exactly when no precondition is blocked.

That verdict is **derived, never stored**. There is no `activation_allowed` field in the runbook,
because a field somebody could set to true is a field somebody will set to true.
The assessor protocol settled this shape first,
and its reasoning transfers unchanged: enumerate the blockers, and let the flag be the emptiness
of that list, so it has to be earned by closing each gap rather than by editing one line.

`scripts/activation-rehearsal.ts` is what derives it. It reads the eight `state` values and
nothing else.

**An unmet precondition is never waived.** There is no waiver field, no override flag and no
code path that reads one. That is asserted behaviourally rather than promised: the rehearsal
re-derives the blocker list against a copy of the runbook carrying `waivePreconditions: true`,
`activation_allowed: true` and `executed: true`, and requires the answer not to move by one
entry. It does not move.

A blocked precondition is also not the same as a missing one. The rehearsal reports an absent
key as its own kind of blocker, because deleting a precondition must never look like progress.

---

## 2. The eight preconditions, and what would unblock each

Every one is blocked. The reasons differ, and the difference is the useful part: three of them
need a decision, three need a build or a run, and two need work nobody has started.

| Precondition | Why it is blocked | What would unblock it |
|---|---|---|
| `operator` | No assignment exists. The operational work item the specification requires to be assigned before cutover has not been assigned to anybody. | An assignment naming the person, made by whoever may make it, recorded outside this file. |
| `runbook` | Written, not approved. | Review and approval by the same authority, bound to a digest of this document and the JSON rather than to their filenames. |
| `app_version` | No activation candidate application build has been produced or recorded, so there is nothing to pin. | Building the candidate and recording its digest beside the migration head it expects. |
| `store_version` | The live owner stores carry no `.zz/` record layout, and nothing in the platform ever creates one. | Running `deploy/init-record-layout.sh` per owner store on the **new** volume — step 7. |
| `database_version` | Production is at 71 migrations, head `071_a_source_has_no_content_revision.sql`. Migration 072 is staged and unapplied. | Applying 072 to the candidate database — step 6 — and recording the head. |
| `restore_evidence` | `RESTORE-AND-CUTOVER.md` is a procedure, not a result. No observation record from a run of it exists in this checkout. | An operator executing it end to end on a throwaway host, and the acknowledged-write replay coming back whole. |
| `parity_evidence` | Nothing has compared what the old deployment holds against what the new one would serve. | The conversion and rebuild that make the corpus searchable, and implementing the two parity cases that have no code behind them. |
| `switch_authorization` | No authorisation exists. | The authorising party recording the decision against a digest of this runbook and the evidence the other seven cite. |

### What the evidence that *does* exist actually shows

Two of these rows are worth spelling out, because the honest answer is narrower than the
available artifact makes it look.

**`parity_evidence` is not the mutation report.** `testing/mutation-report.json` is real and it
is good: at commit `fa975c4`, **68 rows — one per declared check, nothing uncovered** — baseline
passed with zero failures, every check going red under its planted defect, 158 substitutions, no
zero-replacement row, and each row's tree restored byte-identical.

One thing about it should not be rounded off. It was taken across **two trees, not one** — 67
rows against `0ccd5970c9151f4d` and 1 against `53806f4a3d1947`, the authorised top-up that added
`activation-runbook.ts` (the check that reads this runbook) after it landed too late for the main
run's snapshot. Every row names the digest it was measured against, which is what makes that
honest rather than misleading; but the report's top-level `snapshot_tree_sha256` is the second of
the two, and 67 of its 68 rows were not measured against it. Quoting that one field as the run's
digest would be a single-snapshot claim the run does not support.

> **This passage was wrong once, and the reason is worth keeping.** It described a 66-row report
> across three trees with two checks uncovered. That report was superseded by a consolidating run
> and a top-up, and this prose was not re-opened; a closing reviewer caught it by parsing both
> artifacts. The gate could not — `scripts/gate/checks/activation-runbook.ts` validates the
> runbook's *shape* and never compares a written reading against the artifact it cites. **A number
> copied out of an artifact is a claim with an expiry date, and nothing here enforces it.**

What it establishes is that this gate's declared checks **discriminate** — each one notices when
the thing it guards breaks. That is a fact about the checks. It is not a fact about whether a
restored deployment serves the same content as the old one, which is what a cutover's parity
evidence has to mean. Citing it here would be citing the right-sounding words over the wrong
measurement.

**And the assessor protocol that used to sit here is gone.** A reader of an earlier version of
this document was warned not to reach for `packages/contracts/src/eval-protocol*.ts` as parity
evidence, because it was a drafted, unactivated protocol — no arm run, tolerances null, owner
approval null, inventory digest null. It has since been **deleted**, and the reason is the same
fact stated more plainly: its inputs do not exist and this schema has nowhere to put them. No
slice columns, no rate card, no second reviewer in 614 judged rows, and an inventory pinned to
a directory that was never created. A design nothing can run is not evidence of anything, and
keeping it only gave the next reader something to mistake for a measurement.

The measurements that *would* be parity are absent, in three different ways.
`RESTORE-AND-CUTOVER.md` section 7 records that `projection_parity_against_the_isolated_database`
and `copied_multi_owner_store_projection_replay` are a hardcoded `NOT_RUN` map reading no
environment variable — unimplemented, not merely unconfigured. `semantic_parity` is one of the
benchmark report's blocked targets. And AC-7.3 did not close: its producer runs and refuses at
preflight, because schema `zz` carries no `using bm25` index, all seven declared corpora hold 0
artifacts against a pinned 780,000, and all 98 judged relevant artifacts are unresolvable under
the locators their qrels name. **An available extension is not an index, and an applied DDL
migration is not a populated projection.**

**`app_version` is blocked on the application, not on the database image.**
`deploy/postgres/versions.lock.json` had eight of its nine fields resolved on 2026-09-21 against
a real registry, a real upstream repository and a real built image. The ninth,
`okf_reference_digest`, is still a placeholder, and its own `unverified_fields` entry argues it
should be struck from the specification rather than filled, because this repository vendors no
OKF reference to digest.

> **A stale document, since corrected.** `RESTORE-AND-CUTOVER.md` section 3 used to say that lock
> "still carries placeholder pins — every `*_verified` flag is `false`", and section 7's table
> inherited the premise. Both were corrected at `fa975c4`: section 3 now records eight of nine
> flags true, names the ninth as unresolvable by design rather than outstanding, and tells a
> reader to prefer the lock file if the two ever disagree again. Kept rather than deleted, because
> the pattern it caught is the one that then caught the passage above.

---

## 3. What is measured about production, and what is not

Read read-only over the tailnet on 2026-09-21:

```
migrations applied: 71   (latest 071_a_source_has_no_content_revision.sql, 2026-09-21 01:32 UTC)
zz.doc.analyzer_version:            ABSENT
zz.knowledge_node.analyzer_version: ABSENT
bm25 indexes in schema zz: 0
zz.artifact rows: 0      zz.doc rows: 971      zz.knowledge_node rows: 902
```

Step 8 is sized against **971 + 902**. The plan's text says 841 + 902; the live reading is the
newer one, and the discrepancy is recorded here rather than resolved, because the plan's figure
is simply older.

`zz.artifact` holding 0 rows is consistent with the `store_version` row above: a deployment
whose stores have never been adopted.

---

## 4. The steps

Twelve, each with what it does, how it is checked, and where it is abandoned. Steps 1 and 7 are
the only ones rehearsed; the rest need a deployment.

**Step 1 — re-derive the preconditions and stop if any is blocked.**
Run `node scripts/activation-rehearsal.ts` and read the blocker list.
*Verify:* zero blockers and a zero exit.
*Abort:* stop. Nothing has been touched. This is not a failure of the activation, it is the
activation declining to start — the outcome it is supposed to have while anything is outstanding.

**Step 2 — take a complete backup set and build its manifest.**
`deploy/backup.sh` on the production host, one complete stamped set copied off-host,
`deploy/backup-manifest.sh` to build the manifest.
*Verify:* a manifest listing all five components with their hashes, and no refusal. Each refusal
is a real finding about the backup, not a problem with the script.
*Abort:* stop. Production is untouched and still serving.

**Step 3 — suspend.**
Covered in full in section 5.
*Verify:* all three mutation paths report maintenance, and in-flight reaches zero within the
timeout. If it does not, the count is recorded as still running and unknown, and step 4 does not
begin.
*Abort:* lift maintenance and resume admissions.

**Step 4 — freeze the old unit and record it as one matched thing.**
Old application image digest, database identity and artifact volume, recorded together; the old
volume made read-only; the volume resolved from the Compose project rather than from a name
somebody typed.
*Verify:* all three parts recorded, outbound integrations disabled, and the old volume genuinely
read-only rather than intended to be.
*Abort:* restore write access and lift maintenance. Nothing new exists yet.

**Step 5 — restore into a NEW database and a NEW volume.**
Logical restore into a newly created cluster; the artifacts archive onto a separate new volume.
Never mount an older major version's data directory into the new one, and never restore onto the
old volume.
*Verify:* no errors. Any error is fatal here — a partial restore that looks finished is the
failure this whole procedure exists to find.
*Abort:* discard both. The old unit is byte-identical to what step 4 froze.

**Step 6 — apply migrations to the candidate head.**
Up to and including `072_write_path_records_its_analyzer.sql`, which adds a nullable
`analyzer_version` column to `zz.doc` and `zz.knowledge_node`.
*Verify:* the applied head equals the candidate head, and both columns exist and are nullable.
Nullable is the honest state: no row written before this migration carries a value, and null
says "unknown" rather than naming an analyzer that did not build the vector.
*Abort:* discard the new database and restore it again from step 5.

**Step 7 — initialise the record layout on each owner store, on the NEW volume only.**
`deploy/init-record-layout.sh`, once per owner store root, each path visible in the invocation.
List the stores first and read the list before acting on it. The script takes exactly one
existing directory, never searches, and has no recursive mode and no default.
*Verify:* every store carries all three of `.zz/`, `.zz/blobs` and `.zz/commits`; a second run
reports `already complete`; the non-`.zz` content hashes the same before and after.
*Abort:* nothing to undo. This step only ever touches the new volume, and abandoning the
activation discards that volume whole.

**Step 8 — rederive the analyzer generation over the real rows.**
So every row carries the generation this build derives under. The pass rewrites a row whose
`analyzer_version` differs from the current one — which is a null on rows written before the
column existed, and an OLDER generation on rows written under a superseded analyzer. Both
need it, and reading the step as "fill in the nulls" would leave the second kind behind under
an analysis the read path no longer agrees with.
*Verify:* every row in both tables carries a non-null generation, and the counts after equal the
counts before. The pass writes only on its explicit write flag; a bare run plans and writes
nothing.
*Abort:* discard the new database and return to step 5. The connection this reads from its
environment must name the new unit and never production.

**Step 9 — check the new unit with writes still frozen.**
Query behaviour, the restore's integrity, and the parity comparison `parity_evidence` names.
*Verify:* parity passes on that evidence — which is why the precondition blocks rather than
warns — and query behaviour matches what the old unit served for the same requests.
*Abort:* discard the new unit, unfreeze the old one, lift maintenance. **This is the last step at
which aborting is a clean return.**

**Step 10 — switch traffic to the new unit.** Writes remain suspended.
*Verify:* every request is served by the new unit and none still reaches the old one. The old
unit stays frozen and read-only rather than stopped, so step 9's return is still physically
available until step 11 accepts a write.
*Abort:* point the front door back and discard the new unit. Still clean — but this is the last
moment that sentence is true.

**Step 11 — resume writes, and record the first one that is accepted.**
Lift maintenance on the three mutation paths, admit work again, deliberately inject and record
the first accepted write and the boundary it lands after.
*Verify:* the first accepted write is recorded with the identity one accepted mutation actually
has in this schema, and the resume boundary beside it. A resumed platform that cannot name its
first write cannot later prove which writes were recovered.
*Abort:* **not a clean return any more.** Once a write is accepted on the new unit, going back to
the old one means either carrying those writes forward or losing them, and either outcome is a
recorded decision rather than a rollback. Beyond this point abort means forward recovery, with
the recovered writes enumerated.

**Step 12 — observe, and write the activation record.**
Replay the acknowledged writes across the boundary; record what was done, by whom, against which
digests, and what remained outstanding.
*Verify:* every acknowledged write from before the freeze is present after it, and every write
accepted after the resume is accounted for. The record names the operator and the grant — which
is why both must be real before step 1 lets any of this begin.
*Abort:* nothing to abort; this step only observes. A discrepancy found here is an incident on a
live platform, and it is the reason steps 2 and 9 are not optional.

---

## 5. Suspension: what it does, and what it cannot

**What it does.**

- Stops admitting new work on the three mutation paths — request, background and legacy client —
  by putting each into maintenance.
- Revokes the grants that would authorise further work, so nothing new becomes authorised while
  the switch is under way.
- Waits for work already in flight to finish, and records the count still outstanding when the
  wait ends.
- Records a boundary — a per-store commit watermark and a database write boundary — so that what
  happened before the freeze and what happened after it can be told apart later.

**What it cannot do, and must never be written up as doing.**

- **It cannot guarantee a worker stopped.** Suspension withdraws admission and authority. It does
  not reach into a process and halt it. A worker that is mid-operation when maintenance begins
  keeps running until it finishes or fails, and a worker that has stopped responding is
  indistinguishable from one that is merely slow.
- **It cannot undo a completed external effect.** Anything already sent outside this platform —
  a call made, a message delivered, a credential used — stayed sent. Suspension bounds what
  happens next; it does not reverse what happened.
- **It cannot cancel a non-cancellable process.** Where the wait times out, the honest record is
  the count still outstanding and the fact that their state is unknown. Never "stopped", never
  zero. A count nobody could confirm is not a count of zero, and step 4 does not begin on one.
- **It cannot make default-off mean safe-in-general.** Leaving a capability off prevents
  unintended enrolment into it. It does nothing about a regression in code that everything
  shares, and no amount of not-enrolling anybody makes a change to the shared path harmless.

NOT A TOOL: `reconcile` is how the specification phrases the last of these, and `knowledge_reconcile` is a live platform tool, so the runbook says "settles in-flight work" instead.
NOT A TOOL: nothing in this procedure calls that tool, and a reader who greps for the name should not land here.

---

## 6. Rollback, and the invariants it may not trade away

Rollback returns to the matched old unit recorded at step 4 — old application image, its
database and its artifact volume, all three together. It is clean until the end of step 10.

**Three things a rollback may not buy its way out of.**

1. **The record layout refusal stays.** `services/zz-core/src/tenant-info/record.ts` refuses
   `STORE_UNAVAILABLE` when a store's `.zz/` layout is incomplete, and that refusal is not to be
   relaxed to make a rollback smoother. The alternative is a failed mount being read as a tenant
   with no documents, and the next thing that happens to an empty tenant is that something
   helpfully reconstructs them.
2. **A rolled-back method may not weaken current identity or storage safeguards.** A returned-to
   version is allowed to lack a new capability. It is not allowed to admit a caller the current
   version refuses, or to store something the current version protects.
3. **No automatic downgrade may widen exposure or authority.** If a fallback path would expand
   what anybody can see or do, it is not a fallback — it is a second, weaker deployment, and it
   needs its own decision rather than inheriting this one.

And the same limit suspension has: rollback does not unsend what was sent.

---

## 7. What the rehearsal established, and what it did not

`node scripts/activation-rehearsal.ts` rehearses on copies in a temporary directory. It refuses
to start if `TEAM_DB_URL`, `PLATFORM_DB_URL`, `DATABASE_URL`,
`ZZ_TENANT_INFO_ISOLATED_DB_URL`, `POSTGRES_URL`, `PGHOST` or `PGDATABASE` is set, because a
connection string lying around in the environment is how a rehearsal becomes an execution.

**A clean rehearsal and a permitted activation are different facts**, so they get different exit
codes. Collapsing them into one zero is how a refusing gate gets read as green by anything
checking `$?` — the same conclusion `BENCHMARK-MEASUREMENT.md` section 8 reaches about its own
report, that a structurally valid one is not a passing one.

| Exit | Meaning |
|---|---|
| 0 | rehearsed clean, and no precondition is blocked — the gate permits step 2 |
| 1 | the rehearsal found a problem: a malformed runbook, or a step that misbehaved |
| 2 | refused to start, because the environment names a database this must never reach |
| 3 | rehearsed clean, and activation is **refused** because a precondition is blocked |

**Today it exits 3.**

**Established.**

- The gate refuses while any precondition is blocked. Eight of eight are blocked, and the derived
  verdict is `REFUSE`.
- The blocker list is derived from the eight states alone. A copy of the runbook carrying
  `waivePreconditions`, `activation_allowed` and `executed` derives the identical list.
- Every step carries a verification and an abort point, and exactly one is marked as the last
  clean abort point.
- Step 7, on a store-shaped directory holding copies of real files from this repository: it turns
  a store with no layout into one carrying all three directories; a second run reports `already
  complete`; a half-initialised store is **repaired** rather than refused — the state that
  refuses every write while looking initialised to anybody who lists it; and the store's
  documents hash identically before and after all three runs, so the step creates two empty
  directories and rewrites no document byte.

**Not established, and worth stating in the same breath.**

- It did not run the activation. No step was performed against production and no database was
  contacted.
- It did not rehearse steps 2–6 or 8–12. Those need a deployment, and rehearsing them needs the
  throwaway host `RESTORE-AND-CUTOVER.md` describes rather than this checkout.
- It did not produce restore evidence or parity evidence. Exercising step 7 on a copied store
  says nothing about whether a restored deployment serves what the old one held.
- **It did not establish native readiness.** A migration staged in the working tree and a
  procedure describing how to apply it are not the same claim as a platform ready to apply it.
  The new framework may be built and exercised on copied fixtures while the operational migration
  is outstanding — what it may not do is claim active native guarantees over production artifacts
  nobody has migrated. Production holds 971 documents and 902 knowledge nodes with no
  `analyzer_version` column and no BM25 index.
- It did not verify that suspension stops a worker, because suspension does not do that and no
  rehearsal could show that it did.

The rehearsal writes its result into the runbook's `rehearsal` block on `--record`, and into
nothing else. It refuses to record if the preconditions changed on disk while it ran: a rehearsal
that could edit a precondition could mark its own gate met.

---

## 8. Files

| File | What it is |
|---|---|
| `deploy/ACTIVATION.md` | this document — the procedure and its reasoning |
| `deploy/activation-runbook.json` | the same procedure, for a program: preconditions, steps, suspension, rollback, rehearsal |
| `scripts/activation-rehearsal.ts` | derives the gate, and rehearses step 1 and step 7 on copied fixtures |
| `deploy/RESTORE-AND-CUTOVER.md` | the rehearsal procedure, unchanged, which never switches production |
| `deploy/init-record-layout.sh` | step 7's script, unchanged |
