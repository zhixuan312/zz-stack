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
| `blocks/` | What do we know about someone else's building block? | yes, at `/blocks` |
| `deploy/` | How does a host stand this up? | no — the host has it |
| `scripts/` | How does this repository release and check itself? | no |
| `testing/` | How do we drive a deployment by hand? | no |

`docs/` is the ninth and answers: **what is written for a person to read?** Prose, findings,
handoffs, walkthroughs. One file under it is also served — `docs/architecture.html` — and it is
the only one that enters the image (`.dockerignore` excludes the directory and re-includes that
file). `docs/support/` is gitignored working material.

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

The unit is a package. `<owner>` is the team that owns the content: `casebox`, `sdlc`, `sm`, `zz`.
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

`zz-backbone` and `zz-knowledge`. These are not in `catalog/` because they belong to no
package: every flow carries them regardless of who wrote the flow. A skill goes here only when
that is true of it.

### `blocks/<block>/` — someone else's building block

We do not own these. What we hold is our reading of them:

```
blocks/<block>/skills/<skill>/SKILL.md      theirs, as they gave it to us — we never edit it
blocks/<block>/skills/<skill>/references/   theirs — we never edit these either
blocks/<block>/skills/<skill>/evals/        OURS: the ruler we judge their skill by
blocks/<block>/tests/                       what we ask of the block
blocks/<block>/findings/                    defects we found, one file per defect, numbered
```

The split inside `skills/` matters. Their text is evidence and changing it destroys the
evidence. The rubric beside it is our instrument, and we change it whenever it measures the
wrong thing.

`blocks/_standard/` is the exception: `building-a-block` is ours, and it is the contract we ask
every block to meet.

The rule that matters: **a defect in a block's skill is reported, not fixed.** The block team
owns the skill and owns the MCP tools it calls, and they ship both together. A skill we edited
is a skill that no longer matches the block.

### `scripts/` vs `testing/` vs `packages/tools/src`

Three places hold things that are run rather than served, and the boundary is *who runs it*:

- `packages/tools/src` — anything with logic. TypeScript, compiled, imported, testable. If it
  parses, decides, or talks to a database, it lives here.
- `scripts/` — the repository's own lifecycle, run by a person or by CI at the repo root:
  `gate.mjs`, `release.mjs`, `set-version.mjs`. These may shell out to `tools`.
  `scripts/gate/` is the one subtree here, and it splits along the same line as the rule
  below: `gate.mjs` is the ORDER the checks run in, `gate/checks/<subject>.mjs` are the checks
  themselves, `gate/run.mjs` is the one `check` they all register through, and `gate/read.mjs`
  and `gate/facts.mjs` are what they read the repository with. It was one 11,428-line file
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
  level down: authority, flows, teams and people for the admin surface; skills and the archive
  writer for the client package.
- **`services/gateway/src/settings/<scope>.ts` — split by AUTHORISATION, not by resource.**
  `me.ts`, `team.ts` and `platform.ts`, because who may call a route is the property that has
  to be obvious when reading it, and a file per scope makes a route in the wrong file look
  wrong.
- **`packages/contracts/src/identity.ts`** is behind the package's door: `index.ts` is still
  the single definition point every importer sees, and the split is internal to it.
- **`scripts/release/<step>.mjs` — one release step per file**, plus `config.mjs` for the
  release's own flags. `release.mjs` keeps the order, the way `gate.mjs` keeps the order of
  the checks.
- **`scripts/doctor/layers/<layer>.mjs` — one LAYER per file**, where a layer is a question
  with one source of truth on the repository side and one on the deployment side: repo,
  image, host, doors, contract, data. `doctor.mjs` is the order they are asked in, because
  the first layer that disagrees usually explains every layer after it. `doctor/run.mjs` is
  the runner, and it is the only place that decides what a probe's outcome MEANS.
- **`scripts/deployment.mjs`** is the one description of the deployment — its address, its
  paths, its images, how to speak to it. It is not under either subtree because both read it:
  it sat inside `release/config.mjs` until the doctor needed every line of it.

The common shape: **the entry file states the order or the door, the modules hold the work.**
`gate.mjs`, `release.mjs` and `doctor.mjs` are all three that, and a reader who knows one
knows the others.

### The three things that ask whether this is working, and what each one can see

| | asks | reads | when |
|---|---|---|---|
| `npm run gate` | is this checkout correct | the repository, offline | before anything |
| `release.mjs --preflight` | is this release worth starting | the checkout and the host, read-only | before a release |
| `npm run doctor` | where does the deployment stop matching this checkout | both sides, layer by layer | any time, outage included |

They are not three lists. The doctor's layers ARE the release's step-5 verification — the
release selects `host`, `doors`, `contract`, `data` and owns no probe of its own, and the gate
refuses it if it grows one. Step 5 used to hold eleven checks that ran for forty seconds during
a release and at no other time, which is how three of them came to call names they never
imported without anybody finding out.

**A probe that could not RUN is not a probe that FAILED**, and `doctor/run.mjs` is where that
distinction lives. Three verdicts: `ok`, `wrong` (the two sides disagree — the only one a
release may roll back on) and `unknown` (the probe's own bug, an unreachable host, a missing
token — reported, never silent, never evidence about the platform). A checker that cannot tell
its own breakage from its subject's will eventually report the subject as broken, at the moment
somebody is most likely to act on it. That is not hypothetical: it is what rolled 0.26.1 back.

## 3. What a manifest declares

`flow.json` is the package manifest. Four fields carry meaning; the rest is description.

### `stages` — is this a flow?

**A package is a flow if and only if it declares a non-empty `stages`.**

This is the whole rule. Not gates, not documents, not skills — a flow with one stage, no gate
and no document is a flow (`casebox-assist`), and a package with an agent and an MCP server but no
stages is not. `zz-admin` was that second shape and is the reason the rule is written down;
every package in the catalog today declares stages, so the shape currently has no example and
the rule is what stops the next one being guessed at.

A flow appears in flow menus, gets a stepper, and is installed for a team. A package without
stages is a **surface**: an agent and its doors, no steps, no position, never in a flow menu.

### `entry` — the skill the agent opens first

`entry` and `stages` travel together, in both directions:

- `entry` without `stages` is an error. The agent opens a skill and does work; work with a
  beginning has at least one step, and the package must say so.
- `stages` without `entry` is an error. A flow needs a door.

This pair is checked by the gate. It is the check that would have caught `zz-admin` in the flow
menu, and it is the check that catches the next one.

### `servers` — which MCP doors this package's agent gets

Orthogonal to shape. A flow may have none (`sdlc-flow`); a one-stage package may have one
(`zz-access`, which carries `/manage/mcp` — the platform's only non-`zz-core` door).

Tools that flows need live in **one** server, `zz-core`. A package does not ship its own server
to add a tool; it adds the tool to `zz-core` and asks for the door.

### `shelved` — who owns it, not what it is

`shelved: true` means *ZZ owns this and every account already has it* — a team cannot install
it, and it is hidden from the installable listing. It says nothing about shape: `zz-skill-eval`
is shelved and has five stages, two documents and a gate.

It was `kind: "platform"`, and that name is what put `zz-admin` in the flow menu — the one field
that could have said "not a flow" was already spoken for by ownership, so the console guessed
shape from contents instead. Worse, `catalogEntry` carried a comment reading "ANY `kind` means
not a flow", which was simply false about three of the five packages that had it.

It is NOT the same axis as `install`. `install: "auto"` means every team automatically has this
flow; all three evaluation-track packages declare both, so one field cannot carry them.

### The generated router assumes a flow

`install_flow` writes a system prompt: the package's own `agents/<name>/system-prompt.md` if it
has one, otherwise a generated router. The generated router ends every agent with
`skill_view("<entry>")` and describes running a flow for a team.

That is right for a flow and wrong for a surface. **A surface package must carry its own
system prompt.** `zz-access` does — it is one stage and an agent rather than a method run for a
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
parked there becomes a team — production carried `teams/_archive-22-08-2026`, five initiatives
of a team archived in August, and its 76 documents were in `zz.doc` and answered searches as
though the work were live. Retired material goes to `archive/`, which nothing reads.

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

## 4. What the gate checks

| Rule | Check |
|---|---|
| `entry` and `stages` travel together | `flowShapeDeclared` |
| Console flow listing reads `stages`, never infers | same check, second half |
| `kind` is gone; `shelved` is `true` or absent | in the manifest-fields check |
| A shelved or surface package carries its own system prompt | in the agent-prompt check |
| Nothing in `testing/` computes — it drives | `testingDrivesOnly` |
| No skill under `blocks/<block>/` is edited by us | existing `skills.lock.json` |
| No `tests/` fixture directory enters the image | `imageCarriesNoFixtures` |
