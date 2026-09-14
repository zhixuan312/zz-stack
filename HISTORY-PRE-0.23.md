# History before 0.23.0 — the platform that was assembled

What each release delivered from the beginning up to 0.21.0. It was §6a–§6i of
[STATE.md](STATE.md) until 0.34.0; [HISTORY.md](HISTORY.md) carries 0.23.0 onward and its
header states why the two are split there.

**Read this as archaeology, not as documentation.** The platform these entries describe is
gone: two environments, LibreChat as the front end, an OpenID provider, ops-flow, a separate
`zz-admin` package, component-level evaluators. Where an entry here disagrees with
[ARCHITECTURE.md](ARCHITECTURE.md) or STATE.md, those are right and this is a record of what
was true at the time. Nothing is corrected here, because correcting a past entry is how a
record stops being one.

Newest first.

## 0.21.0 — the team discusses, and the platform writes what they decided

**What 0.21.0 adds is the other half of the console initiative: a document can be talked
about, and the talking is what produces the next version.** `zz.discussion_message` is a
gateway-owned, append-only thread keyed to one document. Its sequence is assigned inside the
insert and a unique constraint on (team, initiative, path, seq) is what makes it a database
guarantee rather than an application convention — two appends racing for one number produce a
rejection, retried once, rather than a thread that silently reorders itself.

**It arrives without being asked for.** Server-sent events over an in-process EventEmitter
keyed per thread, so the listener count that matters is people reading one document rather
than everyone on the platform. The replay-versus-subscribe race is closed by subscribing
first and de-duplicating on drain; reading the database first would drop whatever landed in
between. It is single-process and per-container by construction, and the `after=<seq>` cursor
is what makes that recoverable rather than fatal — a client reconnects with its own last seq,
which is also why the browser does not use native EventSource retry: that reopens the URL it
was built with, carrying a stale cursor.

**Neither host could have delivered it.** Caddy sets `flush_interval -1` on the LibreChat and
api hosts and did not on the console host, which was added later — so a stream would have
been buffered and the thread would have appeared to hang rather than fail. That is fixed on
both hosts and `deploy/Caddyfile`, which described neither the console host nor the ten block
OAuth handles both machines actually run, now describes what they serve.

**The platform authors the revision.** Nobody hand-edits markdown in a browser; there is no
editor. A route reads the thread server-side, generates the next version from it, and stores
the discussion verbatim as the source — the same string the model read, so the evidence is
provably what the revision was made from rather than a summary of it. Nothing reaches zz-core
unless generation succeeds, and the new version lands as a draft with the approval cleared,
so generation can advance no gate.

**And a team can ask its own folder.** Retrieval is the existing `knowledge_search`, called as
the caller and therefore already scoped; the route adds generation only. Citations are built
from what was retrieved, never from the model's prose, and a citation the console cannot open
— the shared platform shelf is pooled into that search but its documents 404 outside their own
team — is named as plain text rather than linked to a page that would refuse it.

**The LLM credential never reaches the browser.** One server-held client, per-deployment, that
cannot throw at import: a deployment with no credential still boots and serves everything
else, and the route answers 503 naming the unset variable. A gate check runs the built module
with the variables stripped to prove exactly that, and scans the console for any import or
literal that would leak it.

## 0.20.0 — the console stops being a window and becomes a door

**What 0.20.0 adds is that the console shows one team's work and can act on it.** Every
`/api/console` read was platform-wide by design — the file said so: "the console shows every
team's work at once… SsoAuth is the fence." Three endpoints reached that state through a
fail-open predicate, `($1::text is null or team_slug = $1)`, where a missing `?team=` made
the condition true for every row; four more took the team from the URL with no membership
check at all, so any signed-in person could read any team's documents by typing a slug.
`resolveScope` replaces both with a union that has no unscoped member — a caller is one
team, the platform, or refused — and a gate check refuses a console query that can fall back
to every team.

**A document can be approved from the browser**, proxied to zz-core as the caller so the
platform stamps `approved_by` itself, exactly as it does for an agent. That is the first
write `/api/console` has ever had, and the check standing behind it is that every console
write route records the door it came through: the tools these routes wrap log with domain
detail and no door, so a route that merely calls one inherits the guard but not the audit.

**There is a second way in.** A password verifier on `zz.principal`, scrypt over `node:crypto`
with no package added, for a person the directory does not cover. The door a session came
through is a new `door` field and deliberately NOT a fourth value of `Identity.via`:
`mayReadConsole` is the literal test `id.via === "session"` and is the whole console read
gate, so widening that enum would have locked every browser session out, corporate directory included.
The sign-in endpoint refuses wrong password, unknown email and deactivated principal
identically, pays a real scrypt cost on every refusal so it cannot be asked whether an
account exists, and throttles per address and per account on the forwarded client address —
`trust proxy` is the number 1, because `true` would let a client prepend an address and pick
its own bucket.

**Settings exist at three tiers**, and the tiers were already in the code: `superOnly`,
`teamAuthority`, and the `my_*` / `*_team_*` / `admin_*` naming the credential tools have
always used. A member manages their own credentials, tokens and block connections; a team
admin their team's membership and flows; a superadmin people, teams and block access. No
response carries a secret — one redactor, failing closed on any field whose name looks like
one, so a column added later is redacted by default rather than leaked by default. The single
exception is a newly issued token, shown once.

**Two engines now check what review cannot.** `check:scope` drives the real authority
functions, `check:redaction` every settings response shape. And `check:sql` — which needs a live migrated database and had
therefore never been run here — prepares 173 of 193 statements against a real schema; the
eleven console queries that scoping had turned into runtime-assembled text are back to paired
static literals, because this repository's SQL checker exists precisely because 0.4.0 shipped
a query Postgres refused to parse.

**What is not here yet:** the discussion thread, the platform-authored revision, and the
question-and-answer surface over a team's knowledge. Those are the second half of the same
initiative.

## 0.18.0–0.19.0 — knowledge is written twice, and the console ships as an image

**0.19.0 changed only the release tooling and gets no section of its own** — a build script is
not the platform, and a heading per script change is how a state document turns into a
changelog. What it settled, in one line each: a release goes to UAT unless somebody says
production; one version can reach both deployments, so a component already in the registry is
deployed rather than rebuilt; and `ZZ_DEPLOY_HOST` still means production, because
the sync script read it to decide which host it must refuse to `rsync --delete` onto.
(Both of those are gone now, and so is the sync script itself: deploy/sync.sh was deleted
on 2026-09-11. A host receives the release bundle and runs published images; nothing
rsyncs a working tree onto one any more.)

**What an initiative learned is worth more to the next one than its deliverable is, and it
disappears when the conversation does.** The knowledge base was one shelf belonging to
`zz-platform`, so a lesson a team learned about its own stakeholders had nowhere to live that
was not everybody's.

- **Two shelves, and the write names one.** `knowledge_add(scope: "team" | "platform")`. Team
  nodes stay the team's; platform nodes must be about a registry entry. There is no default,
  because the shelf is a decision and guessing it wrong puts one team's material in front of
  everybody.
- **The handover is a step every flow inherits, derived from the manifest rather than wired
  into a stage list.** `initiative_status` answers `action: handover` until a node names this
  initiative; the handover carries a gate so the team approves what was distilled; `initiative_close()`
  refuses an initiative whose handover is not approved. `learnings.md` is abolished and
  sdlc-flow's own closing skill is deleted — `zz-handover` is the only skill that writes
  knowledge, for every flow. (The retired skill is not named here on purpose: a gate check
  holds that nothing outside the changelog mentions it, because a document naming it is
  indistinguishable from one that still expects it.)
- **A node is added because it earns its place.** An initiative that learned nothing general
  says so rather than minting filler; the platform does not count documents to prove a step
  ran.
- **The console's shelf filter turns itself on.** No console code moved: the team control was
  written to appear only once there is more than one shelf, and until now there never was.
- **The console is a released component.** Its own version (0.1.0), its own image, its own
  compose literal, released by `scripts/release.mjs` beside zz-stack and zz-blocks. It had
  been reaching production by rsyncing source to the host and building there, which is how
  production stopped running published images without anybody deciding to. One release, three
  components; the only file on the host is the console's compose file.

**What a live run found, and the check that came out of it:** on `zz-platform` the team shelf
IS the platform shelf, so a promises-kept count was satisfied by the wrong nodes. The gate now
holds that an approved handover kept the team nodes it promised.

## 0.17.0 — five rules leave prose for code, and nobody onboards by hand

**A rule stated in skill prose is a prompt, and it varies by interface. A rule stated in
server code holds identically everywhere.** That sentence is the whole release. Five
behaviours moved across the line, each one chosen because a live run had already shown the
prose version being routed around.

- **`document_present`** puts a document in front of a person: envelope facts, then the body
  verbatim, never a summary. Every document-writing stage now names it. **The fetch is
  recorded** as a `shown` entry with the path, version and caller — so "was this ever fetched
  before its gate was approved" is answerable from the initiative's own log. That is
  detection, not prevention: a tool result is model input, and the platform cannot vouch for
  a pair of eyes. The refusal that WOULD make it impossible is named and deliberately unbuilt.
- **Three tools stopped discarding a supplied value.** `initiative_close()` given both an acceptor and a
  no-signoff reason preferred the acceptor and dropped the reason; `knowledge_reconcile()` given both an
  initiative and a block answered one and ignored the other. Both now refuse and name the
  contradiction.
- **`document_revise` accepts `self_edit`** — the record could not tell "no cause" from "cause
  not captured".
- **A spec's acceptance criteria are indexed at all.** The reader anchored at a bold key at
  line start, so a flow writing `- [ ] **AC-6.1**` had its requirements indexed AS its criteria
  and its criteria indexed nowhere — and the console displayed that under the heading
  "acceptance criteria". The console no longer claims to show criteria either.
- **A version snapshot is indexed when it is written**, so the console's version chain — built
  months ago and dark — renders every earlier draft with its diff and its causes.

**Onboarding is automatic.** A corporate directory sign-in gets a principal, the default team and every
agent that team's flows imply, from a timer on the host. The unit is the TEAM: install a flow
and the next tick gives it to every member. Membership happens once, recorded as a `zz.event`
of kind `onboard`, so it can never re-add somebody an administrator removed. It is a polling
job rather than a hook because LibreChat authenticates against SsoAuth directly with its own
OIDC client — the gateway never sees that sign-in, so there is nothing to hook.

**The console runs in production**, for the first time, beside UAT's. It needs the four
`SSOAUTH_*`/`CONSOLE_PUBLIC_URL` values on **`cred-proxy`**, which is what serves `/auth/*`.

**What is NOT verified.** Two acceptance criteria in the initiative behind this release name
method `human` and no human has answered them: whether `document_present`'s output reads as a
document, and whether the spine's prose still overstates what the code does. Both were
exercised by an agent, which is the weakest possible reviewer of its own output.

## 0.15.0 — a package declares what it is, and nothing infers it

`zz-admin` sat in the console's flows tab beside `ops-flow`. It is not a flow — no stages, no
documents, no skills directory, an MCP surface and a hand-written prompt — and nothing in its
manifest said so, because the console had been inferring shape from contents.

The field that should have said it was already spoken for. `kind: "platform"` meant OWNERSHIP
(ZZ owns this, every account has it, a team cannot install it) while being named for SHAPE, and
`catalogEntry` carried the comment "ANY `kind` means not a flow" — false about three of the
five packages that had it, since `zz-skill-eval` is shelved and has five stages, two documents
and a gate. `governingPlatformFlows` then re-inferred flowness from `documents.length > 0` to
work around it.

**What was true then:** a package was a flow if and only if it declared a non-empty `stages`,
and `entry` and `stages` travelled together in both directions — so `zz-access` declared one
stage, named after its own entry and producing nothing, to satisfy a rule it had no method for.
**What is true now (0.34.0):** the declaration is `documents`, and ARCHITECTURE.md §3 carries
the rule — a flow is a discipline over documents, so the packages that have one are the packages
that declare documents; `zz-access`'s phantom stage is deleted and it has no stages at all. Ownership is still
`shelved: true`, a separate axis from `install: "auto"` (all three evaluation packages declare
both, which is why one field could not carry them), and `zz-admin` still carries its own prompt,
because the generated router assumes a flow and told it to `skill_read` an entry it does not have.

`ARCHITECTURE.md` is the definition the repository is now checked against, and
three gate checks enforce the parts a machine can read.

**What is NOT yet true:** the definition covers catalog packages, the eight roots and the
boundary between `scripts/`, `testing/` and `packages/tools`. It says nothing yet about the
`blocks/` tests corpus or about `deploy/`.

## 0.12.0 — an initiative's flow is resolved from the document that declared it

The first attempt to run an evaluation flow end to end is what found this, and it found it
the expensive way: the report reached its gate having been governed by the wrong flow from
its second document onward, so the gate the flow declares was never the gate it passed.

Two faults, one consequence. The resolver walked the initiative's folder in `readdir` order
and took the first `flow:` it met, where the design — stated in zz-platform and repeated in
every comment around the resolver — is that the FIRST document declares it. And the check
that refuses an undeclared first document counted only rows in `zz.flow_install`, which a
platform flow never has: `team-one` was excused because it had exactly one install, and
`zz-platform`, which runs nothing BUT platform flows, was excused because it had none.

**What is true now:** documents are consulted oldest first, and the set a team must choose
from is its installs plus the platform flows the shelf ships to everyone. Every team is asked.

**What is NOT yet true:** no evaluation has completed a run under the corrected resolution.
The mis-stamped `2026-09-05-blockeval-casebox` is archived, not repaired, and its `zz.doc` rows
still name `ops-flow`.

## 0.11.0 — the evaluation track exists, and has not been run

Two flows, both platform capabilities, shipped to every team and neither yet exercised end to
end. Shipped, not installed: a platform package has no `zz.flow_install` row by construction,
which is the fact 0.12.0's entry below records the platform having forgotten about itself.

    zz-skill-eval   locate -> profile -> define (GATE) -> judge -> report (GATE)
    zz-block-eval   locate -> measure -> report (GATE)

**What changed is that the platform can now say how well its own parts work.** Before this,
evaluation ran by hand inside a delivery conversation and its scores went to a scratch file —
the dashboard correctly reported every document from two full initiatives as `judged: never`.
Seven scripts do the collecting, a pinned model does the judging, and the flow's own agent
never scores anything.

**What is NOT yet true:** neither flow has completed a run. No `rulers.md` has been approved,
no `findings.md` has closed an initiative, and `zz-platform`'s store holds no evaluation. The
numbers the flows already produce — a low score on one skill's weakest dimension, a block's
read tool refusing on every recorded call — were produced by running the scripts, not the
flows. Running both end to end is the acceptance test and has not
happened.

## 0.10.0 — deployed and verified but not yet exercised by a round

**What 0.10.0 adds is that a skill can be read and judged in one place, wherever it lives.**
The console tells flows from blocks — a flow is an agent method that runs against blocks, a
block is something reached over MCP carrying its team's own skills — and every skill on
either serves its own text, its reference material, what it cost and what it scored.
`skill_read` gained a `file` argument, which is what made a block's reference material
reachable at all: block skills are packaged into no plugin, so MCP is their only delivery
path and it served SKILL.md and nothing else.

Every document now carries the skill version that wrote it — from the run that produced it,
then the eval that judged it, then the version in force when it was created. ops-intent went
from the documents that happened to be attributable to all of them, and a score can be read
against one version instead of averaged across two. The derivation was validated before it was trusted: on the
one skill that has ever changed version, the window predicts the record on every document
where both exist.

**What is NOT proven is the half that needs a round.** The read API ships here; no evaluation
round has yet been decided against a skill page, so the pages answer and nothing has acted on
what they say. `zz.skill` and `zz.skill_version` were empty until this release registered
them, so nothing before now could be attributed to a skill or a version at all.

**The admin console is what 0.9.0 added to this list.** A separate browser app over a new
read API on the gateway, showing every team's work, the knowledge base, what each skill costs
and how it scores, and how each block actually refuses. Sign-in is a directory through SsoAuth —
a third identity adapter beside the PAT and the forwarded header, which is the shape
identity.ts already described. Every page has been driven in a browser against a populated
store, and the sign-in redirect has been checked end to end; what has NOT been exercised is
the far side of that redirect, which is somebody else's to register. So what is proven is our
half, again.

Knowledge moved to the platform's own team in this version — one shelf every team reads
instead of a journal per team, with each team's numbering colliding at 0001. The migration
ran; the shelf has not been written to since.

**Delegated block access is the whole of what 0.6.0 adds to this list.** A person signs in to
a building block as themselves and their own token is attached to every later call. It has
been walked end to end for all three blocks — including one that enforces consent, which
answered with the person's name and their own grants rather than a shared key — and the
automated loop runs from a revoked grant so that "the block names a person" is a result and
not a tautology. What is NOT proven is the other side: no delivery round has run through it,
and the mocks accept a scope without enforcing it, so what is proven is the platform's half.

Everything here passes the offline gate and its own engine, and 0.10.0 is the version the live
host is running — but a release's verification proves the platform ANSWERS, not that any of
this was used. None of it has run in front of a person. It moves into STATE.md's §6 when a round does.

The heading used to read "not yet deployed", which stopped being true the moment the version
went out. Deployed and exercised are two different facts and this file keeps them apart on
purpose: a deploy is ours to do and a round is not, so collapsing them would let us confirm
our own work.

- **Every query is asked of a real Postgres before anything is pushed.** `sql-check` PREPAREs
  each of them against an empty database the real gateway has migrated — which resolves every
  table, column and rule without touching a row, and is therefore cheap enough to run on every
  release and every dry run. 0.4.0 is why: a `SELECT DISTINCT` ordered by a column it did not
  project is refused at PARSE time, so `/pkg` answered 500 to every caller and nothing offline
  could have seen it. The six queries built at runtime are reported as not checkable, every
  run, with the reason — a checker that quietly skips what is hard reads exactly like one that
  found nothing wrong.
- **The adapter walk is tested.** A door that refuses ends the request, so a revoked PAT
  cannot fall through to be retried as a forwarded-header claim. `resolveThrough` said it was
  "exported so the ORDERING can be tested" and nothing tested it; five cases now run against
  the real function with stub doors, asserting the verdict AND which doors were asked.
- **The repository was read line by line** — 152 files, 46,208 lines — and the gate grew to
  255 checks. Most of what that found was one shape: a rule stated in one place and applied in
  another, the two drifted, and nothing able to see it. Four were in the gate itself.

- **A verdict is an act.** `document_approve(path)` and `initiative_close(initiative, disposition)` stamp
  `status`, `approved_by`, `approved_at`, `outcome` and `closed_by` from the session, and
  writing any of them by hand is refused. `outcome` lost `superseded` — supersession is a
  pointer between documents, not the fate of an initiative — and now reads
  `delivered | accepted | abandoned`, derived by `initiative_close()` from a disposition and whether a
  person is named.
- **`knowledge_reconcile(initiative | block)`** joins `zz.decision` against `zz.event`: what a stage
  predicted about a block, beside what the platform later recorded happening to it.
  `zz.decision` had been write-only since it was added — rows derived on every index, read
  by nothing.
- **The store is a git repository**, initialised on a team's first write, committing every
  act under the name of the person who made it and under the name of the ACT: `approve:`,
  `close accepted:`, `revise:`, `patch:`, `write:`. `git` is in the runtime image, which it
  was not; without that, every commit would have failed silently.
- **A team's own skills.** `<team store>/skills/<name>/SKILL.md` is searched LAST, so a team
  can add a skill but can never shadow `zz-platform` or a stage of the flow they run. The
  contribution path starts where the work already is, and costs no review by us.
- **Everything is TypeScript.** The thirteen Python files are gone, and with them a second
  envelope parser and a seventh copy of the MCP handshake. The tools run on a deploy host
  through `deploy/zz-tool`, in the image already there — no toolchain installed, and no
  docker socket mounted.
- **Two reachability defects, one shape.** `list_catalog` was member-safe and mounted only on
  `/admin/mcp` while `zz-access` carries `/manage` alone; ZZ Flow Builder instructed four
  `/admin/mcp` tools with no server declared, so the agent every account gets was told to
  perform an install it could not perform. Complete and unreachable is the most expensive
  shape here because nothing fails, and a gate check asks the question now.
- **The model writes the body; the platform writes the envelope.** `document_write` and
  `document_revise` refuse content that opens with frontmatter and take the rest as named
  arguments. Every envelope field now comes from a fact the platform holds or from an act,
  and the third source — a model typing YAML — is closed. `version` became the platform's;
  `sdlc-spec`'s `contract:` block moved into the body, where a reader can actually see it.
- **One way to change an approved document.** `document_patch` and `document_write` are refused on a
  gated document while it is approved, and point at `document_revise`. Two paths with
  opposite behaviour was the third instance of the asymmetry the guards check for.
- **A comment is a source.** The three comment tools are gone and `zz.comment` is dropped;
  what a person writes on a document from the web now lands as a source, through zz-core.
  The affordance survived, the second record did not.
- **Identity is a port.** The PAT and the forwarded header are two adapters, so a new login
  method is an array entry rather than surgery on identity resolution. A door that says no
  ends the request, so a revoked PAT cannot fall through to be retried as a header claim.
- **Credentials resolve personal, then team.** A new joiner works on day one on the team's
  key; a personal key overrides it. Two levels, never three.
- **Every flow ends with the platform's handover**, appended below the manifest so no flow
  author can drop it — and the platform itself is a tenant now, with `zz-platform` holding
  what we learn about registry entries rather than about anybody's delivery.
- **The improvement loop is closed.** `evolve-report` says which STEP stalls and hands back
  the platform's own refusal sentences; `flow-compare` compares flows and teams on one set
  of metrics; `watch-results` alerts on results worsening and treats its own silence as a
  failure. The change itself is a repository edit and a release — the catalog is read-only
  wherever the platform runs — and `zz-skill-report` specifies it, one change with the
  effect it expects. No flow may run the change beside its own measurement.
- **The envelope and the manifest are defined once**, as zod schemas in `@zz/contracts`, and
  published at `/schemas/*.json` so a team writing a flow can read the rules before a write
  is refused rather than after.
- **A stored XSS in the knowledge web app.** A link's body was rendered as raw source, so
  `[<img src=x onerror=…>](https://ok.example)` came back live in a page that injects with
  innerHTML while the reader's token sits in localStorage. Found by writing the test that
  the two earlier fixes there never had.
- **Secrets left the command line.** `--key`, `--pat` and `--user-pat` carried a
  building-block credential and two platform tokens through `ps` and into shell history.
- **The offline gate was 272 checks at 0.24.0**, from 78. Each one added that release refuses a
  defect that was found in this repository, and each was verified by reintroducing it.
  The newest keeps the server-held LLM client (generate.ts, Task I-22) off the console: it
  scans the sibling zz-stack-dashboard checkout for an import of it, a read of
  LLM_API_KEY/LLM_BASE_URL, or a NEXT_PUBLIC_* name carrying either, and separately runs
  generate.ts with no LLM_* set to prove generateConfigured() answers false and generate()
  refuses with a 503 naming all three variables rather than throwing at import.

## Before 0.10.0 — one door, a registry, a knowledge plane

The four capabilities everything above is built on, and the check that proved each. They are
listed by what they do rather than by when they landed: a delivery schedule is a fact about a
calendar, and this file is the balance.

| Capability | What it is | Proof |
|---|---|---|
| One door | the `zz` schema in our own database; PAT identity, hashed, scoped and revocable; `/admin/mcp` with RBAC, confirm-params and an audit trail; the `/core` proxy | a request without a PAT is refused; a spoofed identity header presented alongside a PAT is REWRITTEN to the PAT's owner, not trusted; every skill is reachable through one URL |
| Registry | `flow.json` manifests drive the guardrail chain; `install_flow` / `grant_tool` decide what a team has; `/p` enforces it once grants exist | the chain is enforced from the manifest rather than from code that knows the flow's name |
| Knowledge | one shelf on the platform's own team, read by every team; version snapshots taken at approval; `sources/` ungated and immutable; a mechanical ledger row at close; index-on-write with `knowledge_search` carrying provenance | a full chain test: three snapshots, a ledger row, and a search hit that cites its source |
| Many flows | the guardrails are flow-agnostic — the chain comes from each flow's own manifest | proven with a one-document, one-gate fixture: same image, different manifest, different discipline, zero code changes. The fixture was deleted once it had done its job |
