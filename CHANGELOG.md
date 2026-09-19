# Changelog

What changed in the platform, for someone deciding whether to upgrade.

The commit history records every change; this records the ones a person running the platform
would feel, and says what they have to do about them. Written per release by `/release`.

**Three repositories, one entry.** `zz-stack` (the gateway, zz-core and the flows) and
`zz-stack-dashboard` (the console) are separate repositories with separate build lifecycles —
the console keeps its own compose file so that a console change is not a platform release. But
they are one product to the person using them, and a release that changes what a document
REPORTS in zz-core and what the console CALLS that report is one change, not two. So each
entry below carries both, labelled with its own version, and a section is simply absent when
that repository did not move.

zz-blocks versions separately and has its own changelog — the mock building blocks stand in
for other teams' services and change for their own reasons. All three are released together
by `zz-stack/scripts/release.ts`; separate lifecycles never meant separate deployments.

**Names in the entries below are not the names that were there.** `CaseBox`, `BookIt`,
`RuleMill` and `SsoAuth` are inventions. One of the three blocks was a system another team
runs; the other two were this project's own stand-ins, and the identity provider was a real
one. Addresses in the entries are `@example.com`.

Numbers here follow one rule. A count that is a property of THIS repository — how many checks
the gate has, how many tools a door offers, how large a file may be — is exact. A measurement
of anything else — what a system this project did not write cost to call, what running this
method on somebody else's work produced — is written as a shape rather than a figure. The
findings those measurements led to are stated in full and stand on their own: a finding is an
engineering fact, and it does not need the corpus it came from to be useful.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html), judged against **what a consumer sees** rather
than how much code moved.

## [0.57.1] — 2026-09-19

Only a door that writes documents has a document record to report.

### Fixed

- **`plugin_profile.record` reported the whole store's document figures under any door-owning
  plugin's name.** It was gated on `servesOwnDoor` alone. For zz-core that is right — it is the
  door every document is written through — but zz-access's profile reported 410 documents, 62
  revised, for a plugin that has never written one, and a ruler drawing a threshold over that
  would have measured the platform while naming zz-access. The block now requires the door to
  have recorded a `document_write`, `document_patch` or `document_revise` call.

## [0.57.0] — 2026-09-19

A timeout does not lose an answer, and every typed call leaves a row.

### Added

- **The typed judgement service now records every call to `zz.model_call`.** It makes every typed
  decision on this platform — the qualitative marks, the thresholds, the recommendation enum —
  and wrote nothing: twelve rounds of evidence with no record that the calls behind them
  happened, how long they took, or whether any had to be retried.
- **`attempts`, `confidence` and `note` on `zz.model_call`** (migration 065). A call that
  succeeded on its third try is not the same fact as one that succeeded immediately; `ok = false`
  made a timeout, a 429 and a moved body look identical when they need different responses; and
  **confusion is a measurement, not an error** — an answer set at 0.96 and one at 0.11 are
  different evidence wearing the same shape, so the mean confidence per call is recorded and a
  run of low-confidence judgements reads as a trend.

### Changed

- **A transient timeout costs latency, not a subject.** The typed client retries a timeout, a
  transport failure or a 5xx within a total budget (`TYPESAFE_BUDGET_MS`, 100s;
  `TYPESAFE_ATTEMPTS`, 3). A 4xx is not retried — asking again with the same body spends the
  budget to be told the same thing. The refusal now names the attempts and seconds spent.
- **The reading judge deliberately does not retry.** It answers one subject per call, and a
  skipped subject leaves `remaining` unmoved so the next call retries it with a *fresh* budget —
  better than one squeezed into a window already nearly spent. The typed client has no such
  resume: its whole ruler rides in one request.

### Upgrade notes

- Migration 065 adds three nullable/defaulted columns and applies on the gateway's next start.
- `TYPESAFE_BUDGET_MS` and `TYPESAFE_ATTEMPTS` are new and optional.

## [0.56.0] — 2026-09-19

How good is it, and what is left to fix — two numbers, because they are two questions.

### Added

- **An effectiveness score, 0–10, computed from the round's own figures.** A round ended in one
  word — `keep`, `keep-and-change`, `re-run`, `not-evaluable`, `retire` — which is a *decision*
  and was being read as a *measurement*. "Keep" does not say whether a plugin is excellent or
  barely adequate.

  `0.6 × qualitative + 0.4 × quantitative`, each rescaled to 0–10, with bands at **8 / 6 / 4**
  fixed before any round is read. Null over a void round: a mean below a collapsed control is
  noise, and printing it with a caveat is how the caveat gets lost.

  **Computed, not asked.** Every input is already on the round, so no model is in the
  derivation — a number a model produced is one more thing a reader has to trust. The weights
  live in `judge-score.ts`, so disagreeing with them is a one-line change.

- **A headroom figure, independent of the score.** A plugin at 9 can still have something worth
  fixing, and a plugin at 5 with *nothing identified* is a worse situation than a 5 with three
  named changes — that quadrant is the retire signal. Headroom counts only things already
  written down: unmet thresholds and generic findings, each of which names a change by
  construction. Anything else is an opinion.

### Changed

- **Both numbers go into the state `round_recommend` hands the typed judge**, so the enum is
  chosen knowing the score rather than derived beside it. A report can no longer carry `keep`
  next to a 4.2 with nothing saying which to believe.
- `round_scores` computes from **this round's** figures, not the pooled series — which is right
  for a trend and wrong for scoring one round.

## [0.55.1] — 2026-09-19

The text catches up with two rules that changed under it.

### Fixed

- **`initiative_close` still said "Closed is not yet complete — one step remains".** Both halves
  stopped being true in 0.55.0, and that sentence is what a person reads at the moment they
  close something. It now says nothing is owed and offers the handover. `sdlc-flow`'s skill
  carried the same claim and says the same thing now.
- **Three surfaces still described the ablation suite removed in 0.54.0** — the `/eval` door
  introduced itself as reading "what a recorded ablation says installing it is worth", README
  described two kinds of evidence with their own sufficiency lines, and the console commented on
  "the most recent ablation run". A door that describes a capability it does not serve is worse
  than one that describes nothing: the reader believes the name is theirs to call.
- **README's `evals/` entry described a directory the repository no longer has.** Replaced with
  what is true: a round's findings live in the initiative it ran as, with the scores in the
  platform's own tables.

## [0.55.0] — 2026-09-19

The close is the end, and closing is a normal way for work to end.

### Changed

- **A closed initiative owes nothing.** It could be closed and still owe three things —
  `handover.md` written, then approved, then its promised team-node count met — reported as
  `action: "handover"` until all three landed. `initiative_status` now answers `closed` from the
  moment an outcome exists, whatever that outcome is.

  Two reasons. **The old rule instructed an act its own gate refused:** `handover.md` requires
  the flow's closing document, an initiative abandoned at the plan stage has none and never
  will, so `document_write` turned the handover away while `initiative_status` demanded it,
  forever — the same shape as the close-with-no-documents trap fixed in 0.54.1, one document
  further along. And **work stops.** Not every initiative finishes; an initiative closed halfway
  is closed rather than short of something, and the ledger row is the record.

- **The handover is still writeable, and still worth writing.** A closed initiative now satisfies
  a prerequisite its close deliberately skipped, so the opportunity survives the obligation being
  removed. That matters: an abandoned initiative on this platform produced the most durable node
  in the store, minted today from a five-day-old folder.

### Removed

- **Two gate checks that enforced the old rule**, replaced by one that enforces the new one.
  The gate is 333 checks, from 334.

### Upgrade notes

- Any initiative reading `action: "handover"` will read `closed` after this. None is lost — the
  outcome and ledger row are unchanged.
- Four skills changed version, so every installed client gets the new text on its next pull.

## [0.54.2] — 2026-09-19

The model is `deepseek-v4.1-flash`, and the judge rule is warned rather than assumed.

### Changed

- **`PLATFORM_BASE_MODEL` and `ZZ_JUDGE_MODEL` are both `deepseek-v4.1-flash`.** They were both
  `glm-5.3-flash` on the deployment, which already violated the rule the env file states two
  paragraphs apart — the judge is "deliberately not the one above". The default said `glm-5.3`
  and the deployment said `glm-5.3-flash`, so the separation was documented and not in force.
  `LLM_BASE_URL` was already `ollama.com`; only the model name changed.
- **The judge-equals-base rule is enforced by a boot warning, not by a default.** It can only do
  damage when the typed judgement service is absent, because every typed decision now goes there
  — twelve of twelve rounds since that switch carry `typesafe/jev-latest`. `checkJudgeModel`
  warns on exactly that combination. Warned, not refused: a deployment that wants one model is
  allowed to have one.

### Fixed

- **`prompt_tokens_details.cached_tokens` is confirmed.** `judge.ts` recorded that the name came
  from a provider reference and had never been seen on a live response, and that the first real
  round would settle it. It is present and correct.

### Upgrade notes

- Set `PLATFORM_BASE_MODEL` and `ZZ_JUDGE_MODEL` to a model your `LLM_BASE_URL` actually lists —
  `curl $LLM_BASE_URL/models` answers. A name that endpoint does not serve fails at the call,
  not at boot.
- Marks taken under the old model do not average with new ones; `zz.eval.judge_model` records
  which answered, and every comparison groups by it.

## [0.54.1] — 2026-09-19

An initiative opened by mistake can be abandoned.

### Fixed

- **An initiative with no documents could never be closed** (bug `e1958baf`, open since 0.39.1).
  Two rules, each right alone, together leaving no exit. `initiative_open` prepended the date but
  did not shape the rest of the name, so a sentence produced a folder carrying spaces and a
  comma; and `initiative_close` records an outcome ON a document, so an initiative opened by
  mistake — which has no documents by definition — could not be abandoned until somebody wrote
  one purely to satisfy the gate. It stayed open in `initiative_status` forever instead.

  Both halves are fixed. `slugify` **shapes rather than refuses**: the platform already composes
  this name and tells callers to use what comes back, so holding the rest of it to the store's
  shape is the same rule one character further along. `slugRefusal` still rejects what is
  genuinely ambiguous — a separator, a leading dot, a second date. And an empty initiative is
  abandoned on its own `_open.json`, with **no ledger row**: a team's counts are built from work
  that happened, and this is the record of work that did not. `initiative_status` reads the same
  field, so the abandon is visible.

## [0.54.0] — 2026-09-19 · platform 0.54.0 · console 0.17.0

The ablation half of plugin evaluation is removed, data included.

### Removed

- **`claude plugin eval` and everything downstream of it.** A suite ran cases with the plugin
  and without it and reported the score delta; `case_record` stored the run, and rulers drew
  thresholds over it.

  **It never measured what it appeared to.** No case ever declared a mock, so under the CLI's
  default `--mocks record` no plugin server started and the plugin's MCP tools were **not
  callable in either arm** — a fact one sdlc case had already written beside its own graders.
  Every grader was a regex over tool *names* or a judgement about an answer's shape. A delta
  therefore established that the method's **text** had reached the agent and that it used the
  right words; never that the plugin worked. The strongest result the suite ever produced came
  from a prompt that typed the plugin's own command.

  Gone: nine `case.yaml` files, the `evals/` tree, `plugin-cases.ts`, the `case_record` tool,
  the CASES block in `plugin_profile` and `ruler_read`, `cases_digest` through the lock and the
  console, `EVALS_DIR` and its Dockerfile `COPY`, the console's Evaluated column and field, and
  four gate checks whose whole subject was the suite. The gate is 334 checks, from 337.

- **The recorded rows, in migration 064.** `zz.plugin_case_run`, `zz.plugin_version.cases_digest`,
  and the ruler dimensions written against case evidence with their scores. Reports were
  published citing these deltas; those documents keep their text and their approvals, and this
  removes the numbers behind them. A figure nothing can reproduce and nothing should be read
  from is worse kept than dropped.

### Changed

- **Evaluation now rests on the platform's own telemetry alone** — which tools were called, on
  whose door, how often, what they refused and whose refusal it was. That is the thing itself
  rather than an agent's vocabulary, it needs no second runner and no credential, and it cannot
  drift out of step with the plugin because the plugin produces it. A plugin nobody has used is
  an honest `not-evaluable`; a ruler whose subject is the document or the initiative may still
  have subjects when the trace history is thin.

### Upgrade notes

- Migration 064 **drops a table and deletes rows**, and applies on the gateway's next start.
- `case_record` is gone from `/eval/mcp`. A caller still naming it gets "tool not found".
- Four skills changed version, so every installed client gets the new text on its next pull.

## [0.53.2] — 2026-09-19

A manually triggered command ablates perfectly well.

### Fixed

- **`revokes-a-leaked-token-before-anything-else` came back `dead` on a grader that could never
  pass.** It asked for `tool_used: Skill`, and zz-access ships five commands and zero skills — a
  promoted skill ships *as* the command, which is the design: `/connect`, `/admin`, `/doctor`,
  `/migrate` and `/update` are operator acts a person types on purpose, and every one carries
  `disable-model-invocation: true`. The grader was a constant subtracted from one arm.
  The case now types `/zz-access:connect` the way `diagnoses-a-401-with-zz-doctor` types its
  command — that case scores **1.000 with the plugin against 0.000 without**, the strongest
  delta recorded here, and has no skill grader at all. A command is part of the plugin; nothing
  about an ablation needs a skill.

### Removed

- **`refuses-a-shared-team-key`.** Its graders named `block_connect` and the credential tools,
  which the blocks removal took off the `/manage` door — and the skill's "there is no shared
  team key" section went with them, because the better answer it offered *was* `block_connect`.
  One clause survives saying a token is personal. There is no distinctive behaviour left to
  measure.

## [0.53.1] — 2026-09-19

A tool outside the chain is a tool nobody calls.

### Fixed

- **`plugin_profile` no longer ends the flow's `next_action` chain when the evidence is
  sufficient.** It returned null there, on the reasoning that a next action nobody needs is
  noise. What it did was stop the chain: a caller following `next_action` from `plugin_locate`
  arrived at the profile, got null, and continued from memory of the skill. `plugin_conform` —
  which reads a plugin against the building-block contract and is named by its own stage's skill
  — had therefore never been called, in four complete evaluations of four different plugins. The
  sufficient branch now points at it, and then at `ruler_read`.

## [0.53.0] — 2026-09-19

A skill that only fires when you already know to ask for it adds nothing.

### Changed

- **zz-access and zz-plugin-eval describe the SITUATIONS they are for, not the machinery.** The
  ablation found the cause of every dead eval case: the skill never loaded, so both arms were an
  unassisted agent and the plugin contributed nothing. The one case where the skill fired is the
  one strong case. What separated them was the prompt — an instruction ("use it on our
  documentation plugin") loaded the skill; an incident ("the terminal was visible in a
  recording, what do I do") and a conclusion offered for confirmation ("three runs is too thin,
  right?") did not. zz-access's `when_to_use` already said "suspects one leaked" and still did
  not fire, because `description` is what gets matched and carried none of that vocabulary.
- **A control round records which round it controls** (`zz.eval.controls`, migration 063), and
  the judge-on-trial gap is computed against that pairing. It pooled every score under a version
  and ruler, which reads correctly while a version has one round and is wrong once it has two —
  a second sdlc round reported 1.86 where its own control put it at 2.02. The pooled form
  remains the fallback for rounds recorded before this, and `judge_on_trial.over` now says which
  of the two a reader is looking at.

### Added

- **`plugin_profile` splits revised documents by whether `document_patch` touched them.** zz-core's
  report hypothesised that documents without a recorded cause were the patched ones. Measured and
  **refuted**: of 49 revised documents 15 carry evidence, and of the 20 patched, 12 do — 60%
  against 10% for the rest.
- **`zz-plugin-define` carries the two ruler lessons this evaluation paid for**: name the artifact
  the judge is handed and ask whether the answer is IN it, and state a threshold as a comparison
  between two named fields rather than arithmetic the judge has to perform.

### Removed

- **The `refuses-a-shared-team-key` eval case.** It scored 0.000 on both arms because three of its
  four graders regex for `block_connect`, `credential_set`, `credential_list` and `platform_list`
  — tools the blocks removal took off the `/manage` door. It tested a surface that no longer
  exists and was never removed with it.

### Upgrade notes

- Migration 063 adds a nullable column and applies on the gateway's next start.
- Both skills changed version (zz-access 2.5, zz-plugin-eval 0.8), so every installed client gets
  the new text on its next pull.

## [0.52.15] — 2026-09-19

`noul` answers `noul` and carries no confidence.

### Fixed

- **The typed client's `noul` shape was wrong since it was written, and 0.52.14 was the first
  caller.** It declared `{ probability, confidence }`; the service returns `{ noul }` and no
  confidence at all. Written from documentation prose rather than from a response, and never
  exercised — choice and score were used from the first typed round, `noul` was dead code
  carrying a wrong shape. The first real threshold round threw and reported the dimension
  skipped, which is the resume design working; nothing was stored wrong.
- **A threshold's confidence is derived and says so.** For a yes/no the probability already is
  the shape of the distribution, so distance from the 0.5 cut, doubled, is that shape on the
  0–1 scale the column holds for every other dimension.

Measured against the live service: "at least half of revised documents carry evidence", against
facts saying 15 of 45, answers **0.02**; "the documentation is generally quite good" answers
**0.41**. The sharp line answers sharply and the vague line reports its own vagueness.

## [0.52.14] — 2026-09-19

A line over a figure is a yes/no, so the typed judge answers it.

### Changed

- **The threshold pass moved from the reading judge to the typed judgement service.** It was the
  last quantitative decision in the flow still made by a transformer returning JSON — does 15 of
  45 clear a half line — while the qualitative marks, the recommendation enum and the
  evidence-strength score had all moved. The cost was shape rather than judgement: the parser
  had to coerce `"true"` the string into `true` the boolean, because a model asked for a boolean
  returns the string often enough to turn a met line into an unmet one, and a truncated answer
  dropped a dimension silently. `noul` cannot answer off-vocabulary.
- **A threshold now records the distribution behind its verdict.** Met is still 5 and unmet 1,
  because a line is binary — but the probability and its confidence are stored beside it, so a
  line cleared at 0.51 and one cleared at 0.99 stop reading as the same result.

The reading judge remains the fallback where no `TYPESAFE_API_KEY` is set. Absence is an answer,
never an error.

## [0.52.13] — 2026-09-19

The record a door keeps is a figure on the sheet, because that is what the question was about.

### Added

- **`plugin_profile` counts the record a door-owning plugin keeps** — documents governed, how
  many have been through a version change, and how many of those carry evidence — and the
  judge's fact sheet carries it with the percentage. On this deployment: 377 documents, 45
  revised, 15 carrying evidence (33.3%), against a tool that refuses a revision naming no cause.
  Null for a flow, which keeps no record of its own.

  This exists because a prediction was falsified. zz-core's evaluation proposed making
  `zz.doc.evidence` carry a document's cause and said it expected the "a version change was
  caused by evidence" mark to rise. 0.52.10 shipped it and it worked — 0 documents to 64 — and
  the mark fell, 3.14 to 2.85. The judge is handed the document's markdown body and never sees a
  database column, so a dimension worded as a question about the record was being answered from
  prose. A threshold can only be drawn over a figure that is on the sheet; the same lesson as
  0.52.6.

## [0.52.12] — 2026-09-19

A single document is capped too, and it reached the ceiling on the first round that looked.

### Fixed

- **A `document` subject had no size cap at all and scored nothing when it overran.** 0.52.11
  derived the pair budget from the judgement service's measured ceiling; one branch over, a
  single document was still sent whole. On the next round a real `spec.md` reached 153,379
  characters — about 51,000 tokens against a 32,768 ceiling — the service answered
  `max_tokens_exceeded`, and the subject was lost rather than shortened. One document now gets
  the whole `ZZ_JUDGE_PAIR_CAP` budget, with the cut announced in the text and counted.

## [0.52.11] — 2026-09-19

The pair cap is measured, and an arc is not finished until somebody signed it.

Both changes are the ones sdlc's own evaluation proposed. Both remove a confound sitting on its
weakest dimension rather than changing the plugin.

### Changed

- **`ZZ_JUDGE_PAIR_CAP` is 70000, up from 24000, and the number is now derived.** 24000 was
  chosen to stay clear of a `max_tokens_exceeded` that had lost a subject once, never measured
  against what the service accepts. Across six real initiatives it cut 210,702 characters, and
  the worst-marked subject was the one that lost 113,332 of them. Measured against the live
  service: 32,275 input tokens accepted and ~36,400 refused, so the ceiling is 32768; a real
  42,531-character document measured 14,117 tokens, so prose runs 3.01 characters per token and
  not the ~5 a repeated-word probe reports. 70000 clears the ceiling even at a pathological 2.5
  chars/token with room for the ruler's own text.
- **An initiative is a subject only when its closing document is APPROVED.** Presence was
  enough, so two unsigned draft reviews were judged as delivered arcs — and they were the two
  lowest marks in that round, 1.7 and 2.9 against an approved-arc mean of 3.78. An initiative
  whose review was never signed has not finished its own gate.

### Fixed

- Closes bug `343ffb42`.

### Upgrade notes

- Rounds against an `initiative` ruler now judge fewer subjects and truncate far less. Marks
  taken before this are not comparable with marks taken after it; re-run rather than compare.

## [0.52.10] — 2026-09-19

A document's evidence column reads the field the platform actually writes.

### Fixed

- **`zz.doc.evidence` was declared on every document and populated on none.** Measured: 0 of 365,
  while `zz.knowledge_node.evidence` — whose tool refuses a node that cites nothing — carried it
  on 867 of 867. The indexer read an `evidence:` frontmatter field that no write path sets, while
  `document_revise`, which refuses a version naming no cause, writes that cause into the
  envelope's `sources`. `evidence` now falls back to `sources`; an explicit `evidence` still wins
  where it is set. This is the change zz-core's own evaluation proposed against its weakest
  dimension.

### Upgrade notes

- Existing documents carry a stale `content_hash` until they are re-indexed. Run
  `knowledge_reindex` once after upgrading, or the column stays empty for everything already
  written.

## [0.52.9] — 2026-09-19

Every wait on the platform database is bounded.

### Fixed

- **A hung statement could take zz-core down behind a green health check.** Its pool holds four
  connections and set no `statement_timeout`, so four statements stuck on a lock or an
  unresponsive peer would exhaust it while `/health` kept answering 200 — it touches no
  database. zz-core now sets a 30s server-side statement timeout, and both services bound how
  long a caller waits for a free connection. The gateway deliberately sets no statement timeout:
  its pool runs the migrations, and aborting one partway is worse than the pile-up it prevents.

### Upgrade notes

- `ZZ_DB_STATEMENT_TIMEOUT_MS` (30000), `ZZ_DB_CONNECT_TIMEOUT_MS` (10000) and `ZZ_DB_POOL_MAX`
  are new and all optional; the defaults are the values above and the pool sizes already in use.

## [0.52.8] — 2026-09-19

A door owns the documents its door wrote, not every document in scope when it was called.

### Fixed

- **An administration door was offered another plugin's documents to be judged on.** A
  door-owning plugin's documents were selected by matching any `tool_call` on its door against a
  document's initiative — so two `whoami` and `team_switch` calls made while an evaluation was
  the session's context handed zz-access the whole of zz-core's evaluation. Attribution now
  requires a call to `document_write`, `document_patch` or `document_revise`: a plugin whose door
  only reads documents has not produced them.

## [0.52.7] — 2026-09-19

Which initiatives are a flow's is answered by `zz.doc.flow`, not by a run nobody recorded.

### Fixed

- **A flow was judged on a sixth of its own work.** `usageInitiatives` decided which initiatives
  belonged to a plugin by joining documents to their producing run and that run to the plugin's
  skill versions — but `zz.doc.produced_by_run_id` is null on 326 of this platform's 365
  documents, because a document is written by whatever is holding the conversation and only some
  of those carry a run. The query returned 3 initiatives where 17 are governed by the flow, and
  1 with a closing document where 6 have one. Nothing errored; the sample was silently wrong.
  `zz.doc.flow` is stamped at write time from the flow that governs the initiative, needs no run
  to exist, and is now what answers the question — counted across every version, the way a door
  plugin's tool use already is.

### Upgrade notes

- Any round recorded against an `initiative` ruler was scored on whatever fraction of the flow's
  initiatives happened to carry a producing run. Re-run it.

## [0.52.6] — 2026-09-19

A refusal says whose it was, and the sheet totals them.

### Fixed

- **A threshold over the share of refusals that are guardrails could not be read at all.** The
  fact sheet carried a refusal count and not `refusal_owner`, so the line came back unmet with
  "the facts contain no refusal_owner breakdown" — an absence in the instrument reported as a
  defect in the plugin. The profile now splits every tool's refusals into `guardrail`, `ours`,
  `theirs` and the ones nothing attributed, and the sheet carries the door's totals beside the
  per-tool rows.

## [0.52.5] — 2026-09-19

A door-owner's documents are the ones written through its door, and a declared subject is never
substituted for another.

### Fixed

- **A ruler whose subject is the document was marking run transcripts instead.** `round_judge`
  fell through to traces when it found no documents, so a ruler asking whether a document
  carries its frontmatter, whether its version moved because evidence arrived, and whether its
  knowledge cites its source was handed transcripts that answer none of those. It scored 1.68 to
  1.94 and the round read as a verdict on the plugin. A declared subject the evidence cannot
  supply is now refused with that reason, the way the initiative subject already was.
- **A plugin that owns a door was credited with only the documents its own skills wrote.** Every
  document on this platform is written by some other flow's stage calling zz-core's
  `document_write`, so the skill route found 13 of 365 for the one plugin that touches all of
  them — the same mistaken attribution 0.52.1 fixed in `plugin_profile`, left standing in the
  subject selector next to it. A door-owner's documents are now those whose initiative its door
  recorded work on, which reaches 211.

### Upgrade notes

- Any round recorded against a `document` ruler for a door-owning plugin sampled the wrong
  artifacts, or none. Re-run rather than re-read it.

## [0.52.4] — 2026-09-19

An initiative's two ends are the ones its flow declares, and it must have reached the last.

### Fixed

- **A ruler whose subject is the initiative was judging pairs no flow ever produced.** The two
  ends were the oldest and newest document in the initiative folder by creation time — but that
  folder also holds material registered with `source_add` under `sources/`, and `handover.md`,
  which is written after the close by a different plugin's skill. Two of three subjects in a
  real round were therefore a stakeholder attachment against a spec, marked 4.55. The ends now
  come from the flow's own `stages[].produces` in stage order, which excludes everything else
  without naming any of it. Stage order rather than clock order, because an audit sends a
  document back and the newest write is then not the furthest point reached.
- **An initiative still in flight was judged as though it had finished.** Asking whether the end
  delivers what the beginning asked for, of work that has no end yet, marks the work's
  incompleteness rather than the plugin. An initiative that has not reached its flow's closing
  document is no longer a subject, and a version with no such initiative is refused with that
  reason — `not-evaluable` is in the recommendation enum for exactly this case.

### Upgrade notes

- Any round already recorded against an `initiative` ruler sampled the old way. Its marks are
  about pairs the flow did not produce; re-run rather than re-read them.

## [0.52.3] — 2026-09-19

An initiative pair is shortened rather than lost, and a round names the judge that marked it.

### Fixed

- **An initiative subject scored nothing when both its documents were real.** The `initiative`
  ruler subject hands a judge the beginning and the end of one initiative at once, and an
  untruncated pair overran the typed judgement service's input window — it answered
  `max_tokens_exceeded` and the subject was skipped, losing it rather than shortening it. Each
  end now gets half of `ZZ_JUDGE_PAIR_CAP`, and a cut is announced in the text the judge reads
  as well as counted in the stored `truncated`. Truncating the concatenation from the end would
  have fed the whole beginning and none of the conclusion, which is the one comparison that
  subject exists to make.
- **A round marked by the typed judge reported the reading model's name.** `round_judge`
  returned `judge: JUDGE_MODEL` unconditionally. Marks from two judges are two scales, and a
  round that misreports which one produced it makes that distinction unreadable from the record.

### Upgrade notes

- `ZZ_JUDGE_PAIR_CAP` is new and optional; it defaults to 24000 characters and only affects
  rounds whose ruler takes `initiative` as its subject. A judgement service with a larger window
  is the same contract with a different number.

## [0.52.2] — 2026-09-19

A parameter the statement stopped naming, and the check that now watches for it.

### Fixed

- **`plugin_profile` threw for every plugin that serves a door.** 0.52.1 made the tool-use query
  count across all versions, which dropped its reference to `$2` — while the caller still passed
  `[plugin, version]`. Postgres rejects that bind rather than ignoring it. `tsc` was clean, the
  gate was green and the dry run was green, because nothing offline reads SQL inside a template
  literal and the dry run's throwaway stack has no released plugin version to profile.

### Added

- **`checks/query-arity.ts`** — a statement's highest `$N` against the length of the array its
  caller binds, over every `.query(\`…\`, [...])` under `services/`. 113 statements compared.
  **It would not have caught the bug above**, and says so in its own header: that statement is
  assembled from a fragment, so it sits in the 34 this cannot read. A check whose stated
  motivation it cannot detect is worse than no check, because the next reader believes the class
  is covered — so the limitation is written down beside the rule rather than discovered later.

## [0.52.1] — 2026-09-19

The window a tool-use figure is counted over.

### Fixed

- **`never_called` asked about four minutes.** 0.52.0 correctly moved tool attribution onto the
  plugin's own door, then scoped it to a single plugin VERSION — so for a plugin released
  minutes earlier it reported the surface as unused. Measured: zz-core's door has taken 627
  calls across its life and 1 since 0.52.0 shipped, and the list built on the second called
  fourteen tools in daily use dead surface. "Is this tool ever called" is a property of the
  SURFACE, which barely moves between releases; the run-shaped figures stay version-scoped
  because those genuinely are about the version. `use_window` now states which question was
  asked.

## [0.52.0] — 2026-09-19

Two models, split by what each is good at — and the evidence fix that changed a verdict.

### Added

- **Typed judgments.** A ruler dimension is a position on named levels; a recommendation is one
  word from a closed set; a threshold is a yes/no over a figure. Those have SHAPES, and a
  general model asked for them in prose can answer outside them. A typed judgement service now
  fixes the score, the recommendation and every threshold verdict, and a language model reads
  the artifact beside those numbers and writes what they mean. **The order is the safeguard**: a
  typed answer cannot be off-vocabulary or unparseable, and an explanation written afterwards
  cannot invent a score to suit its argument, because the score was settled before any prose
  existed.

- **`round_recommend`** — the verdict as an enum with its probability distribution and a
  confidence that is the distribution's shape rather than the model's opinion of itself.
  `keep` · `keep-and-change` · `re-run` · `not-evaluable` · `retire`.

- **`not-evaluable`, and it earns its place.** It is a verdict about the MEASUREMENT. The first
  report written on this platform called zz-core weak when the truth was that nothing had
  measured it — a void round over a one-event window, reported as a low score.

- **An initiative-level judge subject.** "Does the end deliver what the beginning asked for" is
  a property of the sequence, so a judge marking one document at a time could never see it: the
  most important question a flow can be asked was the one its rulers could not express. The
  judge now reads both ends of one initiative together, labelled.

- **A ruler names its levels** — 2 to 10, ordered. Two ends and a 1–5 scale left the rungs
  between them to whoever was marking, which is where two rounds stop being comparable.

### Fixed

- **`plugin_profile` gave two plugins each other's evidence.** Tool use was attributed by SKILL:
  runs of a plugin's own skills, and the calls inside them. But which plugin a tool call belongs
  to is a fact about **the door it arrived on** — a rule this platform already holds as a
  knowledge node. zz-core serves `/core/mcp` and read as **1 run with all 15 of its tools never
  called**; its door had taken **627 calls** and 14 of the 15 were in daily use. The same query
  counted those calls as sdlc's own. A plugin that declares a server is now profiled from its
  door; one that declares none is a flow and keeps skill-based attribution.

### Changed

- **findings.md is five sections**: Outcome (recommendation · confidence · key numbers · one
  paragraph), what is good, what is bad, what to do to improve it, and what this does not
  establish. *Bad* and *not established* are kept apart deliberately — one says the evidence
  shows a defect, the other that there is no evidence.

- **The judge is recorded per round**, so moving to a typed judge reads like a change of rubric
  version rather than silently redefining what every earlier score meant.

- **`checks/eval-names.ts` names the door's tool set** instead of asserting a count of ten — a
  count fails identically whether a tool was lost or added, and says neither.

### Upgrade notes

- **Migration 062** adds dimension levels, per-mark confidence and probabilities, and the
  recommendation enum as a check constraint. No action.
- **`TYPESAFE_API_KEY` is optional and absent is supported.** Without it, rulers written the old
  way keep the reading judge, and a report says its recommendation was not taken and why.
- **`plugin_profile` figures move for any plugin that serves a door.** That is the correction.

## [0.51.0] — 2026-09-19

The evaluation instrument, fixed before it was used to evaluate anything.

### Fixed

- **`plugin_profile` reported a tool in daily use as never called.** `use` and `never_called`
  grouped tool calls by the name the caller typed rather than the alias-resolved one, so a
  renamed tool appeared as two unrelated rows — `core:skill_read` 31 beside `core:skill_view`
  23, `core:document_read` 19 beside `core:read_file` 4 — and `never_called`, which is built by
  subtracting the called set from the reachable set, listed `knowledge_search` while
  `core:search_knowledge` had five calls against it. "A tool its skills name that was never
  called" is one of the two questions this flow exists to answer, and a ruler written from that
  list would have recommended deleting a tool somebody uses every day.

- **`stage_paths` walked initiatives that do not exist.** It read the event log's initiative
  column raw, and that column holds whatever a call passed before the platform answered — so a
  document path recorded by a failed `document_read` came back as an initiative with a stage
  path through it. Same shape rule as the reconciler now applies.

- **The judge's own transcript named one tool twice.** `traceOf` builds the text a judge reads
  from the raw subject, so a run that called one tool under two spellings read as though it had
  reached for two different things.

- **The activity feed did the same**, one console page over.

### Changed

- **A trace count of zero now says WHY.** A run belongs to a plugin version through the skill
  versions that version shipped, so a release that re-versions a plugin's skills starts its
  trace history at zero by construction. zz-core 0.50.0 reported `runs: 0` the day it shipped
  while its skills had been loaded all week under their previous numbers — an honest zero that
  reads exactly like a broken join. The cases block already explained its own emptiness; traces
  now do too.

- **`checks/tool-key-read.ts` covers every reader.** It pinned the rule to one file while four
  other surfaces read the raw column. It now reads the SQL in each — template literals only,
  comments stripped, output strings excluded — and was verified to FAIL with the defect
  reintroduced before being trusted.

### Upgrade notes

- No migration. `plugin_profile` figures change for any plugin whose tools were renamed: counts
  merge and `never_called` shrinks. That is the correction, not a regression.

## [0.50.0] — 2026-09-18 · console 0.16.0

A full audit of both repositories, tool by tool, route by route, page by page. Six walks, every
finding reproduced before it was fixed — and the new probe assertions were run against 0.49.0
first, where all six go red, each naming its defect.

### Fixed

- **`initiative_status` could not answer `close` for any gating flow.** The platform appends a
  handover to every flow that gates something, and its prerequisite is the closing document —
  satisfied the moment the last gate is approved. So the handover became the pending document
  and the platform told every agent to write a handover about an initiative that had not
  closed; `document_approve` then refused the close until somebody signed it, while zz-handover
  requires the outcome to exist already. Two of the six next moves were unreachable in
  production. The handover is the closed branch's business now, and the probe asserts the close
  is offered. A flow that gates nothing reaches `closed` instead of asking for a handover
  forever.

- **No gated document could be overwritten, draft included.** `document_write` says "create or
  overwrite" and rebuilt the envelope from its arguments, so the rewrite dropped `status`,
  `version` and any approval — and removing a field the platform owns is refused. An agent asked
  to rewrite a spec nobody had approved was told to *approve* it instead. The previous copy's
  platform-owned fields are carried forward now, which also stops a rewrite silently resetting a
  revised document to v1 and overwriting a `_versions/` snapshot that already existed.

- **An abandoned close reached no ledger row, and said it had.** Abandoning is the close that
  does not land on the closing document — the work stopped before that document was written —
  and the ledger append skipped exactly that case while the tool reported a row. The ledger is
  what a team's counts are totalled from. The missing row for the one live instance is appended
  and the store committed.

- **An approved freeform document could be patched.** A gate is a person saying yes, not a
  manifest, and `document_approve` accepts any document in a freeform folder for that reason —
  but the guard that protects an approved document asked the manifest, found none, and stood
  aside. It reads the signature on disk now. A document an initiative CLOSED on gets its own
  refusal: a closed record may be corrected, and a correction says what caused it, which is
  `document_revise` and not a silent overwrite.

- **A registered source could be overwritten.** `source_add` calls itself immutable and was
  enforced only by being the tool people used: writing to `sources/…` had three path segments,
  so every document guard short-circuited and the overwrite landed with no contributor, no
  `supports` and no date — taking the source out of attribution and out of the rule that a
  revision must cite its evidence.

- **`document_revise` minted an approval nobody gave.** Revising a document an initiative closed
  on wrote `status: approved` with no approver, on a document no manifest gates — the state 0.44
  removed, reached through a fourth writer, and the likeliest shape for it is an abandoned close
  landing on `explore.md`. It also printed "status undefined" on every ungated revision and told
  the caller nothing downstream could proceed until a document `document_approve` refuses was
  approved.

- **Two claims about frozen copies were false.** A snapshot is taken when a document goes draft
  to approved and at no other time, so revising a closed document twice named a `_versions/`
  file that was never written, and re-approving pointed at a copy that still carries the
  previous signer.

- **The console and the platform described different flows.** The handover derivation lived
  inside zz-core, where the console cannot reach it, so the console reported an initiative
  complete whose handover nobody had signed and drew that document with no gate rule. Both read
  one function now.

- **A `teamless` route returned every other team's slugs.** `/skills` is platform-wide by design
  and also handed back the teams that had run each skill — a member of one team learned which
  other teams exist, what they run and how often. Nothing read the field.

- **Renamed tools were drawn as two unrelated series.** The console grouped by the name the
  caller typed rather than the alias-resolved one, so one tool appeared twice and every ranking
  built on it was wrong by that split; the historical rows are backfilled.

- **The refusal rate counted things that are not refusals.** A call comes back not-ok for four
  unrelated reasons, and the tile that asks "is the tool surface breaking" counted all of them —
  most of what it was reporting was one client sending a malformed argument. Every refusal now
  records whose it is, and the tile splits on it.

- **Initiatives were minted from refused calls.** Whatever string a call passed as its
  initiative was recorded before the platform had answered, so a bad argument on a failed call
  became a real initiative — document paths and a free-text sentence among them — and runs were
  filed against them. An initiative is now a folder something was successfully written into, or
  one that has documents.

- **A telemetry row named one skill and carried another one's hash.** When the manifest overrides
  the traced step, the version and the content hash went on coming from the last skill loaded;
  one hash spanned six different step names.

- **The activity trend's first bucket included events from before the window**, so the chart and
  the tile above it disagreed about the same number.

- **`knowledge_reindex` could not repair the knowledge store.** The rebuild walked the documents
  table only, so a node deleted on disk kept its row for good and a retired team's journal
  survived the archive — the ghost row the rebuild exists to remove. It also stamped every node
  with the moment the index ran, so a rebuild restamped the whole journal to one afternoon; a
  node's own recorded date is used now.

- **Deactivating a person did not revoke their tokens.** It said they stop working immediately,
  which held only while the principal stayed deactivated — and adding them back is an upsert
  that reactivates, so re-adding somebody months later silently restored every token they had.

- **A bound token, and the fourth canonical header.** A team-bound superadmin token arrived at
  zz-core stamped `admin`; `pat_issue`, `team_switch` and the console's token route each let one
  reach further than it does. `x-zz-user-id` was the one identity header the middleware did not
  overwrite, leaving it to a proxy rule rather than to the line that depends on it.

### Fixed — console 0.16.0

- **Every skill with a recorded run threw instead of rendering.** The page read a rubric, its
  dimensions and its findings from fields the gateway stopped sending when an evaluation's
  subject became a plugin version; the tab is what a skill cost to run.
- **"Waiting on you" counted gates nobody had drafted** — work waiting on the agent, reported as
  signatures owed, while the Overview tile one page away said none were.
- **"Updated just now" could not be false.** The freshness stamp was evaluated at render, over
  cached data and over the error state alike; it reads the real fetch now, oldest panel first.
- **A completeness median was labelled as a count of open work**, which made the tile
  arithmetically disagree with the bar beneath it.
- **A knowledge node showed two different times one page apart**, and every platform-shelf node's
  evidence linked to a team that does not hold it.
- Plus: "null MB"; a caveat banner watching a column nothing writes; the Adopted tile and its own
  row badge reading different fields; tiles stating zero while loading and after a failure; five
  page descriptions claiming the platform over one team's rows; an ablation delta shown without
  the errored-run count that qualifies it; two gates at one stage collapsing into one chip;
  `abandoned` rendered in the success colour; a version badge disagreeing with the version chain
  below it; an empty list blaming filters nobody had set.

### Changed

- **The handover derivation moved to `@zz/catalog`**, so zz-core and the console read one answer.
- **`refusalOwner` is in `@zz/contracts`**, beside `refusalClass`, and the gateway stamps its
  verdict on every refused call — previously it existed only in a release-time script, where the
  instrument that writes the data could not reach it.
- **Four source files were split by subject** to stay under the line ceiling: the chain check's
  eval-door walk and its closing walk, the tool report's across-runs half, and the knowledge
  store's read side.
- **A test that asserted a literal against itself is gone**, and two that pinned defects in place
  now assert the corrected behaviour.

### Added

- **`scripts/release/walk-released.ts`** — the same tool-chain walk, against an image ALREADY
  released. The dry run proves a check green on the code about to ship; it cannot prove the check
  would have failed on the code that ships replaced, and a check that passes against both is
  measuring nothing. This release's six new assertions were run against 0.49.0 first and all six
  go red.

### Upgrade notes

- **Migration 061** adds `zz.event.refusal_owner` and backfills it from the refusal text. No
  action.
- **`zz.run.turns` and the turn-event caveat are gone from the API.** Nothing wrote either.
- **`GET /api/console/skills` no longer returns `teams`**, `/skills/:name` no longer returns
  `dimensions`, `findings` or `evaluated`, and `Skill` no longer carries `turns`. All were
  unread or unwritable.
- **`Gate` now carries `written` and `role`.** A gate whose document does not exist is waiting on
  the agent, and the derived handover belongs to the closed branch — a caller reading `passed`
  alone will count both as signatures owed.
- **The phantom initiative rows repaired in this release will come back until the fix is
  deployed**, because the reconciler on the running deployment still mints them. Repeat the
  repair after the deploy.

## [0.49.0] — 2026-09-18

An abandoned close named an acceptor.

### Fixed

- **`abandoned` recorded `accepted_by`.** Closing is the sign-off (0.48.0), and that rule was
  applied to every close — including one saying the work stopped before it was done, which left
  `accepted_by` on a record whose outcome says nobody got what they wanted. Only a finished close
  has an acceptor now. Found on the first real abandon after 0.48.0 shipped; the chain check
  walks both halves — a finished close records an acceptor, an abandoned one records none — and
  the freeform walk moved into `chain-freeform.ts`, its own subject and under the line ceiling.

## [0.48.0] — 2026-09-18 · console 0.15.0

0.47.0's content, plus the defect its own verification found.

### Fixed

- **A revision minted a status on a document its flow does not gate.** 0.44 made `status` a gate
  verdict — stampEnvelope writes one only where the manifest declares a gate, `document_approve`
  refuses a document that carries none — and `document_revise` was the third writer of that rule
  and the one that missed it: every revision went back to `draft` regardless. It reached real
  work (`quan/2026-09-18-daily-collectors-running-correctly/explore.md`), and the doctor probe
  that watches for exactly this rolled 0.47.0 back rather than let it stand. That document is
  corrected in the store. The chain check now revises an ungated document and asserts no status
  appears, so the next writer to miss the rule fails in the dry run.

## [0.47.0] — 2026-09-18 · console 0.15.0 — NEVER SHIPPED

Deployed, failed verification on the defect above, and was rolled back. Its content ships in
0.48.0.

How a flow defines a step, said once and enforced everywhere: what it leaves behind, whether
that is a deliverable or evidence, and whether a person has to agree to it. Plus the reason
0.45.0 and 0.46.0 were rolled back — nothing exercised the tool chain until production did.

### Added

- **The dry run walks the tool chain against the image being released.** A postgres, a zz-core
  and a gateway from the new image on their own docker network, a first token minted the way a
  fresh install mints one, then `chain-check`. Both rollbacks this week were checks that only
  ever ran against the live deployment, asserting contracts those releases had changed; that
  class of failure is now local, a minute in, with nothing pushed.
- **`deploy/issue-first-pat.sh` works again.** It still inserted `scope`, a column dropped when
  PAT scopes went, so the one script a fresh install cannot do without died at the moment there
  is no other way in. Found by the tool-chain walk, which mints its token the same way.

### Changed — breaking

- **A step declares what it leaves behind, in one vocabulary.** `produces` is a document name (a
  MAIN deliverable the flow declares), `"source"` (SUPPORTING evidence another document changes
  because of), `"record"` (rows in the platform's tables) or `"nothing"`. A source stage names
  its target — `supports: "plan.md"` — and only a source stage may. ARCHITECTURE.md carries the
  model; `FlowStage` is two shapes rather than one loose object.
- **An audit round is a SOURCE, not a document.** sdlc-flow declares four documents, not six.
  The audit registers its findings with `source_add(..., supports: "spec.md")`, the revision it
  causes cites that source, and each round is its own file — so three rounds leave three, with
  nothing to append to and no second copy of any of them.
- **A content change names the material behind it.** `document_revise` refuses a revision that
  cites nothing: `sources` for what is on the record, `source_content` for words that are not.
  `self_edit` is gone — it was the route for a version nothing caused. A revision must also cite
  any source that supports the document and is newer than the version being replaced. The
  envelope is untouched by this: approving and closing are not content changes.
- **A stage's state is derived from what it produces**, so a `"source"` stage is done when a
  source declares it supports that stage's target — no ordering guess, and nothing anywhere
  knows the word "audit".

### Console 0.15.0

- **The diagram carries its own detail.** The paragraph under the stepper is gone; the outcome
  sits under the closed node, the way a gate says "approved" under itself.
- **A step that leaves no document is shown as passed** when a later step produced something —
  `execute` is green because the review after it exists — rather than drawn as a mystery.

## [0.46.0] — 2026-09-18 · console 0.14.0 — NEVER SHIPPED

Deployed, failed verification and was rolled back: `chain-check` still asserted the contract this
release changed. Its content ships in 0.47.0. What follows is that content.

Closing is an act, and the progress diagram now shows only what the record can evidence.

### Changed — breaking

- **An abandon records wherever the work stopped.** A flow's closing document is written by its
  last stage, so an initiative that stopped at the plan had none — and `initiative_close` refused
  until one was written, which made `abandoned` mean "write the review you never did first". It
  now records on the furthest declared document that exists.
- **The progress diagram is derived, bookend to bookend.** Every initiative opens and closes and
  no manifest declares either, so `open` and `closed` are steps of every flow. Between them each
  stage carries a state read off the manifest and the store: `done` (its documents exist and
  their gates are approved), `partial` (written, a gate still open), `empty` (nothing written),
  `untracked` (the stage declares no document, so nothing could evidence it). Closing no longer
  fills the stages in: an initiative abandoned at the plan used to show six finished stages and a
  review nobody wrote.
- **`/api/console/initiatives`**: `steps` carry `state` and `current` instead of `done`, include
  the two bookends, and gate `after` indexes that list; each initiative also reports `complete`,
  which is whether every gate was approved and every document required to close was present.
- **Closing is the sign-off.** Every call carries a person's authority — a token IS a person, and
  an agent calls under the authority of whoever it works for — so `initiative_close(finished)`
  records that person as the acceptor and the outcome is `accepted`. `accepted_by` now names
  somebody ELSE; `no_signoff_reason` is the deliberate route to `delivered`, for work nobody
  accepted. Three initiatives had closed `delivered` — "nobody signed it off" — with the closer's
  own name on the close; they are corrected in the store.
- **A revision cites what already explains it.** A flow declares which documents READ another
  (`plan-audit.md` requires `plan.md`), so an audit round written after the version being replaced
  is what the revision answers. `document_revise` refuses until it is cited, instead of leaving
  the agent to paste the findings back as a second copy. `sdlc-plan` and `sdlc-audit-criteria`
  say the same thing: one round leaves one file, and the revision cites it.

### Console 0.14.0

- **One alignment rule for every table**, held by the `Table` primitive: first column left, last
  right, everything between centred, header and cell alike. It was a class on individual cells,
  so thirteen tables had each decided it separately.
- **The stepper renders the API's states** and computes nothing: an outline node means the step
  leaves no document behind, not that it was skipped.

## [0.45.0] — 2026-09-17 · console 0.13.0

The platform stops keeping a record it could not back: which plugins a team had "installed".
It cannot see what is on a person's machine, so that record was a claim, and every use of it a
restriction nobody could enforce. zz-core and zz-access are required; every other plugin is a
person's own choice.

### Removed — breaking

- **`flow_install`, `flow_uninstall` and `install_list` are gone.** `/manage` goes 20 tools to
  17 for a superadmin. `catalog_list` still lists the shelf, and no longer takes `team` or says
  whether a team "has" a plugin.
- **Migration 060 drops `zz.flow_install`.** Nothing is carried forward: an initiative's flow
  is its own declaration, and every initiative on this deployment already makes one.
- **The install registry no longer decides anything.** The client package is built from the
  catalog — the same shelf for everyone, zz-core and zz-access marked required and installed by
  the setup block, the rest listed for a person to choose. Every catalog skill is readable by
  everyone. `initiative_open` accepts any flow the catalog has. An initiative that declares no
  flow is freeform; it is no longer governed by a team's single install.
- **zz-plugin-eval is no longer installed for every team**, and the automatic-install flag it
  was the only user of is gone.
- **Console API:** `/api/console/settings/team/flows` is removed; `/api/console/teams` rows
  lose `plugins`, `events`, `workEvents` and `instrumented` and gain `sources` and `knowledge`;
  `/api/console/teams/:slug` loses `flows`; overview `eventKinds` rows lose `failed`.

### Fixed

- **Closed initiatives read as open.** sdlc-flow once closed on `spec.md` and now closes on
  `review.md`. Initiatives closed back then carry their outcome on `spec.md`, and both the
  console and `initiative_status` looked only at today's closing document — three closed
  initiatives showed "Waiting on you". The outcome is read from whichever document carries it.
- **A team's documents included its sources.** One team read 240 documents: 31 written, 209
  registered sources. They are counted apart.
- **A `flow:` knowledge tag resolved per team.** It resolves to the plugin's release now, through
  `pluginName` — which moved into `@zz/catalog`, where every reader of the rule imports it.
- **The attribution check passed on a comment.** It asserted a join that no longer ran and
  matched only because a comment still named the table. It asserts the door lookup now.

### Console 0.13.0

- **Overview tiles line up whatever the period.** Fixed one-line slots; the comparison moved onto
  the delta pill's hover; no legend rows; a row counts its columns from its own width.
- **Bar lists are honest.** A bar is its share of the total, one number per row, the share on
  hover, in the theme accent. The refusals panel lost its duplicate headline and sits beside
  Event kinds, which states its total.
- **Titles are statements**, across every page.
- **Teams** counts documents, sources and knowledge nodes apart; the install views are gone.
- **An outage is not a refusal.** A gateway that cannot reach its database no longer sends a
  signed-in person to the login screen as "not open to you".

### Upgrade notes

- **Release the console right after the platform.** Console 0.12.0 reads team flows and errors on
  a team page against this gateway.
- **Clients re-pull the shelf.** zz-access is now marked required, and anyone who relied on
  zz-plugin-eval arriving automatically installs it: `claude plugin install zz-plugin-eval@zz-stack`.

## [0.44.0] — 2026-09-16 · console 0.12.0

Every capability is a plugin, and the platform now matches that sentence. This release removes
the last of the concept that competed with it, and makes eleven of the thirteen rules it rests
on things the gate fails on rather than things a document asserts.

### Removed — breaking

- **Four tools changed door.** `bug_list`, `bug_resolve`, `bug_delete` and `knowledge_reindex`
  are on `/core`, not `/manage`. Filing a bug was on one door and answering one on the other,
  because answering is an operator's act — which is role deciding a door. The subject decides
  the door; role decides who SEES it, and all four are still superadmin-only. `/core` goes 20
  tools to 24 for a superadmin and stays at 20 for everybody else; `/manage` goes 24 to 20.
- **`flow.json` no longer carries `version`.** Every plugin ships at the platform's release
  number. It had two answers: flow.json said zz-access 2.3.0 while the shipped plugin.json said
  0.43.0, and the registry recorded the former — so evaluation, whose job is comparing versions,
  was reading a number nobody ran.
- **`document_write` and `document_revise` no longer take `blocks`.** No flow declares a
  selection document, so the guards behind it had never fired.
- **`document_approve` refuses a document its flow declares WITHOUT a gate.** An ungated
  document is finished by being written; there is no verdict to record.
- **Three migrations drop schema.** 057 removes the third-party server tables and columns; 058
  folds the platform's own tool surface into `zz.plugin_tool` and drops `zz.block*`; 059 moves
  853 knowledge nodes into `zz.knowledge_node`, where `adopted` stops sharing a column with
  `approved`. After all three: no `block*` table or column remains.

### Fixed

- **Telemetry attributed tool calls to the wrong plugin.** It inferred them from the caller's
  most recently read skill. 3,928 calls on `/core`, 192 attributed, 150 of those naming a plugin
  that declares no server and so cannot serve a tool call. A door IS a plugin's declared server.
- **Ungated documents carried an approval verdict.** Two writers, and correcting one was not
  durable: `stampEnvelope` conditioned on "the manifest declares this" where the rule is "the
  manifest gates this", and `document_approve` had the same wrong predicate spelled differently.
- **The document insert named 19 columns and 20 values.** Postgres refuses that, inside the
  catch that makes indexing non-fatal — the service would have started, the store kept working,
  and the index silently stopped being written.
- **The live chain check left its initiatives behind.** It opens one per run and closes it, and
  closing is not deleting. Three days of releases — `--dry-run` included, the mode that reports
  touching nothing — left 56 probe initiatives holding 434 documents, 1,882 events and 240 of
  the platform's 350 runs. Four sat on a real person's team. Every ratio anybody had computed
  about this platform was taken over a store that was 81% probe output.

### Added

- **`checks/definition-rules.ts`** — R1, R3, R4, R5's write half, R7, R8 and R12, each its own
  clause naming its own rule. R8 carries a frozen tool→domain table for all 54 tools, because
  the test is a question a person answers and a check could only ask a model.
- **`checks/insert-arity.ts`** — counts an insert's columns against its values, offline. `tsc`
  cannot read SQL in a template literal and `check:sql` needs a database, so this class of
  defect had no check at all.
- **Three doctor probes** — the two rules about DATA cannot live in the gate, which is offline
  by design: no initiative left by a probe, no document carrying a status its flow does not
  gate, and every tool call naming the plugin whose door it arrived on.
- **`scripts/ops/purge-probes.ts`** — an operator script, deliberately not a tool on any door.

### Console 0.12.0

- **One width inside a card.** A document page was 832px while the other nineteen were 1536, so
  opening a spec from its initiative halved the layout under a full-width header. Capping the
  prose and not the tables was worse — two widths in one card. Content fills its card.

## [0.43.0] — 2026-09-16 · console 0.11.0

The two panels under the overview tiles. One drew the wrong population; the other drew the
right one unreadably.

### Changed
- **"Tool calls over time" replaces "Events per hour".** The old chart drew every EVENT, so
  its largest feature was whichever archive had been imported that day and the work was
  invisible underneath it. `metrics.toolTrend` carries tool calls split three ways that are
  DISJOINT and sum to the total — `inside` a run, `outside` a run, `refused` — so the console
  can stack them on one axis and the column height is a real number of calls.

  **Every bucket in the window is emitted, including the empty ones.** Grouping the events
  alone returns no row for a quiet hour: a 24-hour window came back with 13 rows, and a chart
  that spaces 13 buckets evenly across a day states a shape the data does not have. An hour
  with no tool calls is a zero.

- **`refusals` is two axes over the population the Refusal rate tile counts.** It was a
  top-12 of every failed event of any kind, so this panel's total and the tile's were two
  different numbers wearing one word; both are `kind='tool_call'` now and the two agree.
  `byTool` and `byMessage` answer different questions and neither derives the other: one tool
  refusing for nine reasons is a surface problem, nine tools refusing with one identical
  message is a single bug. `byMessage` carries how many distinct tools emit each message,
  which is what makes the second case visible at all.

  The console's table of tool · count · message is gone with it. It truncated the message
  column at 36 characters — exactly where these refusals differ from one another — and ranked
  by count, so one tool filled every row.

### Upgrade notes
- **Roll the two together.** Console 0.11.0 reads `toolTrend` and the reshaped `refusals`;
  against a gateway below 0.43.0 the overview page throws rather than degrading. No
  migration and no env key — both statements read columns `zz.event` already has.

## [0.42.0] — 2026-09-15 · console 0.10.3

The first overview tile read 100% and could not read anything else. That is the entry; the
other two are things noticed while looking at it.

### Changed
- **"Initiatives progressing" is the median over OPEN initiatives.** It was the median over
  every scoreable one, closed included — and a closed initiative is 100% complete by
  definition and never moves again, so each one is a permanent vote for the maximum. Measured
  on production the day this changed: 29 active initiatives, 13 with no flow declared and so
  unscoreable, **13 closed, 3 open**. Thirteen hard 100s against three real numbers put the
  median at 100 and nothing happening in the unfinished work could have shifted it.

  The tile asks "is work advancing, or only accumulating?" and, scored that way, answered
  with the accumulation. The stage bar still counts all six stages including closed — where
  the active set IS is a different question from how far the unfinished work has got.

  A consumer of `/api/console/overview` sees a different number for `metrics.progressing`
  from the same data, which is why this is a minor and not a patch.

### Fixed
- **Every tile's comparison read "vs the previous last 24 hours".** `PERIOD_LABEL` names the
  option in the picker, where "Last 24 hours" is correct; lowercasing a label is not the same
  as having a phrase. There is a `PERIOD_SPAN` now, and the sentence reads "vs the previous
  24 hours".
- **The delta pill sat at the far edge of its tile.** `justify-between` pinned it to the right
  margin, so at a wide column an inch of empty tile separated the movement from the value it
  describes, and the two stopped reading as one statement. It sits beside the number.

### Upgrade notes
- **Nothing to do.** No migration, no env key, no change to the shape of any payload — one
  metric is computed over a different population, and the console states which on the tile.

## [0.41.1] — 2026-09-15 · console 0.10.2

The console only. The platform is unchanged and takes a patch because a release needs a
number, not because anything in the gateway moved.

### Changed
- **The overview row draws its four marks in one shape.** Three tiles carried a composition
  bar and the fourth a cloud of one dot per measured run, which at this platform's volume was
  a wall — a different species of object beside three clean bars, and the untidiest thing on
  the page. "Context pulled per run" draws size bands now: decades, because the distribution
  spans them, and the last band is exactly the tail the strip existed to show, stated in words
  rather than drawn as a cloud. `DotStrip` had one caller and is deleted with its tests.
- **The inline legend is a fixed shape, not a function of its data.** It named each slice with
  its figure — `34 not started · 5 drafting · 5 agreed · 25 settled` — which is wider than a
  tile column, so it wrapped, and one tile in a row of four stood two lines taller than its
  neighbours. It names the colours only now. The figures did not go anywhere: the sublabel
  states the total, and hovering or focusing a slice gives that slice's count and share.
  Beyond four slices the remainder folds into `+N more`.

  Shortening the labels was tried first and is worth recording as the thing that does not
  work: the width was a function of the data, so the next figure to gain a digit brings the
  second line back. It wraps rather than clips below about a 300px column — holding one line
  at every width meant rendering "settled" as "sett", which looks broken in a way a second
  line never does.

### Upgrade notes
- **Nothing to do.** No migration, no env key, no API change — `runs[].kb` was already in the
  overview payload, so the bands needed no gateway field. Only the console image moves.

## [0.41.0] — 2026-09-15 · console 0.10.1

0.40.0's new field, an hour old, drawn against production for the first time and found to be
decoration. This entry is that, fixed, plus the two other things looking at real data made
obvious.

### Changed
- **`metrics.refusals.byDoor` replaces `byBlock`.** The split is read off `subject`
  (`<door>:<tool>`) rather than `event.block`. `block` is null on every tool call this
  platform has ever recorded — 781 of 781, all time — so grouping by it put every refusal in
  one `(platform)` bucket and the console drew a single full-width bar restating the number
  beside it. `subject` is always present and gives a real split: core 641 · eval 125 ·
  admin 9 · manage 6. Same predicate, same total, an axis the data actually varies on.

  The lesson is worth more than the field: a green gate, a passing test suite and 18 live
  probes all agreed 0.40.0 was correct, because every one of them ran against a fixture or a
  shape. Running the shipped statement against the real table is what found it.

### Fixed
- **The overview row was two lines taller than it needed to be, in three places.** The stage
  legend named six stages under a bar that can only draw four — `no flow` and `not started`
  are both steel, `gated` and `closed` are both sage, and two adjacent slices in one colour
  are one slice to the eye — so it named distinctions the chart did not draw and wrapped
  doing it. It merges where the colours already merged, and nowhere else. The context tile's
  sublabel opened by restating the tile's own `description` one line below it. And the
  refusal bar's single slice is now four.

### Upgrade notes
- **Roll the two together, as with 0.40.0.** Console 0.10.1 reads `byDoor`; a gateway below
  0.41.0 does not send it, and the overview page throws rather than dropping the mark. No
  migration, no env key — the door is parsed from a column `zz.event` already has.

## [0.40.0] — 2026-09-15 · console 0.10.0

A minor on both sides. The gateway's overview payload gained a field; the console's metric
tile lost a variant. The thread running through it is one complaint — the four tiles on the
overview did not read as four of one thing — and the two things that turned out to be true
behind it.

### Added
- **`metrics.refusals.byBlock` on `GET /api/console/overview`** — the refused tool calls split
  by the block that refused them, largest first. The rate says how much; this says WHICH DOOR,
  which the rate cannot. It is the same predicate the rate already uses (`kind='tool_call'`
  and `ok = false`) grouped rather than counted, so it sums exactly to `refused`.

  It is not the `refusals[]` list the same payload already carried, and the difference is the
  reason a new field exists: that list is a top-12 over every failed event of ANY kind, so its
  parts neither sum to the tile's total nor compose anything the tile states. Both scopes are
  covered — platform reads `zz.event` directly, a team reads it through the join.

### Changed
- **The overview charts answer the cursor.** They carried a native `title=` attribute and
  nothing else: most of a second's delay, unstyled, and invisible to a keyboard. They use the
  console's own themed tooltip now. A composition slice fades its siblings under the cursor,
  so a 2%-wide sliver is readable as itself while the whole still reads as a whole; a 7px dot
  in the distribution strip grows and lifts above its neighbours, so a reader in a cluster can
  see which dot they are reading. Both are focusable, because a readout must not need a mouse.
- **Refusal rate carries a mark.** It was the one tile of four with an empty middle, and the
  reason was written in its own help text — "the trend below already draws refusals over time".
  That reason did not survive being checked: the trend draws `ok = false` over every event
  kind, and the tile counts failed tool calls. It now draws `byBlock`. At zero refusals the
  mark is OMITTED rather than drawn empty: no refusals is this metric's goal state, and a row
  of four where the good tile is the tallest is backwards.
- **The trend's rose series is labelled "Failures", not "Refusals".** It draws every failed
  event; the tile beside it counts failed tool calls. Two populations under one word invite a
  reader to check one against the other and find that they disagree.

### Removed
- **`MetricCard` no longer takes `tone`.** `tone="attention"` drew a 4px rail in the tile's own
  hue and recoloured the title and the number with it, above a threshold. A tile wearing it
  stopped being this component and became a fifth silhouette in a row of four — which a reader
  resolves by asking what is wrong with THAT CARD before they have read its number.

  What that costs is worth stating, because the two things that remain are not substitutes:
  the tinted chip is IDENTITY (Refusal rate is rose at 0.1% too) and the delta pill is
  DIRECTION (a 9.3% rate falling from 12% wears a sage pill). So crossing a threshold has no
  visual anywhere now, deliberately. `emphasis` remains for singling out one tile, one per row.

### Upgrade notes
- **Roll these two back together or not at all.** They ship together here, so following this
  release needs nothing. A PARTIAL rollback does: console 0.10.0 against a gateway below
  0.40.0 reads `byBlock` off a payload that does not carry it, and the overview page throws
  into its error boundary rather than quietly dropping the mark. There is no guard for this
  on purpose — a version check inside the tile would be compatibility code for a state that
  lasts as long as somebody's mistake. `ZZ_VERSION` and `ZZ_DASHBOARD_VERSION` move together.
- **No migration and no env key.** The new field is read from `zz.event`, which already holds
  everything it needs.

## [0.39.1] — 2026-09-15 · console 0.9.0

The console only. The platform is unchanged and takes a patch because a release needs a
number, not because anything in the gateway moved.

### Fixed
- **The overview tiles say what they are again.** They had become an uppercase mono label, a
  number, and a six-colour bar with nothing naming the colours — reading one meant hovering
  the `i` to find out what "Knowledge from work" counted, and the bar's legend was not missing
  but SUPPRESSED, with `[&>ul]:hidden`. Back on the face: a sentence-case title with its
  one-line definition, a soft tinted icon chip, the delta as a pill beside the value, an
  inline legend in bar order, and the comparison as a footer. `help` keeps the caveats.

  What the previous design had right is kept: a large saturated circle beside a number does
  compete with the number, and four of them make nothing stand out. The chip is 32px against
  a 44px value, identity and emphasis are separate registers, and `emphasis` still marks the
  single tile carrying the finding.
- **A tile could render a silently grey icon chip.** The colour was built by hand as
  `var(--${tint}-tint)`, so a kit hue asked for `--blue-tint` — a variable that does not
  exist — and fell back to grey with no error anywhere. It is a map now: a tint with no
  measured chip pair is a type error. `--zz-blue` gained the pair it lacked, at 5.98:1.
- **A tile needing attention spoke in two colours.** The rail was amber unconditionally, so
  the rose tile carried a rose chip, an amber rail, an amber title and a red delta pill —
  three signals in two colours, on the one tile whose job is to be unambiguous. The rail takes
  the tile's own hue.
- **A design test asserted a class name rather than a property.** It required the literal
  `ink-faint` on a neutral delta and went red for a change that kept its intent exactly. It
  asserts what must hold: no status hue, and a neutral ink token.

### Upgrade notes
- **Nothing to do.** No migration, no env key, no API change. The gateway is byte-for-byte
  0.39.0; only the console image moves.

## [0.39.0] — 2026-09-15

A minor, because `/manage` gained a tool. Everything else here was found by doing 0.38.0's own
release procedure properly, afterwards — it was cut without a release branch, without the
changelog approval, and without the document accounting, and each of those omissions is
represented below by something it would have caught. The console did not move.

### Added
- **`bug_delete` on `/manage`, superadmin — and it is not a stronger `bug_resolve`.** Resolving
  is how this platform records what it has FIXED: the row, its status and the sentence
  explaining the decision are kept for ever, `not_a_bug` included, because that is a finding
  about something confusing rather than a note that nothing happened. Deleting is for rows that
  were **never anybody's report** — `chain-check` walks the tracker end to end against the live
  deployment on its way through a release, and every run left a real row reading "Safe to close;
  it reports nothing real." Five collected beside two genuine reports before anyone looked, and
  resolving them would have written fake decisions into the record of what this platform has
  fixed. It returns the row it removed, is logged and attributed, and refuses anyone but a
  superadmin. Never delete a report a person filed: if its resolution was wrong, file what you
  now know as a new report naming the old id.

  `/manage` is now 34 tools: 16 for a member, +4 for a lead, +14 for a superadmin. The chain
  check removes its own probe row and then asks `bug_list` whether it is gone, rather than
  trusting the success message.

### Fixed
- **`CONTRIBUTING.md` never said which Node.** 0.38.0 moved the contributor floor to 24, and
  the one document a contributor actually opens said nothing about it — so following it on
  Node 22 did not fail a check, it failed to PARSE. It now names the floor, points at
  `.nvmrc`, and says why the Docker images stay on 22 while the console's moved to 24.
- **Two counts in that file had drifted** — `279 checks` where the gate runs 346, and
  `26 import lines` where `gate.ts` has 34. Neither is replaced with a corrected number: a
  count in prose is a count that stops being true, and these two are the demonstration. The
  gate already refuses to pass when the modules and the checks that ran disagree.
- **chain-check filed bug reports it could not close.** It asked the `/manage` door what the
  token may do AFTER filing its probe report. A PAT that is not superadmin is not offered
  `bug_resolve`, so every such run left an open report in the tracker for ever — four of them
  accumulated across 0.36.1 to 0.38.0, sitting beside two real bugs, each one saying "Safe to
  close; it reports nothing real." The capability check moves above `bug_report` and the walk
  returns early. There is no `bug_delete` on any door, so before the row exists is the only
  moment the probe can avoid leaving it.

- **`register-plugins` reported a healthy registry as broken.** It inserted each membership with
  `on conflict do nothing … returning 1` and counted every empty result as missing — so a row
  that was ALREADY recorded, which is the normal case for every plugin whose version did not
  move, was indistinguishable from a skill the registry has never heard of. 0.38.0 printed
  "24 plugin member(s) UNRESOLVED" against a complete and correct registry, told the reader
  their lock described a different catalog, and prescribed a fix that took the number UP to 30.
  It now records 30 and reports 0 — and a planted absent skill still reports 1, so the counter
  still catches what it exists for.
- **A split hid two tools from the gate.** Moving the bug tools into `admin/bugs.ts` took
  `/manage` from 33 registrations to 31 without the door changing at all: two gate checks
  discover `/manage` tools from a hardcoded list of files. Both name the new module now, and
  the `if (sup)` guards stayed inside it — the gate parses those out of the source to decide
  which role is offered what, so guarding at the call site read as three tools handed to every
  member.

### Upgrade notes
- **Nothing to do.** No migration, no env key, no config change. `bug_delete` is additive and
  superadmin-only; every existing call is unaffected.
- `zz-access` goes to 2.3.0 and `zz-admin` to 2.5 — installed clients pick both up on their
  next pull.

## [0.38.0] — 2026-09-15 · console 0.8.0

**Nothing this platform serves changed.** No tool moved, no route changed, no stored shape
changed, and the running images are byte-for-byte the same work as 0.37.0. This release exists
because the layer that BUILDS and CHECKS the platform is TypeScript now, and that moved the
floor a contributor needs.

### Changed
- **BREAKING — contributing needs Node 24.** `scripts/`, `checks/`, `testing/` and the five
  shipped catalog skill scripts are TypeScript, run directly by Node's native type stripping
  with no build step: `node scripts/gate.ts` IS the gate. Stripping only reached Stable in
  24.12, so a checkout on Node 22 can no longer run the gate. `engines` and `.nvmrc` say so.

  **The Docker images stay on `node:22.23.2-alpine` and that is not an oversight.** `scripts/`
  and `checks/` are never copied into them, so the image version and the contributor floor are
  unrelated facts. Do not "fix" the mismatch.
- **Console — the same conversion, and its image DID move to `node:24-alpine`.** Unlike
  zz-stack, the console's Dockerfile copies the manifest that declares the floor and installs
  against it, so the two had to agree. Its `scripts/` and `checks/`, `eslint.config.ts` and
  `postcss.config.ts` are TypeScript; 105 strict errors it had never been checked against are
  gone, and `pnpm typecheck` now reads 22 tooling files it previously did not open.
- **`marketplace/` ships compiled JavaScript.** `catalog/` holds the `.ts` source and
  `build-marketplace.ts` compiles it to a staging directory first — consumers receive `.js`
  and never TypeScript, so nothing installing a skill needs a Node version at all.

### Fixed
- **The console drove Puppeteer with `headless: 'new'`,** undocumented since Puppeteer 22. It
  worked only because every branch tests `=== 'shell'` and everything else falls through to
  `--headless=new`. Both audit scripts say `true`, which is what it meant.
- **A missing colour token killed `doc-counts` three frames from the cause.** It handed
  `readTokens`' `string | null` straight to `ratio()`, which calls `.trim()` on it. A token the
  design doc quotes and the stylesheet does not declare now reads as a finding.
- **`release.ts`'s `drop()` called `.trim()` on `null`.** Under `stdio: "ignore"`,
  `execFileSync` returns null rather than a buffer.

### Upgrade notes
- **Running the platform: nothing to do.** No migration, no config change, no restart beyond
  the normal one. The compose files move to 0.38.0 and console 0.8.0 as usual.
- **Contributing: install Node 24** (`nvm use` reads the new `.nvmrc`). The console additionally
  declares `"type": "module"`; nothing downstream of it is affected.
- Contrast and design checks that evaluate a sibling script's SOURCE must strip it first —
  `new Function` is a JavaScript parser and does not remove type annotations. Use
  `module.stripTypeScriptTypes`, which is the same stripper Node runs these files with.

### A note on the evidence
The case for this conversion was that the tooling had latent bugs types would catch. **That
case was wrong, and the work was done anyway on the stated reason: a language that refuses
what it should.** Of 1145 strict errors across 115 zz-stack files, one was a real defect — the
`drop()` null above. The "246 latent union bugs" that justified it were inference artifacts:
widened array literals and `never[]` from `const x = []`. The console's 105 produced the two
Puppeteer and token defects above. Three real findings in 1250 errors is the honest yield, and
it is recorded here so nobody repeats the argument believing it was the argument that held.

## [0.37.0] — 2026-09-14

### Changed
- **BREAKING — `bug_list` and `bug_resolve` moved from `/core` to `/manage`, and are superadmin
  only.** Filing a report stays on `/core` for everyone: anybody doing anything might hit
  something broken, and somebody who has just hit a wall should not need a role to say so.
  Reading every report on the deployment and deciding what came of one are operator acts — about
  the platform rather than about the work somebody was doing when it broke — which is the rule
  `/manage` states and the reason `knowledge_reindex` is there.

  Superadmin rather than team admin, deliberately: a report is not team-scoped. The platform is
  one deployment, a defect one team hits is one every team has, so the list is everybody's
  reports — and showing a team's own admin every other team's is a wider reading of "admin" than
  a team admin was given.

  `/manage` is now 33 tools: 16 for a member, +4 for a lead, +13 for a superadmin.

### Upgrade notes
- **If you call `bug_list` or `bug_resolve`, they are on `/manage/mcp` now** and need a
  superadmin token. `bug_report` is unchanged on `/core/mcp` and open to everyone.
- No migration. `zz.bug` is unchanged; only which door reads it moved.

## [0.36.1] — 2026-09-14

### Fixed
- **`/zz-access:update` printed "you are undefined" instead of saying what failed.** Its
  identity check returned success on any 200 and left the email unparsed when its regex missed,
  and the caller printed `you are ${email}` without looking. A sentence that reads as an identity
  when it is a failed lookup fails in the direction that looks like success.

  The condition is real rather than hypothetical: a door answering 200 with a body the script
  cannot read is what a RENAMED TOOL looks like from a script one release behind. It is what
  happened — a cached 0.31.0 copy calls `get_my_info`, which 0.34.0 renamed to `session_whoami`.
  It now refuses with the likely cause named: "this script may be older than the door it is
  asking", which points at the real problem rather than at the person's identity.

### Upgrade notes
- Nothing to do beyond updating. No schema, argument or command changed.

## [0.36.0] — 2026-09-14 · console 0.7.1

Two capabilities and a chart that was deciding the height of the page.

### Added
- **Bug reporting, as three tools on `/core`.** `bug_report` files one, `bug_list` reads what is
  open, `bug_resolve` closes it with what was decided. Anybody in any flow can hit something
  broken and no flow owns the act of saying so, which is this door's own rule for what belongs
  on it. Only a title and a detail are required — somebody who has just hit a wall should not be
  interviewed — and the platform version is recorded from the service answering the call rather
  than asked, because a version somebody guesses at sends the next reader to the wrong diff.

  Three tools and not one, because two would be a write-only table: `zz.decision` was derived on
  every index and read by nothing for months, and nothing noticed it going wrong because nothing
  looked. `bug_resolve` requires a resolution for every outcome including `not_a_bug` and
  `duplicate` — enforced by a CHECK constraint, so a status with no reason cannot be stored —
  and refuses a second close, naming who decided and what they said rather than overwriting it.
- **A recorded eval suite is a piece of work.** `case_record` opens an initiative on the
  zz-plugin-eval flow, named for what was measured, and records the run against it. Before this,
  four suites could be run and $15.76 spent while the platform's record of "what is this team
  doing" said nothing had happened — and `findings.md` had nowhere to be written, because no
  initiative existed to write it into.

### Fixed
- **Console — the overview's distribution strip rendered 800 pixels tall and stretched every
  tile beside it.** It stacked a dot upward on each collision, uncapped, on a linear axis; the
  distribution it exists for spans orders of magnitude, so nine tenths of the observations
  landed inside the first two percent of the width and collided. Measured on this deployment:
  130 runs, 113 rows, 801 pixels — one vertical column of dots. The four tiles share a grid row,
  so the page became four mostly-empty columns. Now a log axis and a bounded stack: 6 rows, 52
  pixels, same data.

### Upgrade notes
- **Migrations run on start.** 055 links a case run to its initiative, 056 adds `zz.bug`.
  Existing case runs keep a NULL initiative: a run recorded before the column is a fact about
  how it was recorded, not a run that belonged to no work.
- **Nothing else to do.** Both tools are additive; no argument, schema or command changed.

## [0.35.1] — 2026-09-14

A defect the 0.34.0 rename created for everybody except the person who ran it.

### Fixed
- **`/zz-access:update` now carries somebody through a plugin rename.** `claude plugin update
  zz@zz-stack` fails once `zz` is off the shelf, and the updater printed `FAILED.` with the
  CLI's error and nothing naming `zz-core` as its replacement. Anyone still on 0.31.0 runs the
  one command they were told to run and is told their update is broken. It now installs the
  replacement BEFORE removing the old one — so a failure leaves a working machine — and reports
  a rename as a rename rather than as a plugin that left the shelf.

  `PLUGIN_ALIAS` in `@zz/contracts` is the map, the fifth of its kind beside TOOL_ALIAS,
  MANAGE_ALIAS, EVAL_ALIAS and SKILL_ALIAS. A plugin is the name a person types to install and
  the name recorded in their installation, and it was the one surface where a rename simply
  broke rather than resolving.

### Upgrade notes
- **This fix cannot reach you through the thing it fixes.** If you are on 0.33.x or earlier and
  still have `zz@zz-stack` installed, run once, by hand:

  ```
  claude plugin marketplace update zz-stack
  claude plugin install zz-core@zz-stack
  claude plugin uninstall zz@zz-stack
  ```

  After that `/zz-access:update` handles everything, including the next rename.
- **Two plugins are not installed by default and you may want them:**
  `claude plugin install zz-access@zz-stack` (tokens, keys, client setup) and
  `claude plugin install zz-plugin-eval@zz-stack` (evaluating a plugin).
- **Restart Claude Code** after any plugin change.

## [0.35.0] — 2026-09-14 · console 0.7.0

Two things that were each half-connected: the eval suite and the flow that judges it, and the
console's overview and the numbers the gateway had started sending it.

### Added
- **`plugin_profile` answers with its own next step.** The suite and this platform are one
  pipeline and were reachable only as two: `claude plugin eval` measures, `case_record` stores
  what it measured, and every stage after the profile judges what was stored — with nothing
  joining them. A person ran the suite, read the numbers off their terminal and stopped, and
  the platform went on serving a three-week-old measurement with twelve errored runs in it.
  That happened here, with four suites run and eleven cases measured.

  `sufficient_for_judging: false` was the whole answer, and a boolean is not an instruction.
  The profile now returns `next_action` in the shape `initiative_status` already answers with:
  the command with the plugin's name in it, the `case_record` call that follows, what it costs
  before it is spent, and the one trap worth naming — point it at `marketplace/<plugin>`, never
  the repository root. Null when the evidence is already there.
- **Console — the overview leads with four questions**: is work progressing, is what we write
  down worth reading, is the tool surface breaking, is the system straining. Each carries a
  mark underneath — a stage bar, a distribution strip — and the API sends figures only, so the
  page renders with no model in the path.

### Changed
- **zz-access's purpose admits the operator acts it already carries.** It said a tool belongs
  on `/manage` when it "hands somebody a key or changes who holds one" — which `knowledge_reindex`
  does not do. The placement was right and the sentence was wrong: rebuilding a derived table
  for a team the caller need not be in is a superadmin's act on a deployment, not a step inside
  one team's work. The rule now admits it by construction rather than by exception.
- **zz-plugin-profile 0.5 → 0.6** reads the eval command out of the tool's answer instead of
  restating it, so the instruction is generated from the plugin actually asked about.

### Fixed
- **Console — the initiative stage bar dropped two of its six stages.** It rendered
  `stages.complete`, which this gateway has never sent: `gated` and `closed` are two rungs,
  because an initiative can have every gate approved and still be open with nobody having said
  what came of it. Measured against production, eleven of forty-one active initiatives were
  invisible in that bar. The test fixture carried the same wrong key and was not typed against
  the interface, so 158 tests passed while the contract was broken — it is typed now, and
  putting the old key back fails the build by name.

### Removed
- **STATE.md, HISTORY.md and HISTORY-PRE-0.23.md.** Three documents describing the platform
  beside the one that records what changed to it. This file is the record now. What went with
  them, said plainly because nobody should go looking: STATE.md's §6 and §6b separated work that
  was DELIVERED from work that had RUN in front of somebody, and two gate checks held its
  declared numbers — the gate's check count and the shipped version — to the truth. That
  distinction is now drawn inside a changelog entry by whoever writes it, and those two checks
  are gone with the file they policed.
- **The whole `blocks/` tree**, including the building-block contract. It described what a block
  team must meet for services this repository does not ship and does not build. A contract for
  somebody else's server belongs with that server. The platform keeps its side of the
  relationship — the per-block door, the credential proxy, the usage skills — which is code, not
  documents. One more gate check went with it.
- **`--no-dashboard`.** It existed for the case where leaving the console behind was deliberate,
  and every actual use of it was a way past a message: a dirty console tree, or commits with no
  version decided. It shipped a release carrying a gateway field the console needed with no
  console able to read it. The console is skipped only when its repository says it did not move.

### Upgrade notes
- **Nothing to do on the platform.** `next_action` is an added field; no tool argument, schema
  or migration changed.
- **Re-pull your client package** if you have not since 0.34.0 — that release renamed the
  baseline plugin to `zz-core` and moved three command prefixes.

## [0.34.0] — 2026-09-14

The platform's surface — every tool name, which door serves it, and which plugin ships each
skill — is now declared once and derived everywhere else. Thirty-nine tasks, and the reason
they were one release rather than thirty-nine is that a name is not a local fact: renaming a
tool touches the door that registers it, the alias map that resolves its history, the skills
that teach it, the manifest that ships them, the lock that pins the manifest, and the prose
that describes the lot. **Four breaking changes; read the upgrade notes before deploying.**

The gate went from 296 checks to 331. That number is the honest summary of this release: most
of the work was not writing behaviour, it was making the platform able to notice when a
statement about itself stops being true.

### Changed
- **The baseline plugin is `zz-core`, not `zz`.** Its commands move with it: `/zz:doctor`,
  `/zz:migrate` and `/zz:update` are now `/zz-core:...`. `zz` remains the Postgres schema name
  and the platform's vocabulary prefix; only the plugin was renamed.
- **Tool names are `<noun>_<verb>`, on every door.** `get_my_info` becomes `session_whoami`,
  `search_knowledge` becomes `knowledge_search`, `close` becomes `initiative_close`, and so on
  through fifty-three names. `whoami` on `/manage` is the one deliberate exception — it is the
  question a person asks, not a noun they act on. Old names resolve for READING history
  (`packages/contracts/src/alias.ts` holds 17 + 29 + 7 frozen entries); nothing writes one.
- **A fourth door: `/eval/mcp`.** The ten `plugin_*` tools left `/core/mcp` for a door you get
  by installing the `zz-plugin-eval` flow. `/core` is everybody's process layer; evaluating a
  plugin is one flow's instrument, and a tool on the door everyone holds reads as a tool
  everyone is meant to use.
- **`/manage` is cut by role.** A member is offered 16 tools, a team lead 4 more, a superadmin
  11 more. A tool you cannot see is a fact about you rather than about the platform, and
  `whoami` says which. Every tool still authorises per call.
- **Two core skills renamed** — `zz-backbone` to `zz-platform`, `zz-knowledge` to
  `zz-handover` — and **seven skills now ship from the plugin that owns them** rather than from
  the baseline: `sdlc-deck`, `sdlc-tldr`, `sdlc-breakout` and `sdlc-authoring` to sdlc-flow;
  `zz-doctor`, `zz-update` and `zz-migrate` to zz-access.
- **The console reports an unmeasured aggregate as null, never as zero.** A group nothing was
  measured for rendered as instant and free. `zz.run.bytes_total` is nullable for the same
  reason: a run nobody measured is not a run that moved nothing.

### Added
- **The knowledge base records what is READ.** `knowledge_add` and `knowledge_supersede` each
  left three records and `knowledge_search` left none, so the shelf could say everything about
  what went into it and nothing about what anyone took out. A search now writes a
  `knowledge.search` event carrying the ids it returned — "which nodes does anybody actually
  read" has an answer for the first time.
- **`zz.block_tool.door`** records which door served a tool at the moment a version was built,
  so a surface diff can say "the same tool, served somewhere else" instead of reporting no
  change. Existing rows stay NULL, which means *not recorded* and never *the core door*.
- **Every plugin declares where its eval suite is authored**, and the packaged suite is read
  from that declaration rather than guessed at.
- **The overview API carries a `metrics` field** — four figures the console will lead with.
  Nothing renders it in this release; the console follows separately.

### Fixed
- **A half-fallen-over eval suite could read as clean.** `plugin_profile` reported
  `errored_runs: 0` on a suite where twelve runs had died, because the module that builds an
  empty result hardcoded the field. The recorded 2026-09-13 payload is 12 errored runs and
  `partial: true`; it had been reporting 0 and false.
- **The baseline plugin shipped one developer's run output to every installer** — 264KB of
  `evals/results/` in the package everybody downloads.
- **The committed lock hashed gitignored files**, so a fresh clone's gate was red for a
  difference nothing in the repository carried.
- **A claim that states no verdict now says so.** `zz.decision.verdict` is empty on all 478
  rows of the production store, and that is correct: of the four readers that write those rows
  only two produce a verdict, and no selection document has ever been indexed. The API reported
  `""`, which reads as a broken field rather than as a fact about the documents.
- **Three dormant columns removed** — `zz.initiative.closed_at`, `zz.initiative.deleted_at` and
  `pat.scope`. Each was declared, never written, and read as an answer.

### Security
- **A token carries whatever its holder may do.** `pat.scope` was `member` or `admin` and three
  authority checks asked the TOKEN rather than the person, so the same person was allowed or
  forbidden the same act depending on which of their credentials they held — and the cure for
  being refused was to mint a second token. Authority now reads from `principal.role` and
  `membership` on every call, which costs nothing: it is the same query that resolves the token.
  Binding a token to one team (`pat.team_id`) stays — that answers which team it acts INSIDE,
  which is not a claim about what its holder may do.
- **`zz-tool` finds the token instead of demanding it.** It read `$ZZ_TOKEN` and died otherwise,
  on machines where the install step had already written `~/.zz/token` at mode 600. One
  resolver now follows the order the platform publishes to its own clients — `$ZZ_TOKEN`, then
  `$ZZ_TOKEN_FILE`, then `~/.zz/token` — and a missing token prints the onboarding step rather
  than an error.

### Upgrade notes
- **Migrations run on start; nothing to do by hand.** 049 through 054 drop three columns and add
  one. All 54 were applied in order to a fresh database before this release.
- **BREAKING — command prefixes moved.** `/zz:doctor|migrate|update` are `/zz-core:...`, and
  `/sdlc:deck|tldr|breakout` now come from sdlc-flow. **Re-pull your client package**; an
  installed plugin from 0.33.x names commands that no longer exist.
- **BREAKING — tool names.** Anything calling a platform tool by name needs the new spelling.
  Old names resolve when READING recorded history and are not accepted as arguments.
- **BREAKING — `pat_issue` no longer takes `scope`,** and `pat.scope` is dropped. Existing
  tokens widen to their holder's real authority, which is what their holders always had. If you
  relied on a deliberately reduced token, bind it to a team instead.
- **BREAKING — the console initiative API** returns `null` rather than `""` for a decision's
  `verdict`, `qualifier` and `checker`. A consumer testing truthiness is unaffected; one
  comparing to `""` is not.
- **The console is NOT in this release.** `zz-stack-dashboard` stays at 0.6.1.

## [0.33.1] — 2026-09-13

A defect fix and two pieces of console presentation. Nothing to do on upgrade.

### Fixed
- **The gate could not see a plugin lock a whole release behind the catalog.** Its condition
  read `was.digest !== p.digest && was.version === p.version` — "content moved and the version
  did NOT" — so the moment a version moved the conjunction collapsed and a stale lock passed
  silently. That is how 0.33.0 deployed with `zz.plugin_version` describing 0.32.3: sdlc 0.1.0,
  zz 0.31.0, zz-access 2.0.0, zz-plugin-eval 0.1.0, written for a release containing none of
  them. Nothing about that deployment was wrong; what was wrong was which version its work
  would be attributed to, and `plugin_cases_record` refused every recording against it.

  `plugins.lock.json` is an INPUT, not a record — `release.mjs` registers from it and does not
  regenerate it. So the check now also fails on a version mismatch, `checks/gate-plugin-lock.mjs`
  proves it goes red on a lock a release behind, and the release prints `N member(s) unresolved`
  as a warning naming what to run rather than as a count appended to a success line. **Running
  `node scripts/plugin-versions.mjs --write` before the gate is still a manual step**; what
  changed is that forgetting it is now caught instead of shipped.

### Changed
- **Console — the login page.** The mascot moves from the marketing column to the sign-in
  column. The right column used to end at its own fine print, leaving the bottom half of the
  screen empty while the left ran nearly full height; the mascot sat mid-column on the left with
  air on all four sides. One move fixes both, and it is the more honest placement: the left
  column says what the platform records, and she is not a record — she greets you at the door.
  "AI friend for a brighter you" travels with her, having been sitting under a paragraph about
  telemetry.
- **Console — the favicon has clear corners.** The master draws the purple tile on a white
  canvas, so the four corners outside the rounded curve stayed opaque — invisible on a light
  page and four bright dots on a dark browser tab, which is where a favicon lives. The
  background is now removed by flood fill from the corners, so only white CONNECTED TO THE EDGE
  clears and the white `Z` inside is untouched.

### Upgrade notes
- Nothing. No migration, no environment key, and no client re-pull — no skill or catalog text
  moved in this release, so an installed plugin is already current.

## [0.33.0] — 2026-09-13

Every plugin on the shelf can now be evaluated, and four defects in the evaluation
itself were found by running it rather than by reading it. Each entry below states
what was measured; where a prediction was wrong, the measurement replaces it rather
than sitting beside it.

### Added
- **Eight eval cases across four plugins, where there were four across one.**
  `zz-access` and `zz-plugin-eval` had no suite at all, so neither could be
  evaluated on any evidence: they have no run history either, and both blocks
  empty is the one condition that stops the flow. Cases need no history — that is
  the whole reason the case half exists — so a suite is what makes a plugin
  evaluable the day it ships.

  | plugin | cases | what they ask |
  |---|---|---|
  | `sdlc` | 4 | does the flow hold its gates, route back, and write into the store |
  | `zz` | 2 | does it reach for the doctor script; does it record an approval rather than writing the envelope by hand |
  | `zz-access` | 2 | does it kill a leaked credential first; does it refuse a shared team key nobody can create |
  | `zz-plugin-eval` | 3 | does it refuse to score before a ruler is agreed; does it know thin history is not a blocker; does it decline to call three returns thrash |

  **Every grader reads what the skill makes the agent SAY, name or decline.** A
  plugin's MCP servers are absent from BOTH arms unless `--allow-real-servers`
  starts them as you, outside the sandbox — so a grader on a tool actually being
  called reads zero on both sides and measures the harness.
- `plugin_profile`'s case block carries `errored_runs` and `partial`. A run that
  timed out scores 0, and a 0 from a dead agent is indistinguishable in the mean
  from a 0 the plugin earned.
- A fourth value for a case's `discriminating`: **`harmful`**, when the arm WITH
  the plugin did worse.

### Fixed
- **The blind control was not blind.** `plugin_judge`'s document fallback excluded
  the round's own items and nothing else, so it reached for
  `2026-09-13-console-brand-adoption/plan.md` — an initiative that ran `sdlc-flow`.
  An sdlc document marked against sdlc's ruler is a second sample, not a control.
  It scored 4.00/5.00 against the real round's 4.00/5.00 and the round was read as
  "the ruler does not discriminate", when what had been asked was whether two sdlc
  documents score alike. They do, and should.

  The exclusion is now by INITIATIVE rather than by document, because an initiative
  that ran this flow also holds documents the platform stamped no flow on — that
  one carries three with `sdlc-flow` and two with nothing — and filtering on the
  document's own flow would have let one of the two through. A plugin with no flow
  of its own skips the fallback rather than matching the empty string and sweeping
  in every unflowed document, which is the same defect arriving through its own
  fix.
- **Recording a case run would have stored nothing readable.** `parseCaseRun` read
  `delta`, `with_score` and `with` from a case's top level. On claude 2.1.269 a
  case carries none of those — the numbers are under `aggregates` as `score`,
  `scoreWithout` and `delta`, and the run count is `runsPerCase` — so a suite that
  measured perfectly came back as "carries no case this module could read a delta
  from". Verified against the real output of two suites.
- **A negative delta was filed as `dead`**, the label for "this case decides
  nothing". The arm with the plugin doing worse is the most interesting result a
  suite can produce.
- **The evaluation flow cannot be reached by asking, and its own skill now says
  so.** Measured over nine runs across the three questions `zz-plugin-eval` exists
  to answer, asked in ordinary words with the plugin installed: nothing in it
  engaged, and the delta was zero on all three cases. The cause is structural — a
  flow's `entry` ships as a command carrying `disable-model-invocation: true`, so
  no model can open it whatever its `when_to_use` says, and the five stage skills
  beside it each say "never on its own", which is right. That is what "a person
  invokes this on purpose" costs, stated as a number. Its cases now name the flow,
  the way a person does, so they measure content rather than routing.
- **Four files from the deleted skill-level evaluation** — two `rubric.json`, a
  README and a `1.4.md` — were still shipping inside the `zz` plugin to every
  account, and hashed into its digest. Gone.

### Changed
- Breaking: **`zz` no longer reports an empty tool set.** `entryOf("zz")` is
  undefined — `zz` is not catalog-resident — and every caller of `toolsNamedBy`
  guarded on that and fell back to `[]`. Nothing errored: `zz` reported
  `tools_named: []`, so `reachable` was empty, so `never_called` was empty, so the
  one finding that half exists to produce was structurally impossible for the
  plugin every account installs, and read as a clean bill of health. It resolves
  through `ZZ_SKILLS_DIR` now, the way `plugin-lock.ts` does.
- **A dispatched stage leaves no trace, and now the flow says so.** Measured:
  `zz.event` holds not one `sdlc-spec-audit` or `sdlc-plan-audit` row in its whole
  history. A step is attributed from the last `skill_view` a caller asked for, and
  an audit worker in Claude Code loads its skill from its own plugin directory. A
  return is a relation BETWEEN stages, so one missing stage removes every return
  through it and `spec → audit → spec` reads as a straight line — the single thing
  plugin evaluation most wants to ask of this flow. `sdlc-method` now makes
  `skill_view` the worker's first act and says why; `plugin-profile.ts` says
  plainly that zero returns means none was recorded.

  **The limit that stays** is stated in both places: subagents share the caller's
  credential, so their calls and the main agent's interleave in one trace, and a
  step is only ever the last one anybody loaded. The change makes a dispatched
  stage visible; it does not make the two separable.
- **Two case-running mistakes that produce numbers rather than errors**, both found
  by making them. Running `claude plugin eval` against the repository root
  resolves all four plugins at once and starts every case as one suite: two hours
  and twenty minutes, twelve cases, not one baseline arm reached, killed — and the
  output was `partial: true` with with-arm scores only, which reads like a suite in
  which the plugin helped with nothing. And an sdlc case whose six runs all timed
  out at the 300s default still reported a delta of 0.111, with the baseline arm
  timing out at zero turns three times out of three. The target is
  `marketplace/<plugin>`, one plugin; that case now declares
  `timeout_seconds: 600` and measures 0.67.
- **A capability that ships as a COMMAND cannot be reached by a case that asks
  in words**, and two suites had to learn it separately. `zz-doctor` does not
  ship as a skill at all — `marketplace/zz/skills/zz-doctor/` holds `doctor.mjs`
  and no SKILL.md, because zz's three typed capabilities render as commands — so
  a case grading `Skill(zz-doctor)` scored 0.00 on every grader in the with arm,
  for a capability that is present and works. Both that case and
  `zz-plugin-eval`'s three now reach their subject the way a person does.
- Plugin versions: `sdlc` 0.1.0 → 0.2.0, `zz-access` 2.0.0 → 2.1.0,
  `zz-plugin-eval` 0.1.0 → 0.2.0.

### Upgrade notes
- **No migration.** Nothing in this release changes the schema.
- Re-pull the shelf (`/zz:update`, or `claude plugin marketplace update zz-stack`)
  to pick up the new plugin versions and their case suites.
- **Running a suite still costs real money on your own credential** and nothing
  runs it for you: measured on this release, $1.95 for two cases and $2.30 for
  three, at three runs per arm.

## [0.32.3] — 2026-09-13

### Fixed
- **0.32.2's control fix scored the round's own document as its own control.** The
  fallback said "a document this plugin's runs did not produce" and asked the
  database with `produced_by_run_id is null or not in (...)`. Every document on this
  deployment has NULL there — nothing has ever attributed one — so the predicate was
  true of everything and it picked the very artifact the real round was judging. It
  scored 5.0 against the real round's 4.5, on the same bytes under the same ruler.

  That is not a weak control, it is a broken test: two readings of one artifact
  always agree, so a reader would have concluded the judge cannot discriminate when
  nothing had been asked of it. Worse than having no control, because it looks like
  one. It now excludes the round's own item set, which is knowable without trusting
  a column nothing writes.
- **A control round now says what it actually read.** The loop stores a control
  score against the same subject row, so `subjects` names this plugin's document
  while the bytes judged were somebody else's — a control round read as though it
  had scored the artifact printed beside it. `control_read` names the source. That
  is the one number in the record whose provenance a reader most needs, because it
  is what says the rest are trustworthy.

### Changed
- `tools/plugin-judge.ts` split at the 700-line ceiling into what it is about, not
  by line count: the tools that answer "what is true of this plugin" stay, and the
  two that answer "what did a person decide about it" — `plugin_ruler_record` and
  `plugin_finding_record` — move to `tools/plugin-record.ts`. Both refuse incomplete
  input at RECORDING time, because the alternative is refusing at judging time and
  by then the figures exist.

## [0.32.2] — 2026-09-13

Three defects, all found by running the ten tools against production rather than
by reading them, and one of them is the worst kind.

### Fixed
- **The blind control could never be taken, so every round was unvalidated.** It
  required another PLUGIN's run, and one plugin on this platform has runs — so
  `plugin_judge --control` threw, `judge_on_trial` came back empty, and nothing in
  a round said whether the judge was reading or rewarding confident prose. Every
  number would have been recorded and none of them checked. It now falls back to a
  document this plugin's runs did not produce — a subject the ruler was not written
  about, which is the invariant that matters and is a HARDER control to pass, not an
  easier one, because the two share a house style. When neither exists it refuses
  with the reason and says the round is unvalidated rather than quietly skipping it.
- **`plugin_conform` invented a mapping and labelled it R1–R14.** It reported R4 as
  "8 tools named by this plugin's skills", R5 as "0 servers declared", R6 as "7
  stages declared", R9 as "declared version". Not one is what the clause says: R4
  asks whether the SERVER offers `list_usage_skills()`, R5 whether its tool verbs
  state the capability, R6 whether validation errors teach the rule, R9 for
  `get_app_url`. It produced a conformance report citing a standard it did not
  check — the exact thing `contract.md:196-199` warns of: *"a battery that guessed
  would hand out passes this standard never granted."* R1–R14 is a block-server
  standard and a flow plugin serves no surface of its own, so it now returns
  `not_measured` with that as the reason, settles R5 from tool names where a plugin
  does serve one, and says plainly that the mechanical battery went with
  `zz-block-eval` and is not reimplemented here.
- **A plugin was reported as reaching no servers while naming eight tools.**
  `manifest.servers` alone ignores the baseline: `zz` is required by every package,
  so `zz-core` arrives whether or not a manifest mentions it — the rule the gate
  states at `skill-tools.mjs:182-183`. `sdlc` declares no servers and its seventeen
  skills name eight `zz-core` tools between them, so the report described a plugin
  that is entirely fine using the "complete and unreachable" shape this platform
  treats as most expensive.

### What the first real evaluation found
Not a defect in the platform, but the point of it. Against `sdlc 0.1.0`: eleven
usable runs, `document depth` 4.0, `evidence discipline` 5.0, and two quantitative
thresholds settled from facts — `tool fit` met (one tool never called, ≤ 2) and
`recovery` NOT met (0 returns, below the required 1). The tool never called is
`knowledge_add`: named by sdlc's own skills and not once invoked in eleven real
runs. That is the half of 搭不搭 no static check can see, found on the first run.

## [0.32.1] — 2026-09-13

### Fixed
- **`returns` was structurally zero and 0.32.0 shipped it that way.** The derivation grouped
  `zz.event` by `(initiative, step)` and took `min(ts)`, which collapses every visit to a stage
  into one row at its FIRST entry. The sequence is then monotonic by construction, so a stage
  entered, left and entered again is invisible and no return can be detected however many there
  are. It returned 0 against live data on the first real run, and 0 looked like an answer.

  Proved rather than reasoned, on the same three planted events: the old grouping yields
  `sdlc-spec -> sdlc-spec-audit`, two rows; the islands form now used yields
  `sdlc-spec -> sdlc-spec-audit -> sdlc-spec`, three visits, one return.

  **This is the metric the whole initiative was asked for** — *一个 skill 如果不行，能不能回到
  前面的 step 重新 grounding* — so shipping it reading a constant zero was the worst available
  outcome. `checks/returns-sees-a-backtrack.mjs` is the fixture the spec's own risk table asked
  for and the plan never wrote: *"a metric whose only observation is zero has not been tested."*

### Known, and not fixed here
- **Neither evidence source can see a DISPATCHED stage.** `sdlc-method` sends an audit to a
  subagent, which has its own caller session, so the audit leaves no `step` event under the
  parent's initiative and no `Skill(...)` call in the parent's tool log. Both halves were bitten
  by the same root cause independently: a case grader keyed on `Skill(sdlc-spec-audit)` scored 0
  in all three with-arm runs, and `2026-09-12-plugin-level-eval` — an initiative that really did
  return three times — records only `sdlc-spec` then `sdlc-plan`. So `returns` can now SEE a
  return, and on sdlc it will still read low until a dispatched stage is attributed to the
  initiative that caused it. That is a telemetry change, not an evaluation one.

## [0.32.0] — 2026-09-13

**zz-stack 0.32.0 · zz-stack-dashboard 0.5.0**

**Evaluation's subject is a plugin now.** A plugin is what a person installs — a flow's skills
plus the MCP servers those skills call. The platform evaluated the two halves separately and
could therefore see neither of the things that decide whether the whole is any good: whether a
flow that goes wrong can return to an earlier stage, and whether a tool its own skills name is
ever actually called. Both are properties of the whole.

### Added
- **`zz-plugin-eval`** — five stages over one plugin at one released version, two gates
  (`rulers.md` before anything is scored, `findings.md` before anything is closed).
- **Two kinds of evidence, each with its own sufficiency line.** CASES come from
  `claude plugin eval`, which runs a suite twice — with the plugin and without — and reports
  the delta. That is a counterfactual, which no score can give, and it needs no history: one
  case is enough. TRACES come from the event log and need five usable runs. A thin trace block
  no longer stops the flow; only both empty does. A plugin released this morning is evaluable
  this afternoon.
- **Ten `plugin_*` tools.** `plugin_locate` `plugin_profile` `plugin_cases_record`
  `plugin_conform` `plugin_ruler` `plugin_ruler_record` `plugin_affirm` `plugin_judge`
  `plugin_scores` `plugin_finding_record`. Every read returns facts — counts, sets, orderings,
  differences — and nothing else. `returns: 3` is a fact; whether three returns is a flow
  re-grounding well or one thrashing belongs to a ruler a person approved.
- **A per-plugin content digest, and a lock that makes a declared version true.**
  `plugins.lock.json` records each plugin's version beside a digest of what it ships, and the
  gate refuses a release where they disagree. The shelf-wide digest in `claude plugin list`
  stays what it is — a per-person cache key — and is unchanged.
- **`register-plugins`**, run by the release: a plugin version and the skill versions it
  contained become rows. Release is the only moment anybody knows what a version contained —
  `zz.skill.flow` is current registration, not per-version, and `flow_install` overwrites its
  own history.
- **Five eval case suites**, four for `sdlc` and one for `zz`, each grounded in something that
  actually happened and carrying its provenance and expected delta. They ship WITH the plugin,
  because `claude plugin eval` resolves an installed plugin to its cache directory and looks
  for `evals/` below it.

### Changed
- **The console says Plugins where it said Flows and Blocks.** One page, one row per plugin:
  name, version, its own digest, skills, servers, latest eval. Both halves were true and
  neither was a thing anybody installs.

### Removed
- **`zz-skill-eval` and `zz-block-eval`, and their eight `eval_*` tools.** Also
  `services/zz-core/src/evaluation.ts`, `judge-skill.ts`, the `packages/tools` eval and rubric
  ops, `flow-compare.ts`, and two shell scripts whose only act was to invoke a binary that can
  no longer be built. `judge.ts` survives: it is the subject-agnostic marking loop the new
  judge runs on.
- **Per-skill evaluation in the console** — the rubric, findings and score reads on
  `/api/console/skills` and `/skills/:name`, and `/skills/:name/scores` entirely. Retired, not
  relocated: an evaluation's subject is a plugin version, so nothing can write a per-skill
  score again, and a page showing one would show what was measured before the change and then
  nothing ever after.
- **`zz.run.outcome`.** Written by one deleted op, read by nothing, zero non-empty rows.

### Upgrade notes
- **Two migrations apply on the gateway's next start, together: `047` then `048`.** 047 is
  additive; 048 drops `zz.eval.skill_version_id`, `zz.eval_subject.skill_version_id`,
  `zz.rubric.skill_id`, `zz.skill_version.rubric_id` and `zz.run.outcome`. Every affected table
  held zero rows when this was written, measured on the deployment rather than remembered. Both
  were verified applying as a pair in a rolled-back transaction.
- **Run `npm run check:sql` after this deploys.** It PREPAREs every query against the migrated
  schema and its own header calls it "the check that catches a migration going one way and a
  query staying behind". Nine readers of dropped columns were found while writing 048 — the
  ninth in a route nobody was looking at, with the gate green over it — and the rest of the
  repository was swept by hand with the same scanner `check:sql` uses. The real tool is better
  than that sweep.
- **Anyone with `zz-skill-eval` or `zz-block-eval` installed loses them.** They have never been
  run on this deployment and every eval table is empty, so nothing is lost but the flows
  themselves.
- **Three console response shapes changed**: `/api/console/skills` and `/skills/:name` no
  longer carry evaluation fields, and `/api/console/runs` no longer carries `outcomes` or
  `gaps.runsWithoutOutcome`. The console in this release follows them.
- **`v0.31.1`'s tag does not describe the image that ran under it.** That release was built
  while `14dbe03` was being pushed, so the image carries `fc9d987` and not the commit the tag
  names — `plugin-lock.js` is in it, `plugin-eval.js` and `catalog/zz/zz-plugin-eval` are not,
  and migration 047 never reached the database. Nothing is broken by it, but `v0.31.1` is not a
  reliable rollback target for what its tag says. This release ships the whole of it.
- No environment key was added or made required.

## [0.31.0] — 2026-09-13

### Fixed
- **`zz.run` was 99.8% phantom rows, and the column it keyed on is dead.** `reconcileRuns()`
  resolved a skill version through `zz.event.step_version`, which is stamped only when a skill
  is served WHOLE through `skill_view` — and Claude Code reads an installed skill off disk, so
  in normal operation nothing stamps it. Measured twice a day apart it sat frozen at 39 while
  the event log grew by a third. Every row the initiative-bearing insert wrote therefore
  carried `skill_version_id` NULL, a NULL cannot match that insert's conflict target because
  Postgres treats NULLs as distinct, so `do update` never fired and the timer appended a fresh
  duplicate on every pass — roughly 950 a day. A run is now bound to the version that was
  released at or before the event, which is what "which version was running" actually asks.
- **The setup text told a new person the one command that updates nothing.**
  `my_client_setup`'s refresh section was a single `claude plugin marketplace update`, which
  refreshes the shelf and updates no plugin: each resolves against the marketplace's copy, so
  somebody following it is told — truthfully — that everything is up to date, at the version
  they already had. `/zz:update` now leads it, and section 3 names `/zz:doctor` and
  `/zz:update` whether or not a flow is installed, because those are the ones that work on an
  empty account.

### Added
- **Two guards for the run table**, because nothing offline could see it break — `tsc` cannot
  look inside a template literal, and the gate cannot reach a database. A gate check that a run
  is attributed by time rather than by a column nothing stamps (break-tested: planting the old
  predicate turns it red), and a read-only doctor probe that every run names the version it
  ran. The gate is 283 checks.

### Upgrade notes
- **A migration deletes the phantom runs on start** (`046_delete_phantom_runs.sql`) — 1808 of
  1812 rows on this deployment. The code fix alone does not clear them: it stops new ones being
  written, and the existing rows are what every count of `zz.run` reads. It is safe because the
  table is DERIVED from `zz.event`; the three tables referencing a run all carry
  `ON DELETE SET NULL`, and each linkback re-attaches on the next pass because it matches
  `where <fk> is null`.
- **Anything reading a run count will see it fall by three orders of magnitude.** That is the
  honest number appearing for the first time, not a regression. On this deployment the new
  derivation resolves six real runs across three initiatives where the old one resolved none.

## [0.30.0] — 2026-09-13

### Added
- **`/zz:doctor`, `/zz:update` and `/zz:migrate`** — three commands on the baseline plugin,
  so they are on every machine that has `zz@zz-stack` and need no repository. The baseline
  shipped skills and no commands until now; it promotes any platform-own skill declaring
  `standalone: true` in its own frontmatter, which is the rule flows have always used.
  - `/zz:doctor` answers whether THIS machine can reach the platform: the token and its file
    mode, the doors, which plugins are installed and whether they are on one version, and who
    the token belongs to. It reads the gateway URL from the installed plugin rather than
    carrying one, so it can never report that the deployment it was written against is fine.
    It is not `npm run doctor`, which asks whether a deployment matches a checkout from inside
    this repository — the person typing the command does not have this repository.
  - `/zz:update` refreshes the marketplace and then every plugin that is actually installed,
    in that order, and prints each version before and after. The order matters and nothing
    used to say so: a plugin resolved against a stale shelf is truthfully reported as up to
    date, at the version it already had.
  - `/zz:migrate` brings an mma repository's `.mma/` onto the platform. See Upgrade notes.
- **`client` on every tool-call event**, and the `tool-report` section that reads it. Which of
  the things we ship people actually run was already half of `caller`, hashed together with an
  address and therefore unreadable; on its own it names software and never a person.

### Changed
- **`knowledge_supersede` takes an optional `shelf`.** Ids are allocated per shelf and both
  shelves start at `0001`, so one bare id naming two nodes is the ordinary case. The refusal
  told the caller to supersede "the one you mean by its own shelf" and gave them no argument
  in which to say which — so a node whose number also existed on the other shelf could not be
  superseded at all. Existing calls are unaffected: the argument is only needed when the
  refusal says it is.

### Upgrade notes
- **Restart Claude Code after updating.** The three commands and their scripts arrive as
  files; a running session is still holding the old ones. `/zz:update` says so when something
  moved.
- **Migrating from mma:** run `/zz:migrate` from inside the repository whose `.mma/` you want,
  and rehearse with `--dry-run` first. What it does, and what it deliberately does not:
  - The journal becomes knowledge nodes — mma's six node types are this platform's six.
  - Specs, plans, explorations, audits, backlogs, verifications, notes, retros and decks
    become **sources** on one archive initiative per repository, not documents. An
    initiative's documents are gated, `plan.md` requires an approved `spec.md`, and historical
    plans carry no approvals because nobody approved them under rules that did not exist yet.
  - That archive is what every migrated node cites as **evidence**, which is the only way an
    mma node can satisfy a requirement mma had no concept of.
  - `dropped` and `inconclusive` nodes are skipped and counted, because the platform stamps
    `adopted` on everything it writes.
  - **The archive initiative stays open** and appears in `initiative_status()`. Closing runs
    through a flow's closing document and every flow gates it; signing that gate to tidy a
    listing is the one thing gates exist to prevent.
  - It is resumable and safe to run twice — every send is recorded in `.mma/.zz-migrated.json`
    as it succeeds, which also means a corpus migrated on 0.29.0 should be re-run once this
    release is live to pick up the supersede edges that version could not make.

## [0.29.0] — 2026-09-12

**zz-stack 0.29.0 · zz-stack-dashboard 0.4.0 (unchanged)**

**The Claude Code shelf is published from this repository instead of served as a tarball.**
Installing it no longer needs a token:

```bash
claude plugin marketplace add zhixuan312/zz-stack
claude plugin install zz@zz-stack
```

Nothing is given away by that. Every tool behind these plugins is a door at the gateway, and
the door still answers `401 authentication required: Bearer PAT (zzp_…)` to anyone without
one — the shelf was never the boundary, it only looked like one while it sat behind a
credential. What the shelf now carries in public is the *method*: the skills, which are files
in this repository already.

The reason to change it: the old path made a person's first act on the platform the one thing
they needed the platform for. `curl -H "Authorization: Bearer $ZZ_TOKEN" <gateway>/pkg/…` runs
before `marketplace add`, so somebody with no token had no way to install the tools that issue
one, and the two commands they were handed failed on a directory that could not exist yet.

### Added
- **`npm run build:marketplace`** renders `marketplace/` and `.claude-plugin/marketplace.json`
  from the catalog. It calls the same `buildClientPackage` the gateway serves packages with
  rather than re-implementing it — a second renderer is the drift that function's own comments
  keep warning about — with flows read from manifests instead of from `flow_install`.
- **A gate check that the committed shelf is what the catalog renders.** Build output under
  version control drifts the moment someone edits a skill and does not rebuild, and the drift
  is invisible: the shelf keeps installing, it just installs last week's method. The check
  rebuilds and fails on a dirty tree, so a red gate leaves the fix already written.

### Changed
- **The marketplace and every plugin now declare an owner and an author**, and the marketplace
  carries a description. `claude plugin validate` asks for all three, and a public shelf is
  read by people who did not write it.
- **`target` no longer reaches a published card.** It named the person the package was built
  for — correct for a package built for them, wrong for a shelf anyone can read, since a
  marketplace card is not the place to publish an email address.

**Breaking, twice.** `claude plugin marketplace add ~/.zz/zz-platform` is no longer the
install path for Claude Code, **and the shelf is now called `zz-stack` rather than
`zz-platform`** — so every id spells `zz@zz-stack`, `sdlc@zz-stack`. The two names were the
same shelf: you added `zhixuan312/zz-stack` and then installed from `@zz-platform`, which
made a person learn both and guess which belonged where. `zz-platform` remains the platform's
own TEAM (`PLATFORM_TEAM`), which is what it always meant and is not a marketplace.

Anyone on the old registration:

```bash
claude plugin marketplace remove zz-platform
claude plugin marketplace add zhixuan312/zz-stack
claude plugin install zz@zz-stack
```

**Codex and Hermes are gone with it** — see below.

### Removed
- **Codex and Hermes as served clients**, and everything that existed to serve them: the
  `/pkg/<client>.tgz` route, `tarGz` (a hand-rolled ustar writer of forty lines of octal field
  offsets), two more install/refresh/remove stories, the `hermes` frontmatter branch in the
  router skill, and half of the package-shape probe — which was a tar reader, checking
  checksums this repository no longer writes. Nobody ran either client. A second install story
  is not free: the rename to `zz-stack` had to be made in the Codex branch too, and one
  instance of it was missed.
- **The `clients` matrix**, root and branch: the manifest's `clients` field, `install_flow`'s
  `clients` argument, the `flow_install.clients` column (migration 045), `ALL_CLIENTS`,
  `CLIENT_KINDS`, `ClientKind`, and the `runs_on` / `installed on …` columns in
  `list_catalog`. It intersected three sets — what a flow can run on, what a team wants, what
  the platform supports — to decide where a flow appears. With one client the intersection has
  one possible answer, and a decision with one answer is not a decision.
- **`SERVED_CLIENTS` and `isLocalOnly`**, the served-versus-local split. A flow running in a
  browser had to fetch its method from the platform, and one that ALSO shipped its skills as
  files put two copies of one method in the world. The browser front end went on 2026-09-10;
  after that `isLocalOnly` was true for every flow it was ever asked about, and the branch it
  guarded had one live side.

`services/gateway/src/package/archive.ts` is now `describe.ts`: with `tarGz` gone it holds the
package's digest and the description a person reads, and no archive at all.

### Fixed
- **The install text named a marketplace nobody has.** `describePackage` builds the paragraph
  a person reads at install time, and its update command still said `@zz-platform` after the
  rename — telling them to update against a shelf their client has never heard of. The name is
  read from one constant now, like every other place that spells it.
- **A script that does not parse is caught by the gate.** A probe edit left a stray `);` in
  `doctor/layers/contract.mjs`; 280 checks ran green over it and the error surfaced at
  `release.mjs --preflight`, because nothing in the gate imports the doctor's layers. The
  neighbouring check runs tsc over `scripts/` but filters for TS2304/TS2552 alone, by design —
  a file that cannot be parsed reports TS1005 and was dropped on the floor. `node --check` over
  every script now, asked of the runtime that actually loads them.

### Upgrade notes
- **Every person with a client installed must re-add the shelf**, because it moved and was
  renamed. Updating in place will not find it — `plugin update` reads a clone that no longer
  describes anything:

  ```bash
  claude plugin marketplace remove zz-platform      # the old local-directory registration
  claude plugin marketplace add zhixuan312/zz-stack
  claude plugin install zz@zz-stack                 # then whichever others they had
  claude plugin install sdlc@zz-stack
  ```

  `~/.zz/token` is untouched by this and does not need to be reissued. `~/.zz/zz-platform`, the
  unpacked tarball, is now dead weight and can be deleted.
- **Migration 045 drops `flow_install.clients`** and applies itself when the gateway starts.
  Nothing to run. It is not backward compatible in the direction that matters: a gateway older
  than this release reads that column, so a rollback past 0.29.0 needs the column back.
- **`GET /pkg/*.tgz` returns 404.** Anything scripted against it — a bootstrap, a CI step — has
  to install from the marketplace instead. `my_client_setup` prints the current steps.
- **Nothing to set.** No environment key was added or made required by this release, so
  `deploy/.env` on the host is correct as it stands and needs no edit before the upgrade.

## [0.28.0] — 2026-09-12

**zz-stack 0.28.0 · zz-stack-dashboard 0.4.0**

**This is the release that makes both repositories publishable.** Almost all of it is
subtraction: two browser surfaces the platform served, a directory of working material that
was never the package, and — running through every file — measurements and names that were
records of work done on somebody else's systems rather than facts about this software.

The platform's own surface is unchanged where it matters: no MCP tool was renamed, no
argument changed shape, no environment key was added or made required, and there is no
migration. What a terminal client does with this platform it does exactly as before.

### Removed
- **`/app`, the knowledge-base browser, and the API behind it** (`kb.ts`). It was a second
  front end with its own PAT login and its own read API over the same data the console
  already serves. One front end, one set of APIs: the console.
- **`/architecture`**, the unauthenticated page describing the platform. It was served from
  `docs/architecture.html`, read at module load — so the gateway could not start without a
  file that is no longer part of the package.
- **`docs/` is no longer published.** Findings, walkthroughs and release records are working
  material; they stay on disk and out of the repository. What was genuine package
  documentation — where the boundaries are and why — is `ARCHITECTURE.md` at the root, which
  is where the gate and `console/catalog.ts` now point.

### Changed
- **Sign-out is `POST /auth/logout`**, answering 303. It revokes a session row, and anything
  that can make a browser issue a GET could issue that one — an image in a document body, a
  link in a mail. The console submits a form; nothing can make a browser POST cross-origin
  without the person acting.
- **The console applies a URL policy to document markdown.** A link is navigation a reader
  chooses, so an external one is fine and only the dangerous schemes are refused. An image is
  a fetch nobody agreed to: only a same-origin path survives, and a dropped image renders as
  its own alt text. `![](https://someone-else/p.png)` in a document body used to hand that
  document's author the IP address and reading time of every person who opened it.
- **`deploy/Caddyfile` carries a documentation address as its template default.** It is a
  substitution source — `install-caddy.sh` replaces it with the target host's own address and
  refuses the install if the literal survived — so a template shipping a real hostname was a
  default nobody should inherit. Nothing on a running host changes.

### Fixed
- **Two gate checks that named a flow they were not about.** A scripted rename ran over
  sentences describing the flow being renamed, so a comment could quote a one-element array
  naming the new flow and then list that same flow as one the loop had missed. Where two
  flows are genuinely contrasted both names stay; elsewhere the sentence names a shape.
- **`RuleMill` stood where `rulemill` belongs** in a copy-pasteable command, a compose service
  name, a URL, two directory paths, a version list and a map key — and in the console's Block
  field hint, which told a person to type an id the registry does not hold. The check that
  guards this class matched one casing, so the defect was invisible to it in the casing it
  actually appears in.

### Upgrade notes
- **Anything linking to `GET /auth/logout` must POST instead.** A link will now 404.
- **Anything pointing at `/app` or `/architecture` will 404.** The console serves what `/app`
  served; `/architecture` has no replacement and is not coming back.
- No migration, no new environment key. `docker compose pull && docker compose up -d` is the
  whole upgrade.

## [0.27.0] — 2026-09-11

**zz-stack 0.27.0 · zz-stack-dashboard 0.3.5 (unchanged)**

**Nothing under `services/`, `catalog/`, `packages/` or `skills/` moved**, so the platform
image behaves exactly as 0.26.1's did: same tools, same schemas, same routes, no migration, no
new environment key. What is new is the thing that tells you whether a deployment is what this
checkout says it is — and a release that can now end in an outcome it had no way to express.

### Added
- **`npm run doctor` — where does the deployment stop matching what this checkout declares.**
  Not "is it healthy": health is one bit, and the bit is yes right up until somebody is already
  looking. Six layers, each with one source of truth on the repository side and one on the
  deployment side — `repo`, `image`, `host`, `doors`, `contract`, `data` — asked in the order
  that makes a diagnosis, because the first layer that disagrees usually explains every layer
  after it. Later disagreements are tagged `downstream of <layer>` rather than reported as
  independent defects. `--layer repo,image` needs no host at all; `--since 0.26.0` lists the
  commits since a known-good version that touched the layers that disagree, named as suspects
  rather than causes; `--json` for the console or an agent. It changes nothing, and the gate
  refuses it if it ever tries to — the check scans command positions only, so a failure message
  that merely mentions `docker compose up` is not mistaken for running it.
- **A `contract` layer, which is what the 0.26.1 restructure needed and did not have.** A door
  that fails to mount does not answer 500 — it answers 200 with a shorter tool list, and every
  health probe stays green. It compares the live tool list against what the source registers,
  by name and by module, so the answer names the file a missing door came from.

### Changed
- **Release step 5 runs the doctor's probes. It owns none of its own.** Its eleven checks ran
  for forty seconds during a release and at no other time, so nothing exercised them in between
  and nothing noticed when the `release.mjs` split left three of them calling names they never
  imported. One list, run daily, with the release selecting which layers it cares about — and a
  gate check that refuses `verify.mjs` if it grows a probe again.
- **A release now has three outcomes, not two.** `wrong` — the two sides disagree — rolls back.
  `unknown` — the probes could not look — does neither: the new version stays live and is **not
  tagged**, because a tag is this repository's claim that a version was verified. The first
  attempt at 0.26.1 rolled a healthy deployment back on six ReferenceErrors thrown inside the
  verifier, and the fix for that cannot be to carry on to the tag instead.
- **A probe may throw only for a PRECONDITION; once a request is sent, the answer is returned.**
  Getting this wrong the other way is worse than the bug it replaces: `curl` exits 7 on a
  refused connection, so a crash-looping gateway threw out of seven probes, produced zero
  disagreements, and would have been TAGGED. The four cases are now pinned by mutation tests
  that live beside the code — a probe with a ReferenceError (live, untagged), a real
  disagreement (rollback), a dead gateway (rollback), an unreachable host (live, untagged).
- **`--verify-only` exits non-zero when it could not look.** It printed green after sixteen
  yellow "did not run" lines: somebody asked whether their deployment works and was told yes
  for a question nobody managed to ask.
- The doctor's "this is a bug in the doctor" label is `ReferenceError` alone now. A SyntaxError
  from `JSON.parse` on a Caddy 502's HTML error page is the platform's doing, and calling it
  ours is the same misattribution aimed the other way — at a platform that really is broken.
- **`scripts/deployment.mjs` is the one description of the deployment** — address, paths,
  images, and how to speak to it — read by the release and the doctor alike. It was inside
  `release/config.mjs`, which parses release flags and dies at import when it cannot resolve an
  address: importing that would have made the doctor unable to run its offline layers on a
  laptop that cannot reach the host, which is exactly the case a doctor is for. The address is
  a function now, not a constant, so nothing spends an ssh round trip at import time.

### Upgrade notes
- **Nothing to do on any host.** No migration, no env key, no client re-pull: the deploy
  bundle and the images are the same shape they were, and installed clients are unaffected
  because no skill changed.
- **If you release from this repository, one behaviour is different and it is deliberate.** A
  release used to end in two ways. It now ends in three: a DISAGREEMENT between the deployment
  and the checkout rolls back as before, but probes that could not RUN — an unreachable host, a
  missing token, a bug in a probe — leave the new version **live and untagged**, and say so.
  Rolling back on them would undo a release for a reason that was never about it; tagging would
  stamp a version nothing verified. If you see that outcome, run `node scripts/release.mjs
  --verify-only` once the probes can reach what they ask about, or `--rollback`.
- `node scripts/release.mjs --verify-only` now exits non-zero when it could not look, instead
  of printing a green summary under a list of probes that never ran.

## [0.26.1] — 2026-09-11

**zz-stack 0.26.1 · zz-stack-dashboard 0.3.5**

**A patch, and the number is the claim.** Sixty-nine new files is how much code moved, which
is the judgement this changelog says not to use. What a consumer sees is unchanged: the 29
tools' schemas are byte-identical to 0.26.0's live ones, every console route answers the same
verb at the same path, and `@zz/contracts` still exports through the one door. The console's
image content is identical too — 0.3.5 exists so its tag names the tree it was built from.

**Nine files held sixty-nine subjects between them, and the largest was 11,428 lines.** The
0.26.0 audit read every file and found the code honest; it did not ask whether the code was
reachable by a reader. This asks that, and the answer was that nine files in `zz-stack` were
each several things wearing one name.

- **`scripts/gate.mjs`: 11,428 lines → 67.** It is now the ORDER the checks run in — 26
  `import` lines, one per subject, under `scripts/gate/checks/`. A module missing from that
  list is a module that does not run, which is a new way to lose a check silently, so
  `report()` refuses to pass unless the number of checks WRITTEN under `gate/checks/` equals
  the number that RAN. `gate/run.mjs` holds the one `check()` they all register through —
  it cannot live in `gate.mjs`, because a checks module importing `check` from a file that
  imports it back is a cycle, and `failures` is a `const` in its temporal dead zone when the
  first verdict lands.
- **`services/zz-core/src/server.ts`: 5,270 → 290.** Its 29 tools moved to
  `src/tools/<door>.ts`, one `register<Door>Tools(server)` per file, so the file a tool lives
  in is the door a caller reaches it through. Eight shared layers — paths, guards, the chain,
  indexing, persistence, the platform database, skill roots, refusals — moved out first. The
  live `tools/list` from 0.26.0 was diffed against the rebuilt binary: 29 tools, schemas
  byte-identical.
- **`services/gateway/src/console.ts`: 2,071 → 70**, one file per console resource;
  **`server.ts`: 1,394 → 434**; **`admin.ts`: 1,152 → 490**; **`client-package.ts`:
  1,160 → 623**; **`settings.ts`: 741 → 137**, split by AUTHORISATION rather than resource, so
  a route in the wrong file looks wrong. The console's route set was diffed verb-for-verb.
- **`scripts/release.mjs`: 1,427 → 556**, one step per file. Moving `config.mjs` into
  `scripts/release/` silently re-rooted every path derived from `root`, and preflight printed
  "manifests ?" rather than failing — `safe()` returns "?" on error. That is how a relocated
  path announces itself if you are lucky.
- **`packages/contracts/src/index.ts`: 733 → 561**, with `identity.ts` behind the package's
  door — `index.ts` is still the single definition point every importer sees.

**A 700-line ceiling, enforced in both repositories, with no exemption list.** 700 is measured
rather than chosen: above it every file here held a whole second subject, while `judge.ts` at
627 lines with three exports is genuinely one. A list of files allowed to be large is a list
nobody prunes, so there is none — a file that cannot come down is a signal, not a case to be
excused. The gate is **275 checks**; the console's own gate holds the same ceiling. What the
rule does NOT catch is stated beside it: `identity.ts` is 619 lines with seventeen exports and
passes, because line count finds "definitely too big" and cannot find "more than one subject".

**What a restructure this size can break is a check that reads a file by its path**, and both
before and after are green because the pattern it hunts is simply absent. So nothing here was
verified by reading. The 273 gate verdicts were diffed at every commit and were identical every
time; the live tool list, the console route set, and the release's `--preflight` and full
`--dry-run` were diffed against the deployment; and roughly twenty mutation tests planted a
real violation at each new boundary and confirmed red before restoring green. Four checks were
found to be reading nothing or reading the wrong thing, and are fixed.

### Fixed
- **Two release steps used names they never imported, and both were invisible to the dry run.**
  Splitting `release.mjs` left `verify.mjs` calling `PUBLIC`, `die` and `envToken` and
  `build.mjs` calling `die` and `dryRun` without importing either — a ReferenceError waiting
  for its line to be reached. `build.mjs`'s eleven sit in a branch skipped when the console is
  already at its target version; `verify.mjs`'s are in step 5, which a dry run does not run at
  all. So the first attempt at this release deployed, failed six of eleven live verifications
  with "PUBLIC is not defined", and rolled itself back to 0.26.0 — the platform healthy
  throughout, the thing checking it not. The gate now runs `tsc --checkJs` over every `.mjs`
  under `scripts/` and refuses TS2304: `scripts/` is outside every tsconfig, so `tsc -b` has
  never looked at it.

### Changed
- The release refuses a version whose `## [<version>]` changelog section does not exist yet,
  beside the refusal for a `package.json` that was never bumped. The gate has always required
  that section of a SHIPPED version — which means it can only go red after the tag, where
  0.26.0 found it. This asks the same question one step earlier, where the answer is free.

## [0.26.0] — 2026-09-11

**zz-stack 0.26.0 · zz-stack-dashboard 0.3.4**

**Every file in both repositories was read and decided — 449 of them — and the most expensive
things found were not dormant code.** They were things that looked like they were working.

- **The platform had no backups.** `deploy/backup.sh` runs nightly. It wrote the database, the
  artifacts volume and the credential volume, then dumped a Mongo that was removed on
  2026-09-10, and its cleanup — "an incomplete run must not leave a file that reads as a
  backup" — deleted all three good archives. `/root/zz-backups` was empty and there was no log
  saying so. Fixed and verified on the host: three archives kept, 903 artifact entries read
  back and matched, restore drill returns 3 principals.
- **Two security checks existed, passed, and had never been run.** `check:redaction` drives the
  real `redact()` over eight response shapes; `check:scope` drives the real `resolveScope` and
  `teamAuthority` over nineteen cases. 713 lines about secrets and authorisation that neither
  the gate nor the release invoked. Every mention of them in the source was a comment saying
  they drive the real predicate — true, and describing something that had never happened.
- **The console's own gate was red**, and nothing ran it: a settings table rendered its headers
  over nothing for a person on no team, which is the exact class of bug that file was written
  for. It has an npm script now and the release runs it.
- **The design audit was measuring the sign-in screen.** `design-metrics.mjs` has no
  authentication step, so all ten pages redirected to `/login` and every number it ever printed
  described that one page. Its sibling in the same directory carries the guard and a comment
  saying why: an unauthenticated run "passes vacuously, which is the worst outcome for a check".

### Added

- **Ten gate checks**, each written from something this audit found, each mutation-tested: an
  npm script whose tool is not in the tree; an environment variable `zz-tool` forwards that
  nothing reads; an HTTP route with no caller in any of four caller sets; unused exports in the
  console, which had no such check while zz-stack had had one for months; the redaction and
  scope suites above; the two behaviour suites the zz-core split made reachable; and the
  console's gate joining the release; and a released version whose changelog entry is still
  under [Unreleased], which is how 0.25.0 shipped — found one release late, when the next
  entry wrote its sections beside it and "a release groups each kind of change once" went red.
- **`checks/document-rules.mjs` and `checks/write-guards.mjs`** — the first tests any of that
  logic has ever had.

### Changed

- **zz-core is split.** `server.ts` 6,114 → 5,271: `document-rules.ts` (the twelve pure document
  predicates) and `write-guards.ts` (the refusals that protect the store, with the `Chain` they
  are decided against). Both landed with their checks in the same commit, because a function
  inside a 6,000-line file cannot be imported, so nothing can call it, so every claim about it
  is a claim about how the source reads. Writing those checks corrected six of my own
  expectations about functions I had just read line by line — `approved_by` and `approved_at`
  are atomic; `renderEnvelope`'s `order` argument is not a filter.
- **`gate.mjs` 11,521 → 11,391**, with its file and text helpers in a module anything can
  import. Verified by diffing all 272 verdicts before and after: identical.
- **Block OAuth stops naming three blocks this platform does not have.** `OAUTH_CLIENTS` and
  `OAUTH_SCOPES` listed casebox, bookit and RuleMill; with those gone `connect_block` — a registered,
  documented tool — could not succeed for any block configurable through `PLATFORMS`. Both maps
  are empty, nine compose lines and six `.env.example` keys went with them, and adding one is
  three edits written down in all three places. **Breaking** only for a deployment that had set
  those six keys; none does.

### Removed

- The hourly turn collector, which had been creating a container every hour to fail on a Mongo
  that is not there; `provision`, `smoke` and `classify-cases`, three npm scripts naming tools
  the tree does not have; `deploy/systemd/zz-onboard.*`, whose `ExecStart` pointed at a script
  the repository never had; `/api/kb/activity`, a second activity feed for a view that was
  never built; thirteen console primitives and 1,035 lines nothing imported; 188KB of captured
  UAT responses carrying three real addresses; and eleven things `README.md`'s own map named
  that are not in the tree.

### Upgrade notes

**Nothing here changes how the platform behaves for a caller**, with one exception: a
deployment that had set `CASEBOX_/BOOKIT_/RULEMILL_OAUTH_*` loses those knobs. No deployment has.

**Re-run `deploy/install-backup-cron.sh` on any host that still has the hourly collector line.**
It removes it. Until then that host creates a container every hour to fail.


## [0.25.0] — 2026-09-10

**A deck is built in stages now, not in one shot.** `/sdlc:deck` used to read a 252KB template
and emit a whole 53-slide deck in a single step. It now reads only the ~80KB chassis, writes a
complete scaffold in one call — every slide present as a placeholder — then fills one slide per
edit. A run that stops early used to leave a file that looked finished but was short, with
nothing to tell you which slides were real; now it leaves a valid, openable file that names its
own unwritten slides. Hence `2.0`, not `1.1`: the skill's instructions are replaced wholesale,
not extended.

### Removed

- **`deck-template.html`**, replaced by `deck-chassis.html` (the runtime — style layer,
  pagination, `?qa`, the version dock) and `deck-guidebook.html` (the 53 sections and the
  manifest). **Breaking:** anything reading `deck-template.html` by path needs repointing to
  whichever half it actually wanted.

### Changed

- **Decks no longer land in an initiative.** They go to `decks/YYYY-MM-DD-<slug>.html` under
  the workspace root, always. **Breaking:** if your habit was running `/sdlc:deck` inside an
  initiative and expecting the file beside `spec.md`, it will not be there any more — but
  nothing is lost. What used to appear there was corrupt HTML that no surface could render: the
  platform's document write prepends YAML frontmatter, and the artifact browser shows anything
  that isn't `.md` as escaped source. A deck was never actually viewable from that location.
- **The `sdlc-deck` skill is `version: 2.0`.** Its instructions are replaced wholesale, not
  extended — hence the major bump, not `1.1`. **Breaking:** this is not the platform's own
  0.24.0 line above; it is the skill's own version, and anything that pinned or scripted
  against the 1.0 skill's behaviour needs to be re-checked against the rewrite.
- **`/api/console/initiatives` returns `approvals`, not `revisions`** — it counts `_versions/`
  files, which are written per approval. **Breaking** for anything reading that field by name;
  the console ships in the same release.

**Approving a document now says whether anybody fetched it first.** `zz-backbone` has always
asked for `show_document` before a gate — a person approves bytes, and the fetch is the only
part of "I put it in front of them" the platform can see — and nothing ever said so at the
moment it was skipped. An initiative closed here with four of its six approvals carrying no
fetch since the content last moved, an eleven-task plan among them, approved twice and fetched
never. `approve` now computes that and reports it. **It does not refuse, and it is not going
to:** a refusal there would land on the one call whose job is to record a decision a person
already made.

### Added

- **`approve` reports whether the document was fetched since its content last changed** —
  computed by `shownSinceLastChange` (`services/zz-core/src/attest.ts`), stated in the result,
  and written to the activity log as `fetched`. A standing "approve without checking with me"
  waives the person's REVIEW, not the fetch; the fetch is the part that reaches the record.
- **The console names versions that were used and never kept.** `_versions/` freezes one copy
  per APPROVAL while the version counter advances per REVISION, so a draft revised again
  before anyone approved it consumes a number and leaves no file — the page read `v1, v3, v4`
  and explained the hole nowhere, which looks like data loss. It now says which numbers those
  were and why nothing was kept.
- **A gate check that runs code rather than reading it** (`checks/attest-shown.mjs`, 8 cases).
  The offline gate is 269 checks, from 268.

### Fixed

- **`deploy/Caddyfile` and `STATE.md` named an address belonging to another platform.**
  The Caddyfile carried a hostname literal from before this became a single deployment, and it
  had gone stale; `STATE.md` stated that same address as the live gateway. Repointed at the deployment this repository actually targets, and the
  template's config body now matches the running `/etc/caddy/Caddyfile` line for line.
- **`install-caddy.sh` was discarding `$UPSTREAM` silently.** Its substitution still targeted
  a tailnet address the template had stopped carrying, and a `sed` that matches nothing does
  not fail — it emits the file unchanged, so every install hardcoded whatever the template
  said. Pattern corrected, and a guard added that refuses an install whose upstream
  substitution did not take, mirroring the one already guarding the hostname.
- **`sdlc-plan` told you to scaffold with markers `patch_file` refuses.** Every task's body
  was a single `<!-- enrich -->`, identical across tasks, and `patch_file` requires its target
  to occur exactly once — so an eleven-task scaffold could have its first task filled and none
  of the other ten. The marker now carries the task id. `sdlc-plan` is `1.3`; `zz-backbone` is
  `3.21`.

### Upgrade notes

**Nothing happens to a deck that already exists.** A deck is output, not state — a previously
generated file is a finished HTML document and keeps opening and rendering exactly as before.
There is no format change and nothing to re-run. Regenerating from the same source will simply
build the deck differently and land it at the new path.

**Every installed user must re-pull, and will not otherwise be told.** `sdlc-flow` is a
local-only flow — its skills ship as files inside the client tarball rather than being fetched
at run time — so an installed Claude Code or Codex keeps running the 1.0 skill indefinitely,
with nothing warning that a 2.0 exists. This is the same stranding shape the platform fixed for
retired plugins in 0.24.0, and it applies to every local-only flow content change:

```bash
rm -rf ~/.zz/zz-platform
curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" <gateway>/pkg/claude-code.tgz | tar xz -C ~/.zz
claude plugin marketplace update zz-platform
claude plugin update sdlc-flow@zz-platform
```

**Both claims were tested, and one of them failed.** A Sonnet worker built an 11-slide deck
from a 71,905-character spec following only the rewritten instructions: scaffold 1:1 with the
plan, one edit per slide, no batching, nothing left unfilled — so a weaker model can build a
deck it could not before. An interrupted run does leave a valid, openable file. But **it does
not show which slides are unwritten**: an unfilled slide's body is an HTML comment, comments
do not render, and 7 of 10 slides displayed as blank rectangles, with the deck's own `?qa`
panel reporting them identical to finished ones. The failure moved from *silently truncated*
to *silently blank*, which is an improvement and is not what was promised. Fixing it changes
the placeholder format, so it is a separate change and not a patch to this one.

## [0.24.0] — 2026-09-10

**zz-stack 0.24.0 · zz-stack-dashboard 0.3.2 (unchanged)**

**One door. The tools you are offered are the ones your role can execute.**

`/admin/mcp` is gone. It was never an authorisation boundary — its own entry in the door
index said so, "any member; each tool authorises per call" — and it behaved accordingly: a
member-scope token opened it, listed all twenty tools, and was refused by every one of them.
A URL that admits everybody sorts nothing. The only thing the split bought was a shorter tool
list, and it leaked even at that: `admin_set_credential` and `admin_delete_credential` are
operator tools and they lived on the *member* door, because that is where the credential
store is.

So the list is now shortened by the thing that was doing the work all along. `/manage/mcp`
builds its tool set per request from the caller's role: **20 tools for a member, 24 for
somebody who administers a team, 34 for a superadmin.** The predicates are the same
`isSuper`/`isTeamAdmin` the handlers call, not a second reading of `platformRole`, so
visibility is exactly executability — a superadmin holding a member-scope PAT is not super
for that request and is not offered tools that would refuse them.

**Authorisation did not change.** Every handler still resolves the caller from the database
and checks for itself, because "administers some team" is not "administers THIS team":
`install_flow` is in a team admin's list and still refuses the team they do not lead, with
its reason. The role filter is ergonomics; the handler is the boundary.

**What a member loses, stated plainly:** `list_people` used to answer "ERROR: superadmin
required" and now answers "tool not found", which explains less. `whoami` is registered for
everyone precisely so that question has a tool, and both skills now say that a tool missing
from your list is a fact about your role.

### Removed

- **`/admin/mcp`.** Everything it served is on `/manage/mcp`. **Breaking:** any client config,
  script or bookmark naming `/admin/mcp` must be repointed — `zz-tool call`, the release
  probes and the deploy guide already are.
- **The `zz-admin` plugin.** Its skill moved into `zz-access`, which now ships two: `zz-access`
  for the person in front of you, `zz-admin` (a standalone `/zz-admin` command in Claude Code)
  for everybody else. One plugin, one door, one MCP server in a client config. Its browser
  agent is gone too — an administrator gets the admin tools through ZZ Access, which is the
  point of the merge.
- **`render_harness_config`.** **Breaking:** the tool no longer exists. The door split was the
  only thing keeping it alive; its own description said "for your OWN setup use
  my_client_setup on /manage". `my_client_setup` now takes an optional `email`,
  superadmin-only for anyone but yourself, which is the whole of what it added.

### Fixed

- **A client refresh no longer strands a retired plugin.** `tar xz` writes what the archive
  holds and removes nothing else, so a plugin the platform had withdrawn stayed on the laptop
  for ever, still pointing at a door that had stopped answering. The refresh command now
  clears `~/.zz/zz-platform` first. `~/.zz/token` is a sibling of it, not a child, and is
  untouched. **Anyone upgrading past this release should run `rm -rf ~/.zz/zz-platform`
  before re-fetching**, once — the old instructions are what left the stale copy.

### Changed

- `serveMcp` accepts an async `buildServer`. **Breaking** for callers of
  `@zz/mcp-http`: the signature is now `() => McpServer | Promise<McpServer>`. Resolving who
  is calling is a database read and it has to finish before the first tool is registered.
- The gate's door-shaped checks became role-shaped, which is stronger: it now asserts the
  tier each tool is registered under, that both predicates derive from the handlers' own
  functions, and that every tool on the door is taught by one of the two skills it ships with
  — the check that would have caught twenty admin tools shipping with no instructions at all.
- **The MCP server `zz-access` declares is renamed `cred-manage` → `zz-access`.** **Breaking**
  for an installed client: the server id is part of every tool's name, so an existing config
  keeps calling a server that no longer answers under that name. Re-pull (below).

### Upgrade notes

**Everyone with a client installed must re-pull, and uninstall `zz-admin` first.** Order
matters — the marketplace must still list the plugin when you remove it:

```bash
claude plugin uninstall zz-admin          # while the marketplace still lists it
rm -rf ~/.zz/zz-platform
curl -fsSL -H "Authorization: Bearer $ZZ_TOKEN" <gateway>/pkg/claude-code.tgz | tar xz -C ~/.zz
claude plugin marketplace update zz-platform
claude plugin update zz@zz-platform zz-access@zz-platform
```

The `rm -rf` is one-time: this release makes the generated refresh command do it, but the
instructions that put the current copy on your machine did not, so the retired `zz-admin`
directory is already there and would otherwise stay for ever.

**No migration.** The database is untouched — this release moves no schema.

**Fewer tools is not a downgrade.** If a tool you used is missing after this, run `whoami`:
the door registers what your role can execute, and a member-scope PAT makes even a superadmin
a member for that request. `~/.zz/token` is whichever token you last installed with.

## [0.23.0] — 2026-09-10

**zz-stack 0.23.0 · zz-stack-dashboard 0.3.2**

**The platform is one person's, on one host, behind a passkey.** Everything below follows
from that, and most of it is deletion.

**0.20.0 through 0.22.0 shipped without entries here.** They are tagged — `git log
v0.19.0..v0.22.0` is the record — and what they carried is in that range: stateless MCP
doors, OAuth for the doors themselves, the end of the shared team key, and the console's
scoped reads. This entry does not restate them; it says so rather than leaving the gap to be
discovered by someone counting versions.

### Removed

- **LibreChat and ops-flow**, with the smoke suite, the connection checker and the onboarding
  timer that existed to keep a browser front end honest. What is left is the SDLC flow, our
  own MCP, and the console.
- **The third-party building blocks** (casebox, bookit, RuleMill) and their catalog flows. They
  live in their own repositories now.
- **The password door.** `/auth/password`, `passwordSetAuthority`, the scrypt verifier, its
  rate limiter and its check engine. Migration 043 drops `zz.principal.password_verifier`.
- **OpenID Connect.** `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `/auth/login`
  and `/auth/callback`. An external provider's value is telling us who somebody is when we
  do not already know; we do, so what it bought was a consent screen, a test-user list and a
  client secret to rotate.
- **The second environment.** `--env=uat|prod`, `ZZ_DEPLOY_HOST`, `ZZ_PROD_TOKEN`,
  `ZZ_UAT_TOKEN` and the `~/.zz/token` fallback. The sync script is now `deploy/sync.sh`.
- **zz-blocks from the release.** `--blocks=<v>`, `--no-blocks` and everything behind them.

### Added

- **A passkey is the console's door.** WebAuthn, discoverable credentials, so signing in
  asks for no email at all — the browser offers what it holds and you pick. Migration 044
  adds `zz.passkey`, `zz.passkey_enrolment` and `zz.passkey_challenge`.
- **Enrolment links.** A passkey attaches to a principal ONLY through a one-time link naming
  it, because an authenticator asserts possession of a key and never an identity — a
  registration that could name its own email would be open self-registration. The first link
  comes from the host (`./deploy/issue-enrolment.sh <email>`), since before anyone has a
  passkey there is no superadmin session to mint one; later ones come from Settings › People
  or `issue_enrolment` on `/admin/mcp`. The token travels in the URL fragment, so it reaches
  neither Caddy's access log nor browser history.
- **`deploy/provision-host.sh` and `deploy/install-caddy.sh`** — a bare Ubuntu host to a
  running one, by substitution rather than by retyping addresses, which is how the old UAT
  went down twice.

### Fixed

- **The session query read a column migration 044 had just dropped.** `resolveSession`
  selected `s.door`; tsc cannot see SQL, so the sign-in would have succeeded and the console
  would have died on its next request. The gate now catches both shapes it missed: a dropped
  COLUMN retires every state it could hold, and a constraint added by `alter table` belongs
  to that table rather than to whichever one was declared last.
- **The passkey userHandle guard refused every honest login.** It arrives base64url and was
  compared against a raw UUID, so it failed on length — after enrolment, on the second visit.
- **A gap you cannot have is not a gap.** The Runs page opened with "zz.run.turns is 0 on all
  0 rows" on a platform that had never run anything, reporting a defect that was an empty
  table.
- **Preflight misreported the cycle it exists to save.** It read `process.env.ZZ_TOKEN` while
  the release read `envToken()`, so a `ZZ_TOKEN` in this repo's own `.env` — the documented
  place for it — made the release work and made preflight say "no token found".

### You have to

- **Enrol a passkey before you can open the console.** `./deploy/issue-enrolment.sh <email>`
  on the host, then open the link. PATs are unaffected.
- **Delete `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`** from `deploy/.env`, and
  retire the OAuth client at the provider.
- **Set `ZZ_TOKEN`** in this repository's gitignored `.env`. It is the only release credential
  now.
- **Know that a passkey is bound to `CONSOLE_PUBLIC_URL`'s hostname.** Ours encodes the
  droplet's IP; change the host and everybody re-enrols from a fresh link.

## [0.19.0] — 2026-09-08

**zz-stack 0.19.0 · zz-blocks 0.3.4 (unchanged, deployed) · zz-stack-dashboard 0.1.0 (unchanged, deployed)**

**Nothing a person using the platform will notice.** The only file that changed is
`scripts/release.mjs`, which is not in the image. It is a minor rather than a patch because
it breaks something for the person who runs a release, and that person is a consumer too.

This release also brought UAT level with production: same blocks, same console, both deployed
from the images already in the registry rather than rebuilt.

### Changed

**zz-stack**
- **A release goes to UAT unless somebody says production.** `--env=uat|prod` selects the
  deployment on every mode — release, preflight, verify-only, rollback — and defaults to
  `uat`. The safe answer used to be the one you had to remember and the dangerous one the one
  you got by forgetting.
- **`ZZ_PUBLIC_URL` no longer has to be set.** When it is not, the script reads
  `GATEWAY_PUBLIC_URL` off the host it is about to deploy to. It still has no baked default,
  for the reason it never did — the live checks send a bearer token to whatever it names — and
  an address read from the machine you are deploying to is not inherited from this repository.
  `--verify-only` now needs no environment at all.
- **One version can reach two deployments.** Tagging re-uses a tag that points at the same
  commit and refuses one that points elsewhere; an explicit `--blocks=` / `--dashboard=` ships
  that component even when its repo is unchanged since its tag; and a component whose image is
  already in the registry is **deployed rather than rebuilt**, so a second environment cannot
  replace the bits behind a number the first one already pulled.

### Fixed

**zz-stack**
- **A release can reach a host that is not a git checkout.** The deploy step read
  `git reset --hard origin/master` as universal. Production is a checkout; UAT is not and
  never was — it is populated by the sync script, which rsyncs and excludes `.git` — so
  the first release aimed at UAT died there, after pushing an image and before deploying
  anything. A host without a checkout is now given the **deploy bundle**, which is the
  artifact this script already builds for the "no repository, no toolchain" install and which
  carries exactly the `deploy/` files a host needs at this version. `.env` is untouched: it is
  the host's own and the bundle carries `.env.example`. Preflight reports which of the two a
  host is on, so it is a fact known before anything is built rather than after.
- **A refused tag no longer strands two repositories' commits.** The tag check refuses by
  dying, and it dies on the first repository — so the blocks' and the console's `git push`
  sat below it and never ran, leaving their commits on one laptop while their images were
  deployed and verified. Every commit now reaches origin before any tag is cut.

### Upgrade notes

- **A bare `node scripts/release.mjs <version>` now deploys to UAT, not production.** Pass
  `--env=prod` for production, with `ZZ_TOKEN` set to a production PAT — `~/.zz/token` is
  UAT's, and preflight fails it with a 401 before anything is built.
- **`ZZ_DEPLOY_HOST` still means PRODUCTION** and still defaults to `sm`. It is not "where
  this release goes": the sync script reads it to decide which host it must refuse to
  `rsync --delete` onto. Nothing about it changed, deliberately.

## [0.18.0] — 2026-09-08

**zz-stack 0.18.0 · zz-stack-dashboard 0.1.0 · zz-blocks unchanged at 0.3.4**

The theme is one sentence: **what an initiative learned is worth more to the next one than
its deliverable is, and it disappears when the conversation does.** The knowledge base was
one shelf belonging to `zz-platform`, so a lesson a team learned about its own stakeholders
had nowhere to live that was not everybody's. It is now two shelves, and every flow ends by
filling them.

Alongside it, the console stops being the one thing that reached production by being built
on the host.

### Added

**zz-stack**
- **Two knowledge shelves, and the write says which.** `knowledge_add` takes
  `scope: "team" | "platform"`. A team node goes to that team's own store and stays theirs; a
  platform node goes to `zz-platform` and must be about a registry entry — a block, a flow, a
  provider, an interface. Nothing infers the shelf from the node's text, and nothing decides
  it for you.
- **The handover is a step every flow inherits, not a document one flow wrote.**
  `initiative_status` returns `action: handover` until a knowledge node names this
  initiative. It carries a gate, so the team sees what was distilled and says yes to it, and
  `close()` refuses an initiative whose handover is not approved. A flow author does not opt
  in — it is derived from the manifest.
- **Nothing is recorded to go through the motions.** A node is added because it is worth the
  next initiative's time, and an initiative that genuinely learned nothing general says so
  rather than minting filler.

**zz-stack-dashboard**
- **The knowledge shelf filter appears.** No console code moved for this: the team control was
  written to show itself only once there is genuinely more than one shelf, and until now there
  never was. Splitting the store is what turns it on — the shelf names the team on every row,
  counts how many are in view, and toggles between them.

### Changed

**zz-stack**
- **`zz-knowledge` is the only skill that writes knowledge, for every flow.** It runs at the
  end of the initiative, from the backbone, rather than being wired into one flow's stage
  list. Seventeen gate checks hold the shape, including that an approved handover kept the
  team nodes it promised — the case a live run found, where on `zz-platform` the team shelf
  IS the platform shelf and the promised count was satisfied by the wrong nodes.

**zz-stack-dashboard**
- **The console is a released component.** Its own version, its own image
  (`ghcr.io/zhixuan312/zz-stack-dashboard`), its own compose literal, released by
  `zz-stack/scripts/release.mjs` alongside the platform and the blocks: it runs its own
  typecheck, lint and test, deploys after the gateway, and rolls back with it. Until now it
  reached production by rsyncing its source to the host and building there, which is how
  production stopped running published images without anybody deciding to. The only file that
  goes to the host is its compose file; there is no checkout there any more.

### Removed

**zz-stack**
- `learnings.md`. The handover is knowledge nodes; there is no document.
- The `sdlc-record` skill, and its stage from `sdlc-flow`.
- `knowledgeMentions` from zz-core.

### Upgrade notes

- **`knowledge_add` without `scope` is refused.** Any caller outside the shipped skills — a
  script, a saved prompt — must pass `"team"` or `"platform"`. There is no default: the shelf
  is a decision, and guessing it wrong puts one team's material in front of everybody.
- **Every installed client must re-pull**, `claude plugin update <name>@zz-platform`. The
  plugin cache is keyed by version directory, so a client that does not update keeps running
  the old skills — including `sdlc-record`, which no longer exists on the server side.
- **An initiative cannot close until its handover is approved.** Work already open when this
  lands will ask for a handover it did not previously owe. That is the intended behaviour,
  not a stuck initiative.
- **The console is now pulled, not built.** On any host that predates this release, the old
  source tree at `/root/zz-stack-dashboard` is dead weight apart from `docker-compose.yml` —
  see `/release`. And in the `zz-stack-dashboard` checkout, `docker compose up -d --build` no
  longer builds from source: use
  `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
- **The console has no rollback target on its first release.** Production is running an image
  built on the host, so nothing published exists to go back to. From 0.2.0 onward it rolls
  back with the platform.

## [0.17.0] — 2026-09-07

The theme is one sentence: **a rule that lives in skill prose is a prompt, and it varies by
interface; a rule that lives in server code holds identically everywhere.** Five behaviours
moved from the first place to the second. Alongside them, a person signing in with corporate directory is
now onboarded without anybody watching, and the console is deployed to production for the
first time.

Two releases (0.15, 0.16) shipped without an entry here. This one covers everything since
0.14.0 that a person running the platform would feel.

### Added

**zz-stack**
- **`show_document(path)`** — fetch a document from the team's store and put it in front of
  the person: envelope facts stated separately, then the body verbatim as markdown, never a
  summary. Every document-writing stage in every flow now names it and calls it after writing
  and before asking anyone to decide. **Call it in a separate call once the write has
  returned** — parallel tool calls have no ordering, and a fetch issued alongside its own
  write answers truthfully that the document is not there yet.
- **The fetch is recorded.** Each call appends a `shown` entry naming path, version and
  caller, so "was this document ever fetched, and at which version, before its gate was
  approved" is answerable from the initiative's own log. On success only — a refused fetch
  opened nothing and must not claim it did. This is detection, not prevention: a tool result
  is model input, and the platform cannot vouch for a pair of eyes.
- **`revise_document` accepts `self_edit`** — a string saying WHAT you edited, for a version
  nothing external caused. The record could not previously tell "no cause" from "cause not
  captured". Supplying it alongside `source_content`, `sources` or `note` is refused: they are
  opposite claims about the same version.
- **Automatic onboarding.** A deploy-side onboarding script with a systemd timer (removed
  when the platform became single-tenant): a new directory sign-in
  gets a platform principal, the default team, and every agent that team's flows imply. The
  unit is the TEAM — install a flow for a team and the next tick gives it to every member.
  Membership happens once, recorded as a `zz.event` of kind `onboard`, so it can never re-add
  somebody an administrator deliberately removed.

**zz-stack-dashboard**
- **Deployed to production** for the first time, at `console.<host>`, beside UAT's. It needs
  `SSOAUTH_ISSUER`, `SSOAUTH_CLIENT_ID`, `SSOAUTH_CLIENT_SECRET` and `CONSOLE_PUBLIC_URL` in
  `deploy/.env` — **on the `cred-proxy` service, which is what serves `/auth/*`**, not
  `zz-core`. Without them `/auth/login` answers 503 and nothing says why.

### Fixed

**zz-stack**
- **Three tools silently discarded a supplied value.** `close()` given both `accepted_by` and
  `no_signoff_reason` preferred the acceptor and dropped the reason; `reconcile()` given both
  `initiative` and `block` answered one and ignored the other. Both now refuse and say which
  two claims contradict each other.
- **A version snapshot is indexed when it is written.** `_versions/*.md` reached the database
  only through a manual `reindex_knowledge(force)`, so the console's version chain — built,
  and correct — had nothing to render. Every earlier draft of a document is now visible with
  its diff and the sources that caused it.
- **A spec's acceptance criteria were not indexed at all.** The claim reader anchored at
  `**AC-1.1**` at line start, so a flow writing `- [ ] **AC-6.1**` had its *requirements*
  indexed as its criteria and its actual criteria indexed nowhere — and the console then
  displayed the result under the heading "acceptance criteria". Both halves fixed.
- **A database fault reached the caller as a raw error.** Sixteen tools call `userRoot()` or
  `teamFor()` bare; an outage produced a stack-shaped message instead of a refusal that says
  what happened. One wrapper on the server instance now catches it and answers in the house
  style.
- **`blockVersionFor()` treated three subject kinds as one**, and returned `null` on an infra
  fault — indistinguishable from "no subject involved". A subject tag now always resolves to
  a version or to a permanent `"unresolved"`.

**zz-stack-dashboard**
- **The agreement panel no longer claims to show acceptance criteria.** It shows whatever
  keys a document states, so it is titled for the claims the document makes, with a `Key`
  column rather than `AC`. The surface must not assert what the platform declines to
  determine.

### Changed

**zz-stack**
- The offline gate grew from 255 to **260 checks**, each one refusing a defect this release
  actually found.
- Every test tool takes the flow it is testing rather than assuming `ops-flow`.

### Breaking

- **`eval-step.sh` now requires `--flow`.** `smoke-env.sh` and the other launchers stop
  defaulting to `ops-flow`; a guard keeps them honest. Callers passing no flow must pass one.

## [0.14.0] — 2026-09-06

Everything here came out of running a set of requirements end to end on `casebox` and then trying
to measure what happened. Three of the fixes are things that had been silently broken for
a week or more.

### Added
- **A rubric file may declare its `subject`** — `auto`, `document`, `trace` or `body` —
  instead of having it inferred from `vendored` and `produces_document`. The inference was
  measured wrong: `vendored` forced `body`, and a body control is another skill's text,
  which satisfies the same generic dimensions, so the control cannot fail. Eight body
  rounds across three judge configurations produced no gap above the collapse line.

### Fixed
- **A document had been attributed to no version since 2026-08-31.**
  `zz.doc.produced_by_run_id` and `initiative_id` were written once, by migration 018's
  backfill, and by nothing since — so the evaluation track could only see the corpus as it
  stood that day. `reconcileRuns` fills both now, from the manifest rather than from 018's
  hardcoded ops-flow table.
- **A release tells the registry what it ships.** `zz.skill_version` was updated by
  nothing, and `zz-tool register-skills` cannot work where it is documented to run: it
  executes inside the image and its default psql is `docker compose exec`.
- **Work that stopped could not be recorded as stopped.** closeCheck exempts a stopped
  initiative from its gates and says to close it as abandoned; the next loop then refused
  that close for a missing `requiredForClose` document. Abandoned work stayed open in the
  ledger for ever.
- **`block_skills` names the reader.** An agent handed the block's skill names called
  `bookit:usage_skill_view` with one of them and got "no usage skill", which reads as
  the skill not existing rather than as the wrong door.
- **The fast-judge experiment accused the wrong thing.** judge.ts and knowledge node 0039
  recorded that reasoning-off broke the control. It did not — no body round has ever
  cleared under any configuration, and reasoning-off scored better on both skills cited.
  Node 0039 superseded by 0074.

### Upgrade notes
- No migration in this release. 031-036 shipped in 0.13.0 and apply on first start.
- **The registry now updates on every release.** A deployment upgrading from before 0.13.0
  will see its first `register-skills` run record every version added since it was last
  run by hand.
- Installed clients need `claude plugin update` for the skill changes.

## [0.13.0] — 2026-09-06

A stage can now say which building blocks it may call, and the platform holds it to that.
Everything else here came out of running the evaluation track end to end and reading what it
actually produced.

### Added
- **Stage-level block authority.** A flow's `stages` entry may declare `blocks` — a named list,
  or `"selected"` for the ones the initiative's own selection document chose. The gateway
  refuses a block `tools/call` the running stage does not declare, and zz-core refuses a write
  to a document whose stage declares no block and whose body NAMES one. Only `ops-flow`
  declares any; the other five flows behave exactly as before.
- **`block_skills`** — which building blocks this platform routes and which usage skills each
  one ships, from the registry rather than from a naming convention. `ops-select` told agents to
  look for `<block>-usage`; a block ships its usage skills under the names its own authors
  chose, so they came through a whole evaluation campaign never opened.
- **`blocks` on a selection document**, written as its own `write_file` argument and capped at
  five. It is what `blocks: "selected"` resolves to, so the approved selection becomes the
  actual boundary of the build.
- **Coverage and behaviour in every evaluation report.** `eval_skill_scores` and
  `eval_block_usage` return finished markdown: how many subjects were judged out of how many
  there were, and what the skill actually did — loads, calls, refusal rate, distinct tools,
  blocks, run lengths, refusal classes. No report before this said "13 subjects" *of what*.

### Changed
- **`ZZ_TZ`** — dates the platform stamps are local to the deployment, not UTC. In Singapore
  the first eight hours of every working day were filed under yesterday.
- **A closed report can be corrected; the close it records cannot.** `revise_document` carries
  `outcome` and the gate forward on a closed initiative, freezes the signed text in
  `_versions/`, and records why. Two guards had between them made a closed report permanently
  uneditable, by accident rather than by decision.
- **Where an initiative got to** is read from which stages have written, not from how many
  documents exist — a five-stage evaluation with two documents could never report past 3.
- **`zz-skill-report` specifies the change**: one per round, with the effect it expects, and
  the route (repository edit, then release).

### Removed
- **`zz-skill-evolve`.** Three of its four steps were `zz-tool` shell commands, which no agent
  on this platform can run, and the fourth — changing a skill — is impossible at runtime
  because `/catalog` and `/skills` are read-only. It never ran. What was worth keeping moved
  into `zz-skill-report`.

### Fixed
- Deleting an initiative was impossible: `zz.run`'s foreign key orphaned its runs into a
  unique index that then refused them.
- `ops-spec` 1.2 makes the one change its own evaluation recommended — a criterion names its
  check and its owner in one sentence.

### Upgrade notes
- **Migrations 031–036 apply on the gateway's next start.** 035 adds `zz.doc.blocks`; 036
  changes `zz.run`'s foreign key to cascade.
- **`flow.json` `stages` is now `[{name, blocks?}]`, not `[string]`.** Every flow in this
  catalog is updated. A flow maintained outside it must be updated before it installs.
- **`eval_skill_scores` and `eval_block_usage` return markdown, not JSON.** Anything parsing
  them breaks.
- **Set `ZZ_TZ`** in `.env` — it defaults to `Asia/Singapore`.
- **`ops-intent` and `ops-spec` can no longer call a building block**, and a spec naming one is
  refused. If a stakeholder names their current system, store their words with `add_source`
  and write "their current system" in the document.
- **Installed clients need `claude plugin update`** to pick up the skill changes.

## [0.12.8] — 2026-09-05

### Changed
- **The findings reports are written for people now.** A reader could not tell what a round
  concluded without reconstructing it from the evidence. The skill-evaluation manifest ordered
  the report provenance-first, numbers-second, verdict-third; the block report buried its asks
  under four sections of measurement, which reads to the receiving team as a complaint. Both
  now lead with the answer, both carry ASD-STE100's writing rules (one idea per sentence,
  twenty words, active voice, articles kept, no noun stacks) and a written-out opening to fill
  in rather than redesign, and the platform's own measurement failures have a section of their
  own instead of leaking into the verdict, the numbers and the recommendations at once. Not
  STE's dictionary: it has no word for a 422 or a rubric, and forcing one produces worse prose.

### Added
- **A manifest says which stage writes each document.** `FlowDoc.stage` — one optional field,
  and it is what lets a flow be drawn without being known. The manifest already declared which
  documents a flow gates and never where in the flow each is written, so nothing could place a
  gate: the console hung four of them off fixed positions 1, 2, 4 and 6, which is ops-flow's
  shape, over every initiative on the platform. Every alternative is a second per-flow table
  somewhere that stops being true the day a flow is added. Filled for all six flows; where it
  is absent the console says the manifest does not place the gate rather than inventing a spot.

### Fixed
- **The console described every initiative as if it were running ops-flow.** `stageOf` was
  hard-coded to seven stages named intent/spec/select/plan/build/verify/close and exactly four
  gates, and it was applied to every row whatever flow the work actually declared. So a
  `zz-skill-eval` round — five stages, two gates, documents called `rulers.md` and
  `findings.md` — displayed as "S6 · Verify", "Awaiting acceptance", "1 of 4", every word of
  which is about a different flow. Not slightly wrong: describing work nobody did. Stages and
  gates now come from the initiative's own manifest, so a flow that adds a stage tomorrow is
  described correctly with no change here; ops-flow's shape survives only as the fallback for an
  initiative whose flow the catalog cannot resolve.
- **Every document reported `00:00`.** The index stored `updated_at` as the envelope's date
  cast to `::date` — a day, therefore midnight — on every document. The envelope was the
  right instinct for the wrong half of the problem: it is there because `now()` restamped the
  whole corpus to the moment of the last reindex, and what it protects is that a rebuild must
  not move the time. The file's mtime protects that too — re-reading does not change it — and
  is a real timestamp rather than a day.

## [0.12.7] — 2026-09-05

### Fixed
- **A skill's score page listed every ruler the skill has ever had, merged into one table.**
  The dimension query joined `zz.rubric` by skill alone, so a skill carrying two rubric
  versions offered the union of their dimensions — `using-casebox` showed six rows where
  its ruler has three, and the three belonging to the unaffirmed ruler appeared with a dash and
  an empty n, indistinguishable from a dimension that had been scored badly. The page now shows
  the dimensions of the ruler its versions declare, or failing that the newest the catalog has
  loaded.
- **Two judges reading one subject were merged into one row.** Scores were keyed by initiative
  alone, so a second judge's reading overwrote the first and the row's n counted both — a mean
  across two judges, which is a number about neither. Every query in `evaluation.ts` groups by
  judge for exactly this reason and this page was the one place that did not. Readings are now
  kept apart by judge, and a document row shows the most recent with its judge named.

## [0.12.6] — 2026-09-05

### Added
- **`ZZ_JUDGE_THINKING`, and the experiment it settled.** A control call ran past 95 seconds
  and timed out three times in a row, storing nothing — and a lost control costs a round the
  only number that establishes the judge was reading rather than rewarding confident prose.
  Turning the judge's deliberation off answered the same call in five seconds, which looked
  like a clear trade. **Then the control judged the change and refused it:** re-scored under
  the fast judge, one subject's real-vs-control gap fell by a point and another went
  **negative** — the judge scoring the real subject *above* a different skill's text under its
  own ruler, which is exactly the collapse the control exists
  to detect. Deliberation stays on and the timeout is paid instead: a timed-out subject is
  reported skipped, `remaining` does not move, and the next call retries it with a fresh
  budget. The flag is kept so the comparison can be re-run, and a mode is part of a judge's
  identity — `off` records as `glm-5.3/no-reasoning` and never averages with the rest.

### Upgrade notes
- Four evaluations exist under `glm-5.3/no-reasoning` (two skills, plain and control). They are
  the evidence for the paragraph above and are deliberately kept; every comparison groups by
  judge, so they will not mix with the reasoning scores.

## [0.12.5] — 2026-09-05

### Fixed
- **A control run continued from the plain run's session judged nothing and reported success.**
  `eval_skill_judge` resumes by `eval_id` and decides what is left from the subjects that
  session has already scored. A body-subject skill has exactly one subject, so passing the
  plain session's id with `control: true` found nothing to do, answered `remaining: 0,
  stored: 0`, and closed with "The control is complete." Nothing was judged and the report said
  the measurement had its control — which is the one failure this apparatus cannot tolerate,
  because the control is the only evidence that the judge was reading at all. Migration 033
  records `is_control` on the evaluation itself (not inferred from its scores, since the state
  this is caught in has no scores yet) and a mismatched resume is now refused with the reason.
  Found by the flow, on the second skill evaluation, and reported by it before anyone asked.

## [0.12.4] — 2026-09-05

### Fixed
- **`eval_skill_ruler` reported no rubric for every skill that has one.** It read
  `zz.rubric` through `skill_version.rubric_id` — the *affirmed* link — so a rubric the catalog
  ships and nobody has affirmed was invisible, while its own description promised "every rubric
  the skill has". zz-skill-define branches on exactly that field: told `dims: 0`, the stage
  correctly concluded "derive one", and derived one in a vacuum beside two loaded rubrics with
  three dimensions each. It produced a ruler that scored obedience to conduct rules this
  platform had already decided were harmful in its flows — and every skill on the shelf is in
  the same state, so it would have happened fifteen times. The tool now returns the skill's
  rubrics with their affirmation state, and says REUSE, DO NOT DERIVE when one exists unaffirmed.

### Added
- **A rubric declares what it is a ruler FOR, and the judge obeys it.** Every `rubric.json` in
  the catalog carries `produces_document` and `vendored`, and nothing carried them into the
  database — so the judge inferred its subject from what the skill happened to leave behind.
  For a vendored file that inference is wrong in the one way that matters: its ruler asks
  whether the file earns its place beside the block's own tools, which no run trace can answer,
  and traces were all the judge could see. Migration 032 adds `zz.rubric.subject`
  (`auto` | `document` | `trace` | `body`), `rubric-load` fills it from the catalog, and a
  `body` rubric is judged against the skill's own text — with another skill's text as its
  control, because a control of a different artifact kind measures the kind rather than the judge.
  The subject is the rubric's and never the caller's: an evaluation whose subject is chosen by
  whoever runs it is not a measurement.

## [0.12.3] — 2026-09-05

### Fixed
- **`zz.run` had no maintainer, so every skill's measured reach stopped on 2026-08-31.**
  Migration 017 created the table and backfilled it from `zz.event.detail->>'run'`, and nothing
  ever inserted another row. Five days of delivery, four evaluation rounds and a whole block
  evaluation left no run at all — and `zz.event.run_id` went unset for the same five days, so
  even the runs that did exist had no trace a judge could read. It is not cosmetic: a run is
  what attributes work to a version of a skill, `zz.doc.produced_by_run_id` hangs off it, and
  a skill whose runs stopped being recorded is indistinguishable in every query from one
  nobody ever used. Found because eleven of the fifteen skills queued for evaluation reported
  nothing to judge. Runs are now recomputed from the event log — set-based, idempotent, on the
  grain 017 declared — when the gateway starts and every five minutes after.
- **A run could not be recorded before its initiative existed, which is where a block usage
  skill lives.** An agent loads `using-casebox`, makes a run of calls against casebox, and
  opens an initiative later or not at all — so the skill showed 11 loads, 3 sessions, 22
  stamped calls and zero runs, which every query reads as a skill nobody has ever used.
  Migration 031 adds the partial unique index that makes initiative-less runs upsertable
  (Postgres treats NULLs as distinct, so the existing key would have re-inserted them on every
  pass), and the reconciler records them. A run still needs a skill version: one attached to
  neither an initiative nor a skill is a caller session and answers no question.
- **`eval_skill_judge` could not return, so it stored nothing.** One document takes the judge
  about thirty seconds, and something between the tool and its caller closes an MCP request at
  two minutes — so a call scoring a whole corpus was severed mid-flight every time. Not a
  partial answer: a dropped connection, no rows written, and an event-log entry recording a
  failed call with no message, which is the least useful record a platform can keep. It now
  judges **one subject per call** and reports what is left; the `zz.eval` row is the session,
  and passing its id back continues it. Progress lands in the table while it runs, so a turn
  that dies loses one subject rather than the round. `finished_at` is set only when nothing
  remains, so a half-judged evaluation can never be averaged as a whole one.
- **The judge's output cap truncated its own answer, and the retry then ate the request.**
  `max_tokens: 4000` sounds generous until the model spends most of it on reasoning tokens and
  returns `finish_reason: "length"` — JSON cut off mid-string, unparseable, so the retry fired
  and spent the rest of the two minutes. The symptom was a tool that returned nothing; the
  cause was a number. The cap is 16000, a truncated answer is now refused out loud rather than
  scored as a bad document, and the retry moved to where it can afford itself: the next call,
  with its own budget, because the tool resumes.
- **A dimension the judge renamed slightly was dropped, silently.** The first real judging
  stored 4 marks against a 5-dimension rubric and said nothing about the fifth: the judge had
  answered `Criterion Fidelity` for `Criterion Fidelity (as written, not as built)`, and that
  mark went nowhere while the mean was computed over what survived. Names now match exactly or,
  where that fails, on the name reduced to its letters with parentheticals dropped — built only
  where it is unambiguous, because a wrong dimension is worse than a missing one. Anything
  still unmatched is reported by name rather than discarded.
- **zz-core had no LLM endpoint, so the judge refused on its first call.** `LLM_BASE_URL` and
  `LLM_API_KEY` were LibreChat's alone. Found by probing the tool before a flow depended on it
  rather than by fifteen evaluations stopping at stage four.
- **`zz-tool provision` left the person it provisioned unable to run a flow.** Storing their
  token fires LibreChat's `updateUserPlugins`, which tears down their MCP transports; the
  reconnect exhausts its two attempts and LibreChat never rebuilds them. The next agent turn
  makes its first tool call — a lazy reconnect covers exactly one — and then stops, with
  `unfinished: false`, `error: false`, empty text, nothing in the container log and nothing in
  `zz.event`. It reads as a model that gave up. Provisioning now restarts the front end.

### Upgrade notes
- The same restart is needed after `docker compose up -d cred-proxy zz-core`, for the same
  reason, and doing it before a provision does not cover the provision.

## [0.12.2] — 2026-09-05

### Added
- **`eval_skill_judge` — the judge is an MCP tool now, and the invariant is stronger for it.**
  Stage 4 of skill evaluation told the agent to run `judge-stats.mjs` and `zz-tool eval-judge`
  from a terminal. An agent on this platform has MCP tools and no shell, so the stage was
  unperformable by the only thing meant to perform it, and every skill evaluation would have
  stopped there. judge-stats carried a paragraph saying it must never become a tool — what
  that paragraph protects is that THE FLOW'S AGENT IS NOT THE JUDGE, and taking the inputs out
  of the conversation protects it more tightly than a shell prompt did: the tool takes a skill
  name and a version and nothing else, assembles the ruler, the subjects and their text from
  the database and the artifact store, and runs a model pinned by the deployment. Subjects are
  the version's documents where it wrote any and its run traces where it did not, never mixed.
- **`eval_skill_affirm` — the define gate can be closed from inside the flow.**
  `zz.skill_version.rubric_id` is what says "this version is judged by this ruler", and the
  only way to set it before judging was `zz-tool rubric-load --affirm`. So the flow's one gate
  could be reached and not closed.
- **`ZZ_JUDGE_MODEL`**, defaulting to `glm-5.3` — deliberately not `PLATFORM_BASE_MODEL`
  (`glm-5.3-flash`), which is what the flows' own agents run on. Judging with the base model
  would make the ruler exactly as good as the thing being measured.

### Changed
- **The skill-evaluation stages describe the flow they are actually part of.** They had drifted
  from it in every direction: the entry skill said "four stages" of five and listed `profile.md`
  and `scores.md` in a flow that declares neither; locate said it writes `target.md` and profile
  `profile.md`, both folded away; define's `when_to_use` waited on `profile.md`; report called
  itself stage 4 and waited on `scores.md`. Fifteen evaluations were about to be run through
  those instructions, each writing documents the flow does not govern.
- **`zz-skill-judge` had its "a person's judgement" heading twice, on one line** — a
  copy-and-paste the gate's duplicate-line check cannot see, because the duplicate is inside a
  single line.

### Removed
- **The statistics judge that ran from a terminal.** Superseded exactly — same subjects, same prompt, same
  storage — and two implementations of scoring would drift into two answers.

### Upgrade notes
- Scores taken from here name `glm-5.3` in `zz.eval.judge_model`. Every comparison in the
  evaluation queries groups by judge, so earlier `sonnet`-judged scores stay their own group
  and are not averaged with these. That is the mechanism working, not a gap.
- `eval-judge` and `eval-store` remain as the platform team's corpus-research tools. No skill
  names them any more. Document judging now exists in two places — a known overlap to collapse.

## [0.12.1] — 2026-09-05

### Fixed
- **`zz-backbone` told every flow to load a skill that no longer exists.** `blocks-capabilities`
  became ops-select's own reference when it stopped being a skill — a capability sheet is a
  document you consult, not a method you follow — and two SKILL.md files still said
  `skill_view("blocks-capabilities")`. One of them was zz-backbone, which every flow on this
  platform loads first, so every run began with a refused call. zz-backbone now names no sheet
  of its own: there is no flow-agnostic capability sheet to name, and what is flow-agnostic is
  the rule. ops-select points at `references/blocks-capabilities.md` beside it.
- **The console selected `retired` and emitted everything but.** The column was added to the
  skills query and to nothing else, so `casebox-stg-usage` and `zz-learn` were still listed exactly
  like skills that are still served.

### Added
- **A 239th gate check: a `skill_view` a skill spells out must name a skill that exists.** The
  existing citation check matches a backticked name sharing the flow's own skill prefix, which
  is what a citation looks like within a flow and can never be what a cross-family name looks
  like — so the gate was green for as long as the instruction above was wrong.

## [0.12.0] — 2026-09-05

### Changed
- **Every team must now declare its flow on an initiative's first document.** The check that
  refuses an undeclared first document only ran for a team with two or more rows in
  `zz.flow_install` — and a platform flow never gets a row there, because the shelf ships it
  to everyone. So the teams the check excused were the two shapes it went wrong on: a team with
  exactly one install, whose initiative was then governed by the wrong flow from the second
  document onward; and a team with no installs at all, which was never asked anything,
  so every evaluation it runs was governed by nothing — no gate on the one document the flow
  exists to gate. The question is now "which flows can this team RUN", which is its installs
  plus the platform flows that declare documents of their own.

### Fixed
- **The flow was resolved from whichever document the filesystem listed first.** An
  initiative's flow comes from its FIRST document — zz-backbone says so and every comment
  around the resolver repeated it — but the resolver walked the folder in `readdir` order and
  took the first `flow:` it met. On ext4 that order is a hash of the names. In
  `2026-09-05-blockeval-casebox` it was `findings.md surface.md target.md usage.md`: the initiative
  opened with `target.md` declaring `zz-block-eval`, every later write resolved off
  `surface.md` instead, and the report that a block's own team receives was written under the
  wrong flow with no gate on it. Self-reinforcing, too — the platform stamps the flow it
  resolved onto each document, so one wrong fallback becomes a written declaration the next
  write reads back. Documents are now consulted oldest first, which is what "first document"
  meant all along.

- **The console's skills view answered 500 to everyone.** The `retired` column was added to
  the select without being added to the `GROUP BY`, so Postgres refused the statement and the
  whole route failed — not slowly, not with wrong rows, but every time. Caught by the
  release's own `sql-check` against a live schema, which is why it never reached a deployment.

### Added
- **A retired skill says so in the console.** The skills view is "every skill the platform has
  run", so a skill removed from the catalog stays — it owns those runs. `casebox-stg-usage` and
  `zz-learn` were both listed as though still served, with nothing on the row to say otherwise.

### Upgrade notes
- **A client that opens an initiative without `flow:` on its first `write_file` is now
  refused, on every team.** The refusal names the flows that team can run and says to pass
  `flow: "<name>"` as an argument. Nothing existing breaks — a document already carrying the
  field is unaffected — but a caller that relied on the single-install fallback must declare.
- Initiatives written before this release keep whatever flow was stamped into their
  documents. `2026-09-05-blockeval-casebox` in `team-one` was mis-stamped by the bug above and is
  archived rather than repaired.

## [0.11.4] — 2026-09-05

### Fixed
- **An evaluation wrote its report into a delivery team's store.** A `zz-block-eval` run
  filed its report where the caller's active team pointed, which was not the platform's. `issue_pat` says a person
  keeps one token and "picks the team by picking that team's agent" — but an agent carries no
  team to the gateway, which resolves it from `principal.active_team_id`, so picking the
  evaluation agent picked whichever team the person last worked in. Nothing warned, and
  nothing could: writing into a team you belong to is what the platform is for. Both
  evaluation flows now declare the `cred-manage` server and their locate stage switches to
  `zz-platform` first.
- **A gate check had been covering nothing for both evaluation flows.** "No skill references a
  skill that is not shipped" derived its prefix as the flow name minus `-flow`, so for
  `zz-block-eval` it looked for `zz-block-eval-*` while the skills are `zz-block-*`. Seven
  stale citations survived a restructure — an agent loaded `zz-block-defects`, was refused,
  and the gate had been green throughout. The prefix now comes from the flow's own skill
  names, and a citation of any skill shipped anywhere is allowed, so a cross-flow reference
  is not called a defect.
- The block-evaluation entry and locate skills still described the four-stage shape with
  `target.md`, `defects.md` and `handover.md`, all of which were merged away.

## [0.11.3] — 2026-09-05

### Added
- **Six read-only evaluation tools on zz-core** — `eval_skill_profile`, `eval_skill_ruler`,
  `eval_skill_scores`, `eval_block_surface`, `eval_block_usage`, `eval_block_defects`. The
  evaluation stages named programs shipped beside them, and an agent here has MCP tools and
  no shell: a stage that says "run this" was a stage the agent could not perform, so both
  flows were unrunnable by the thing meant to run them.

### Changed
- **The scripts are gone; the tools are the single implementation.** They were briefly both —
  a program beside each skill and a tool — and two copies of a query drift, which for
  evaluation is fatal: a round that counted differently from the last is worse than one that
  did not run. A skill now names the tool.
- **Judging is deliberately NOT a tool** and must not become one. It runs a pinned model
  through the claude CLI, outside the conversation, because a judge an agent can invoke is a
  judge that varies with the agent. It moved to a workspace script beside
  `eval-judge`, which has always been a workspace tool for the same reason.

## [0.11.2] — 2026-09-05

### Fixed
- **The block-evaluation agent could not reach the block it evaluates.** Its manifest declared
  no `tools`, so `render_agent_definition` produced an agent with `zz-core` and nothing else —
  it could read its own skills and never call casebox. Found by rendering the agent rather than by
  reading the manifest.
- **Both evaluation agents' prompts described flows that no longer exist** — "four stages, one
  gate on defects.md" for a flow that is three stages gating findings.md, and "four stages and
  one gate" for one that has five and two. The prompts were written before the structure was
  cut and nothing re-read them.
- **The stage skills told an agent to run a program it has no way to run.** An agent here has
  MCP tools and no shell. Each skill now says plainly that the operator runs the program and
  pastes the output back, which is the division the design wanted anyway: a program produces
  the numbers, a conversation interprets them, and an agent that could run its own collection
  could also vary it.

## [0.11.1] — 2026-09-05

### Fixed
- **The console showed a platform smaller than the one running.** `/api/console/flows`
  filtered out every package with a `kind`, so `zz-access`, `zz-admin`, `zz-flow-builder` and
  both evaluation flows were invisible — five capabilities with skills, versions, runs and
  refusals like anything else. They are listed now, each carrying `platform: true` so the
  distinction reaches the reader instead of being decided for them.
- **`building-a-block` could not be registered at all.** It lives in `blocks/_standard/`, and
  the registrar read `_standard` as a block name; there is no such row in `zz.block`, so
  `block_id` came back null and the constraint refused the insert — silently, because the
  registrar reports what it registered rather than what it could not. A `blocks/_*` directory
  is the platform's, not a block's.
- **`zz-tool` did not offer `register-skills`**, though the tool's own usage line says
  `zz-tool register-skills` and the README lists it as a day-2 op. `refresh-block-tools` and
  `ladder-close` were missing the same way. A deploy host has no toolchain, so a tool absent
  from that map cannot be run where it matters.

### Known
- `register-skills` still cannot run through `zz-tool` on a host: it reaches the database by
  shelling to `psql`, the runtime image carries no `psql`, and the wrapper mounts no docker
  socket by design. It runs from a checkout whose catalog matches the deployed image — which
  is verifiable and was verified — but the tool and its own documentation disagree until it
  learns to connect with `PLATFORM_DB_URL` directly.

## [0.11.0] — 2026-09-05

### Added
- **Two evaluation flows**, both platform capabilities. `zz-skill-eval` measures how well a
  skill works: locate → profile → define (gate) → judge → report (gate). `zz-block-eval`
  measures a building block's MCP surface: locate → measure → report (gate). Between them
  they answer the two questions the platform could not: is this skill any good, and is this
  block any good to use.
- **Seven scripts, each beside the stage that owns it** — the first use of the `script` asset
  kind `register-skills` has supported since the beginning. `profile.mjs`, `ruler.mjs`,
  the statistics judge, `scores.mjs` for skills; `surface.mjs`, `usage.mjs`, `defects.mjs` for
  blocks. The queries live in the programs so two rounds cannot count differently.
- **Non-document skills can be judged at all.** The run trace is the document: one run per
  subject, its ordered events as the text, every score citing specific events. Five of
  forty-six skills write a gated document; the rest were previously unjudgeable, including
  `ops-build`, which has the largest surface on the platform.
- `eval-record` stores a judgement from any judge, with the judge named; `rubric-load
  --affirm` records that a version is judged by a ruler, which the evaluation gate decides
  and only `eval-store` could previously write.
- `building-a-block`: the building-block contract as an authoring skill, with R1–R14 as its
  reference.

### Changed
- **`zz-learn` is now `zz-knowledge`, a universal platform skill run at the end of every
  flow** — the bookend to `zz-backbone`. It mints knowledge nodes directly; `learnings.md` is
  gone. The closing handover now checks that the initiative left something in the knowledge
  base rather than that a file exists, because the promotion step it used to rely on never
  ran once in any initiative.
- `zz-evolve` → `zz-skill-evolve`, `zz-distil` → `zz-block-evolve`, named for the flows they
  consume. `blocks-capabilities` moved to `ops-select`'s references.
- Two platform rules moved into `zz-backbone` from the skill that held them: what a team
  overlay may and may not do, and the tag kinds the knowledge base enforces.

### Removed
- **The OKR mechanism entirely** — `okr_set`, `okr_grade`, the `serves_okr` field and the
  `zz-okr` skill. Zero calls, ever, and an empty directory.
- `zz-kb-usage` and `zz-journal`, neither ever loaded once. `journal_add` and the OKR
  directory were separate things: the tool is renamed, not removed.

### Fixed
- `register-skills` enumerated one hard-coded flow, so 22 of 46 skills were never registered:
  every sdlc skill, casebox-assist, zz-access, zz-flow-builder. All installable, all reachable over
  MCP, none scoreable.
- `snapshotOnApproval` wrote `_versions/*.md` and indexed nothing, so every frozen approval
  copy was invisible to the console until a restart swept the directory.
- `indexDoc` threw on a document that states the same acceptance criterion twice — ordinary
  writing — and its catch left `zz.doc` silently stale.
- A retired skill is kept, not deleted: `zz.run` attributes documents to its versions.

### Upgrade notes
- **`journal_add` and `journal_supersede` are now `knowledge_add` and `knowledge_supersede`.**
  Any client naming the old ones must `claude plugin update <name>@zz-platform`.
- **`okr_set` and `okr_grade` are gone.** Nothing called them; if anything does, it will now
  be refused.
- The `zz-learn` flow no longer exists. `zz-knowledge` is a platform skill every flow ends
  with, so nothing installs it.
- Migrations 027–030 apply on the gateway's next start: skills retire rather than delete,
  scores hold half points, an eval subject may be a run rather than a document, and
  `skill_version.body_hash` says whether a version's text actually changed.

## [0.10.0] — 2026-09-04

### Added

- **A skill can be read in the browser, and so can what ships beside it.** The console could
  say ops-intent scored what it scored and never show a line of what ops-intent asks for. Every skill —
  a flow's steps, a flow's own front door, a block's published method — now serves its text
  and its reference material, at `/flows/<flow>/skills/<skill>` and
  `/blocks/<block>/skills/<skill>`.

- **`skill_view` takes an optional `file`.** A skill may ship long reference material beside
  its SKILL.md, as the Agent Skills standard intends; until now `skill_view` served SKILL.md
  and nothing else, and block skills are packaged into no plugin at all — so that material
  was reachable by nobody. `skill_view(name: "using-casebox", file:
  "references/casebox-staging-notes.md")` reads it. The path is refused if it leaves the skill's
  own directory.

- **Every document now knows which skill version wrote it.** Derived, not stored: from the
  run that produced it, then from the eval that judged it, then from the version in force
  when it was created. ops-intent went from 30 attributable documents of 81 to all 81. The
  scores view filters on it, so "how is 1.1 doing" no longer averages 1.0's work into the
  answer.

- **Every document a skill produced, scored or not.** A mean over the documents a judge
  happened to read is a mean over an undisclosed sample. `/skills/<name>/scores` lists the
  whole set — ops-intent has 81 intent.md documents and 30 have ever been judged.

- **The console reads flows and blocks as separate things**, each with its skills. A flow is
  an agent method that runs against blocks; a block is something reached over MCP carrying
  its team's own skills. `/api/console/flows` and a reworked `/api/console/blocks`.

### Changed

- **`casebox-stg-usage` is no longer a skill.** It was written when the block published no usage skill of its own
  and said so in its own frontmatter. That is no longer the case. Its content is
  now `using-casebox/references/casebox-staging-notes.md` — reference material beside the
  block's own skill rather than a second skill competing to be read first. Twelve of its
  thirteen claims are made nowhere in the official skills, so nothing was discarded.

- **CaseBox Assist is a flow with one skill and no hand-written system prompt.** The generated
  router prompt now reads the manifest: a flow that gates no document is not told that a
  gate must be recorded, or that the platform writes frontmatter onto documents it never
  produces. Every future assistant flow gets a correct prompt without writing one.

- **`zz-flow-builder` is a platform capability, not a flow.** It creates flows; it is not
  one, and it was appearing in both places at once.

- **The required `zz` plugin carries the platform's own skills.** It shipped the generated
  router and nothing else, so `/skills` — zz-backbone among them — was installable by
  nobody.

- **A skill belongs to a flow or to a block, and nothing else.** `zz.skill.kind` no longer
  allows `common`; the platform is recorded as a block and its own skills belong to it.

### Fixed

- **`register-skills` would have been refused by the database.** Migration 024 stopped
  allowing `kind = 'common'` while the registrar still wrote it — the next registration
  would have failed on every skill in the tree. It writes `block_usage` on the platform
  block now.

- **Two check constraints on `zz.skill.kind` disagreed.** One permitted `common`, the other
  refused every row using it. Migration 026 drops the redundant one.

- **`skill_version.released_at` recorded when rows were imported, not when versions began** —
  a column that reads as a release date and holds an import date. It carries the catalog's
  own history now, and `register-skills` names it on insert so a version registered tomorrow
  records when it actually arrived.

- **A document's `updated_at` came from the envelope, not from indexing time**, and a
  document is no longer re-versioned by a formatting change: a new version needs a content
  change.

### Upgrade notes

- **Four migrations apply on the gateway's next start** — 023 (`zz.doc.supports`), 024
  (`zz.block.origin`, the platform block, `common` retired), 025 (version release dates),
  026 (the redundant constraint). All additive except 024's constraint tightening, which
  runs after moving the rows it would otherwise refuse.

- **After upgrading, run `register-skills`** if this deployment has never had its skills
  registered. Production had zero rows in `zz.skill` and `zz.skill_version` despite 1,167
  recorded calls, so nothing there could be attributed to a skill or a version.

- **`skill_view(name: "casebox-stg-usage")` now refuses.** Anything relying on it should read
  `using-casebox` and follow it to the reference.

- **CaseBox Assist's browser agent must be re-rendered** (`render_agent_definition`) to pick up
  the generated prompt in place of the removed hand-written one.

- **`ZZ_SKILLS_DIR`** is new and optional; it defaults to `/skills`, which is correct inside
  the image. It exists so a checkout can point the packaging code at its own `skills/`.

## [0.9.0] — 2026-09-04

### Added

- **An admin console.** A separate browser app showing every team's work in one place:
  initiatives and where each sits in the flow, the knowledge base with each node's full text,
  what every skill costs to run and how it scores, how each building block actually refuses,
  the event log, and who holds which access. It reads a new `/api/console/*` on the gateway —
  eleven GET-only endpoints — and is served from its own repository, `zz-stack-dashboard`.
- **Sign in to the console with corporate directory.** SsoAuth is a third identity adapter beside the PAT
  and the forwarded header, which is the shape `identity.ts` already described. The gateway
  owns the OIDC exchange, not the dashboard: whoever completes it has to convince the platform
  afterwards, and the only ways to do that are to forward a credential or to be trusted on
  assertion. Anyone in the directory may sign in and read the console, and a person the
  platform has never seen becomes a `member` on their first sign-in.

### Changed

- **Knowledge belongs to the platform, not to the team that happened to learn it.** A lesson
  like "a success response is never evidence" is true for every team, and it was being filed in
  the store of the one that hit it — so the next team to hit the same wall could not find it,
  and each team numbered its own journal from 0001, which made two teams both have a node 1.
  `knowledge_add` and `knowledge_supersede` now write to `zz-platform`; `search_knowledge` reads the
  caller's team AND that shelf, so nothing a team could find before has become unfindable.
  Documents, initiatives and OKRs stay with their team.

### Fixed

- **The turn collector had not run since 0.4.0.** Its defaults were `docker compose exec`, from
  when these tools were host Python; they run inside the image now, on the compose network,
  deliberately without the docker socket — so every hourly run died on `spawnSync docker
  ENOENT` into a log nobody reads. The only visible symptom was that turns stopped being
  collected, which looks exactly like a quiet platform. It reaches both stores by service name
  now, and both flags still accept a command for off-host use.
- **A document's date was the moment it was last indexed, not the moment it changed.** A
  reindex touches every file it re-derives, so one rebuild restamped every document on a
  deployment to the same afternoon and the whole corpus claimed to have been written at once.
  The envelope carries the date and the platform stamps it itself, so it is now read from
  there — including a knowledge node's `date`, which is the field `knowledge_add` writes.
- **`zz.decision.doc_id` was never written.** The column existed and was indexed, and was null
  on 836 of 941 rows, so every join from an acceptance criterion back to the spec that stated
  it had to go through three text columns. The index deletes and re-inserts a document's claims
  on every rebuild, so a backfill could not hold either.

### Upgrade notes

- **A migration runs on the gateway's next start** — `022_console_session.sql`, two new tables
  for the browser session and the half-finished sign-in. Additive; nothing existing changes.
- **The console needs four new variables on the gateway**, and is off without them:
  `SSOAUTH_ISSUER`, `SSOAUTH_CLIENT_ID`, `SSOAUTH_CLIENT_SECRET`, `CONSOLE_PUBLIC_URL`.
  `/auth/login` answers 503 and names what is missing rather than redirecting anybody into a
  half-configured exchange. **SsoAuth must also register `${CONSOLE_PUBLIC_URL}/auth/callback`**
  as a redirect URI — matched byte for byte at their end.
- **The console app itself is a separate deployment.** It is not in this compose file and not
  in the release bundle: `zz-stack-dashboard` builds its own container, binds to loopback, and
  Caddy splits one host on path — `/auth/*` and `/api/console/*` to the gateway, everything
  else to the app. Same origin, so the session cookie is first-party.
- **Existing knowledge nodes stay where they are until moved.** Search reads both shelves so
  nothing is lost, but a deployment that wants one journal has to relocate the files to
  `zz-platform` and reindex. Both of ours have been done.
- **Re-run `deploy/install-backup-cron.sh` on every host.** A crontab written before 0.4.0
  still names `collect-turns.py`, which no longer exists — the installer in this repo has been
  right for some time and simply had not been run again.

## [0.8.2] — 2026-09-03

### Added

- **Sign in with an organisation identity.** The deployment can now put SsoAuth (or any OIDC
  provider) beside the password box: `ALLOW_SOCIAL_LOGIN`, `OPENID_ISSUER`, `OPENID_CLIENT_ID`,
  `OPENID_CLIENT_SECRET`, `OPENID_SESSION_SECRET`, `OPENID_SCOPE`, `OPENID_CALLBACK_URL`,
  `OPENID_BUTTON_LABEL`, the two claim names, and `DOMAIN_CLIENT` / `DOMAIN_SERVER`. Off unless
  configured, and `ALLOW_EMAIL_LOGIN` stays true — an identity provider that is down, or a
  tenant that has not been given your account yet, must not be the only way in.
- **Every one of them is documented with the symptom it produces when wrong**, because four of
  the five failures on the way to a working login named neither the setting nor the value:
  a missing `ALLOW_SOCIAL_LOGIN` reports `Unknown authentication strategy "openid"`; a missing
  `OPENID_SESSION_SECRET` registers no strategy and says nothing at all; a missing
  `DOMAIN_SERVER` fails with `Invalid URL` AFTER logging that OpenID configured successfully;
  and `OPENID_CALLBACK_URL` must be the PATH, because LibreChat joins it to `DOMAIN_SERVER` and
  a full url is sent to the provider doubled.

## [0.8.1] — 2026-09-03

### Fixed

- **The delegated-access harness claimed to test refresh and no longer did.** It waits 75 seconds
  to cross the gateway's one-minute renewal threshold, which worked while the mock blocks issued
  120-second tokens. Raising them to a realistic twelve hours (zz-blocks 0.3.4, the same day)
  left the wait crossing nothing: the check re-read a stored token and reported a renewal. It now
  reads the lifetime off the callback and either tests refresh or prints UNTESTED with the reason
  and the fix — start the block with `OAUTH_ACCESS_TTL=120`. A passing check that proves nothing
  is worse than a missing one, because it is counted.

## [0.8.0] — 2026-09-03

### Added

- **`CaseBox Assist`, an agent for working INSIDE CaseBox** — vendored under catalog/casebox,
  and since removed with the rest of the third-party blocks. It
  carries casebox and RuleMill, and a block team's own field guides: operating the block's tools,
  writing its case queries, its scripts, and its `{{template}}` strings. Vendored from the
  CaseBox plugin, so the block team owns the content; the version and `when_to_use` lines are
  ours, because this platform requires them.
- It is deliberately not a delivery flow: no gates, no documents, no approvals. Its prompt says
  so and routes anyone who wants something BUILT to the Operations Agent, because a build with no
  spec and no gate is the thing the gates exist to prevent.
- The four guides are the ones that would have saved most of the evening this package came out
  of: a round-robin switch is a *script*, an assignment email is a *template*, and a
  day-before reminder's filter is a *case query* — three refusals that each cost a round.

## [0.7.3] — 2026-09-03

### Fixed

- **An agent probed with `credential_required` and stopped a build over the answer** —
  `zz-backbone` 3.2 → 3.3. That stub exists only while a block is unreachable, so on a working
  block it answers `Unknown tool`. An agent called it on two blocks it was correctly connected
  to, read the refusal as being locked out, and halted a build with all three gates recorded and
  nothing wrong. The wording invited it: the skill said the block "tells you itself" and that
  calling the stub returns a link, without saying that the stub is absent when things work.
- The rule now: find out by USING the block. Call the tool the work needs; if it answers, you
  were connected and there was no question. The tool LIST is not the signal either — every agent
  carries that stub for every block regardless — only what a real call returns is.

## [0.7.2] — 2026-09-02

### Changed

- **An agent identifies its initiative once per conversation and holds on to it** — `zz-backbone`
  3.1 → 3.2. It was re-deriving which initiative it was in on every turn, reading other people's
  half-finished drafts to place an answer it already had the context for. A team's store holds
  the whole team's work, so that derivation gets slower and less certain as the team does more —
  and the person watches a one-line answer turn into an investigation. Read the store again when
  something says the ground moved, not as a habit.

## [0.7.1] — 2026-09-02

### Changed

- **"approve" means the document this conversation just wrote** — `zz-backbone` 3.0 → 3.1. Asked
  to approve, an agent read four other initiatives out of the store and asked which gate was
  meant, having written the document itself one turn earlier. The store holds everybody's work
  and most of it is not the person's to approve, so the enumeration turns a one-word answer into
  a puzzle about other people's drafts. Ask only where this conversation genuinely has two gates
  open, which is rare.

## [0.7.0] — 2026-09-02

Carries **zz-blocks 0.3.3**, unchanged.

**A block is checked when something needs it, and never before.** 0.6.2 put a check at the front
of every flow: before stage one, name every block you cannot reach and send the person to connect
them. That was the wrong shape and got worse the more blocks a platform had. A flow does not know
which blocks it needs until it has worked out what it is building, so the check asked people to
connect things the work would never touch — and on a platform with dozens of blocks it is a wall
in front of the door rather than a helpful warning.

### Changed

- **`zz-backbone` 2.2 → 3.0: the pre-flight is gone.** In its place, the two needs a flow actually
  has, which arise at different moments and only one of which involves connecting anything.
  Choosing a block is a CAPABILITY question — what is it for — and needs no connection. Using one
  needs a connection, and the block says so itself: one you cannot reach offers a single tool,
  `credential_required`, which answers with a sign-in link. There is nothing to probe. Reaching
  for the block is the check.
- **Confirm reachability when a flow WRITES DOWN that it will use a block** — not at the first
  call, by which point the work is planned around it. Every flow has that moment because every
  flow records its decisions; what the document is called is the flow's business.
- **`ops-select` narrows on the capability sheet before opening any server**, then profiles the
  one or two candidates that survive. It used to profile every connected block from its tool
  surface, which costs a hundred tools each and still leaves the judgement undone.
- **`ops-plan` is where reachability is confirmed**, for the blocks `selection.md` names and no
  others. A person who needs one block signs in to one block.

### Added

- **`blocks-capabilities`, a platform skill: what each building block is FOR.** The prose existed
  — fit, poor fit, honest limits — and only the EVALUATION read it. So the judge knew casebox runs its
  own workflow engine and that adding RuleMill is the expensive mistake, while the agent being graded
  was told to work it out from verb names. The two now read the same sheet.
- **A gate check that every block in the registry has a section in it**, because a block nobody
  can read about is a block chosen by guesswork — and the fallback is the tool-surface trawl this
  release removes. 238 checks.

## [0.6.11] — 2026-09-02

### Fixed

- **`zz-access` told people to store a key with a tool that has never existed.** The name was
  `set_credential`; the tools are `set_my_credential` and `set_team_credential`. An agent
  following that hunts for a tool the platform does not have, then reaches for a block's tool
  whose name is close, then reports that the platform cannot do the thing — which is the entire
  failure this release series has been chasing, with a documentation typo at the bottom of it.
- **`zz-backbone` named `close_record` as its example of a block tool that reads like a gate.** No
  block publishes it; it was invented to make a point. An example that does not exist is a name
  an agent may go looking for. The examples are bookit's real `approve_slot` and
  `reject_slot` now — 2.1 → 2.2.

### Added

- **A gate check: no skill may name a platform tool that does not exist.** It reads the
  registrations from zz-core, the gateway and admin, and refuses a release where a skill names
  something in the platform's own namespace that nothing serves. Deliberately narrow — block
  tools like `read_api_spec` are the contract's, not ours, and a check that cries wolf earns an
  exception list and then gets ignored. 237 checks.
- Audited every tool name in every skill against the live servers: 47 tools, each confirmed
  present and attributed to the server that serves it; 18 frontmatter fields correctly not tools.

## [0.6.10] — 2026-09-02

### Changed

- **The skills say which SERVER a tool comes from, not how a client spells it** — `zz-backbone`
  2.0 → 2.1. 2.0 gave the roster and then taught two client spellings alongside it, which is a
  detail that differs per client and is worth nobody's memory. The rule is simpler and holds
  everywhere: every tool a skill names is *zz-core's* tool of that name — read `approve(path)` as
  zz-core's `approve` — and you find it by server, never by verb. Where two tools share a verb,
  the one from a block is never the one a skill meant.

## [0.6.9] — 2026-09-02

### Added

- **`zz-backbone` 2.0 carries the platform's whole tool roster — all twenty-one, by name.**
  Whenever any skill names a tool without saying where it lives, it means the one on that list;
  anything not on it belongs to a building block, whatever it is called. The test is where a
  tool comes from, never what the verb sounds like: `approve` is a gate and `approve_slot` is
  a booking, `close` ends an initiative and `close_record` ends somebody's case.
- **A gate check holds the roster true.** It reads zz-core's own `registerTool` calls and refuses
  a release where the two disagree. A hand-written list is exactly the thing that stops being
  true, and this one is load-bearing — a tool added to zz-core and not to the skill is a tool the
  next agent is told does not belong to us.

### Changed

- The roster is stated client-agnostically, because the spelling differs and the spelling is
  where the answer is: `approve_mcp_zz-core` in the browser, `mcp__plugin_zz_zz-core__approve` in
  Claude Code. The verb is identical everywhere and is not what decides. `zz-core` is.

## [0.6.8] — 2026-09-02

### Changed

- **The skills now name the exact tool, not the idea of it** — `zz-backbone` 1.8 → 1.9. The
  skill said call `approve(path)`; what an agent actually holds is `approve_mcp_zz-core`, and it
  had to map one to the other with `approve_booking_mcp_bookit` sitting beside it. It made
  that mapping wrong four times in one session. The rule is now the suffix: the platform's tools
  are the ones served by `zz-core`, the part that decides is `zz-core` and never the verb, and
  `approve` and `close` are named in both spellings wherever the skill instructs them.

## [0.6.7] — 2026-09-02

### Changed

- **An agent is provisioned complete again, in one pass.** 0.6.6 gave a block's tools only to
  someone who could already reach it, so an agent provisioned before its owner signed in to
  anything held `credential_required` and nothing else for every block — permanently, until
  somebody remembered to provision a second time. Provisioning happens once, before anyone has
  connected anything, so that second run is the one nobody does.
- **The failure 0.6.6 was reacting to has a different cause and a different fix.** An agent
  holding 146 tools twice failed to find `approve`, wrote out a tool list it half-remembered,
  and told the person the platform could not do the thing it was holding a tool for. Length made
  that easier; it is not what made it possible. `zz-backbone` 1.8 is the fix — if a tool looks
  missing, CALL IT, because the call is the test and an agent's memory of its own tools is not.
  Verified since on a 146-tool agent: it calls `approve` directly, with no deliberation about
  whether it exists.

## [0.6.6] — 2026-09-02

### Fixed

- **An agent carried 146 tools when 21 of them could work, and lost the platform's own among
  them.** 0.6.2 filled an unconnected block's tools in from the operator's view, so that an
  agent would be complete before the person connected anything. It made every unconnected
  block's entire surface part of their context — 125 tools that answer `credential_required` to
  every call. The cost was not tokens: asked to record a gate, the agent wrote out a tool list it
  half-remembered, dropped `approve`, `close` and `reconcile` — the three platform tools a
  delivery agent touches least — and told the person the platform could not do the thing it was
  holding a tool for. Twice, in two conversations, with the tool present at every layer.
- **A block now contributes its tools when the person can reach it, and its stub when they
  cannot.** The same agent, re-provisioned, carries 24 tools and records a gate without ever
  asking itself whether `approve` exists — measured by driving it, not inferred. Connecting a
  block changes what its owner's agent should hold, so re-run `provision` afterwards; it updates
  in place rather than duplicating.

## [0.6.5] — 2026-09-02

### Changed

- **`zz-backbone` 1.7 → 1.8: if a tool looks missing, call it.** An agent cannot reliably
  enumerate its own tools — asked to list its zz-core tools, one named eighteen of twenty-one
  twice, dropping `approve`, `close` and `reconcile`, the three it uses least, while all three
  were being delivered to it. A call to a tool that is genuinely absent fails instantly and costs
  nothing; deciding it is absent without calling costs the person their session.
- **Never write "the platform lacks X" into the knowledge base.** The next agent reads it,
  expects the tool to be missing, half-looks, and finds its own expectation confirmed. That
  happened on this deployment: the note was manufacturing the failure it described.
- **A conversation that has concluded something false does not recover.** Every later turn
  reasons from it, including the turns that re-check. The skill now says to name the thread as
  unreliable and ask for a new one, rather than argue with its own transcript. Measured, not
  assumed: the same agent on the same account with the same tools does the work correctly in a
  fresh conversation.

## [0.6.4] — 2026-09-02

### Fixed

- **An agent told a person the platform had no approve action, while `approve` sat in its own
  tool list.** It reached for `approve_slot` on an unrelated block to record a stage gate, was
  refused, concluded the gate did not exist, and sent them to a web view to do something it could
  have done itself. The cause is in this repository, not in the model: `zz-backbone` enumerates
  which tools are the PLATFORM's — the artifact store, the knowledge store, the skills library —
  and that list never included `approve` or `close`, the two most consequential of them. An agent
  holding 146 tools and looking for "approve" had nothing telling it which one was the gate.
  The list now names them, says plainly that a block tool reading like a gate is never one, and
  says not to claim a platform tool is missing without saying what was looked for.
- `zz-backbone` 1.6 → 1.7.

## [0.6.3] — 2026-09-02

### Changed

- **A block you cannot reach now hands you the way in, instead of directions to it.** Calling
  `credential_required` answers with a single-use consent link for that block, prefilled with the
  caller's own address. The person opens it, approves, and carries on in the same conversation.
  It used to say "open the ZZ Access agent and run `connect_block`" — a correct sentence that
  costs someone their place: they leave the flow, do a thing elsewhere, and come back to explain
  where they were.
- **This does not move credentials out of ZZ Access.** A consent URL is not a secret: single-use,
  ten minutes, and the token it leads to is delivered to the gateway and never appears in the
  transcript. A key is the opposite on all three counts, and keys still belong to ZZ Access
  alone — which is what the same answer says when a block has no authorization server.
- `zz-backbone` 1.5 → 1.6 to match: the pre-flight check calls the tool and hands over the link
  rather than routing the person to another agent.

## [0.6.2] — 2026-09-02

### Fixed

- **A new person got no delivery agent at all.** Provisioning refused to build one when a block
  was out of that person's reach, which is the wrong half of a real problem. The problem is that
  an agent's tool list is a fixed set of ids: built from one person's view while a block is
  unreachable, it bakes in `credential_required_mcp_<block>` and nothing else, and stays that way
  after they connect. Refusing avoided the broken agent by leaving them with nothing, and nothing
  said which it was. The list describes the FLOW, not one person's access, so it is now read with
  the operator's token — two people on the same flow get the same agent, whatever either has
  connected today.

### Changed

- **Every flow checks its blocks before its first stage** — `zz-backbone` 1.4 → 1.5. A block you
  cannot reach offers one tool, `credential_required`, and every agent now carries that tool for
  every block it uses, so the check is reading its own tool list rather than probing a block and
  spending a turn to be refused. Unreachable blocks are named to the person up front, with
  `connect_block` as the fix, and the flow stops there. It used to find out at the step that
  needed the block, which wastes every step before it and leaves a half-built initiative that
  somebody else has to decide what to do with.
- The rule lives in the backbone, not in each agent's prompt: every flow loads that skill first,
  so flows written after this one inherit it. The generated prompt gained one line only — that
  signing in as yourself is better than storing a key, which it had never said.

## [0.6.1] — 2026-09-02

Carries **zz-blocks 0.3.3**.

**0.6.0 is not a version anybody has.** It was deployed, failed verification and was rolled
back inside a minute; its number is not reused because an image carrying it exists in the
registry. What it left behind on the host it touched is two migrations, `013_doc_created_at`
and `014_event_columns`, which applied before the chain stopped. Both are additive, so the
rolled-back 0.5.0 ran against them without noticing.

What stopped it is the whole reason this entry is worth reading: `015_doc_decision` closes the
`status` and `outcome` vocabularies, and six documents from real delivery rounds carried values
those sets do not have. It applied to an empty database and to UAT and refused production —
a migration that only works where there is no data is not a migration. It now normalises
first, and the two rows whose wording the vocabulary cannot hold keep that wording in `tags`
rather than losing it.

**A person can now sign in to a building block as themselves.** Until this release every
person's call reached a block as one shared API key: the block could not tell who asked, and
the key could do far more than any individual needed. A block that supports OAuth now sees
whoever actually asked, with only the permissions that person granted. Proven end to end
against a block that implements the consent flow, not only against a mock that accepts
anything.

### Added

- **Delegated block access.** `connect_block` on `/manage` returns a consent link; the person
  approves at the block; the gateway stores their token against their principal and attaches
  it to every later call to that block. Refresh happens without them. A block nobody has
  connected keeps working on the stored key, so this is additive for every existing setup.
- **The ZZ Access agent now exists.** It never has before, on any deployment — see *Fixed*.
  One agent owns credentials: platform tokens, block API keys, and `connect_block`. Delivery
  agents need no credential tools, because the gateway resolves a person's credentials from
  who they are rather than from which agent asked.
- **`CASEBOX_OAUTH_SCOPE`, `BOOKIT_OAUTH_SCOPE`, `RULEMILL_OAUTH_SCOPE`** — what to ask a block's
  authorization server for. Unset means ask for whatever the block's own protected-resource
  document advertises, which is right for a block that publishes its whole list. Not every
  block does: a resource document can name one scope while the client also needs
  `offline_access`, and without that no refresh token is issued.
- **A judge that scores substance rather than shape**, with the controls that show it does: a
  scrambled control scoring each document against a neighbour's requirement caught every one,
  and the noise floor was measured rather than assumed. Differences under it are
  reported UNTESTED, a third verdict added because "not significant" was being read as "no
  difference".
- **`/architecture`** — the design as one self-contained page, served unauthenticated.

### Changed

- **The telemetry grain.** `detail.run` was never a run; it was a caller session, and one value
  carried eight steps of a single initiative, so every per-step number was really a
  per-conversation number wearing a step's name. It is `caller_session`, and the grain is
  (initiative, skill_version, caller_session).
- **LibreChat's completion budget, 32,768 → 131,072**, the provider's actual ceiling. The model
  reasons before it writes, and a budget that truncates a reasoning model does not shorten its
  answer — it deletes it, returning empty content with no error.
- **The `zz-access` package names its MCP server `cred-manage`**, which is what clients call it.

### Fixed

- **The ZZ Access agent could never be created.** The catalog called that server `zz-access`
  and every client calls it `cred-manage`; the provisioner looks up tools by name, found none,
  and refused — down its silent path. The agent the door index calls "the one place access is
  managed" has been unbuildable on every deployment.
- **A delegated call reported itself as the shared key.** fastmcp's `get_http_headers()` strips
  `authorization` by default. The person's token was sent, arrived, and was never read.
- **Endpoint discovery cached for the life of the process**, so a block that gained a
  `userinfo_endpoint` stayed invisible and the platform went on storing blank identities.
- **`reconcile` had been failing silently** with `column "surface" does not exist` for a day
  and a half.
- **`psqlRows` cannot run `INSERT…RETURNING`** — it wraps its argument as a subquery, which
  Postgres forbids for a data-modifying CTE. A load wrote thirty subjects and zero scores and
  reported success.

### Upgrade notes

- **Ten migrations apply on the gateway's first start** (`013`–`021`), against a live database.
  They are additive. `021_delegated_tokens` creates the table `connect_block` writes to;
  without it that tool cannot store anything.
- **Delegated access needs configuration per block** — client id and secret, and for our own
  mocks an issuer and redirect URI list. A deployment that sets none keeps using stored API
  keys exactly as before; nothing breaks by leaving this alone.
- **Each block's OAuth endpoints must be reachable publicly** — `authorize`, `token`,
  `.well-known/`, `userinfo`. The person's browser goes to them; `/mcp` stays private.
- **Anything reading `detail.run` reads nothing** — it is `caller_session` now.
- **`ZZ Access` is provisioned per person**, like any other agent.
- **Installed clients need `claude plugin update <name>@zz-platform`** to pick up the skill
  changes in this release.

## [0.5.0] — 2026-08-30

Carries **zz-blocks 0.3.2**, unchanged.

**A release that reads the repository rather than trusting it.** Every file in this
repository was read line by line — 152 files, 46,208 lines — and what that found is below.
The pattern in most of it is one thing: a rule stated in one place and applied in another,
where the two had drifted and nothing could see it. Four of the defects were in the gate
itself, which is the part that is supposed to see.

### Added
- **`sql-check` — every query in this repository, PREPAREd against a real Postgres.** 0.4.0
  shipped a `SELECT DISTINCT` ordered by a column it did not project: error 42P10, raised at
  PARSE time, so `/pkg` answered 500 to every caller on all three clients and nobody could
  install or refresh a client package. Nothing offline could have found it — the gate does not
  run SQL, the type system sees a template literal, and the smoke suite starts each service
  and checks it is alive, which that service was. It runs in every release AND every dry run
  against a throwaway Postgres the real gateway has migrated, so an empty-database migration
  run is now exercised on every release too. Six queries build part of their text at runtime
  and are reported as not checkable, every run, with the reason.
- **`check:identity` — five cases against the real adapter walk.** `resolveThrough` carried
  the sentence "exported so the ORDERING can be tested, because the property that matters is
  not visible by reading", and nothing tested it. The property is an authentication bypass: a
  refusing door that fell through would let the forwarded-header adapter answer for a REVOKED
  PAT, turning a revoked token into an unauthenticated header claim. The bug is a missing
  early return, and the code reads identically with and without it.
- **The deploy bundle carries the backup scripts.** `deploy/README.md`'s Day-2 section opens
  "Every command below runs from `deploy/`, which is what the release bundle unpacks to" and
  then tells an operator to run `backup.sh` and `install-backup-cron.sh`. Neither shipped — so
  the no-repository install path this bundle exists to serve had no way to back the platform
  up, and nothing said so.

### Changed
- **Breaking — the deploy bundle contains seven files, not five.** `backup.sh` and
  `install-backup-cron.sh` join the compose file, `.env.example`, `librechat.yaml`,
  `issue-first-pat.sh` and `zz-tool`. Anything scripted against the old contents sees two more.
- **`install-backup-cron.sh` derives `REPO` from its own location.** It defaulted to the
  literal `/root/zz-parent/zz-stack`, which is right for the host a release deploys to and
  wrong for anyone who unpacks the bundle anywhere else: three cron lines pointing at a
  directory that does not exist on their machine, installed successfully, reporting three
  tagged jobs. The deploy host resolves to the identical path.
- **`scripts/build-image.sh` builds for the deploy host, not for the machine running it.**
  It pinned no `--platform` while `release.mjs` pins `linux/amd64`, so on an Apple Silicon
  laptop it produced an arm64 image under the release's own tag — which cannot run on the
  x86_64 host, and says so only when a container fails to start. `ZZ_PLATFORM` overrides both.
- **The image installs from the manifests, then copies the source.** The Dockerfile's own
  comment said "Manifests first, so a change to source does not invalidate the install layer"
  directly above a wholesale copy of `packages/` and `services/`. Every source edit reinstalled
  the entire dependency tree to compile one changed line; `npm ci` now stays cached.
- **`set-version.mjs` moves the lockfile too.** `package-lock.json` records a version nine
  times and the script moved none of them, so every manifest said 0.4.1 while the lockfile
  said 0.4.0 — the release that was rolled back and spent. `npm ci` tolerates the mismatch, so
  nothing said anything: exactly the invisible half-done that script's first paragraph argues
  against.

### Fixed
- **A failed backup left a file that reads as a backup.** `cmd > "$db_file"` creates the file
  before the command runs, and both container tars write straight to their final names — so
  any failure under `set -e` left files stamped with today's date in `$BACKUP_DIR`, sorting
  NEWEST. That is not hypothetical: the script's own header records four nights of 20-byte
  dumps left behind by exactly this path, and those files were what "restore the latest
  backup" would have found. A cleanup trap armed before the first write removes a partial set,
  and the set is released only once every archive has been read back.
- **Two documents described a backup that protects half of what it does.** `deploy/README.md`
  and STATE.md both said "the platform database and the artifacts volume", omitting the
  credential volume — which `backup.sh` calls the one thing nobody can reconstruct — and
  LibreChat's Mongo.
- **`COMPOSE_PROJECT_NAME` was undocumented, and it decides what every volume is named.**
  `backup.sh` reads it out of `deploy/.env`, and it was the one name read that way that
  `.env.example` did not offer — in a file whose first line calls itself "the whole
  configuration surface". Its absence is the shape of the four nights above.
- **The release's migration probe typed the database's role and name.** `release.mjs` addressed
  the container as a compose SERVICE, with a paragraph explaining why a literal was wrong, and
  then passed `-U zz -d zz` two lines below it. `POSTGRES_USER` and `POSTGRES_DB` are settable
  and `.env.example` documents them as such; on a deployment that sets either, that probe fails
  — and it is step 5, which rolls the release back. A good version undone by a name the script
  guessed. The smoke-store reset script, removed with the smoke suite, had the same pair.
- **The block standard understated its own battery.** §6 of
  `docs/release/building-block-contract.md` said the conformance run settles eight requirements
  and it settles nine: R10 is scored, and two paragraphs below the same section cites R10 as
  something the measurement found. A requirement the standard calls unmeasured is one no block
  team expects a verdict on.
- **Four defects in the gate itself.** Its own prose was keeping dead exports alive — the
  dead-export check scans `scripts/*.mjs` as consumers, and gate.mjs discusses nearly every
  export in this repository by name, so "is this symbol used anywhere else" was answered by a
  paragraph ABOUT it. The write-only-column rule stated a general law and implemented one
  instance with two hardcoded readers, and generalising it found four readers where the list
  named two. Two pairs of checks were one rule spelled twice, disagreeing on what counts as
  documented. And the file broke the import-order rule it enforces, invisibly, because the walk
  stopped short of `scripts/`.
- **`stakeholderCanAnswer` carried an `export` nothing imports**, and the check that refuses
  exactly that could not see it.

### Upgrade notes
- **Take the new deploy bundle.** The compose file carries the image tags, so a host on the old
  bundle stays on the old images however many times it runs `docker compose pull`.
- **Re-run `deploy/install-backup-cron.sh`.** Nothing breaks without it; the three lines it
  writes are unchanged on the deploy host. Do it if you install from the bundle anywhere else,
  where the old literal `REPO` pointed at a directory that does not exist.
- **Check `/var/log/zz-backup.log` once.** If a nightly run has been failing, the partial files
  it left behind are still in `$BACKUP_DIR` and still sort newest — this release stops new ones
  appearing and does not remove the old ones.
- **Installed clients need `claude plugin update <name>@zz-platform`** for the corrected skill
  text: `sdlc-tldr` names the Codex form of the command, `zz-journal`'s node count is stated as
  the dated observation it is, and `zz-knowledge`'s prompt no longer describes `zz-access`.
- **Nothing to set.** No migration, no new required variable, no tool renamed or removed.

## [0.4.1] — 2026-08-30

Carries **zz-blocks 0.3.2**.

**There is no 0.4.0, and the number is not skipped for tidiness.** 0.4.0 was built, pushed
and deployed; verification found `/pkg` returning 500 for every caller and rolled the host
back to 0.3.4 with the tag uncut. An image tagged 0.4.0 exists in the registry and someone
may already have pulled it, so that number can never mean anything else — a release that
rolled back still spent its version. Everything below was going to be 0.4.0 and is unchanged
apart from the first entry under Fixed, which is what 0.4.0 got wrong. Coming from 0.3.4,
read this as one release and note that the breaking changes take the minor.

### Added
- **The tool report reads what the gateway was already recording.** Three fields were
  captured on every call and read by nothing. `ids` — which skill, which initiative, which
  block — was added with a long argument for why it was needed: "which skills does a winning
  run load that a stalling one does not" was said to be unanswerable from a record taken
  specifically to answer it. Adding the capture did not answer it; nothing read the field.
  The report now shows the skills a run loaded and what else it named. `aborted` is worse:
  a call that never came back is neither accepted nor refused and leaves no answer to
  classify, so it was the least visible failure there is, and the headline now counts it.

- **A token can now be issued with an expiry.** `issue_pat` takes `expires_in_days`.
  `pat.expires_at` was enforced and never written — resolvePat has always refused a token
  past its expiry and nothing could issue one, so every token on the platform lived for ever
  and that check could not fire. Enforcement without issuance reads, to anyone looking at
  the schema, like a platform that expires its tokens.

- **Which team a person is acting as is decided in one place.** `actingTeam` in
  `@zz/contracts` holds the whole rule — a bound token wins or resolves to nothing, else the
  team they chose while it is still a live membership, else admin-role then alphabetical —
  and both zz-core and the gateway call it. The gateway had no notion of a chosen team at
  all and took the first row of a differently ordered query, so a person in two teams could
  have documents land in one team's store while the block call spent the other team's quota.
  Two more places were taking the same first-row shortcut: the web knowledge base, so the
  browser showed one team's documents while the agent wrote to the other's, and
  `list_catalog`, so "what does my team run" answered about a team they were not working in.

- **Block credentials resolve personal, then team.** A new joiner can work on their first day
  on the team's key; anyone wanting their own quota or permissions stores a personal key and it
  wins. Two levels only — a third would turn "whose key did this call use?" into something you
  have to look up, and that question only gets asked after something has gone wrong.
  `set_team_credential` is team-admin only, and the audit records the person who acted either
  way, with the level that answered. `delete_team_credential` removes one — a shared key is
  usually removed because it leaked, and "wait for somebody to overwrite it" is not a
  response to that.

- **Every flow ends with the platform's handover.** `initiative_status` appends the step below
  the manifest: a closed initiative returns `action: handover` naming `zz-knowledge` until
  `learnings.md` exists. What a run learned is worth more to the next initiative than its
  deliverable, and which flow you happened to run should not decide whether it survives.

- **The platform's own knowledge has a home.** `zz-platform` is an ordinary team with the
  ordinary store and the same `_knowledge/` every tenant has — zero new mechanism. What lives
  there is about a registry entry (a block, a flow, a provider, an interface) rather than about
  anybody's delivery. Seeded by the bootstrap and reserved in `create_team`.
  `skills/zz-knowledge` is the act that promotes a tenant's finding into it: a conclusion crosses,
  never their file, and reading a team you are not in is refused rather than enabled.

- **Team overlays.** `<team store>/overlays/<skill>/SKILL.md` is appended whenever anyone on
  that team loads that skill. Appended, never substituted — so no overlay can shadow
  `zz-backbone` or take over a stage, and that is a property of the code rather than a rule
  anyone follows. `flow.json` stays the platform's: an overlay changes how a step is done,
  never which steps exist.

- **The envelope and the manifest have one definition.** Both were three things at once — const
  arrays and a regex in zz-core, a TypeScript interface in `@zz/catalog`, and a third narrower
  view. They are zod schemas in `@zz/contracts` now, `flow.json` is parsed THROUGH the manifest
  schema, and `GET /schemas/envelope.json` and `/schemas/manifest.json` publish them
  unauthenticated — a rulebook that needs a token is one people copy by hand.

- **Three reports that close the improvement loop.** `evolve-report` says which STEP stalls,
  attributing each refusal to the skill the agent had loaded when it happened, and hands back
  the platform's own refusal sentences; `flow-compare` puts the same metrics beside each other
  across flows and teams; `watch-results` alerts when results get worse rather than when a
  service is down, and treats its own silence as a failure — a collector nobody scheduled
  produces "nothing wrong today" every day, which is worse than being down.
  A `zz-skill-evolve` skill was the method that used them; it was removed in a later
  release, because three of its four steps were shell commands no agent can run.
  `evolve-report` reads BOTH halves of the evidence: what the platform refused, and how often
  a person sent that step back. A refusal says a rule was broken; a revision says a person
  found the document wrong, which no rule can tell you — and a step can refuse nothing while
  being rewritten three times every run, which the refusal-only ranking made invisible.
  Counts cross; the reasons stay in the team's store, where their words belong.
  `watch-results` also reads the stranded-event count off `/health` and alerts on it: an
  event the database refused is written to a file and counted, and the comment beside that
  count said "a monitor already polls this endpoint" — an assumption about somebody else's
  setup. Nothing here polled it, so the one signal saying the audit record has holes was
  reported to nobody.

### Changed
- **Breaking — `subskills` is gone from the manifest schema.** It was declared in
  `CatalogManifest`, validated by the gate, taught by zz-flow-builder, published in
  `/schemas/manifest.json` — and read by no code anywhere. The packager ships a flow's whole
  `skills/` directory and promotes only what `standalone` names, so a subskill already behaved
  exactly like any other shipped skill. It did not even describe what it appeared to: sdlc-flow
  ships 18 skills, names 12 in `entry`/`stages`/`standalone`, listed 3 under `subskills`, and
  left 3 more that are equally stage-loaded named nowhere. The real statement of which workers
  a stage fans out to is in that stage's own skill, with the counts and the reasons.
  **Upgrade note:** the schema is strict, so a manifest still carrying `subskills` is now
  refused by name — delete the field. Nothing else changes: those skills ship and serve exactly
  as before.

- **Everything is TypeScript. There is no Python left.** Thirteen files and ~3,600 lines —
  the smoke harness, the conformance measurer, the chain probe, the outcome audit, the tool
  report, the classifier cases, the block probe, the credential batcher, the provisioner, the
  turn collector, the shared MCP client and the Operations flow's scenarios. They live in
  `packages/tools`, each with an npm script, and the client they all use is
  `packages/mcp-client` — the counterpart to `@zz/mcp-http`, which hosts one.

  Three things the port removed rather than moved. The outcome audit carried a **second
  implementation of the envelope parser**, held to the TypeScript original by a gate check
  comparing three regexes as string literals; it imports `parseEnvelope` now, and the check
  is gone because there is nothing left to compare. `release.mjs` held a **seventh copy of
  the MCP handshake**, announcing a fourth protocol version (`2024-11-05` against the
  client's `2025-06-18`); its probes still use curl, deliberately — a status code over real
  HTTPS is a stronger claim than "our own client can talk to it" — but they read the version
  from the one place that defines it. And a flow's scenarios are **data now**: the engine
  reads `scenarios.json` and nothing executes it, with every line of reasoning that was in
  the module's comments kept in a README beside it.

  Behaviour is preserved, and where it was worth proving, it was proved rather than
  reasoned about. The reply classifier — the most delicate part, because a misread costs a
  whole scenario — was run against **2,000 generated cases** alongside the Python it
  replaces: identical on every one, across all fourteen classification outcomes. The outcome
  audit was run against a fixture store built to exercise every branch: byte-identical
  output and matching exit codes. `echoesName` and both refusal classifiers: ten cases each,
  identical.

  **Breaking, for operators.** A deploy host runs containers and has no toolchain, which is
  why the Python was standard-library-only. The tools run in the image that is already
  there, through `deploy/zz-tool` — no Node on the host, no new install, and no docker
  socket mounted, because mounting one would give a one-shot command root on the box. The
  cron'd turn collector moves to it, and the release bundle carries it in place of the
  provisioner. Everything else is an npm script: `npm run audit -- …`, `npm run smoke -- …`.
- **STATE.md carries the thirteen principles, and the platform's own sentence.** §8 held
  eight principles that predated the direction work; §1 opened on a description the
  direction work replaced. Three principles left the list for reasons worth keeping:
  "MCP is just an adapter" is a corollary of another and settles no argument, "one deploy
  per round boundary" is a working agreement at the wrong altitude, and "blocks are
  consumed, never owned" split into two — its best half, *the contract is the
  relationship*, is kept verbatim. §5c gained the two laws this release adds: a verdict is
  recorded by an act, and the store is a git repository the team can walk away with.
- **STATE.md said 0.3.0 while the code shipped 0.3.4.** A date going stale is expected and
  the gate deliberately only warns; a version claim being wrong is not the same thing, and
  a reader was told the world as of a release three patches back. The gate check "STATE.md names
  the version this release ships" compares the two. It checks rather than rewrites: bumping the
  stamp mechanically would say "the world as of 0.4.1" about a document nobody reread, which is
  worse than a wrong number because it converts "probably out of date" into "recently
  confirmed".
- **Six Python scripts spoke MCP; one does now.** The smoke harness, the conformance
  measurer, the chain probe, the block probe, the credential batcher and the provisioner
  each carried a hand-written client, and they had already drifted: three protocol versions
  between them (`2025-06-18`, `2025-03-26`, `2024-11-05`) and three ways of reading a
  streamable-HTTP answer — first `data:` line, last JSON object, and the frame whose id
  matched. One sent `notifications/initialized`; the others did not. Nothing had broken,
  which is the argument for fixing it rather than against: copies of a protocol agree until
  one is updated alone. `@zz/mcp-client` is now the only client — named as a `.py`
  file here until this release, in the very entry announcing that no Python is left.
  `npm run check:mcp-client` proves it against a stub server with no gateway and no network,
  and a gate check refuses a seventh copy. The reading that takes the LAST JSON object is the one that survived: a
  progress frame arriving ahead of the result made the first-line reading return a
  notification and call it the answer.

- **A team's git log reads as acts, not as writes.** Every store change was committed with
  the message `write: <path>`, so an approval, a close, a revision and a typo fix were
  indistinguishable in the one place a team looks to ask what happened between the approval
  and the close — which is the question the repository exists to answer. Commits now name
  the act: `approve:`, `close accepted:`, `revise:`, `patch:`, `write:`. The parameter has
  no default, so the compiler asks the next person who adds a write path rather than
  silently recording another `write`.

- **The model writes the body; the platform writes the envelope.** Every envelope field now
  comes from a fact the platform holds or from an explicit act, and "the model typed it into
  some YAML" is gone as a third source. `write_file` and `revise_document` take the BODY and
  refuse content that opens with frontmatter; what a document needs beyond the facts arrives
  as named arguments — `flow` on the first document, `stakeholder`, `tags`, `title`, and
  `fields` for a flow's own keys. `version` joins the platform's fields, because it starts at
  1 and moves only through `revise_document`, so a template typing `version: 1` asserted a
  fact it could not check.

  The cost of the old arrangement was countable: approved documents were found carrying no
  `approved_at`, and others no `approved_by`; smoke runs signed a gate as a team SLUG rather
  than a person; and a run closed an initiative `accepted` that nobody had accepted. The ANONYMOUS blocklist exists to catch the worst of that, and its own
  comment admits there is no way to test whether a string is a person.

  `sdlc-spec`'s `contract:` block moved out of frontmatter into the body under
  `### Deliverable contract`. The platform never read it, and a rendered document does not
  display frontmatter — so the one part of a spec a person most needs to read before agreeing
  to it was the part they could not see.

- **An approved gated document changes through `revise_document`, or not at all.** There were
  two paths and they disagreed: `revise_document` bumped the version, returned the document to
  draft and cleared the approval, while `patch_file` and `write_file` ran the content guards
  and then simply wrote — leaving the approver's name standing over bytes they never read.
  "Never overwrite an approved document" was prose in `zz-backbone` that nothing enforced, and
  the cheaper path was the one that skipped the record. Refused rather than taught to imitate:
  a second partial copy of `revise_document` is exactly what the acts exist to prevent.

- **What someone says about a document is a source.** A comment and a source were one thing
  under two names, and they cost differently — a source versions the document, is named in the
  envelope, and is frozen into `_versions/`; a comment did none of that. So whether "this
  requirement is wrong" entered the record depended on which door it came through. The web
  affordance is intact: writing on a document from the browser now stores a source naming that
  document, through zz-core like every other write. "Addressed" is no longer a flag — the next
  version citing the source is what it means.

- **Identity is a port with adapters.** The PAT and the forwarded compose-network header are
  two adapters behind one interface; adding Keycloak, another OIDC provider or a corporate directory is adding an
  array entry rather than surgery on identity resolution. Behaviour is unchanged, and
  authorisation still converges on one path for every door. One property became explicit: a
  door that says NO ends the request, so a revoked PAT 401s instead of falling through to be
  retried as a forwarded header — which would have turned a revoked token into an
  unauthenticated header claim.

### Fixed
- **No client package could be installed or refreshed — `/pkg` returned 500 for everybody.**
  The query behind it orders by `f.created_at` so a person in two teams gets the newest
  install of a flow, and did not select that column. Postgres rejects a `SELECT DISTINCT`
  ordered by an expression it does not project (42P10) at PARSE time, so this was never a
  slow path or a wrong answer: the statement never ran, and all three clients — claude-code,
  codex and hermes — failed identically for every caller. The column is in the select list
  now, and `distinct on (f.flow)` was deliberately not used: dedupe has to happen after the
  client filter or a flow whose newest install is codex-only disappears from someone's
  claude-code package. Found by release verification against production, which is the only
  place it could have been found — the gate does not run SQL. It does now check the shape:
  "a SELECT DISTINCT is ordered only by columns it selects" reads the select list and the
  order list out of the same string, and exempts `distinct on`, which carries the opposite
  rule.

- **The knowledge web app named the wrong team beside the right documents.** Which team a
  person acts as is `actingTeam` and nothing else — a bound token wins, else the team they
  chose, else admin-role then alphabetical. Three places took the first row of a
  differently-ordered list instead; the gateway and `list_catalog` were fixed, and the browser
  was not. Its data was never wrong (every `/api/kb/*` route is scoped server-side by
  `activeTeam`), but the header — the one sentence telling a reader which team they are
  looking at, and so the one they would use to notice a mistake — read `teams[0].slug`. It
  already fetches an identity carrying `activeTeam`. A gate check now refuses any first-row
  membership pick, in `.ts` and in the app's own HTML.

- **The platform admin's browser agent was told to load a skill that does not exist.**
  `render_agent_definition` falls back to a generated router when a package ships no prompt
  of its own, and that router ends every agent with `skill_view("<entry>")`. `zz-admin` ships
  a SERVER and no skills, so the one instruction its agent was given answered with an error —
  and nothing failed at provisioning: the agent is created, it carries the admin tools, and
  its instructions point at nothing. The router is also wrong ABOUT a platform package, which
  is already recorded here for `zz-access`: it says "running the zz-admin flow for team X",
  and it is neither a flow nor run for a team. `zz-admin` and `zz-knowledge` now carry their own
  prompts, as `zz-access` and `zz-flow-builder` already did, and a gate check refuses a
  platform package without one — or any package whose router would name a skill it does not
  ship.

- **The first command an operator runs after installing could not connect to anything.**
  `deploy/zz-tool` runs a tool inside the platform's image on the compose network, where
  `127.0.0.1` is that one-shot container — and both documented `provision` invocations passed
  no `--base` and no `--gateway`, so both defaulted there. Its own header told you to pass
  `--gateway http://gateway:8000`; there has never been a service called `gateway`. Both
  commands now pass `--base http://librechat:3080 --gateway http://cred-proxy:8000`, and a
  gate check refuses any dotless hostname that is not a service `docker-compose.yml` defines.
  `deploy/README.md` also described `install_flow` as creating an agent preset, offered
  `project: false` (no such argument — where a flow runs is `clients`), promised comments in
  the browser knowledge view (a comment is a source as of this release), and named Ollama Cloud as
  the model provider twice.

- **An unreadable flow manifest was reported as a missing one.** `smoke-engine` parsed
  `flow.json` itself inside a `try` that caught everything, so a manifest with `gate: "false"`
  or a misspelled key came back as `no manifest at <path>` — and the operator went looking for
  a file that was sitting right there, while the premature-acceptance guard silently switched
  off. `manifest-audit` and `chain-check` had already been moved to `@zz/catalog`'s
  `manifestAt` for exactly this reason; this was the third of three. It now says which of
  "missing", "not JSON" and "not a manifest" happened.

- **A personal block key never won, because the block proxy could not see who was calling.**
  `requestHeaders()` reads an AsyncLocalStorage store, and exactly one place enters it:
  `serveMcp`'s own route handler. The block proxy is a plain `app.all("/p/:platform/mcp")`, so
  the store was never entered and `caller().email` was always `""` — while the identity
  middleware had written the address onto `req.headers` three lines earlier. `resolveCredential`
  then looked the personal key up under the empty address, found nothing, and every block call
  fell through to the team's shared key: a person who had stored their own key spent the team's
  quota under the team's permissions, and the audit recorded `level: "team"` for everybody.
  "A personal key always wins" is what the tool description, the door index and the
  missing-credential guidance all say. The proxy reads `req.zzIdentity` now, as the line below
  it already did for the acting team. **If your calls have been using a shared key while you
  had a personal one stored, this is why, and they will use yours from this release.**

- **An initiative could be closed twice, and counted twice, by revising the document that
  recorded the close.** `close` refuses a second close by reading `outcome` off the document,
  and `ledgerOnClose` refuses a second row by reading it off the file on disk — both guards
  are one field deep. `revise_document` deleted that field: it clears the governance fields so
  the gate goes back to a person, and `outcome` sat in that list beside `approved_by` and
  `approved_at`, while `closed_by` and `accepted_by` were left standing. `closeCheck` fires
  only on content that HAS an outcome, so nothing refused it. One revision of the closing
  document left the initiative stamped with who closed it and no outcome, reopened it in
  `initiative_status`, and let `close` run again and append a second `_ledger.md` row for the
  same work — and the ledger is what the OKR grading and `flow-compare` count. Revising a
  document that records a close is refused, in the same words `close` already uses: a
  correction somebody can find beats an overwrite nobody can.

- **A write arriving before the first database-backed request never reached the index.**
  zz-core built its connection pool lazily and spelled the construction out at five call
  sites, while three other functions read the `pool` variable directly and treated an unset
  one as "this deployment has no database". Those are different questions — is one configured,
  and has anybody connected yet — and answering the first with the second is a race with
  whatever the caller happened to run first. It had already cost something once: the boot
  rebuild reported 0 scanned, 0 indexed, 0 removed for every team because nothing had served a
  request yet, and that was fixed by writing the construction out a fifth time. `indexDoc` and
  `reindexTeam` still asked it, so a document could be written to disk and be missing from
  `search_knowledge` until the next reindex. One accessor now answers "is there a database",
  connects on first use, and holds the pool size, which was four connections spelled in five
  places.

- **A subject tag could be written and validated and never found by the word it is about.**
  `knowledge_add` teaches `block:casebox`, `flow:ops-flow`, `provider:forgejo`; `subjectTagError`
  refuses a kind the platform does not have; `TAG_TOKEN` admits exactly one colon. The payoff
  those three exist for is stated in the tool's own description — "what have we learned about
  casebox" becomes a query rather than a search through documents. `search_knowledge`'s tag arm
  could not answer it: it derives candidate words by splitting the query on everything that is
  not a letter or a digit, so `casebox` is a token and `block:casebox` can never be one, while the stored
  tag is that one string with the colon in it. The arm matched plain tags, missed every subject
  tag, and looked like it worked because the lexical arm usually found the node by its prose.
  The query's words are expanded by the five kinds before they reach the tag column; the
  caller's explicit `tags` filter is untouched, because there the caller typed the whole tag.

- **`write_file` answered about the document when the path was wrong.** Of the five paths that
  write a document, four resolved the caller's path before judging anything; `write_file`
  resolved it last, after a chain lookup, an envelope stamp, heading normalisation and eight
  guards. So `.zz/spec.md` came back complaining about the sections the flow requires, and
  `pathShapeRefusal`'s message — the reason the write could not succeed at any path — arrived
  only on the next attempt, after the author had rewritten the document to satisfy a guard that
  was never the problem.

- **Production had no backup for four nights, and said so in a log nobody reads.** `deploy/.env`
  sets `COMPOSE_PROJECT_NAME=zz` — a file compose reads and a cron shell does not — so
  backup.sh's `$(basename $(dirname $0))` resolved to `deploy` and the nightly job ran
  `docker exec deploy-postgres-1` into "No such container". `set -e` stopped it after the
  redirect had created the file: three 20-byte database dumps, and no artifacts or credential
  archive since 2026-08-25 — the volume holding every person's building-block key, which that
  script calls "the one nobody can reconstruct". The second time the project name has been
  wrong there; the comment recording the first fix says hard-coding it "silently backed up
  nothing on any host whose project differed". Containers are addressed as compose SERVICES
  now, so nothing rebuilds the naming convention, and the project — still needed for volume
  names — is read from `.env`. Fixed and verified on the host: trialled to a scratch
  directory, restore drill run against the result, then a real set taken.
  **Upgrade note:** if you run this stack anywhere, check `/var/log/zz-backup.log` and take a
  backup by hand. Your newest set may be older than you think.
- **Two more container names, each correct on exactly one host.** `release.mjs`'s migration
  probe said `zz-postgres-1` under `|| true` and `reset-smoke-store.sh` said
  `deploy-zz-core-1` — production sets the project and UAT does not, so the same stack runs
  as `zz-*` and `deploy-*`. Both go through compose now.

- **One stray file in the catalog left the platform with no skills at all.** `catalogSkillRoots`
  walked the catalog's two levels under a single `try`, so a FILE where an owner directory was
  expected threw `ENOTDIR` and the catch beneath it — whose comment reads "no catalog mounted
  (local dev)" — swallowed it and returned whatever had accumulated. `.DS_Store` sorts first,
  so what accumulated was nothing: no platform skills, no flow stage skills, no team overlays,
  and `skill_view` finding nothing at all, with the only symptom being that every skill had
  vanished. It shipped in 0.3.x and is reachable on any host using the build override, which
  mounts the working tree over the image's copy — which is where a stray file comes from.
  `@zz/catalog` already had the tolerance and named it; both readers share one walk now.
  **Upgrade note:** nothing to do. If skills ever went missing on a dev host, this was why.

- **Storing your own building-block key left no trace; an operator storing it for you did.**
  `admin_set_credential` and `admin_delete_credential` both logged an event.
  `set_my_credential` and `delete_my_credential` — the path almost every key actually takes,
  through the ZZ Access agent — logged nothing. So the same change to the same store was
  recorded when an operator made it and invisible when the person made it themselves, and
  "who holds a key for `casebox`, and since when" could only be answered by opening the file that
  holds those keys in plaintext. The key itself is still never recorded: that a credential
  changed is provenance, its value is not. The gate check "a tool that changes something
  records that it did" asks it of every tool that mutates.
- **The documented configuration surface disagreed with the actual defaults, on the two
  settings that decide what is published.** `deploy/.env.example` showed `WEB_PORT=8080` —
  the previous front end's port; LibreChat listens on 3080 and compose defaults to it, so an
  operator uncommenting that line would publish the browser somewhere every other document
  says it is not. And `WEB_BIND=0.0.0.0` against a compose default of `127.0.0.1`, which is
  the insecure direction and disagreed with its own three sibling binds, all documented as
  loopback. A check already said this file was COMPLETE; nothing said it was ACCURATE, and a
  commented line here reads as "this is the default", so a wrong one is worse than an
  undocumented knob — the operator has no reason to check.
- **A refused revision left a source document behind.** `revise_document` wrote the source
  that explains a revision forty lines before `documentGuards` ran, so a revision the
  platform then refused left that file on disk, indexed into `zz.doc` and logged to activity
  — while the caller was told the write had failed and reasonably believed nothing had
  happened. It also sat uncommitted until some later act swept it into a commit under that
  act's name. Only the source's NAME is needed before the guards, because the document links
  to it by name; the file is written after they pass, and lands in the same commit as the
  revision it explains, which is what it is. The gate check "nothing is written before the
  guards that would refuse it" refuses a write that precedes a guard in the same handler.
- **ZZ Flow Builder could not perform the install it exists to perform.** Its method calls
  `install_flow`, `render_agent_definition`, `grant_tool` and `render_harness_config` — all
  four on `/admin/mcp` — while its manifest declared `tools: []` and no `servers`, so
  `render_agent_definition` gave its agent `zz-core` and nothing else. Every account gets
  that agent, because the flow installs automatically. Nothing failed: the tools exist, the
  skill is well written, the agent provisions, and the calls its method depends on were on no
  surface it carried. This is the second time — `list_catalog` was member-safe and mounted
  only on `/admin/mcp` while `zz-access` carries `/manage` alone — so the gate check "a skill
  never instructs a tool its package cannot reach" now reads every skill's tool calls against
  the surfaces its package can reach. Authorisation is
  untouched: `/admin/mcp` refuses a caller without the authority and says which is missing,
  and `install_flow` and `render_agent_definition` both admit a TEAM ADMIN, which is who
  builds a flow for their own team.

  `servers` now means one thing everywhere. It was read only for `kind: platform` packages;
  a flow declaring it was ignored by both the browser agent and the client package.

- **A refusal was classified two ways, and the report's way was wrong.** The gateway redacted
  the varying nouns out of a refusal at WRITE time, to keep an address out of the table; the
  report redacted them again at READ time, to group a hundred classes of one. Same patterns,
  different order — and order decides the answer. Measured on four real refusals, three came
  out differently, and `24-08-2026-sample-intake` collapsed to `<initiative>` in the gateway and
  `<date>-sample-intake` in the report, because an initiative folder starts with a date and the
  date pattern ran first. So in the report every initiative produced its own refusal class,
  which is precisely what the redaction exists to prevent, and the `--ledger` comparison it
  feeds could not see a class close. One function in `@zz/contracts` now, with the initiative
  pattern ahead of the date, and a gate check refusing a second placeholder vocabulary.
- **A link's body was rendered as raw HTML — stored XSS in the knowledge web app.** The two
  known holes in that renderer had been closed: raw HTML is escaped, and `javascript:` URLs
  are refused. Between them sat a third nobody had looked at. `token.text` on a link is the
  RAW SOURCE, not something already rendered, so
  `[<img src=x onerror=…>](https://ok.example)` came back as an anchor wrapping a working
  payload — in a page that injects with innerHTML while the reader's platform token sits in
  localStorage, and from a document drafted out of what a stakeholder wrote. The body goes
  through `parseInline` now, which escapes it through the same renderer AND renders
  `[**bold** link](…)` properly, which the raw insertion never did.

  Found by writing the test, not by reading: the previous comment asserted the body was
  already rendered, it sounded right, and nothing existed to disprove it. Twenty hostile
  documents and six ordinary ones now run against the real renderer in the gate, judged on
  the tags that survive into the output rather than on a substring search — the first
  version of that judge called six correctly-escaped documents dangerous, and a check that
  cries wolf on its own correct output is one somebody eventually silences.
- **`status: draft` had no author, and the first save of every sdlc document would have been
  refused.** Making `status` platform-owned closed the door on a model typing an approval —
  and closed it on the model opening a document too, because a NEW document has no previous
  value, so a template starting `status: draft` reads as setting the field. Three sdlc
  templates did exactly that. The sm templates, edited to drop the line, produced the
  opposite failure: a document with no status at all for the index and `initiative_status`
  to read. Both readings left the field to whoever remembered. The platform stamps it now —
  a new chain document IS a draft — and `approve()` is the only thing that moves it.
  Verified across five cases: a new document passes and gains `draft`; a second write
  passes; an edit to the body of an approved document passes; a hand-written `approved` is
  refused; the old template shape is refused. The gate check "no skill template hands a model a
  field the platform owns" refuses a skill template that carries any of the five owned fields as
  a key.
- **Four skills still told the agent to write the verdict by hand**, which the platform now
  refuses: `ops-flow` and `sdlc-flow` on `outcome:`, `ops-verify` contradicting itself between
  two sections forty lines apart, and `sdlc-record` handing over an `outcome: delivered`
  block plus a `closed:` field the platform has never had — while the same file, further
  down, correctly said `close()` derives it. The stale half came first, which is the half an
  agent follows. `sdlc-record` also told the agent to record a missing plan approval by
  writing it; it now says `approve(path, on_behalf_of)`.
- **`block-conformance.py` reported a failing block and exited 0.** It printed ✗ against
  every unmet requirement and "unreachable" against a block that answered nothing, then
  returned success — `main()` was typed `-> None` and called bare. Anything running it in a
  release or a pipeline read that as a pass. It now exits 1 when a measured requirement is
  unmet or a block is unreachable, and NOT-MEASURED still does not count: R1, R7, R12, R13
  and R14 need a write, a sequence or a delivered event, and saying so is the design.
  `manifest-audit.py` had the same defect once and its comment still records it, so the
  convention is now mechanical rather than remembered: every engine returns its status from
  `main()` and exits with it, and the gate check "a testing engine's exit status comes from
  its results" refuses one that does not. The convention survived the TypeScript port above —
  all fourteen tools end `process.exit(main(...))` — which is why it is stated here in the
  form it now has rather than the `sys.exit(main())` it had when this was found.
- **The model switch left two places behind, and the changelog said it touched four.** 0.3.1
  recorded the move to `glm-5.3-flash` as four places kept in step, with "context length is
  1,048,576 … asked of the provider rather than assumed". Neither half held. The provisioner
  carried a fifth place — a hard-coded fallback to `deepseek-v4-flash:0731`, so a deployment
  that had not been told its model provisioned every agent onto one the platform no longer
  serves, failing on the agent's first turn rather than at provisioning. And the context
  figure's own justification in `librechat.yaml` read `deepseek4.context_length = 1048576`,
  naming the REPLACED model: the number survived the switch and its reason did not, which is
  the opposite of asking the provider. The fallback is gone — `render_agent_definition`
  returns the configured model or null, and null is an error rather than a guess. The figure
  stays at 1,048,576 and is now marked as needing confirmation when the model next changes:
  Z.AI's `/models` publishes no context length, so it cannot be read back from the endpoint.

- **Three commands took a secret as an argument.** `set-credential.py --key` carried
  somebody else's building-block credential, `block-conformance.py --pat` and
  `provision-librechat.py --user-pat` carried platform tokens. All three are visible in `ps`
  to every user on the host and are written into shell history, where they stay. The gate
  check that exists to catch exactly this had spelled the pattern `api[-_]?key`, which
  requires the word "api" — so a bare `--key` went straight through it, and the release
  passed while reading as though the question had been asked.

- **The install instructions installed everything.** The block a person pastes listed every
  optional plugin as a live command, directly under the line "take what you want, and
  nothing else" — so following the instructions installed all of them, `zz-admin` included.
  A plugin that can create teams must not arrive by default, and one plugin per flow exists
  precisely because installing one used to bring everything. They are commented now, under
  "uncomment the ones you want" — in the Codex branch as well as the Claude Code one, which
  carried the identical list under the identical sentence.

- **A spec could be written narrowed and then refused at its own gate.** `sdlc-spec` said to
  emit all eight components "unless the person narrowed them", and `sdlc-spec-audit` had an
  UNLESS clause for exactly that — while `sectionCheck` refuses the APPROVAL of a gated
  document missing any heading its manifest declares. So a narrowed spec wrote cleanly, the
  person agreed, and the gate refused it: the worst place to discover a rule, after the work
  is finished and the verdict given. Both skills now say what the platform does, and a
  component that does not apply keeps its heading and says so in a sentence — which a reader
  can disagree with, and an absent heading is not.

- **The audit criteria are written once.** `sdlc-spec-audit` and `sdlc-plan-audit` shared 165
  identical lines — the eleven prose failure modes, the evidence shapes a finding must take,
  and the JSON a round returns — with nothing holding them together. They were in sync when
  this was found, and an edit to either would have left two auditors applying different
  standards with nobody able to say which was current. They live in `sdlc-audit-criteria`
  now, which both load first, exactly as a flow loads `zz-backbone` rather than restating it.
  Two auditors remains deliberate: a spec and a plan fail in different ways, and each keeps
  the contract its own document owes.

- **The smoke harness could not recognise the honest close.** `classify` matched
  `outcome: accepted|rejected|abandoned` — `rejected` has never been an outcome this platform
  records, and `delivered` was missing. So a flow that closed the way this release makes
  first-class — work finished, nobody signed off, reason recorded — read as a gate, and the
  scripted stakeholder went on answering "approved" to an agent that had already closed. It
  derives the pattern from `OUTCOMES` now, and the suite has a case for each of the three.

- **An initiative closes once.** A second `close()` overwrote the outcome on the closing
  document, while the ledger row — appended at the first close and skipped thereafter — kept
  the original word. The ledger is what OKR grading and `flow-compare` count, so the document
  and the team's own counts could disagree with nothing to notice from either side. A second
  close is refused now and says what the initiative was closed as; if that close was wrong,
  the correction is a journal node somebody can find rather than an overwrite nobody can.

- **The smoke suite scored an abandoned initiative as a pass.** `ledgerClosed` read the ledger
  for initiative NAMES and ignored the outcome column, so both paths to a verdict treated any
  fresh close as ACCEPTED. `abandoned` is exempt from the all-gates rule by design — an
  initiative that stopped is precisely one whose gates were never passed — so an agent that
  gave up scored a pass. A false green is the one result a suite must never produce: it is
  indistinguishable from working, and every number built on it inherits the lie. A scenario
  passes on `accepted` now; `delivered` fails too, because the scripted stakeholder is present
  and would have accepted, so nobody signing off means the agent never asked.

### Upgrade notes
- **The release reinstalls the host's scheduled jobs.** The Python turn collector under
  deploy/ is gone with the rest of the Python, and a release replaces the checkout with
  `git reset --hard` — so the hourly `python3 collect-turns.py` in production's crontab would
  have started failing at the moment of deploy, silently. (Named without backticks on
  purpose: a backticked path in these documents is one the gate proves exists, and this one
  is what the version removes.) Step 4 now runs `deploy/install-backup-cron.sh` after the
  containers come up (that order matters: `deploy/zz-tool`, which the new line calls, arrives
  with this version), and verification refuses a release whose crontab names a file the
  version does not ship. Nothing for you to do; if you had installed the cron by hand, it is
  replaced by its own tagged lines and nothing else is touched.

- **Breaking — documents are written as a body, not as a whole file.** `write_file` and
  `revise_document` refuse content that begins with `---`. Send the markdown starting at its
  first heading and pass the rest as arguments: `flow` on an initiative's first document,
  then `stakeholder`, `tags`, `title`, and `fields` for a flow's own keys. Every shelf skill
  is already updated; a flow written against the old shape needs its templates changed.
- **Breaking — `close()` refuses an initiative that already carries an outcome.** Nothing in
  the shelf flows closes twice; a caller that did was silently diverging the document from
  the ledger.
- **Breaking — `revise_document` refuses a document that records a close.** It cleared
  `outcome` as one of the governance fields it puts back to draft, which reopened the
  initiative and let `close()` run a second time, appending a second ledger row for the same
  work. Nothing in the shelf flows revises a closed document. If you need to correct one,
  record why with `knowledge_add` against that initiative — a correction somebody can find
  beats an overwrite nobody can.
- **Behaviour — a block call now spends YOUR key, where you have stored one.** The block
  proxy could not read the caller's identity at all, so `resolveCredential` looked every
  personal key up under an empty address and every call fell through to the team's shared
  key. If your calls have been spending the team's quota under the team's permissions while
  you held a personal key, they will use yours from this release. Nothing to do; check that
  the key you stored is the one you meant, with `my_credentials` on the ZZ Access agent.
- **Breaking — an approved gated document is read-only to `write_file` and `patch_file`.**
  Use `revise_document`, which versions it, returns it to draft and keeps the approved copy
  in `_versions/`. Drafts and ungated documents are unaffected.
- **Breaking — the comment tools are gone.** `add_comment`, `list_comments` and
  `resolve_comment` are removed and `zz.comment` is dropped WITH ITS ROWS; migration 012 does
  not convert them, because a conversion would have to invent which comments were material
  meant to change a document and which were asides. `/api/kb/comments` is now
  `/api/kb/sources`. Anything reading those tools or that endpoint must move to `add_source`
  and `list_sources`.
- **Breaking — a `flow.json` that does not satisfy the manifest schema is skipped**, with an
  error, instead of being loaded as a malformed chain. A manifest with `gate: "true"` used to
  produce a chain that was wrong rather than absent, failing at a later stage far from the
  typo. Check yours against `GET /schemas/manifest.json`.
- **Breaking.** Pass these through the environment instead:
  `--key '…'` → `ZZ_BLOCK_KEY='…'`, `--pat '…'` → `ZZ_PAT='…'` (already the documented
  form), `--user-pat '…'` → `ZZ_USER_PAT='…'`. The `--csv` batch path is unchanged.

## [0.3.4] — 2026-08-29

Carries **zz-blocks 0.3.2**.

### Changed
- **Every date is `YYYY-MM-DD`, in frontmatter AND in the initiative's folder name.** They
  are the same date and had been disagreeing: one initiative held `updated_at: 2026-08-29`
  inside a folder called `29-08-2026-…`. `zz-backbone` had permitted both forms — "both
  accepted and both normalised by the index" — which is precisely how both got into the
  store, since the platform stamps ISO while every sm skill told the author to name the
  folder day-month-year. ISO also sorts, so a listing of a team's store is a timeline.
  `ops-intent` no longer says "take the date from the system", which is what an agent
  believed it was doing while reasoning from the newest stored row; it names `get_my_info`.

### Fixed
- **Concurrent saves failed inside both blocks.** The atomic-rename fix that cured the
  state-splice named its temp file after the PROCESS, and these servers answer concurrent
  requests within one process — so two overlapping saves shared a temp path, the first
  `os.replace` consumed it and the second died with `[Errno 2] No such file or directory`.
  Measured: 30 concurrent saves, **24 failures before, 0 after**. On production it cost 2 of
  4 `create_table` calls in one run, and the agent then spent turns re-verifying
  every write because "acknowledgements have been wrong twice; only the read-back counts".

### Upgrade notes
- Folders created from now on are named `YYYY-MM-DD-<slug>`. Existing initiatives are not
  renamed, so a store will show both until the old ones age out.

## [0.3.3] — 2026-08-29

Carries **zz-blocks 0.3.1**. Four defects, every one found by running the flow rather than
reading the code.

### Added
- **`get_my_info` returns `today`.** The model has no clock, so it pattern-matched its way to
  one: an agent naming an initiative reasoned "latest stored activity is 27-08-2026 and your
  tag names pilot-2808, so this is 28-08-2026-…" and called that the date from the system. It
  landed on the right day by luck; the same reasoning wrote 26-08-2026 on the 28th. Telling a
  model not to guess does not give it the value, so the platform hands it over.

### Changed
- **`updated_at` is stamped by the platform, and OVERWRITTEN rather than merely added** —
  the failure was a confidently wrong value, not a missing one. ISO, because the alternative
  sorts wrong and reads differently in two countries. There had been three sources of truth
  for one mechanical fact: sm's skills asked authors for `<DD-MM-YYYY>`, sdlc's for
  `YYYY-MM-DD`, and `revise_document` had already decided this was the platform's job. On
  disk that produced most documents in one format and the rest in the other. Six skill templates no
  longer ask anyone to write a date.
- **`zz-backbone` states where today comes from**: `today` from `get_my_info`, and nothing
  else — not the newest row in the store, not digits inside a run tag. The platform can
  repair frontmatter; it cannot repair a folder name chosen before the first document exists.

### Fixed
- **BookIt's delete tools were undiscoverable.** 0.3.0 shipped `delete_service` and
  `delete_usecase` and documented them nowhere, so an agent holding both still reported its
  own leftovers as "unavailable via my tools — they'd need the console". The usage skill now
  has a cleanup section and `read_api_spec` a `cleanup` topic. Fixing a surface and leaving
  the thing that teaches it behind is the same defect twice.
- **The smoke stakeholder was doing the agent's engineering.** Verbatim: "That reads like a
  tooling fault, not a fault in your plan — keep diagnosing." At the one point an agent was
  stuck, it was handed the conclusion, so the run scored the pair rather than the agent. It
  is non-technical now, with a banned vocabulary, and pushes every problem back.
- **The stakeholder was approving documents it had read a tenth of.** Every turn was
  truncated to 1400 characters when assembling what it sees; agent messages run 5,000 to
  12,500. Measured in one round: 25%, 25%, **11%**, 26% — and the 11% was a 12,479-character
  plan it approved. Every gate approval this suite ever recorded was given that way. The
  message being answered is now sent whole. The harness had made sure a LENIENT stakeholder
  could not fake a verdict; a BLIND one never needed leniency.

### Upgrade notes
- **Re-pull the client package** (`claude plugin update <name>@zz-platform`) for the
  `zz-backbone` date rule. Nothing breaks without it; agents just keep guessing dates.
- Documents written from now on carry `updated_at` in `YYYY-MM-DD`. Existing documents are
  not rewritten, so a store will hold both formats.

## [0.3.2] — 2026-08-28

Carries **zz-blocks 0.3.0**. No platform code changed; the compose literal moves, so a host
needs the new bundle to get the new block images.

### Changed
- **BookIt can delete a service.** `delete_service` and `delete_usecase` did not exist, so
  a service the block created could never be removed — R13 of the building-block standard asks
  for "clearly deletable test data", and the standard's own appendix records the generic rule
  from 2026-08-20: every create needs a delete, or a documented no-delete rationale. The block
  is one of the two worked examples teams are handed, and it reproduced the exact defect the
  rule was written about. Measured on this deployment: nine near-identical "Public
  Consultation" services accumulated across smoke rounds with no way to remove any one of
  them, so the only cleanup available was destroying the whole store — which takes every other
  scenario's fixtures with it. `delete_service` takes its bookings and names them;
  `delete_usecase` refuses while services still reference it rather than cascading.

### Fixed
- **Preflight printed the `--blocks` hint twice** when zz-blocks needed a release, because the
  remedy was already inside the reason it appended it to.

## [0.3.1] — 2026-08-28

**0.3.0 was cut and never released.** It built, pushed and deployed, then failed its live
verification with four 401s and rolled itself back inside a minute. Nothing was wrong with
it: the release script authenticates to the deployment with the token in `~/.zz/token`, and
that file held a token for a DIFFERENT deployment — one file, more than one environment. The
same four checks failed identically against the 0.2.0 it rolled back to, which is what proved
the release innocent. 0.3.1 is that content, plus the two fixes below. **The number is skipped
deliberately**: an image tagged 0.3.0 exists in the registry and was briefly live, so it can
never mean anything else.

**The platform stopped taking the conversation's word for it.** A tool call now records what
it DID rather than that it happened, a document is checked against what its flow declares
rather than against a model's reading of it, and a scenario passes when the ledger holds a
close rather than when the transcript sounds finished. In the same move it stopped policing
the person: the guardrails point at the agent, which is the unreliable component, and never
at somebody's own words.

### Added
- **Every tool call, on every door, records what it DID.** Accepted or refused, the platform's
  own refusal text, duration, response size, and the argument NAMES. On a refusal it also
  records each argument's SHAPE — `value=string(0)` — never its content. Before this the whole
  record was `{"status": 200}`, and an MCP refusal is a 200: 2,369 rows could not tell a call
  that worked from one the platform had refused. It also covered only the block proxy, so the
  21 tools that do a flow's actual work were recorded nowhere.
- **Argument values that are IDENTIFIERS are kept** — a skill name, an initiative, a block, a
  path, an enum, each capped at 200 characters. The team's own words never are: no title, no
  body, no search query, no address, no key. `skill_view` used to log that *a* skill was read
  and not which, which made "does this skill earn its place" unanswerable from the record
  taken to answer it.
- **`zz.decision`** — the claims a stage document makes, as rows, derived at index time from
  text the flow already writes. A fit ledger is seventeen predictions per initiative and was
  markdown nobody read back; the corpus it produces answers "what have we predicted about this
  block, and where were we wrong" as a query instead of a reading exercise. It reads four
  document shapes, the fourth being a PLAN's tasks — so the traceability table `sdlc-plan`
  asks an author to write by hand is now derived, and the first query over it found four tasks
  claiming one acceptance criterion, two of which had nothing to do with it.
- **the turn collector** — what a conversation cost and where it stopped, from the front
  end's own store, which it never writes to. A turn that made no tool call and was answered
  next by a person is a fork; one measured fork ran for forty-nine minutes. Cron it beside the
  backup.
- **`npm run tool-report`** — the tool record read back per tool and per refusal class, with
  `--ledger` across saved runs and `--actor` per person. The accepted RATE is not the number to
  watch: it is governed by which tools a run happened to call, and one run was 93.8% accepted
  with seven of its eight failures on a single tool.
- **`npm run conformance`** — each block measured against the published standard,
  where §6 of that document used to carry a hand-written dated table. It picks its probe by
  asking the block — MCP's own `annotations.readOnlyHint` — and says which of the two chose,
  because a declared fact reads differently from a guess.
- **`reindex_knowledge(force: true)`** — re-derive every row even where the stored hash says
  nothing changed. Rows written by older logic are otherwise invisible to a rebuild forever,
  which has now happened twice.
- **The sync script** (since renamed `deploy/sync.sh`) — sync a checkout to a host and
  ASSERT the secrets survived it. The
  rsync was retyped by hand each time, and one without `--exclude .env` deleted `deploy/.env`
  from a host: the four secrets compose has no default for, plus the database and admin
  credentials. Recoverable only because every container was still running with the values in
  its own environment. A sync that quietly removed them still exits 0.
- **`release.mjs --preflight`** — everything about a release that is a matter of fact rather
  than judgement, in one read-only pass before any of it costs anything: which repos moved,
  whether the tree is clean and master is level with origin, what the range DECLARES as
  breaking, and whether this machine can finish — docker, the registry login, the gateway
  address read off the host, and **whether the token actually authenticates against the
  deployment being released to**. That last check is the whole reason it exists: 0.3.0 ran a
  gate, built two images, pushed one, deployed it and rolled it back in order to learn
  something one request answers. The breaking list is a FLOOR — of 0.3.0's seven, three said
  so in a commit body; a closed enum, a write path that began enforcing its guards, and a
  changed default model each broke something in silence.
- **`LOGIN_MAX` / `LOGIN_WINDOW`** — LibreChat's login limiter, exposed with its own defaults
  unchanged (7 attempts / 5 minutes). A published deployment sees no difference; only a test
  host raises them, because a five-scenario smoke round opens five logins at once and trips a
  limiter sized for people signing in.

### Changed
- **The platform no longer tells a flow to refuse a person's own words.** `zz-backbone` used to
  say, verbatim, that a gate passes ONLY on "approved" or "yes, I approve" and that "please
  continue", "ok" and "go ahead" do NOT pass. That is the platform instructing every agent to
  make somebody say it again. It now asks for the judgement a colleague would make, says a
  standing delegation keeps holding until it is withdrawn, and says the gate constrains the
  AGENT — it is a line the agent owes the document, never a hoop for the person. A gate check
  refuses a phrase whitelist reappearing in any flow's skills.
- **`outcome` is a closed set** — `delivered`, `accepted`, `abandoned`, `superseded`. It sat one
  line from `status`, which has been exactly `draft` or `approved` since the beginning, and took
  any string a model felt like writing while being the field the team's ledger is read by. "How
  many initiatives were accepted this quarter" cannot be answered over a column holding
  `accepted`, `delivered`, `shipped`, `done for now` and `mostly complete`. `zz-backbone` now
  states the rule behind it: be loose with the person, exact with ourselves — openness belongs
  at the boundary with a human, determinism everywhere after it, and the model is the thing that
  converts one into the other.
- **A document's declared section headings are checked by the platform**, on every write path,
  for a gated document offered as `approved` and for any ungated document whose flow declares
  them. WHICH headings stays in `flow.json` — sdlc's eight and sm's four are different sets, and
  a list hard-coded in the platform would make it an sdlc platform. Grepping this repository for
  any of those heading names previously returned nothing: the only thing reading the list was a
  model, and the audit meant to catch a missing section was also a model reading the same
  document. Drafts are exempt.
- **A heading that says everything the required one says is renamed, not refused.** Of six real
  documents that DID the lookup, six paraphrased the heading the same way — that is what a
  heading specified in prose gets, not carelessness. The rename is reported in the reply, never
  silent, and a genuinely absent section is still refused.
- **`approved_by` records who the approval BELONGS to**, not that a human typed it. When someone
  puts an agent in front of their work, what it does in their name is their decision carried
  out. A team slug, "the user" and "the agent" are still refused — not for failing a test of
  humanness, but because an initiative whose approval belongs to nobody cannot be answered for
  by anyone.
- **The platform's model is `glm-5.3-flash`**, replacing `deepseek-v4-flash:0731`. Four places
  carry it and all four move together: LibreChat's model list, its `titleModel`, its
  `tokenConfig` block — which is keyed BY model name, so a rename that misses it silently drops
  the context window to LibreChat's generic 115.5K default — and `PLATFORM_BASE_MODEL`, which is
  what `render_agent_definition` stamps onto every agent it builds. Context length is 1,048,576,
  the same as the model it replaces; asked of the provider rather than assumed.
- **A flow's commands lost the words they were saying twice.** `/sdlc-flow:sdlc-deck` is
  `/sdlc:deck`; the entry command of any flow is `/<name>:flow`. One rule for every flow, and a
  gate check refuses a catalog where two flows would collapse onto one namespace.
- **The client package carries the command Codex actually needs.** Codex does not read the
  `headers` in a plugin's `.mcp.json` at all — not the `${ZZ_TOKEN}` form the package writes,
  and not a literal token pasted in its place. `codex mcp list` shows an empty bearer variable
  and Auth "Unsupported", every call answers "the tool is not available in this session", and
  nothing says why. The note had said UNVERIFIED since it was written and its guess did not
  work either. The package now carries `codex mcp add --bearer-token-env-var`, and names two
  other refusals that read as platform faults and are not.
- **`ops-select` must write what past work recorded** about each candidate block, under a heading
  a reader and a check can both find, with `(nothing recorded)` as a required answer. The lookup
  was already instructed and produced no artifact, so nothing could tell it had been skipped —
  and two runs of one scenario showed the cost: one consulted the corpus and passed, the other
  did not and stalled on a trap already written down.
- **Selection must make one real call across each seam before the plan is agreed.** A composition
  has seams between blocks, and a SIMULATION NEVER CROSSES ONE — it runs inside the calling
  platform, so it is most convincing exactly where it is least informative. A scenario composed
  three blocks with everything inside each one correct, and both live tests stopped at the first
  hop. A seam that cannot be tested yet is a Workaround with the check named, never a Native
  because the tools exist on both sides.
- **The welcome line names no agent.** It is shown only to someone who picked the plain model,
  and naming one team's agent in the app's own configuration hardcoded it for everybody while
  telling a person who chose the plain model on purpose that they chose wrong. It now says what
  the plain model is — no team tools, no platform access — and stops.
- **The smoke suite judges the work, not the conversation.** A scenario passes when zz-core
  appends a close to the ledger; that row is a fact about the work, where everything the old
  path read was a fact about the transcript. Two initiatives closed by the agent in 1.1 and 1.4
  hours were reported as five-of-five failures, because the gate counter behind the old verdict
  incremented only when a regex liked a sentence. It also runs five scenarios at once under one
  account each, drops the planted obstacles and every canned reply in `SMOKE_NATURAL` mode, and
  streams each lane to its own log while it runs.

### Fixed
- **A release's failure output printed a live admin token.** The client-package check
  interpolated the bearer token into a `bash -c` string, and `curl -f` exits non-zero on a
  401 — so the throw carried the whole command, token included, into the failure report a
  person then pastes into an issue. It goes through the environment now, and the redaction
  runs where the problem is RECORDED rather than at each site that might produce one, because
  the next site to hold a credential will not know to. Same shape as the platform redaction
  fixes below, in the tooling this time, and found by the release that failed.
- **Provisioning planted the operator's admin token in each person's account.** Every tool call
  they then made resolved to the operator: documents attributed to someone else, telemetry
  naming someone else, and platform-admin tools in the hands of a member. Measured: with the
  operator's token their agent saw a couple of hundred tools from `casebox`; with their own, 1. The token it stores
  is the person's own, and one is minted with member scope if none is supplied.
- **A refusal message could carry the caller's own data into the record.** A good refusal teaches
  by quoting what was sent — `confirm must repeat the email exactly ('...')` — and the telemetry
  stored that text verbatim. Eight such sites in this platform's own tools, plus refusals from
  third-party blocks that nobody here writes. The redaction now runs where the row is written
  rather than at read time, and `confirm` is out of the identifier list: every tool defining it
  defines it as an echo of another argument, and one defines it as an echo of an email address.
- **A gate could be passed by nobody, on no day.** `approved_by: <your team>` was refused for
  recording nobody while omitting the field entirely was accepted. A gated document now needs
  both `approved_by` and `approved_at`.
- **`revise_document` was the write path that checked nothing.** A document compliant when
  written could have its required section deleted in a revision, with no refusal. Three of the
  five checks are inert for a revision, which is why the gap read as harmless to anyone who
  looked; the other two are not. All three write paths now run all five guards through one
  function, and `revise_document` no longer keeps its own writer beside the shared one.
- **The turn collector skipped turns two ways.** Its watermark was truncated to whole seconds,
  so a turn at 13:47:16.897 produced 13:47:16 — earlier than the row that set it. It was also
  rendered in the session's timezone with a literal `Z` appended: on an Asia/Singapore host that
  is eight hours of turns skipped by every run, and the gap would not heal, because the next
  watermark comes from what was recorded rather than from the clock.
- **`collect-turns.py --since` reached `mongosh` spliced into the script text**, against the
  store that file's first paragraph promises it never writes to. The Postgres half of the same
  file passes every value as a parameter and explains why.
- **The backup cron installer appended a duplicate collector on every run.** Its filter was a
  path pattern kept in step with the commands by hand, and was not — four runs against a stub
  crontab produced four collectors. It also broke for any repository path not ending in
  `zz-stack`, a setting the script itself offers, and treated a failed `crontab -l` as "no
  crontab yet", which would have made its three lines the host's entire crontab.
- **`tool-report.py --fail-under` could not fail.** The empty-events branch exits 0 before the
  rate exists, so a gate asked for a floor returned "all good" for exactly the runs worth
  catching — an `--actor` matching nobody, a window missing the run, an evaluation that died
  before calling anything.
- **`block-conformance.py` picked its read-only probe by name prefix, which is a guess about a
  name rather than a fact about a tool.** A verb like `archive_thread` passes a read-only prefix
  rule and is not read-only. It asks the server's own `annotations.readOnlyHint` first now.
- **A batch's large answer was recorded as unreadable**, because its head was filed under an
  empty key and that key is read back only when there is exactly one call and one answer — wrong
  in the one situation where the key matters. Multi-byte characters straddling a write boundary
  also became U+FFFD, silently, since the JSON around them is ASCII and still parses.
- **`ops-select`'s ledger template produced zero rows.** The skill's Output section says the
  ledger is keyed by acceptance criterion; its Choose section showed a template grouped the
  other way, with no key opening any row. The claim index is non-empty only because the authors
  believed the prose over the example. The template is that table now.
- **A deleted document kept its claims.** Reindexing dropped a vanished document from `zz.doc`
  and left its rows in `zz.decision`, joined against a path nothing would produce again.
- **Two identical plugins for one flow.** Belonging to two teams that both run `ops-flow`
  produced two identical plugin directories, two identical MCP files, and a router offering the
  same flow twice. Blocks were already deduplicated; flows were not.

### Upgrade notes
- **Set `PLATFORM_BASE_MODEL=glm-5.3-flash` in your `.env`.** The new bundle's
  `librechat/librechat.yaml` serves that model; your existing `.env` still names the old one,
  and nothing rewrites it for you. A mismatch stamps every agent with a model the front end no
  longer serves. **`docker compose restart` does not re-read `.env`** — it restarts the
  container with the environment it was created with. Use `up -d --force-recreate`.
- **Installed flow plugins change key.** `sdlc-flow@zz-platform` becomes `sdlc@zz-platform`,
  and the same for every flow whose name ends in `-flow`. Re-install from your package;
  nothing migrates itself.
- **A gated document already marked `approved` without `approved_by` or `approved_at` is
  refused on its next write** until the missing field is supplied. Nothing rewrites existing
  records.
- **A document whose flow declares sections is refused on its next write while `approved`
  unless every declared heading is present.** Affects sdlc `spec.md` and `plan.md`, sm
  `intent.md` and `selection.md`. A heading that says everything the required one says is
  renamed rather than refused, so in practice this lands on a document that genuinely lacks
  the section. Five of six selection documents on this deployment predate the requirement;
  they are not repaired retroactively.
- **`outcome` no longer accepts an arbitrary string.** A close writing anything but
  `delivered`, `accepted`, `abandoned` or `superseded` is refused.
- **Re-run `deploy/install-backup-cron.sh`** to pick up the turn collector's hourly job. It
  replaces its own tagged lines and touches nothing else. Without it the turn record stops at
  whenever somebody last ran the collector by hand — a gap nothing reports, because a
  collector that is not running looks exactly like an hour in which nothing happened.
- **Codex users must register the MCP servers with `codex mcp add --bearer-token-env-var`.**
  The plugin's `.mcp.json` headers are ignored by Codex entirely; the client package now
  carries the command.
- **`zz.event` rows for refused calls hold the redacted refusal text**, not the raw message,
  and no longer carry `ids.confirm`. Existing rows are not rewritten.

## [0.2.0] — 2026-08-26

This release was verified by running it on a host built from bare Ubuntu, with the
unverified parts named as unverified. Releases since have been verified by
`scripts/release.mjs`, which checks live and rolls back rather than writing a document.

**Open WebUI is gone.** The browser front end is LibreChat, and the platform did not move to
accommodate it: no gate, document, envelope, telemetry, knowledge-store or PAT behaviour
changed, and the platform database was untouched — the old front end had been a guest in it,
not its owner.

The reason for the swap was a ceiling, not a preference. Open WebUI ran a chat loop, and a
Operations scenario makes thirty to fifty sequential tool calls; turns stalled with
no output and no surfaced error, and there was no step budget, compaction or pruning to
configure. `AIOHTTP_CLIENT_TIMEOUT=300` was already in the compose file, treating the
symptom.

### Removed
- **`sync_openwebui`, and the whole preset projection.** `install_flow` used to write an
  agent into the front end's own `model` table, which made installing a flow a mutation of a
  product we do not control and left a copy of the registry to drift from it.
- **The Open WebUI import in `seed()`**, and **the group fallback in `teamFor()`** — the two
  paths where a front end was a source of platform truth rather than a projection of it. A
  live check found the fallback matched no user.
- **The Open WebUI bootstrap script, its prompt-sync helper, and the CSV onboarding
  script** — each drove that front end's REST API or wrote its tables — and the `owu` field
  on a block's platform config.
- **Redis**, which existed only to route socket.io events between that front end's workers.
- **`archive_team`'s second half.** It opened the retired front end's database to delete
  from its `group` and `group_member` tables. That schema is gone, so it could only find
  nothing or fail, while telling a reader that archiving a team still has a half elsewhere.
  The dead `OWU_BASE_MODEL` knob went with it — documented, and read by nothing.

### Added
- **`render_agent_definition(team, flow)`** on the admin MCP — the browser agent as data:
  id, name, the system prompt generated from the flow's own manifest, model, and the MCP
  servers it carries. The registry answers; whoever provisions the browser reads it. A preset
  cannot drift from what the team actually runs.
- **`deploy/issue-first-pat.sh`** — the first token on a fresh install. Every other way to
  get one needs one already, so an Open WebUI-free deployment could authenticate nobody: a
  closed loop with no door into it. This is the door, and it is the operator's.
- **the provisioner** — registers a person, stores their platform token
  against every MCP server, connects each one, and creates their agent from the registry.
- **`BOOTSTRAP_TEAM`** — the first team, created on boot with the superadmin as its admin.
- **`my_teams` and `switch_team`** on ZZ Access — which team you are acting for, and how to
  change it. You belong to as many teams as you belong to and act for exactly one at a time.
- **`STATE.md`, beside `CHANGELOG.md`.** What the platform IS at this version, versioned
  with it. The pair is the point: the changelog is the transaction log, STATE.md is the
  balance. It was the "direction" document under `docs/release/`, which read as neither — a
  document describing where you are going has no obligation to be accurate about where you
  are, and it had come to say the old front end still borrowed our database.
- **`npm run chain-check`** — the document chain over MCP with no model in the loop. The
  smoke suite needs a model provider for every turn, so when one is unavailable it cannot say
  whether the PLATFORM still works. This answers that in seconds: gates enforced, chain
  ordered, closing recorded.
- **A `Dockerfile`, and `scripts/build-image.sh`.** The image had been built by piping a
  heredoc into `docker build -f -` from the parent directory, so `docker history` was the
  only surviving record of the recipe and the running artifact could not be rebuilt from a
  checkout. Building one level up also put `.dockerignore` out of scope, so the image copied
  the host's `node_modules` and `dist/` straight in — the exact failure that file exists to
  prevent. The build now installs from the lockfile and compiles inside the image.

### Changed
- **The identity headers between the gateway and zz-core are `x-zz-user-*`**, not
  `x-openwebui-user-*`. Same values, same one writer and one reader.
- **`TRUSTED_FORWARD_HOST` is empty by default**, so the forwarded-header path — a way in
  that rested on a source address rather than a credential — is off unless a deployment
  names a host. **`TRUSTED_PEERS` on zz-core is `cred-proxy` alone.**
- **The smoke engine drives LibreChat.** `build_history`, `push`, `linear` and `chain_len`
  are gone: the front end persists server-side and returns a flat ordered list, so there is
  no message graph to rebuild after every turn.
- **Postgres is named `zz`**, not `webui`, and `WEBUI_*` variables are `WEB_*`.
- **A person acts for ONE team at a time, and chooses which.** It was already one team — the
  platform picked it by role and then alphabetically, which nobody chose and nobody could see.
  It is now a column on `principal`, moved with `switch_team`. One token, one team in view,
  the same rule in the browser and in a CLI harness. A person in one team meets none of this.
- **A team-bound token is for automation**, not for a person who works in several. It still
  outranks the active team, because the point of binding is that it cannot wander — but it
  refuses every other team its owner belongs to, so it is the wrong tool for a person.

### Fixed
- **A gate could be passed by nobody, on no day.** `approved_by: <your team slug>` was
  refused for recording nobody, while omitting the field entirely — the same non-answer —
  was accepted, because the check only ever judged a field that was present. Writing
  `status: approved` alone was a complete gate pass. A gated document now needs both.
- **A member could not provision their own agent.** `render_agent_definition` demanded
  team-admin; reading what your own team runs is not an administrative act.
- **One block dying mid-response took the whole gateway down.** Both relays piped an
  upstream body straight to the caller, and `.pipe()` does not forward errors — an
  unhandled `error` event throws from a socket callback where nothing can catch it. A block
  closing its socket mid-response, routine for a long tool call against staging, exited the
  process; each exit dropped *every* user's session rather than the one request that failed.
  A truncated response to one caller is the correct blast radius.
- **An expired MCP session could not be recovered from.** A session id the server does not
  recognise must answer `404`, and a client receiving it must open a new session; we answered
  `400`, which says the request was malformed and leaves nothing to recover from. Sessions
  are reclaimed after two idle hours *by design*, so this was the normal end of every idle
  conversation: the front end retried on the dead id, exhausted its reconnects, and left the
  agent with no tools mid-conversation. `400` is kept for a request that carries no session
  and is not an initialize.
- **A stand-in block could corrupt its own state and stay down.** `_save` used `write_text`,
  which truncates — so it looked safe. It is a race: two overlapping requests each open the
  file, the longer write lands first, the shorter overwrites only its prefix, and the tail of
  the longer document survives. The result parses as JSON followed by garbage, and since every
  tool reads the file, one spliced write took the block down until someone repaired it by
  hand. Reproduced with two writers and a reader over 300 rounds: 210 unparseable reads
  before, 0 after. Both blocks had the identical `_save`. (zz-blocks 0.2.0.)
- **A starved agent looked provisioned.** A block with no stored credential answers with one
  tool called `credential_required` — indistinguishable from a working server if you only
  count. Provisioning now refuses and names the blocks to fix.

### Security
- **Public registration is closed by default.** The browser is proxied to a public host and
  carries the deployment's own model key, so an open sign-up form is an invitation to spend
  someone else's model budget. This was not a regression — the previous front end defaulted
  open too — but it is now a named switch, and the honest default for a published door is
  shut. `registration.allowedDomains` bounds who may sign up even while it is open, and
  `provision-librechat.py` falls back to LibreChat's own `create-user` so onboarding does
  not need the form.
- **The forwarded-header path is off unless a deployment names a host.** It let a container
  assert who it was with no secret at all, which was necessary when the browser had no token
  to send and is not any more.

### Upgrade notes
- **`ALLOW_REGISTRATION` now defaults to `false`.** Set it to `true` only while onboarding a
  team, and turn it off afterwards — or use `provision-librechat.py`, which does not need it.
- **This is a front-end replacement, not an upgrade in place.** Open WebUI's accounts and
  conversations do not migrate. Its container, volume and tables can be retained, unrouted,
  so rollback stays a proxy change rather than a restore.
- **Set `BOOTSTRAP_TEAM`, `CREDS_KEY`, `CREDS_IV`, `JWT_SECRET`, `JWT_REFRESH_SECRET`.**
  Compose refuses to start without the last four, deliberately — a default would be a
  published secret. Without `BOOTSTRAP_TEAM` a deployment gets a superadmin and no team,
  which looks healthy and writes every document into a per-user store.
- **Run `./issue-first-pat.sh`, then `provision-librechat.py` per person.** Each person
  supplies their own token once per MCP server.
- **`recursionLimit` is 600 in `librechat.yaml` and must stay well above the default 25.**
  A tool call is reported to consume two of the budget, so the default allows roughly twelve
  real calls — a scenario making thirty to fifty fails partway through every run.
- **A gated document already marked `approved` without `approved_by` or `approved_at` will
  be refused on its next write** until the missing field is supplied. Nothing rewrites
  existing records.
- **Everyone who used the old front end must clear that site's data in their browser.** Its
  service worker is installed in each person's browser, not on the server, so it survives the
  migration and keeps serving them the cached old app — which then calls an API that is no
  longer there and shows its own "Oops! Something Unexpected Occurred / 404". Every
  server-side check passes throughout, because nothing server-side is wrong. Tell people
  before switching the proxy, not after they report a broken site.
- **A migration adds `principal.active_team_id`.** It applies on the gateway's next start, to
  a live database, and is additive — nobody's active team changes on upgrade, because an
  unset column falls back to the same team the old rule would have picked. The first
  `switch_team` is what sets it.
- **zz-blocks moves to 0.2.0 with this release.** A host left on the old block image keeps
  the state-corruption bug; the compose file carries the tag, so pulling is not enough — the
  new deploy bundle is.

## [0.1.0] — 2026-08-25

The first release. Before it, the platform ran only as a checkout deployed by hand, so there
is no earlier version to compare against and **Changed**, **Removed** and **Fixed** below are
measured against that running deployment rather than against a published one. They are here
because the deployment is real and someone was using it — not because a released version ever
behaved that way.

### Added
- **The knowledge base in a browser.** `/app` on the gateway: your team's documents, search,
  and comments that the agents read and answer through `list_comments` / `resolve_comment`.
- **A client package per person.** `/pkg/<client>.tgz` renders your access as an installable
  marketplace for Claude Code, Codex or Hermes — the platform baseline, your own keys and
  tokens, and one plugin per flow your teams installed. Nothing you do not use.
- `/release` — a command that walks a release end to end: read the diff, propose a version,
  write this file, gate, build, deploy, verify, roll back on failure, tag last.
- `scripts/gate.mjs` — the checks that must pass before a release leaves the machine:
  manifest lockstep, catalog consistency, both compose files, the bootstrap bundle, `tsc -b`.
- `scripts/set-version.mjs` — sets every package manifest and the compose file's image
  tags from one input. The list is read from the workspace rather than written down, so
  a new package cannot be missed.
- `scripts/release.mjs` — build, push, deploy, verify against the live deployment, and roll
  back automatically if verification fails.
- `deploy/docker-compose.build.yml` — the development override that builds from a checkout.
- `sdlc-flow` — a software delivery flow: explore, spec, audit, plan, audit, execute, review,
  record, plus `sdlc-deck`, `sdlc-tldr` and `sdlc-breakout`. Sixteen skills, four commands.
- Knowledge base retrieval: relevance ranking over full text, tags and evidence links, with
  matched excerpts returned, plus `reindex_knowledge` and a rebuild from the files at boot.

### Changed
- **Installing no longer needs a repository.** `deploy/docker-compose.yml` runs published
  images; a host needs that file and a `.env`, nothing else. The versions are written into the
  compose file, so an empty environment resolves; `ZZ_VERSION` and `ZZ_BLOCKS_VERSION` still
  override, which is what makes a rollback one edit.
- **One image per repo instead of two.** gateway and zz-core are the same image with a
  different `SERVICE`; RuleMill and bookit the same with a different `SERVER_DIR`. They remain
  separate containers — the internet-facing one keeps `/artifacts` read-only.
- **The catalog ships inside the image.** A released version now describes the method as well
  as the code. The build override mounts the working tree back over it for development.

### Removed
- The `hermes` compose service. Hermes is a client, like Claude Code and Codex — not a
  platform service — and it was never started.

### Fixed
- **An approval could name nobody.** `approved_by` and `accepted_by` accepted the caller's own
  team slug, and the live index shows them also accepting a role — "The stakeholder". Both are
  refused: the field records a person, and if you have no name you do not yet have the verdict.
- **A declared gate could be enforced by nothing.** The chain fires on `requires` edges, so a
  gated document nothing required — sdlc-flow's `plan.md` — was declared discipline no code
  applied. Closing now needs every gate the flow declares, on every document that was written.
  `outcome: abandoned` and `superseded` are exempt, because an initiative that stopped is
  precisely one whose gates were never passed.
- **The second flow in the catalog had no way to end.** sdlc-flow declares `spec.md` as its
  closing document and none of its sixteen skills ever wrote an `outcome`, so every sdlc
  initiative stayed open and never reached the team's ledger. `sdlc-record` closes it.
- **An initiative nothing governs was reported, never prevented.** On a team running more than
  one flow, a document declaring no `flow:` produced an initiative with no gate, no required
  document and no closing rule — silently, because the write succeeded. It is refused now, and
  the refusal lists the flows your team runs. A `flow:` naming one you have not installed is
  refused separately.
- **A journal node could be written by hand**, around the tool that numbers it, requires its
  evidence, and writes the index and the append-only log. `_knowledge/` is closed to
  `write_file` and `patch_file`. Its evidence must also name an initiative that exists: of the
  eleven nodes on one deployment, three carried prose and five named an initiative that does
  not, so the field read "checked" for eight nodes nothing had checked.
- **A link in a document ran script in the reader's browser.** The knowledge app escapes raw
  HTML, but `marked` emits `[click](javascript:…)` as a live anchor, in the page that keeps the
  reader's platform token. Link and image URLs are now allowlisted.
- **"Current state only" returned every superseded copy.** `include_superseded: false` filtered
  `status`, which is the journal node's convention and nothing else's, so every frozen approval
  snapshot came back looking like the live document — three rows for one spec. Snapshots now
  carry what they are, and the filter reads both columns.
- **Archiving a team did not have to take.** zz-core could not tell "team archived" from "not a
  member yet" and fell back to the front end's group of the same name, restoring the store, the
  installed flows and the gate chain.
- **The rollback could not roll back**, and **the nightly backup could not have run on a fresh
  install** — an empty volume tars to 87 bytes, under a floor meant to catch a broken one.
  Archives are matched against their source volume now, entry for entry.
- **An initiative could close itself as accepted.** Approvals carry `approved_by`; acceptance
  carried only a date, so the platform could not tell a stakeholder's verdict from an agent's
  account of one. The first live smoke run closed an initiative with `outcome: accepted` and
  wrote the ledger row while the scripted stakeholder had never accepted anything.
  `outcome: accepted` now requires `accepted_by` and is refused without it.
- **The live smoke suite could not be started.** Its preflight read the agent's tools from
  `meta.toolIds`; `/api/models` returns them under `info.meta.toolIds`, so it reported every
  correctly configured deployment as unprojected and refused to run.
- **zz-core answered anything on its network.** It reads the caller from forwarded identity
  headers and trusted them without checking who the peer was, so any container could act as
  any person — read and write every document that person can reach. It now accepts only the
  hosts `TRUSTED_PEERS` resolves to, and is published to loopback alone.
- **A caller in no team reached every building block.** Grants are held by teams, and the
  proxy skipped enforcement entirely for someone who belonged to none — so the absence of a
  grant meant unrestricted rather than nothing. Anyone could reach it: minting your own token
  and storing your own key needs no admin.
- **A document could rewrite its own envelope.** A source reference carrying a newline
  inserted lines into the frontmatter — `status: approved` and an approver of your choosing,
  under the `status: draft` the same call had just written. Rendering can no longer emit a
  value that ends a line, and one parser decides what an envelope says.
- **A revision could change which flow governs its document**, and with it the gates, the
  required documents and the closing rule.
- **A document that merely mentioned `outcome:` closed its initiative** in the browser and
  appended a row to the ledger the OKRs are graded from.
- **Hermes packages carried two files** where Claude Code got forty: the platform's own skills
  were built and then dropped. `deploy/.env.example` was gitignored, so a release cut from a
  clean clone would have shipped a bundle without the file the install instructions read.
- The nightly backup aborted on dumps that were complete, and `add-user.py` exited 0 when
  every platform-side placement failed.

### Upgrade notes
- **The close is two fields: `outcome` and `accepted_by`.** No date — the ledger row the
  platform appends at that moment carries it, and the hand-written one had two spellings and
  no readers.
- **`initiative_status()` with no argument returns `{ open, closed_not_listed }`**, not a bare
  array. It promised open initiatives and returned every initiative; on one store that was
  eight, seven of them closed. Naming an initiative is unchanged.
- **`ZZ_URL` and `ZZ_PUBLIC_URL` have no defaults.** `add-user.py`, `set-credential.py` and
  `release.mjs` all defaulted to the gateway of the deployment this repo is developed on, and
  all three send a bearer token to it. Set the address or they refuse.
- **sdlc-flow's `contract.state` is gone.** The spec carried it beside `status`, giving two
  answers to "has this been agreed?", and only `status` was ever enforced or moved.
- **`MCP_BIND` is gone.** It set the gateway's bind address; use `GATEWAY_BIND`. Internal
  services take `INTERNAL_BIND` and the database `POSTGRES_BIND` — they were one variable, so
  widening the gateway's reach used to publish zz-core beside it. A deployment still setting
  `MCP_BIND` silently returns its gateway to loopback.
- **`OLLAMA_API_KEY` is gone.** Use `LLM_API_KEY`, beside `LLM_BASE_URL`. Nothing warns: the
  model connection simply has no key the next time the bootstrap runs.
- **`GATEWAY_PUBLIC_URL` has no default.** It is the address every client package embeds, and
  the gateway now refuses to build one rather than guess. Set it before anyone installs.
- **A pre-rename agent preset is no longer deleted for you.** A deployment still carrying a
  `product-agent`, `flowsmith`, `flow-builder` or `solution-agent` row should remove it.
- `deploy/.env.example` lists every variable this deployment reads, each with its default.
  It is worth re-reading after this release: several of the names above are new to it.
- Installed clients need `claude plugin update <name>@zz-platform` to pick up skill changes.
  The plugin cache is keyed by version directory, so a client that does not update keeps
  running the old skills and nothing warns it.
