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
by `zz-stack/scripts/release.mjs`; separate lifecycles never meant separate deployments.

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

- **`deploy/Caddyfile` and `STATE.md` named addresses that belong to another platform.**
  The Caddyfile carried a hostname literal from before this became a single deployment, and it
  had gone stale. `STATE.md` stated one of them
  as the live gateway. Repointed at the deployment this repository actually targets, and the
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
