# Repository architecture

What lives where, and how a thing says what it is.

This document is the ruler. Where the repository disagrees with it, the repository is wrong.
Every rule below that a machine can check names the gate check that checks it; a rule with no
check is a rule that will be broken within a month and nobody will notice.

## 1. The one idea

**A package declares what it is. Nothing infers it from what it contains.**

The bug that produced this document: `zz-admin` appeared in the flow menu next to `ops-flow`.
(That package has since been folded into `zz-access` — one door, one plugin, tools registered
by role. The rule it produced outlived it, and is the subject of this section.)
It is not a flow. Nothing in its manifest said so, and the console had been guessing from the
contents — a package with skills looked like a flow, a package with documents looked more like
one. Guessing is wrong even when it guesses right, because the day it guesses wrong there is
nothing to point at.

So: shape is declared, never derived.

## 2. The eight roots

The repository has eight top-level directories and each answers one question. A file that does
not answer its directory's question is in the wrong place.

| Root | Question it answers | Ships in the image |
|---|---|---|
| `packages/` | What code is shared between services? | yes |
| `services/` | What runs as a process? | yes |
| `catalog/` | What can a team install? | yes, at `/catalog` |
| `skills/` | What does every flow carry, whoever owns it? | yes, at `/skills` |
| `deploy/` | How does a host stand this up? | no — the host has it |
| `scripts/` | How does this repository release and check itself? | no |
| `testing/` | How do we drive a deployment by hand? | no |

`docs/` is gitignored working material — prose, findings, handoffs, walkthroughs. None of it
is published with the package and nothing that ships may read it: a document a deployment
depends on belongs beside the code it describes, which is why this file is at the root rather
than under there.

`dist/` and `runs/` are generated. Both are gitignored, both are excluded from the build
context, and neither may be read by anything that ships.

### `packages/` — shared code

Five packages, each with one job: `contracts` (schemas, the single definition of every shape),
`catalog` (reads the catalog from disk), `mcp-http` and `mcp-client` (the transport, both
ends), `tools` (every operation that is not a service).

A package may not import a service. A service may import any package.

### `services/` — processes

`gateway` (HTTP, MCP mounts, console, admin) and `zz-core` (the platform's own MCP tools).
There are two, and adding a third needs a reason written down before the directory is made.

### `catalog/<owner>/<package>/` — what a team installs

The unit is a package. `<owner>` is the team that owns the content — `sdlc` and `zz` here, a
block team's own name where a block ships one.
Ownership is the directory; it is not a manifest field.

A package holds:

```
flow.json                       the manifest — the declaration
skills/<skill>/SKILL.md         the skills this package's agent opens
agents/<name>/system-prompt.md  optional: a hand-written prompt, replacing the generated one
tests/                          fixtures for this package — requirements, steps, expectations
```

`tests/` is read at build and test time and never at runtime, so it does not enter the image.

### `skills/` — carried by everyone

`zz-platform` and `zz-handover`, which a flow loads; `zz-deck`, `zz-tldr` and
`zz-breakout`, which a person types; and `zz-authoring`, the library the first two of those
load. The typed three are named in the baseline's own manifest at
`catalog/zz/zz-core/flow.json`, in the same `commands` map every other package uses — the
baseline had no manifest once and each skill carried its own `command:` line, and that is
gone rather than kept as a second way of saying it.

These are here and not under the baseline's catalog entry for one reason: `zz-router` is
generated per person from the flows they installed, so the baseline's files are synthesised
by `buildClientPackage` rather than read from a catalog everybody shares. A skill placed under
`catalog/zz/zz-core/skills/` ships in no plugin at all.

What does NOT belong here is anything about the machine or the credential rather than the
record — a 401, a connection, a plugin version, a legacy import. `zz-doctor`, `zz-update` and
`zz-migrate` are in `catalog/zz/zz-access/` with the rest of the credential door.

### `scripts/` vs `testing/` vs `packages/tools/src`

Three places hold things that are run rather than served, and the boundary is *who runs it*:

- `packages/tools/src` — anything with logic. TypeScript, compiled, imported, testable. If it
  parses, decides, or talks to a database, it lives here.
- `scripts/` — the repository's own lifecycle, run by a person or by CI at the repo root:
  `gate.ts`, `release.ts`, `set-version.ts`. These may shell out to `tools`.
  `scripts/gate/` is the one subtree here, and it splits along the same line as the rule
  below: `gate.ts` is the ORDER the checks run in, `gate/checks/<subject>.ts` are the checks
  themselves, `gate/run.ts` is the one `check` they all register through, and `gate/read.ts`
  and `gate/facts.ts` are what they read the repository with. It was one 11,428-line file
  until 2026-09-11, which is how long it takes a list to stop being navigable.
- `testing/` — drivers that point at a *running deployment*. Orchestration, not computation.

The line between the last two is **computation versus orchestration, not length.** A driver is
long when the protocol it drives is long: `ladder-round.sh` is 184 lines because standing up a
store, running a round and collecting it takes that many steps, and rewriting it as TypeScript
would make the repository worse. A file that touches no deployment and no database is not
driving anything — it is a program, nothing imports it and no test reaches it, and it belongs
where programs are compiled. That was `ladder-stats`, `ladder-compare` and `ladder-baseline`:
399 lines of statistics in untested `.mjs`.

## 2a. Inside a unit — the 700-line ceiling and what the subdirectories mean

No source file in either repository is over 700 lines, and the gate refuses one that is. The
number is measured rather than chosen: 700 is the line above which every file here held a
whole second subject, while `judge.ts` at 627 lines with three exports is genuinely one. There
is **no exemption list** — a list of files allowed to be large is a list nobody prunes, so a
file that cannot come down under 700 is a signal about that file, not a case to be excused.

The ceiling says a file is too big. It does not say where to cut, and a cut made to hit a
number produces fragments. Every subtree below therefore has a stated boundary rule, and the
rule is what the directory means:

- **`services/zz-core/src/tools/<door>.ts` — one door per file.** Each exports exactly one
  `register<Door>Tools(server)` and nothing else, so the file a tool lives in is the door a
  caller reaches it through. Underneath them sit the layers every door shares — `paths.ts`,
  `guards.ts`, `chain.ts`, `indexing.ts`, `persist.ts`, `platform-db.ts`, `skill-roots.ts`,
  `refusal.ts` — each one thing the doors do, never a tool. A door may use any layer; a layer
  may not know about a door.
- **`services/gateway/src/console/<resource>.ts` — one resource per file.** The routes that
  answer for overviews, teams, initiatives, knowledge, skills and the catalog, split the way
  the console's own URLs are, with `shared.ts` for what more than one of them needs.
- **`services/gateway/src/admin/<subject>.ts` and `package/<part>.ts`** — the same rule one
  level down: authority, flows, teams, people and the bug tracker for the admin surface;
  `skills.ts` and `describe.ts` for the shelf a person installs. `bugs.ts` arrived at 0.39.0
  when `bug_delete` joined the other two and `access-door.ts` reached 661 lines — a tracker is
  a different subject from keys and teams, and the ceiling is where that keeps being noticed. `describe.ts` was `archive.ts` until 0.29.0,
  when the tarball it wrote went with Codex and Hermes.
- **`services/gateway/src/settings/<scope>.ts` — split by AUTHORISATION, not by resource.**
  `me.ts`, `team.ts` and `platform.ts`, because who may call a route is the property that has
  to be obvious when reading it, and a file per scope makes a route in the wrong file look
  wrong.
- **`packages/contracts/src/identity.ts`** is behind the package's door: `index.ts` is still
  the single definition point every importer sees, and the split is internal to it.
- **`scripts/release/<step>.ts` — one release step per file**, plus `config.ts` for the
  release's own flags. `release.ts` keeps the order, the way `gate.ts` keeps the order of
  the checks.
- **`scripts/doctor/layers/<layer>.ts` — one LAYER per file**, where a layer is a question
  with one source of truth on the repository side and one on the deployment side: repo,
  image, host, doors, contract, data. `doctor.ts` is the order they are asked in, because
  the first layer that disagrees usually explains every layer after it. `doctor/run.ts` is
  the runner, and it is the only place that decides what a probe's outcome MEANS.
- **`scripts/deployment.ts`** is the one description of the deployment — its address, its
  paths, its images, how to speak to it. It is not under either subtree because both read it:
  it sat inside `release/config.ts` until the doctor needed every line of it.

The common shape: **the entry file states the order or the door, the modules hold the work.**
`gate.ts`, `release.ts` and `doctor.ts` are all three that, and a reader who knows one
knows the others.

### The three things that ask whether this is working, and what each one can see

| | asks | reads | when |
|---|---|---|---|
| `npm run gate` | is this checkout correct | the repository, offline | before anything |
| `release.ts --preflight` | is this release worth starting | the checkout and the host, read-only | before a release |
| `npm run doctor` | where does the deployment stop matching this checkout | both sides, layer by layer | any time, outage included |

They are not three lists. The doctor's layers ARE the release's step-5 verification — the
release selects `host`, `doors`, `contract`, `data` and owns no probe of its own, and the gate
refuses it if it grows one. Step 5 used to hold eleven checks that ran for forty seconds during
a release and at no other time, which is how three of them came to call names they never
imported without anybody finding out.

**A probe that could not RUN is not a probe that FAILED**, and `doctor/run.ts` is where that
distinction lives. Three verdicts: `ok`, `wrong` (the two sides disagree — the only one a
release may roll back on) and `unknown` (the probe's own bug, an unreachable host, a missing
token — reported, never silent, never evidence about the platform). A checker that cannot tell
its own breakage from its subject's will eventually report the subject as broken, at the moment
somebody is most likely to act on it. That is not hypothetical: it is what rolled 0.26.1 back.

## 3. What a manifest declares

`flow.json` is the package manifest. Five fields carry meaning; the rest is description.

### `documents` — is this a flow?

**A package is a flow if and only if it declares `documents`.**

This is the whole rule. Not skills, not stages, not an MCP door — a flow is a discipline over
documents: which ones exist, in what order, which of them gate, which one closes. A package
that governs no documents has nothing for the platform to enforce, and is a **surface**: an
agent and its doors, no steps, no position, never in a flow menu. `zz-access` is one.

It was `stages`, and the change is worth writing down because the *kind* of answer was right
both times. A declared field, never inference — that part never moved. But `stages` does not
discriminate: every package whose agent opens a skill does work with a beginning, so every
package could claim a stage, and one did. `zz-access` declared a single stage whose name
repeated its own `entry` and which produced nothing, purely to satisfy the rule, and was
rewarded with a stepper over one meaningless step. A declaration written to pass a check is
exactly the failure a declared rule exists to prevent.

`stages` keeps every other job it had, and they are real ones: it is what `produces` hangs
off, what a stage's `blocks` authority is read from, and what the console's stepper walks.
It simply no longer decides what the package *is*.

### `stages` and `documents` travel together, in one direction

- `documents` without `stages` is an error. A document has to be produced by something, and
  `stages` is what produces it. `manifestAt` refuses such a manifest, naming `stages`.
- `stages` without `documents` is **not** an error. It is an ordinary non-flow package: a
  method somebody follows that leaves no governed document behind.

### `entry` — the skill the agent opens first

`entry` is orthogonal to shape. A flow needs a door — `stages` without `entry` is an error,
checked by the gate — but an `entry` says nothing about whether the package is a flow.
`zz-access` has one, declares no stages at all, and that is a supported shape.

### `servers` — which MCP doors this package's agent gets

Orthogonal to shape. A flow may have none (`sdlc-flow`); a package that is not a flow may have
one (`zz-access`, which carries `/manage/mcp` — the platform's only non-`zz-core` door).

Tools that flows need live in **one** server, `zz-core`. A package does not ship its own server
to add a tool; it adds the tool to `zz-core` and asks for the door.

### `shelved` — who owns it, not what it is

`shelved: true` means *ZZ owns this and every account already has it* — a team cannot install
it, and it is hidden from the installable listing. It says nothing about shape: `zz-access`
is shelved and is not a flow, while `zz-plugin-eval` is not shelved and has five stages, two
documents and two gates.

It was `kind: "platform"`, and that name is what put `zz-admin` in the flow menu — the one field
that could have said "not a flow" was already spoken for by ownership, so the console guessed
shape from contents instead. Worse, `catalogEntry` carried a comment reading "ANY `kind` means
not a flow", which was simply false about three of the five packages that had it.

### The generated router assumes a flow

A flow's agent gets a system prompt: the package's own `agents/<name>/system-prompt.md` if it
has one, otherwise a generated router. The generated router ends every agent with
`skill_read("<entry>")` and describes running a flow for a team.

That is right for a flow and wrong for a surface. **A surface package must carry its own
system prompt.** `zz-access` does — it is a door and an agent rather than a method run for a
team, and its `agents/zz-access/system-prompt.md` says so in its own words instead of being
described as a flow it is not.

## 3a. The deployed store

The repository is not the only thing with a shape. Every deployment carries an artifact
volume, and it has exactly two entries:

```
/artifacts/teams/<slug>/     the live store. THE ONLY THING THE PLATFORM INDEXES.
/artifacts/archive/          retired material. Present, readable, indexed by nothing.
```

`reindexAllTeams` walks `teams/` and treats every directory under it as a team, so anything
parked there becomes a team — a deployment carried an `_archive-<date>` directory of retired
initiatives, and every document under it sat in `zz.doc` and answered searches as though the
work were live. Retired material goes to `archive/`, which nothing reads.

The store and the index must agree in BOTH directions, and that is a property rather than a
one-off cleanup:

- a file under `teams/<slug>/` passing `indexable()` has a `zz.doc` row
- a `zz.doc` row has a file — including when the whole team's directory is gone, which is the
  case `reindexTeam` could not see until 0.15.1 and which left six ghost rows behind an
  archived team
- `zz.decision` is cleaned with `zz.doc`, never separately

Audit it by diffing the three sets per team. Both environments read zero in every direction.

`_knowledge` is a reserved directory inside a team's store, not an initiative. Anything
walking initiatives excludes it by name.

## 3b. The plugin standard

This section is for whoever builds the next plugin. It states each rule, the reason for it,
and the gate check that enforces it — by name, because a name is stable and greppable and a
position is not.

Three properties of this standard are the standard, as much as any row below:

- **A rule nothing checks says so, in the same line, tagged [convention]** — the tag
  `zz-platform` uses, for the reason it gives: a rule stated as an absolute that nothing
  enforces teaches a reader to distrust the ones that are real.
- **There is no "this will hard-fail later".** A promised flip to blocking is the documented
  way a standard in this repository becomes decoration, and `plugin-declaration.ts` says so
  in its own header. A rule either has a check on the day it is written, or it is a convention.
- **Where this document and the repository disagree, the repository is wrong.** That is what
  makes the rows below rules rather than description.

### The three shapes, and the one field that decides

`documents` is the only field that decides what a package IS. Nothing infers shape from
contents — §1 is the bug that produced that rule.

| Shape | `documents` | `stages` | What it is | Example |
|---|---|---|---|---|
| **Flow** | yes | required | a discipline over documents: which exist, in what order, which gate, which closes | `sdlc-flow`, `zz-plugin-eval` |
| **Method** | no | yes | steps somebody follows that leave no governed document behind | none on this shelf today |
| **Surface** | no | no | an agent and its doors: no steps, no position, never in a flow menu | `zz-access` |

`documents` without `stages` is refused by `manifestAt`, naming `stages` — a document has to
be produced by something. `stages` without `documents` is an ordinary Method and is not an
error. Check: `check "a package declares whether it is a flow, and the console reads the
declaration"`, and `check "a flow is a plugin that declares documents, and zz-access is not one"`.

**A Surface must carry its own `agents/<name>/system-prompt.md`. [convention]** The generated
router ends every agent with `skill_read("<entry>")` and describes running a flow for a team,
which is right for a Flow and wrong for a Surface. `zz-access` carries one. Nothing checks
that the next Surface does; getting it wrong costs an agent described as something it is not.

### What every plugin declares

| Field | Required | Rule, and why | Enforced by |
|---|---|---|---|
| `purpose` | yes | the sentence that decides whether a capability belongs in THIS plugin or the next one. `description` is what a reader sees in a listing; `purpose` is what you argue against when the plugin starts accreting whatever was convenient | `check "a plugin manifest says what the plugin is for"` |
| `entry` | yes, if it has stages | the skill the agent opens first. Orthogonal to shape: an `entry` says nothing about whether the package is a Flow | `check "every flow.json parses, and its entry names a skill it ships"` |
| `commands` | yes, for every skill a person types | a command is DECLARED, never derived. `commandName()` derived one from a skill's name, so it could not be wrong in a way anybody could see | `check "a command is what a manifest declares, not what a function derives from a skill name"` |
| `libraries` | yes, for every skill another skill loads | a library is a skill nobody types and no stage names, so without this field it is shipped and declared nowhere. That was the hole: `catalog-manifest.ts` never read `libraries` | `check "a plugin declares every skill it ships, and ships every skill it declares"` |
| `stages[].name` | yes, per stage | the stage's own skill | same check |
| `stages[].produces` | yes, per stage | what the stage LEAVES, and the vocabulary is closed: **a document name** the stage writes, **`"record"`** where the result is stored by the platform rather than as a file, or **`"nothing"`**. The last two are ANSWERS, not omissions — that is the whole reason the field is required, because an absent field cannot tell "the author forgot" from "this stage genuinely produces nothing". A document it names must name the stage back | `check "every stage says what it leaves behind, and the document it names names it back"` |
| `documents` | only if it is a Flow | see the table above | `check "every flow declares which document closes it"` |
| `servers` | when the agent needs a door | which MCP doors the plugin's agent gets. Orthogonal to shape — a Flow may have none, a Surface may have one. A plugin does NOT ship its own server to add a tool; it adds the tool to `zz-core` and asks for the door | `check "every server a manifest declares is a door the gateway mounts"` |
| `shelved` | when ZZ owns it | ownership, not shape: every account already has it and no team can install it. It is `true` or absent; `kind` is gone, and `kind` is what put a non-flow in the flow menu | `check "every catalog entry has a flow.json and declares what it is"` |

The four fields a skill can be NAMED in are `entry`, `commands`, `libraries` and `stages[].name`.
The set difference is taken both ways: a plugin that ships a skill its manifest names nowhere
fails, and a manifest naming a skill the plugin does not carry fails. Shipped means a directory
with a `SKILL.md` in it — the same test the packager applies.

### What every plugin's use records

The platform's claim is that evidence falls out of the work rather than being written by
anybody. These are the rows that have to exist for that to be true.

| Recorded | Rule, and why | Enforced by |
|---|---|---|
| the plugin | every tool call leaves a row naming the plugin it was made for. Attributed at the call, never derived afterwards from a tool's name — a rename would otherwise rewrite history | `check "every tool call says which plugin it was made for"` |
| the act | a tool that changes something records that it did, through the shared guard, once | `check "a tool that changes something records that it did"`, `check "a record that is counted is a record that is written once"` |
| what it cost | a column beside the row, where the platform made the call. Detail keeps no second copy of it | `check "what a call cost is a column, and detail keeps no second copy"` |
| what it cost, unobtainably | where the caller is a client we do not run, the figure cannot be had, and it is recorded as **null** — never as zero. A confident zero is a measurement nobody took | `check "every completion the judge asks for is recorded, and an unreported figure stays null"`, `check "an aggregate nothing measured renders as null, never a confident zero"` |
| the spend, uncapped | an evaluation run's cost is readable without paying for it again, and nothing may cap spend. A ceiling turns "what does this cost" into "what did we allow" | `check "what a recorded eval run cost is readable without paying for it again, and nothing caps spend"` |
| the content identity | a plugin's identity moves with its content, not with its address, and `plugins.lock.json` records version AND digest | `check "a plugin's content identity moves with its content and not with its address"`, `check "plugins.lock.json says what the catalog ships, on both version and digest"` |

### A description of the surface is derived, never asserted

The most expensive defect this repository has found repeatedly is a person keeping a
description beside the thing instead of computing it from the thing. Three rules fall out:

- **No shipped file states a count of this platform's own surface.** "A member sees twenty
  tools" against a real nineteen, a table headed "THESE TWENTY-NINE" over thirty-one rows.
  A historical measurement — "three tools were renamed in the 2026-08 pass" — is not this and
  stays. Check: `check "no shipped file states a count of this platform's own surface"`.
- **No shipped prose names a tool no door registers, or a skill no plugin ships.** Prose is
  read as an instruction, so a name that resolves to nothing is an agent told to do something
  impossible. Checks: `check "no shipped prose names a tool no door registers"`,
  `check "no shipped prose names a skill no plugin ships"`.
- **A count the platform reports says when it was counted.** Checks:
  `check "a count of what is on this deployment says when it was counted"`,
  `check "the platform records its own surface, the way it records everybody else's"`.

### Where a plugin's files go

```
catalog/<owner>/<plugin>/flow.json                       the manifest — the declaration
catalog/<owner>/<plugin>/skills/<skill>/SKILL.md         every skill it ships
catalog/<owner>/<plugin>/agents/<name>/system-prompt.md  optional; REQUIRED for a Surface
catalog/<owner>/<plugin>/tests/                          fixtures — never enter the image
```

`<owner>` is the team that owns the content, and ownership is the directory rather than a
manifest field. The baseline is the one exception and it is a structural one: `zz-router` is
generated per person from the flows they installed, so `skills/` at the repository root holds
what every plugin carries. **A skill placed under `catalog/zz/zz-core/skills/` ships in no
plugin at all** — see §2.

### Releasing one

`scripts/release.ts` is the only release procedure this repository has. Step 1a is the
fit-for-purpose review, and it is the one step no check can do for you: it prints each
plugin's declared purpose beside the tools its declared doors actually register, and asks
whether that surface delivers that purpose. A check that computed a verdict there would be
claiming to judge fit, which is exactly the over-reach the rest of this section avoids — so
the script prints, pauses, and requires the reviewer to say they looked.

## 4. What the gate checks about the repository's shape

The plugin standard's own rules, and the check enforcing each, are §3b. This table is the
smaller set: what the gate holds about where things LIVE.

| Rule | Check |
|---|---|
| `entry` names a skill the package ships | `check "every flow.json parses, and its entry names a skill it ships"` |
| A package declares whether it is a flow, and the console reads the declaration | `check "a package declares whether it is a flow, and the console reads the declaration"` |
| `kind` is gone; `shelved` is `true` or absent | `check "every catalog entry has a flow.json and declares what it is"` |
| A Surface carries its own system prompt | nothing checks it — **[convention]**, §3b |
| Nothing in `testing/` computes — it drives | `check "nothing in testing/ computes — it drives, and the computing lives in packages/tools"` |
| No `tests/` fixture directory enters the image | `check "no fixture directory enters the image"` |
| No source file is over 700 lines | `check "no source file is larger than one subject usually is"` — `.md` is outside it, so the documents this repository ships are held by `checks/docs-current.ts` instead |
| The written record matches the delivered surface | `check "the written record matches the delivered surface, and no document outgrew the ceiling"` |

The rows above used to name `flowShapeDeclared`, `testingDrivesOnly`, `imageCarriesNoFixtures`
and "the agent-prompt check". Not one of those existed: three were function names from before
the gate was split into `scripts/gate/checks/`, and the fourth named a check nobody ever wrote.
The ruler was citing its own enforcement and the citations resolved to nothing — which is the
defect `check "a gate check cited elsewhere is cited by a name that exists"` now refuses,
this file included.
