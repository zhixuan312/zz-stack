# History — what each release delivered, 0.23.0 onward

The release-by-release record of this platform. It was §6a–§6s of [STATE.md](STATE.md) until
0.34.0, and it left for the reason STATE.md's own opening gives: "the changelog is the
transaction log, this is the balance. A reader asking 'what changed in 0.2.0' wants the
changelog; a reader asking 'what IS this platform' wants this." Nineteen version-by-version
sections describing what changed are the first kind of material, and they had accreted on the
second kind's side of that line until STATE.md was 1309 lines and the balance was 40% of it.

**This is not CHANGELOG.md and does not replace it.** The changelog is every change, written
for somebody deciding whether to upgrade. This is one entry per release saying what that
release was FOR and what it turned out to cost — the reasoning, kept because the reasoning is
what the next decision needs and a diff cannot carry it.

**Where this file starts, and why there.** 0.23.0 is where the platform became one person, one
host and one door: before it there were two environments, a browser front end we did not own,
an external identity provider and a separate admin package. Every entry here therefore
describes the platform that still exists. Everything before 0.23.0 describes one that does
not, and is in [HISTORY-PRE-0.23.md](HISTORY-PRE-0.23.md).

**The rule for the next split, stated so nobody has to invent one.** No file here may pass 700
lines. When this one does, the oldest CLOSED era moves down into its own file the same way —
by the version at which the platform changed shape, never by cutting at a line number. A split
made to hit a number produces fragments; a split made at a shape change produces two documents
each of which is about one platform.

Newest first.

## 0.33.0 — every plugin can be evaluated, and running it is what found the defects

**Held to this section's bar.** Everything below was measured on 2026-09-13 — by running
`claude plugin eval` against all four plugins on this shelf, and by querying the deployment —
not by reading the code that was supposed to do it.

**Four plugins, eight cases, and three of the four could not be evaluated at all before this.**
`zz-access` and `zz-plugin-eval` had no case suite and no run history, and both blocks empty is
the one condition that stops the flow. `zz` had one case. Cases need no history, so a suite is
what makes a plugin evaluable the day it ships — and writing one for each is what closes the
gap between "the platform can evaluate a plugin" and "the platform can evaluate its plugins".

**What running them found, which reading them had not:**

- **The blind control was not blind.** The document fallback excluded the round's own items and
  nothing else, so it took `2026-09-13-console-brand-adoption/plan.md` — an initiative that ran
  sdlc-flow. Control 4.00/5.00 against real 4.00/5.00, and the round was read as "this ruler
  does not discriminate" when what had been asked was whether two sdlc documents score alike.
  The exclusion is by initiative now, because an initiative that ran a flow also holds documents
  the platform stamped no flow on.
- **And after the fix there is no same-kind control left on this deployment.** Measured: every
  candidate that survives is a `_knowledge` node, because every non-node initiative here has run
  sdlc-flow. A ten-line node marked against a spec ruler scores low for the wrong reason, so it
  is kept as the last resort and `control_read` now says in the string itself what it is and
  what it does not prove. A real control for sdlc needs a second flow on this platform.
- **`zz` could never have produced the finding the tool exists for.** `entryOf("zz")` is
  undefined and every caller fell back to an empty tool list, so `never_called` was empty by
  construction for the one plugin every account installs — and read as a clean bill of health.
- **Recording a case run would have stored nothing readable.** The parser read three top-level
  keys the CLI does not emit; the numbers are under `aggregates`. A suite that measured
  perfectly came back as unreadable.
- **The evaluation flow cannot be reached by asking.** Over nine runs across the three questions
  it exists to answer, asked in ordinary words with the plugin installed, nothing in it engaged
  and the delta was zero on all three. The cause is structural, not a wording slip: a flow's
  `entry` skill ships as a COMMAND carrying `disable-model-invocation: true`, so no model can
  open it whatever its `when_to_use` says, and the five stage skills beside it each say "never
  on its own", which is correct — a stage firing out of order is worse than one that does not
  fire. That is what "a person invokes this on purpose" costs, stated as a number. Its cases now
  name the flow, the way a person does, so they measure the flow's content rather than the
  shelf's routing.
- **No audit stage has ever reached the door.** `zz.event` holds not one `sdlc-spec-audit` or
  `sdlc-plan-audit` row in its whole history, because a dispatched auditor in Claude Code loads
  its skill locally. A return is a relation between stages, so every `spec → audit → spec` on
  this platform reads as a straight line.

**And the same lesson twice, from two directions: a capability that ships as a COMMAND cannot be
reached by a case that asks in words.** `zz-doctor` does not ship as a skill at all —
`marketplace/zz-access/skills/zz-doctor/` holds `doctor.mjs` and no SKILL.md, because the three
typed capabilities of the plugin that ships it render as commands with
`disable-model-invocation: true`. (It was `marketplace/zz-core/` when this was measured; the
skill moved to zz-access on 2026-09-14 and the finding travelled with it unchanged.) A case grading
`Skill(zz-doctor)` therefore scored 0.00 on every grader in the with arm, for a capability that
is present and works. What makes this worth a section rather than a footnote is that the failure
is silent in the direction that matters: the suite reports a delta, the delta is zero, and zero
reads as "this plugin adds nothing here".

**A prediction that was wrong, kept as written.** zz-access's `kills-it-first` grader predicted
a delta of ~0.8 and measured 0.00: a bare agent told a credential was visible in a forty-person
channel revokes it first as readily as the plugin does. The case is unchanged and the
measurement is recorded beside the prediction, because a case edited until it flatters its
plugin ends the series — nothing after it compares with anything before it.

**What is NOT claimed:** that these eight cases are the right eight. They are the first eight,
each one written from a rule its plugin states in its own text, and three of them measured a
delta of zero on their first outing.

## 0.32.0 — the subject of an evaluation is a plugin, and it has not been run

**Held to this section's bar, which means saying what is NOT verified.** Everything below is
in the release and none of it has been exercised against the deployment, because migrations
`047` and `048` apply on the gateway's next start and that start is this release.

A plugin is what a person installs — a flow's skills plus the MCP servers those skills call.
The platform evaluated the halves separately and could see neither of the two things that
decide whether the whole works: whether a flow that goes wrong can return to an earlier stage,
and whether a tool its own skills name is ever actually called.

**Two kinds of evidence, and the second one is new to this platform.** TRACES come from the
event log and need five usable runs. CASES come from `claude plugin eval`, which runs a suite
twice — with the plugin and without — and reports the delta. That is a COUNTERFACTUAL, which
no score can give: it says the plugin caused the outcome. It needs no history at all, which is
what makes a plugin evaluable the day it ships. Each block carries its own sufficiency and only
both empty stops the flow.

**What is verified about it, and it is not the flow:**
- One case ran end to end against the shipped shelf — `Plugin under test: "sdlc" version
  "0.31.0+600dd6c5"`, two arms, with-arm 0.75, $1.40. The ablation resolves and both arms run.
- That run paid for itself: a grader keyed on `Skill(sdlc-spec-audit)` scored 0 in all three
  with-arm runs, not because the plugin failed but because `sdlc-method` DISPATCHES an audit to
  a subagent whose transcript the parent's tool log never sees. It measured the harness and
  understated the plugin by a quarter every run.
- `047` and `048` apply as a pair, verified in a rolled-back transaction against the live
  database. Every affected table held zero rows, measured rather than remembered.
- 199 queries across `services/`, `packages/` and `scripts/` PREPARE against the post-`048`
  schema. Nine readers of dropped columns were found and fixed; the ninth was in a route
  nobody was looking at, with the gate green over it.

**The flow has since been run, and 0.33.0's entry above records what it found.** This paragraph used to say
`/zz:zz-plugin-eval sdlc` had never been run and predicted it would take the full path. It has,
it did, and the prediction was worth exactly what this section says predictions are worth: the
round it produced was void, because the control it took was another sdlc document.

**Three write tools exist because their absence was found three times.** `plugin_cases_record`,
`plugin_ruler_record` and `plugin_finding_record`. Each closed a hole where the flow READ a
table nothing could write: the case results are produced by a CLI on somebody's laptop and
zz-core is a container that cannot see them; a ruler was written into a document and never into
a row, so the judge would have refused forever with the gate green; and `zz.eval_finding` lost
its only writer when the old evaluation went. The shape was one shape three times — the design
specified what the flow reads and under-specified what it writes.

## 0.29.0 — one client, and a shelf anyone can read

The client package stopped being a tarball behind a token. `claude plugin marketplace add
zhixuan312/zz-stack` clones a shelf committed to this repository — `build-marketplace.mjs`
renders it, through the same `buildClientPackage` the gateway has always used, so there is
one renderer rather than two. The old path put a credential in front of the tools a person
installs in order to obtain one: `curl -H "Authorization: Bearer $ZZ_TOKEN" /pkg/…` ran
before `marketplace add`, so somebody with no token had no way to install the tools that
issue one. Nothing is given away by publishing it. Every tool the shelf lists is a door at
the gateway, and the door still answers 401 — the shelf was never the boundary.

Build output under version control drifts, so a gate check rebuilds the shelf and fails on a
dirty tree. A red gate leaves the fix already written.

**Codex and Hermes are gone, and the `clients` matrix with them.** Nobody ran either. What
they cost was not two branches: it was a tarball route, a hand-rolled ustar writer nothing
else called, two more install stories, and a three-set intersection — what a flow can run on,
what a team wants, what the platform supports — threaded from the manifest through
`install_flow` into a database column, to decide something that now has one possible answer.
`isLocalOnly` went the same way: it chose between shipping a flow's skills as files and
leaving a pointer, and the pointer side existed for the browser front end removed in 0.28.0.
It had been true for every flow it was ever asked about since.

The marketplace is called `zz-stack`, the same word as the repository it is cloned from.
`zz-platform` was the shelf AND the platform's own team, which meant one word for two
unrelated objects and two names for one shelf.

## 0.28.0 — one front end, one set of APIs, and nothing that is not the package

The platform served three browser surfaces and now serves none: `/app` was a knowledge-base
browser with its own PAT login and its own read API over data the console already serves, and
`/architecture` was an unauthenticated page about the platform. Both are gone, with `kb.ts`
and the API behind `/app`. The console is the front end and `/api/console/*` is the API.

`docs/` is no longer part of the package. What was under it was working material — findings,
walkthroughs, a release record — and the one file that was genuine package documentation is
`ARCHITECTURE.md` at the root, which the gate and `console/catalog.ts` now name.

**The rule the repository is now written to, because it is publishable:** a count that is a
property of THIS repository is exact; a measurement of anything else is written as a shape.
Two gate checks hold the line — one refuses an address, a routable host or a credential
anywhere in the tree, the other refuses a stand-in block written about as a real deployment.
Both were proven by break-test before being trusted, which is the only reason to believe a
check that is green on a tree somebody just cleaned by hand.

Sign-out is a POST. The console applies a URL policy to document markdown: a link is
navigation a reader chooses, an image is a fetch nobody agreed to.

## 0.27.0 — the doctor, and the difference between "wrong" and "could not look"

**`npm run doctor` asks where the deployment stops matching what this checkout declares.** Six
layers, each with one source of truth on the repository side and one on the deployment side —
repo, image, host, doors, contract, data — asked in the order that makes a diagnosis, because
the first layer that disagrees usually explains every layer after it. Later disagreements are
tagged `downstream of <layer>` rather than counted as independent defects. It changes nothing,
and a gate check enforces that rather than a sentence in its header promising it.

**It exists because of a specific hour.** 0.26.1 deployed, and the release's own verification
reported six failures — "gateway /health: PUBLIC is not defined" — which were ReferenceErrors
thrown INSIDE the verifier by the release.mjs split. A healthy platform was rolled back by the
thing checking it. The old runner had one `catch`, and everything it caught became a verdict
about the deployment.

**So there are three verdicts, and a release has three outcomes.** `wrong` — the two sides
disagree — rolls back. `unknown` — the probes could not look — leaves the new version live and
**untagged**, because rolling back undoes a release for a reason that was never about it and
tagging stamps a version nothing verified. The rule underneath is `a probe may throw only for a
PRECONDITION; once a request is sent, the answer is returned` — getting that wrong the other
way is worse, and did happen in draft: curl exits 7 on a refused connection, so a crash-looping
gateway threw out of seven probes and would have been TAGGED.

**Release step 5 runs these probes and owns none.** Its eleven lived in the release and ran for
forty seconds a release and at no other time, which is exactly how three of them came to call
names they never imported without anybody finding out. One list, run daily; a gate check
refuses `verify.mjs` if it grows a probe again. The release verifies 16 probes where it
verified 11, and the doctor asks 23.

**The contract layer is what the 0.26.1 restructure needed and did not have.** A door that
fails to mount does not answer 500 — it answers 200 with a shorter tool list, and every health
probe stays green. It compares the live tool list against what the source registers, by name
and by module. That proof was done by hand, once, because nothing could do it.

## 0.26.1 — nothing is over 700 lines, and the gate says so

**Nine files held sixty-nine subjects between them.** `scripts/gate.mjs` was 11,428 lines,
`zz-core/src/server.ts` 5,270, the console's API 2,071. The 0.26.0 audit read every file and
found the code honest; it never asked whether the code was reachable by a reader.

**Each entry file now states the ORDER or the DOOR, and the modules hold the work.**
`gate.mjs` is 67 lines of `import` — one per subject — and `report()` refuses to pass unless
the number of checks written under `gate/checks/` equals the number that ran, because a module
missing from that list is a check that silently does not exist. `zz-core/server.ts` is 290
lines and its 29 tools live one door per file under `src/tools/`. `release.mjs` is 556 and one
step per file. The console API is 70 lines over seven resources; `settings.ts` splits by
AUTHORISATION rather than resource, so a route in the wrong file looks wrong.

**700 lines, measured rather than chosen, with no exemption list.** Above it every file here
held a whole second subject; `judge.ts` at 676 with three exports is genuinely one. A list of
files allowed to be large is a list nobody prunes. The gate is **328 checks** and the console's
gate holds the same ceiling. Stated beside the rule is what it cannot do: `identity.ts` is 619
lines with seventeen exports and passes, because line count finds "definitely too big" and
never "more than one subject".

**Nothing here was verified by reading, because the failure this restructure invites is a
check that greps a file by path and stays green after the code moves out.** Both before and
after are green; a verdict diff cannot see it. So: 273 verdicts diffed at every commit and
identical every time, the live `tools/list` diffed against the rebuilt binary (29 tools,
schemas byte-identical), the console route set diffed verb-for-verb, `--preflight` and a full
`--dry-run` run end to end, and roughly twenty mutation tests planting a real violation at each
new boundary. Four checks turned out to be reading nothing or the wrong thing. They are fixed.

## 0.26.0 — every file was read, and what it found was not dormant code

**449 files across both repositories, each read and given a verdict with its evidence.** The
audit that produced this section is gone from the tree, as its own design document promised —
what survives is ten gate checks and the changelog entry, because a finding that only lives in
a report is a finding somebody has to remember.

**The expensive things were not dead code. They were things that looked like they worked.**

- The platform had **no backups**. The nightly run wrote all three archives, then dumped a Mongo
  removed on 2026-09-10, and its own cleanup — "an incomplete run must not leave a file that
  reads as a backup" — deleted all three. An empty directory and no log.
- **713 lines of security checks had never been run.** `check:redaction` drives the real
  redaction predicate; `check:scope` drives the real authority rules. Every mention of them in
  the source was a comment saying they drive the real thing — true, and describing something
  that had never happened.
- **The console's own gate was red**, and nothing ran it.
- **The design audit was measuring the sign-in screen** for all ten pages, because it has no
  authentication step, and reported a disciplined-looking three type sizes and no radii.
- **STATE.md's §6 described a platform that was dismantled** — the Operations flow
  "running on LibreChat", a five-scenario standing evaluation. It is re-established against the
  deployment, and every claim in it was checked by calling the platform while writing it.

**Three findings were overturned by reading one more file, and all three were wrong in the
same direction — they made the audit look more productive than it was.** `decision_block` was
release sequencing with a written plan, not an abandoned normalisation. The evaluation track is
not implemented twice; the two halves score different subjects. Twenty-three files recorded
dormant were reachable, and the eval tools answer on the live door today. In each case the
mechanical evidence was accurate and the conclusion drawn from it was not.

**The evaluation track stays.** Zero rows in five tables is nobody having used it, not nothing
being able to. That was the owner's call and it is recorded as one.

## 0.25.0 — a deck is built in stages, and the record says who looked

**`/sdlc:deck` scaffolds, then fills one slide per edit.** It used to read a 252KB template and
emit a 53-slide deck in a single write. The load-bearing reason that could not hold is not a
claim about model quality: `max_output_tokens` is a hard cap far below the context window, so a
long deck in one write is simply truncated. The template is split — `deck-chassis.html` is the
runtime a scaffold copies, `deck-guidebook.html` is the 53 worked examples to consult — which
cuts what a model must read to start by 68%, and the output is staged. Those are two
independent fixes and it needed both.

**Verified by running it, which is how the rest of this release's findings arrived too.** A
Sonnet worker built 11 slides from a 71,905-character spec: scaffold 1:1 with the plan, one
edit per slide, no batching, nothing left unfilled. **One claim failed.** An interrupted run
leaves a valid, openable file and does NOT show which slides are unwritten — the placeholder is
an HTML comment, comments render as nothing, and 7 of 10 slides were blank rectangles that the
deck's own `?qa` panel reported as identical to finished ones. Silently truncated became
silently blank. That is better and it is not what was promised; fixing it changes the
placeholder format and is separate work.

**`document_approve` says whether anything fetched the document since its content last changed.** The
platform has always asked for `document_present` before a gate — a person approves bytes, and the
fetch is the only part of "I put it in front of them" that reaches the record — and nothing
ever said so at the moment it was skipped. The initiative that produced this release closed
with four of its six approvals carrying no fetch, an eleven-task plan among them, approved
twice and fetched never. **It reports and does not refuse,** and that is a standing decision,
not an unfinished one: a refusal there would land on the one call whose job is to record a
verdict a person already gave. A standing "approve without checking with me" waives their
REVIEW, not the fetch.

**Where a script can decide it, a script decides it.** `shownSinceLastChange` is a function, not
a paragraph asking a model to remember. The console derives which version numbers were consumed
by a revision and never frozen — `_versions/` holds one copy per APPROVAL while the counter
advances per REVISION, so `v1, v3, v4` is the rule working and read as data loss. And the check
guarding all of it RUNS the code rather than reading it (`checks/attest-shown.mjs`); the gate is
269, from 268.

## 0.24.0 — one door, and the tool list is the role

**The admin door is gone, and it was never a boundary.** `/admin/mcp` said so in the platform's
own door index — "any member; each tool authorises per call" — and behaved accordingly: a
member-scope token opened it, listed all twenty tools, and was refused by every one. A URL that
admits everybody sorts nothing. What the split actually bought was a shorter tool list, and it
leaked even at that, because the two operator tools for storing a key on somebody else's behalf
sat on the MEMBER door, where the credential store is.

**So the list is shortened by the thing that was doing the work.** `/manage/mcp` builds its
tool set per request from the caller's role — 20 tools for a member, 24 for a team admin, 34
for a superadmin — and the predicates are the same `isSuper`/`isTeamAdmin` the handlers call,
never `platformRole`. That equality is the property worth stating: **visibility is exactly
executability.** A superadmin holding a member-scope PAT is not super for that request, so they
are not offered tools that would refuse them, and the gate refuses a build where the two are
derived differently.

**Authorisation did not move.** Every handler still resolves the caller from the database and
checks for itself, because "administers some team" is not "administers THIS team": a team
admin carries `install_flow` and is still refused the team they do not lead, with its reason.
The role filter is ergonomics; the handler is the boundary. What a member loses is the
explanation — a refusal that said "superadmin required" now says "tool not found" — which is
why `whoami` is registered for everyone and why both skills say a missing tool is a fact about
your role.

**One plugin follows the one door.** `zz-admin` is folded into `zz-access`, which ships two
skills: `zz-access` for the person in front of you, `zz-admin` for everybody else. A package
whose whole content was MCP wiring and no instructions is the shape 6j's predecessor kept
producing; there is no longer one in the catalog.

## 0.23.0 — one person, one host, one door

**This platform belongs to one person now, and almost everything 0.23.0 does is subtraction.**
LibreChat and ops-flow are gone, with the smoke suite and the onboarding timer that existed to
keep a browser front end honest; the third-party building blocks live in their own
repositories; the two shared environments are one host. What is left is the SDLC flow, our own
MCP, and the console.

**The console's door is a passkey, and there is no other.** An external identity provider's
value is telling us who somebody is when we do not already know — we do, and its principals
are created from the back end, so what the provider bought was a consent screen, a list of
permitted test users and a client secret to rotate. A passkey asserts possession of a private
key we hold the public half of, which is the fact we wanted, with nothing to rotate and nobody
else in the path. Sign-in asks for no email: the credential is discoverable, so the browser
offers what it holds and the person picks.

**Nobody registers themselves, and that is structural rather than a convention.** An OpenID
sign-in could create a principal it had never seen, because the provider vouched for the
email. Nothing vouches here — an authenticator asserts possession of a key, not an identity —
so registration requires an enrolment token naming a principal that already exists, and reads
the principal off that token's row rather than off the request body. The first link is minted
on the host, because before anyone has a passkey there is no superadmin session to mint one.

**What it costs, said here because it is easy to meet by surprise.** A credential is bound to
the RP ID, which is `CONSOLE_PUBLIC_URL`'s hostname, and ours encodes the droplet's IP address.
Move the host and every registered passkey stops verifying at once. It is not a lockout — the
host mints fresh links — but it is everyone re-enrolling.

**The release ships two components to one host.** `--env`, `ZZ_DEPLOY_HOST`, the
per-environment tokens and the zz-blocks half of the release are gone; `ZZ_TOKEN` in the
repository's own gitignored `.env` is the only credential, and preflight now reads it through
the same function the release does — it read a different one, so a token in the documented
place made the release work and made preflight report "no token found".
