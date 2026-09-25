# Repository architecture

What lives where, and how a thing says what it is.

This document is the ruler. Where the repository disagrees with it, the repository is wrong.
Every rule below that a machine can check names the gate check that checks it; a rule with no
check says so.

## 1. The one idea

**A package declares what it is. Nothing infers it from what it contains.**

A reader that guesses shape from contents — a package with skills looks like a flow, a package
with documents looks more like one — is wrong even when it guesses right, because the day it
guesses wrong there is nothing to point at.

So: shape is declared, never derived.

## 2. The roots

Each top-level directory answers one question. A file that does not answer its directory's
question is in the wrong place.

| Root | Question it answers | Ships in the image |
|---|---|---|
| `packages/` | What code is shared between services? | yes |
| `services/` | What runs as a process? | yes |
| `catalog/` | What can a team install? | yes, at `/catalog` |
| `skills/` | What does every flow carry, whoever owns it? | yes, at `/skills` |
| `deploy/` | How does a host stand this up? | no — the host has it |
| `scripts/` | How does this repository release and check itself? | no |
| `checks/` | Which gate checks need a script of their own? | no |
| `testing/` | How do we drive a deployment by hand? | no |
| `marketplace/` | What does the public Claude Code shelf serve? Generated, committed | no |

`docs/` is gitignored working material — prose, findings, handoffs, walkthroughs. None of it
is published with the package and nothing that ships may read it: a document a deployment
depends on belongs beside the code it describes, which is why this file is at the root rather
than under there.

`dist/` and `runs/` are generated. Both are gitignored, both are excluded from the build
context, and neither may be read by anything that ships.

### `packages/` — shared code

Six packages, each with one job: `contracts` (schemas, the single definition of every shape),
`catalog` (reads the catalog from disk), `indexing` (the knowledge index both services write),
`mcp-http` and `mcp-client` (the transport, both ends), `tools` (every operation that is not a
service).

A package may not import a service. A service may import any package.

### `services/` — processes

`gateway` (HTTP, MCP mounts, console, admin) and `zz-core` (the platform's own MCP tools).
There are two, and adding a third needs a reason written down before the directory is made.

### `catalog/<owner>/<package>/` — what a team installs

The unit is a package. `<owner>` is the team that owns the content — `sdlc` and `zz` here.
Ownership is the directory; it is not a manifest field.

A package holds:

```
flow.json                       the manifest — the declaration
skills/<skill>/SKILL.md         the skills this package ships
tests/                          fixtures for this package — requirements, steps, expectations
```

`tests/` is read at build and test time and never at runtime, so it does not enter the image.

### `skills/` — carried by everyone

`zz-platform` and `zz-handover`, which a flow loads; `zz-deck`, `zz-tldr` and
`zz-breakout`, which a person types; and `zz-authoring`, the library the first two of those
load. The typed three are named in the baseline's own manifest at
`catalog/zz/zz-core/flow.json`, in the same `commands` map every other package uses.

These are here and not under the baseline's catalog entry for one reason: `zz-router` is
generated from the shelf's flows when a package is built, so the baseline's files are
synthesised by `buildClientPackage` rather than read from the catalog. A skill placed under
`catalog/zz/zz-core/skills/` ships in no plugin at all.

What does not belong here is anything about the machine or the credential rather than the
record — a 401, a connection, a plugin version, a legacy import. `zz-doctor`, `zz-update` and
`zz-migrate` are in `catalog/zz/zz-access/` with the rest of the credential door.

### `scripts/` vs `testing/` vs `packages/tools/src`

Three places hold things that are run rather than served, and the boundary is *who runs it*:

- `packages/tools/src` — anything with logic. TypeScript, compiled, imported, testable. If it
  parses, decides, or talks to a database, it lives here.
- `scripts/` — the repository's own lifecycle, run by a person or by CI at the repo root:
  `gate.ts`, `release.ts`, `set-version.ts`. These may shell out to `tools`.
  `scripts/gate/` is the one subtree here, and it splits along the same line as the rule
  below: `gate.ts` is the order the checks run in, `gate/checks/<subject>.ts` are the checks
  themselves, `gate/run.ts` is the one `check` they all register through, and `gate/read.ts`
  and `gate/facts.ts` are what they read the repository with.
- `testing/` — drivers that point at a *running deployment*. Orchestration, not computation.

The line between the last two is **computation versus orchestration, not length.** A driver is
long when the protocol it drives is long, and rewriting a long driver as TypeScript would not
make it better. A file that touches no deployment and no database is not driving anything — it
is a program, and it belongs where programs are compiled and tested.

## 2a. Inside a unit — the 700-line ceiling and what the subdirectories mean

No source file in either repository is over 700 lines, and the gate refuses one that is: 700
is the line above which a file here has held a whole second subject. There is **no exemption
list** — a list of files allowed to be large is
a list nobody prunes, so a file that cannot come down under 700 is a signal about that file,
not a case to be excused.

The ceiling says a file is too big. It does not say where to cut, and a cut made to hit a
number produces fragments. Every subtree below therefore has a stated boundary rule, and the
rule is what the directory means:

- **`services/zz-core/src/tools/<subject>.ts` — one tool subject per file.** Each exports its
  `register…Tools(server)` — `bugs.ts` a second one for its operator half — and a tool subject
  too large for one file keeps its helpers beside it (`search-predicate.ts` and
  `knowledge-search-verdict.ts` serve `knowledge-search.ts`; `initiative-open.ts` and
  `initiative-close.ts` are registered from `initiative-acts.ts`). Underneath them sit the
  layers every tool shares — `paths.ts`,
  `guards.ts`, `chain.ts`, `indexing.ts`, `persist.ts`, `platform-db.ts`, `skill-roots.ts`,
  `refusal.ts`, `typed-service.ts` (the Jev client), `semantic.ts` (the checkpoint families and
  their recorded answers) and `audit-rounds.ts` (which source is a round and what it owes next)
  — each one thing the tools do, never a tool. A tool may use any layer; a layer
  may not know about a tool.
- **`services/gateway/src/console/<resource>.ts` — one resource per file.** The routes that
  answer for overviews, teams, initiatives, knowledge, skills and the catalog, split the way
  the console's own URLs are, with `shared.ts` for what more than one of them needs.
- **`services/gateway/src/admin/<subject>.ts` and `package/<part>.ts`** — the same rule one
  level down: authority, flows, teams and people for the admin surface; `skills.ts` and
  `describe.ts` for the shelf a person installs.
- **`services/gateway/src/settings/<scope>.ts` — split by authorisation, not by resource.**
  `me.ts`, `team.ts` and `platform.ts`, because who may call a route is the property that has
  to be obvious when reading it, and a file per scope makes a route in the wrong file look
  wrong.
- **`packages/contracts/src/identity.ts`** is behind the package's door: `index.ts` is still
  the single definition point every importer sees, and the split is internal to it.
- **`scripts/release/<step>.ts` — one release step per file**, plus `config.ts` for the
  release's own flags. `release.ts` keeps the order, the way `gate.ts` keeps the order of
  the checks.
- **`scripts/doctor/layers/<layer>.ts` — one layer per file**, where a layer is a question
  with one source of truth on the repository side and one on the deployment side: repo,
  image, host, doors, contract, data. `doctor.ts` is the order they are asked in, because
  the first layer that disagrees usually explains every layer after it. `doctor/run.ts` is
  the runner, and it is the only place that decides what a probe's outcome means.
- **`scripts/deployment.ts`** is the one description of the deployment — its address, its
  paths, its images, how to speak to it. It is not under either subtree because both read it.

The common shape: **the entry file states the order or the door, the modules hold the work.**
`gate.ts`, `release.ts` and `doctor.ts` are all three that, and a reader who knows one
knows the others.

### The four things that ask whether this is working, and what each one can see

| | asks | reads | when |
|---|---|---|---|
| `npm run gate` | is this checkout correct | the repository, offline | before anything |
| `release.ts --preflight` | is this release worth starting | the checkout and the host, read-only | before a release |
| `npm run doctor` | where does the deployment stop matching this checkout | both sides, layer by layer | any time, outage included |
| `tenant-info verify --finalize` | is a whole delivery's evidence complete | every receipt, hashed, outside the checkout | once, at the end of a delivery |

**The fourth one runs outside the gate, and the gate never reads what it writes.** It spawns
the gate as one of its inputs, so registering it as a check would make the gate invoke itself;
more importantly, a gate that came to depend on its own final acceptance report would be a
gate that passes because it passed. The split is a file boundary: `assessAcceptance` in
`scripts/tenant-info/verify.ts` is a pure function of observations, which the gate does drive
over synthetic inputs, and everything that reads a real file or spawns a real command is in
`scripts/tenant-info/acceptance.ts`, which the gate never calls. `services/zz-core/src/tenant-info/README.md`
describes what it decides and how to read its report.

The doctor's layers are the release's step-5 verification — the release selects `host`,
`doors`, `contract`, `data` and owns no probe of its own, and the gate refuses it if it grows
one. A list that runs only during a release is exercised nowhere else.

**A probe that could not run is not a probe that failed**, and `doctor/run.ts` is where that
distinction lives. Three verdicts: `ok`, `wrong` (the two sides disagree — the only one a
release may roll back on) and `unknown` (the probe's own bug, an unreachable host, a missing
token — reported, never silent, never evidence about the platform). A checker that cannot tell
its own breakage from its subject's will eventually report the subject as broken, at the moment
somebody is most likely to act on it.

## 3. What a manifest declares

`flow.json` is the package manifest. Five fields carry meaning; the rest is description.

### `documents` — is this a flow?

**A package is a flow if and only if it declares `documents`.**

This is the whole rule. Not skills, not stages, not an MCP door — a flow is a discipline over
documents: which ones exist, in what order, which of them gate, which one closes. A package
that governs no documents has nothing for the platform to enforce, and is a **surface**: an
agent and its doors, no steps, no position, never in a flow menu. `zz-access` is one.

`stages` does not decide this: every package whose agent opens a skill does work with a
beginning, so every package could claim a stage, and a stage declared only to satisfy a rule
is the failure a declared rule exists to prevent. `stages` is what `produces` hangs off and what
the console's stepper walks; it does not decide what the package *is*.

### `stages` and `documents` travel together, in one direction

- `documents` without `stages` is an error. A document has to be produced by something, and
  `stages` is what produces it. `manifestAt` refuses such a manifest, naming `stages`.
- `stages` without `documents` is **not** an error. It is an ordinary non-flow package: a
  method somebody follows that leaves no governed document behind.

### Defining a step: three questions, answered in the manifest

A flow is a sequence of steps, and each step answers the same three questions about what it
leaves behind. The manifest is where it answers them, and every reader — the write guards, the
console's diagram, the release's own checks — derives from those answers rather than knowing
anything about a particular flow.

**1 · Does this step produce documentation?** `produces` says so, in one of four values:

| `produces` | What the step leaves | Example |
|---|---|---|
| `"<name>.md"` | a main document, declared in `documents` | `sdlc-spec` → `spec.md` |
| `"source"` | supporting material another document changes because of | `sdlc-plan-audit` → a source about `plan.md` |
| `"record"` | rows in the platform's own tables | `zz-plugin-evaluate` → scores |
| `"nothing"` | no artifact at all | `sdlc-execute` → the repository itself |

**2 · Main or supporting?** That is the difference between the first two rows, and it is a
difference in kind rather than in importance. A main document is a deliverable: the flow
declares it in `documents`, somebody may be asked to approve it, and downstream steps wait for
it. A source is evidence: it is filed under `sources/`, nobody approves it, and its whole job is
to explain why a main document changed. An audit report is a source — **the material that makes
the next version of somebody else's document necessary** — which is why declaring it as a
document put one round on the record twice.

A step producing a source names its target: `supports: "plan.md"`. The contract requires the
pair, and the gate requires the name to resolve to a document the same flow declares. That one
field is what lets the platform refuse `plan.md`'s next version until the round is cited, with
nothing anywhere knowing the word "audit".

**3 · Does it need a person?** `gate: true` on the declared document, and only there. A gate is
a verdict a person records with `document_approve`; the platform stamps `status` only where a
gate exists, and refuses to approve a document that carries none. A source is never gated.

```json
{ "name": "sdlc-plan",       "produces": "plan.md" },
{ "name": "sdlc-plan-audit", "produces": "source", "supports": "plan.md" },
{ "name": "sdlc-execute",    "produces": "nothing" }
```

### What a step's state is derived from

Nothing stores progress. It is read from the manifest and the record, per step:

| `produces` | done when | other states |
|---|---|---|
| a document | the file exists, and a gate on it is approved | `partial` — written, gate still open (this is "waiting on a person"); `empty` — not written |
| `"source"` | a source in the initiative declares `supports: <target>` | `empty` — no such source |
| `"nothing"` / `"record"` | any later step is done or partial | `empty` — nothing after it either |

The last row is order, not assumption: a review that exists could not have been written without
the execution before it. A step is drawn `empty` rather than done whenever the record cannot
show it happened, and nothing infers the other way.

**Every initiative also opens and closes, and no manifest declares either.** `open` is the
initiative existing; `closed` is an outcome recorded by `initiative_close`. They are the two
bookends of every flow's diagram, added by the platform, because they are acts of the initiative
rather than steps of the method.

### A version names the material behind it

`document_revise` refuses a content change that cites nothing: pass `sources` for material
already on the record, or `source_content` for words that are not yet. It also refuses a
revision that ignores what already explains it — any source supporting this document, added
after the version being replaced, must be cited. Approving, closing and the envelope are
untouched by this rule: it is the body that may not change with the reason left off the record.

### `entry` — the skill the agent opens first

`entry` is orthogonal to shape. A flow needs a door — `stages` without `entry` is an error,
checked by the gate — but an `entry` says nothing about whether the package is a flow.
`zz-access` has one, declares no stages at all, and that is a supported shape.

### `servers` — which MCP doors this package's agent gets

Orthogonal to shape. A flow may have none (`sdlc-flow`); a package that is not a flow may have
one (`zz-access`, which carries `/manage/mcp`, the gateway's own door).

Tools that flows need live in **one** server, `zz-core`. A package does not ship its own server
to add a tool; it adds the tool to `zz-core` and asks for the door.

### `shelved` — who owns it, not what it is

`shelved: true` means *ZZ owns this and every account already has it* — a team cannot install
it, and it is hidden from the installable listing. It says nothing about shape: `zz-access`
is shelved and is not a flow, while `zz-plugin-eval` is not shelved and has eight stages, four
documents and two gates.


## 3a. The deployed store

The repository is not the only thing with a shape. Every deployment carries an artifact
volume, and it has exactly two entries:

```
/artifacts/teams/<slug>/     the live store, and the only thing the platform indexes.
/artifacts/archive/          retired material. Present, readable, indexed by nothing.
```

`reindexAllTeams` walks `teams/` and treats every directory under it as a team, so anything
parked there becomes a team and answers searches as though the work were live. Retired material
goes to `archive/`, which nothing reads.

The store and the index must agree in both directions, and that is a property rather than a
one-off cleanup:

- a file under `teams/<slug>/` passing `indexable()` has a `zz.doc` row
- a `zz.doc` row has a file — including when the whole team's directory is gone
- `zz.decision` is cleaned with `zz.doc`, never separately

Audit it by diffing the three sets per team.

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
- **There is no "this will hard-fail later".** A rule either has a check on the day it is
  written, or it is a convention.
- **Where this document and the repository disagree, the repository is wrong.** That is what
  makes the rows below rules rather than description.

### The three shapes, and the one field that decides

`documents` is the only field that decides what a package is. Nothing infers shape from
contents — see §1.

| Shape | `documents` | `stages` | What it is | Example |
|---|---|---|---|---|
| **Flow** | yes | required | a discipline over documents: which exist, in what order, which gate, which closes | `sdlc-flow`, `zz-plugin-eval` |
| **Method** | no | yes | steps somebody follows that leave no governed document behind | none on this shelf today |
| **Surface** | no | no | an agent and its doors: no steps, no position, never in a flow menu | `zz-access` |

`documents` without `stages` is refused by `manifestAt`, naming `stages` — a document has to
be produced by something. `stages` without `documents` is an ordinary Method and is not an
error. Check: `check "a package declares whether it is a flow, and the console reads the
declaration"`, and `check "a flow is a plugin that declares documents, and zz-access is not one"`.

### What every plugin declares

| Field | Required | Rule, and why | Enforced by |
|---|---|---|---|
| `purpose` | yes | the sentence that decides whether a capability belongs in this plugin or the next one. `description` is what a reader sees in a listing; `purpose` is what you argue against when the plugin starts accreting whatever was convenient | `check "a plugin manifest says what the plugin is for"` |
| `entry` | yes, if it has stages | the skill the agent opens first. Orthogonal to shape: an `entry` says nothing about whether the package is a Flow | `check "every flow.json parses, and its entry names a skill it ships"` |
| `commands` | yes, for every skill a person types | a command is declared, never derived from a skill's name: a derived name cannot be wrong in a way anybody can see | `check "a command is what a manifest declares, not what a function derives from a skill name"` |
| `libraries` | yes, for every skill another skill loads | a library is a skill nobody types and no stage names, so without this field it is shipped and declared nowhere | `check "a plugin declares every skill it ships, and ships every skill it declares"` |
| `stages[].name` | yes, per stage | the stage's own skill | same check |
| `stages[].produces` | yes, per stage | what the stage leaves, and the vocabulary is closed: **a document name** the stage writes, **`"source"`** with a `supports` target, **`"record"`** where the result is stored by the platform rather than as a file, or **`"nothing"`**. The last two are answers, not omissions — that is the whole reason the field is required, because an absent field cannot tell "the author forgot" from "this stage genuinely produces nothing". A document it names must name the stage back | `check "every stage says what it leaves behind, and the document it names names it back"` |
| `documents` | only if it is a Flow | see the table above | `check "every flow declares which document closes it"` |
| `servers` | when the agent needs a door | which MCP doors the plugin's agent gets. Orthogonal to shape — a Flow may have none, a Surface may have one. A plugin does not ship its own server to add a tool; it adds the tool to `zz-core` and asks for the door | `check "every server a manifest declares is a door the gateway mounts"` |
| `shelved` | when ZZ owns it | ownership, not shape: every account already has it and no team can install it. It is `true` or absent | `check "every catalog entry has a flow.json and declares what it is"` |

The four fields a skill can be named in are `entry`, `commands`, `libraries` and `stages[].name`.
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
| the content identity | a plugin's identity moves with its content, not with its address, and `plugins.lock.json` records version and digest | `check "a plugin's content identity moves with its content and not with its address"`, `check "plugins.lock.json says what the catalog ships, on both version and digest"` |

### A description of the surface is derived, never asserted

A description kept beside the thing instead of computed from it drifts. Three rules:

- **No shipped file states a count of this platform's own surface.** A historical measurement
  — "three tools were renamed in the 2026-08 pass" — is not this and stays. Check: `check "no shipped file states a count of this platform's own surface"`.
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
catalog/<owner>/<plugin>/tests/                          fixtures — never enter the image
```

`<owner>` is the team that owns the content, and ownership is the directory rather than a
manifest field. The baseline is the one exception and it is a structural one: `zz-router` is
generated from the shelf's flows when a package is built, so `skills/` at the repository root holds
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
smaller set: what the gate holds about where things live.

| Rule | Check |
|---|---|
| `entry` names a skill the package ships | `check "every flow.json parses, and its entry names a skill it ships"` |
| A package declares whether it is a flow, and the console reads the declaration | `check "a package declares whether it is a flow, and the console reads the declaration"` |
| `kind` is gone; `shelved` is `true` or absent | `check "every catalog entry has a flow.json and declares what it is"` |
| Nothing in `testing/` computes — it drives | `check "nothing in testing/ computes — it drives, and the computing lives in packages/tools"` |
| No `tests/` fixture directory enters the image | `check "no fixture directory enters the image"` |
| No source file is over 700 lines | `check "no source file is larger than one subject usually is"` — `.md` is outside it, so the documents this repository ships are held by `checks/docs-current.ts` instead |
| The written record matches the delivered surface | `check "the written record matches the delivered surface, and no document outgrew the ceiling"` |

Every check this file cites by name must exist — `check "a gate check cited elsewhere is cited
by a name that exists"` holds this file to that.
