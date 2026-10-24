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
| `checks/` | Which checks need a script of their own — the gate checks registered by name, and the break-tests that spawn the gate to prove a plant goes red? | no |
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

Some routes on the gateway are not doors and not the console. `PUT /upload/<id>` takes a file's
bytes with the person's own token, and `/u/<secret>` is the staging page a link opens
(`services/gateway/src/upload.ts`). Those two only stage a plain-text file for an upload `upload_start`
began; the write that consumes it is zz-core's, so there is no second idea of what a document or a
source is. A file attached in ChatGPT takes neither route: zz-core fetches that `file` itself
(`services/zz-core/src/file-fetch.ts`), only from a host `OPENAI_FILE_HOSTS` lists — none by
default, so the route is off and no tool declares `file`; a file goes through `upload_start` instead.

`POST /internal/agent-read/<tool>` is the agent door (`services/gateway/src/agent-door.ts`), zz-core's
way back to the console's reads. The core door's `platform_status`, `release_list`,
`activity_refusals`, `run_summary` and `record_read` are answered by the functions the console's own
routes call (`services/gateway/src/console/agent-reads.ts`), so zz-core asks for them over HTTP,
the way the gateway reaches zz-core, rather than importing a service. The door answers only the peer
`CORE_PEERS` resolves to (default `zz-core`), sits outside the identity middleware because that
peer carries no credential, and rebuilds the person from the identity headers zz-core was forwarded,
through `callerIdentity` and `isSuper`. Caddy answers `/internal/*` with 404 on the public host.

**Every tool says what it does to the world.** Each `registerTool` passes one of `READS`, `WRITES`
or `DESTROYS` from `@zz/mcp-http` as its annotations. A client decides confirmation from them —
ChatGPT confirms every call to a tool that does not declare `readOnlyHint` — and the MCP defaults
read an unannotated write as destructive and open-world. A record that a call happened is not a
write. Check: `check "every tool declares whether it reads, writes or destroys, and a client reads that off the live door"`.

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
`zz-breakout`, which a person opens by name; and `zz-authoring`, the library the first two of
those load. The three are named in the baseline's own manifest at
`catalog/zz/zz-core/flow.json`, in the same `commands` map every other package uses.

A skill in a `commands` map ships as a skill, in its own directory, never as a `commands/` file:
Claude Code and Codex both read `skills/`, and only Claude Code reads `commands/`. The packager
names it by its command and marks it for both clients as one a person opens — never matched on
its own: `disable-model-invocation: true` in its frontmatter for Claude Code, and
`agents/openai.yaml` with `policy.allow_implicit_invocation: false` for Codex, which reads only
that. A person opens it as `/zz-core:deck` in Claude Code and `$zz-core:deck` in Codex.

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
  `guards.ts`, `chain.ts`, `indexing.ts`, `platform-db.ts`,
  `refusal.ts`, `typed-service.ts` (the Jev client), `semantic.ts` (the checkpoint families and
  their recorded answers) and `audit-rounds.ts` (which source is a round and what it owes next)
  — each one thing the tools do, never a tool. A tool may use any layer; a layer
  may not know about a tool.
- **`services/gateway/src/console/<resource>.ts` — one resource per file.** The routes that
  answer for overviews, teams, initiatives, knowledge, skills and the catalog, split the way
  the console's own URLs are, with `shared.ts` for what more than one of them needs. `live.ts`
  is the one that is not an answer: one Server-Sent Events stream per tab, fed by one `LISTEN`
  connection per process held from the gateway's start, which says that a collection changed and
  never what changed in it. `live-revision.ts` counts those changes per caller, so every console
  read answers with its collection's revision and a stream opened for a page, asked with it, is greeted
  `synced` or a `resync` naming only what moved.
- **`services/gateway/src/admin/<subject>.ts` and `package/<part>.ts`** — the same rule one
  level down: authority, flows, teams and people for the admin surface; `skills.ts` and
  `describe.ts` for the shelf a person installs.
- **`services/gateway/src/settings/<scope>.ts` — split by authorisation, not by resource.**
  `me.ts`, `team.ts` and `platform.ts`, because who may call a route is the property that has
  to be obvious when reading it, and a file per scope makes a route in the wrong file look
  wrong.
- **`services/zz-core/app/` — code that runs in a person's browser, not on the server.** The
  document panel: `panel.ts` (the page), `render.ts` (markdown to safe HTML, pure, so a check runs
  it in Node), `panel.css` and `brand/`, bundled by `build.ts` into one self-contained page,
  `dist/apps/document-panel.html`, which `src/document-panel.ts` serves as the MCP Apps resource
  `document_present` names. Its tokens and brand images are the console's, copied, and
  `checks/document-panel.ts` fails when the copy drifts.
- **`services/gateway/assets/` — files the gateway reads at runtime, never code.** Today one: the
  console's wordmark, which `src/oauth-page.ts` inlines into the consent and refusal pages so they
  load nothing. The image copies `services/` whole and prunes only TypeScript, so it is beside
  `dist/` on the host; `checks/consent-page.ts` holds it byte-identical to the panel's copy.
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
  **`scripts/door-frame.ts`** beside it reads what a door answers, by its JSON-RPC frame and its
  HTTP status: a door whose upstream is down answers 200 with an error, so a status alone reads
  it as up. It is its own file because the gate holds a file that both builds the handshake and
  reads the answer to be a second MCP client.

The common shape: **the entry file states the order or the door, the modules hold the work.**
`gate.ts`, `release.ts` and `doctor.ts` are all three that, and a reader who knows one
knows the others.

### The three things that ask whether this is working, and what each one can see

| | asks | reads | when |
|---|---|---|---|
| `npm run gate` | is this checkout correct | the repository, offline | before anything |
| `release.ts --preflight` | is this release worth starting | the checkout and the host, read-only | before a release |
| `npm run doctor` | where does the deployment stop matching this checkout | both sides, layer by layer | any time, outage included |

**A gate that came to depend on its own acceptance report would be a gate that passes because
it passed**, which is why no delivery-level acceptance runner is registered as a check. The
gate drives the pure half of every such assessment over synthetic inputs and never reads what
an operator's own final report says.

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

A source step may also declare its own round policy, and only a `produces: "source"` step may:
`round_budget` (an integer 1..3; absent means the platform's `ROUND_BUDGET`, 3) is how many
rounds the platform may ask for on the target (per phase, for a plan), and `continue_on` (a non-empty list of
`critical`, `high`, `medium`, `low`; absent means any revision owes a round) is the finding
weights that owe another round. Any other step declaring either is refused.

**3 · Does it need a person?** `gate: true` on the declared document, and only there. A gate is
a verdict a person records with `document_approve`; the platform stamps `status` only where a
gate exists, and refuses to approve a document that carries none. A source is never gated.

```json
{ "name": "sdlc-plan",       "produces": "plan.md" },
{ "name": "sdlc-plan-audit", "produces": "source", "supports": "plan.md",
  "round_budget": 2, "continue_on": ["critical", "high"] },
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

Two tools write a document: `document_write` creates one, and refuses a path that exists
(`TARGET_EXISTS`); `document_edit` makes every change after that — an edit batch, one section,
the whole body, or the editable metadata alone. The version follows the cause: a body change
that brings a source new to the current version (`sources` for material already on the record,
`source_content` for words that are not yet) opens the next version, and one that brings none
stays in the version it is in. An approved document's body does not change without a cause
(`CAUSE_REQUIRED`), and the change is a draft of the next version while the approved one stays
readable. The platform links what already explains a change itself: a source supporting the
document, filed at or after the cause-link epoch (the release that began cause links) and
cited by no version of it yet, becomes a cause of the next body change, named in the reply as
linked by the platform; an older source is never linked automatically. Approving, closing and
the envelope are untouched by this rule: it is the body that may not change with the reason
left off the record.

What a write is sent is read before it is compared, and content's envelope never becomes the
stored envelope. An envelope at the top of whole `content` — the platform's own block shape,
`ENVELOPE_BLOCK`, holding nothing but `key: value` lines — is separated from the body by
`document-normalize.ts`: its `title`, `tags`, `stakeholder` and flow fields are taken as the
named arguments they stand for, every key the platform writes is ignored and reported, and any
other key, or a value a named argument contradicts, is refused by name. A thematic break, SQL or
a YAML document that is not such a block is body, byte for byte; a body an edit batch or a
section would make open with an envelope is refused. Tags are lower-cased, a reference to a
document of the same initiative is put in its canonical spelling, and a source name already
taken is filed under the next free suffix, reserved under the lock. Each normalisation is one
reported line, and it runs before identity is compared, so a document read and sent back whole
is a no-change and never a version.

### An approval signs what was presented

A presentation is recorded, and an approval rests on one. `document_present` works in a review
context (`rc_…`) the server mints and the reply names; it belongs to one person, one document and
one kind of credential, and a later present that passes it back shows only what changed since the
context last covered the document (`full: true` for all of it). Each presented page is a
`document.shown` or `document.shown_part` row naming its context, snapshot and span, committed
under the document's lock before the text returns, so a snapshot once shown is kept. What it
records is coverage delivered to the caller — never proof that a human read every character. An
approval signs exactly the current snapshot, and only when a context of the caller's own covered
it (`approvalBasis`, `attest.ts`): another person's or the console's never counts, a snapshot
changed after display is `APPROVAL_CONFLICT`, and no covering context is `PRESENTATION_REQUIRED`.
The console records and approves only what a browser session was shown.

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

A deployment's store is the `zz` schema in its own PostgreSQL. There is no artifact volume:
documents, knowledge and every piece of state the platform keeps are rows in the database the
services are given, and the volume that used to hold them per team — `_versions/` snapshots, the
per-initiative JSON files, `activity.jsonl`, `_ledger.md` and the git repository every write was
committed to — is retired. The gateway's only durable file is `/data/events-unwritten.jsonl`,
which holds events it could not write, and is drained back into `zz.event`.

What that leaves, in the four shapes a reader has to know:

- a document is `zz.doc` for its identity and status, and `zz.doc_revision` for every version of
  it — one row per revision, immutable once written, and the only permitted update is the
  one-time approval seal that bound that revision;
- what a revision cites is `zz.doc_link`, of kind `cites` (both ends pinned to exact revisions)
  or `supports` (a source revision pinned to the TARGET DOCUMENT's identity) — a link needs its
  target's row, so a source naming a document not yet written keeps the name in its declared
  `supports` and the link is filed when that document is first written;
- a knowledge node is `zz.knowledge_node`, on a shelf named by its `team_id`, addressed as
  `_knowledge/nodes/<node_ordinal>-<slug>.md`, and what it cites is `zz.knowledge_node_evidence`;
- what the platform did is `zz.event`, one row per call, written by the door that served it. A
  document change's own `document.*` row is written inside the change's transaction, so it fails
  the change rather than the fallback file, and carries `details_ref` (`dr_…`) and `details`: the
  complete receipt, every list whole. A refusal that had to cut a list writes a `document.refused`
  row before it replies — whole, except a `MULTIPLE_MATCHES` edit's match lines, of which it
  keeps the first 1,000 and records `details_complete: false` with `details_omitted`. The reply
  itself counts every list and previews what fits 16 KiB, and
  `document_read(path, details_ref, cursor)` pages the rest back; these rows are kept as long as
  the audit kinds, so a printed ref never dangles.

The deployment backs up three archives and not four (`deploy/backup.sh`): the database dump, the
credentials proxy's data, and the compose configuration. The store's own tarball is gone with the
volume, because the store is in the dump.

Every deployment's schema is proved equal to this repository's hand-declared target:
`node checks/schema-inventory.ts` migrates a throwaway PostgreSQL with the real migrations and
compares the two catalogs, and `scripts/rehearse.ts` does the same against a restored production
backup as well as the data checks below.

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
| `commands` | yes, for every skill a person opens by name | a command is declared, never derived from a skill's name: a derived name cannot be wrong in a way anybody can see | `check "a command is what a manifest declares, not what a function derives from a skill name"` |
| `routed` | only to say `false` | whether `zz-router` loads the flow for the person. `false` marks a flow a person opens by name — the router names how to open it in each client instead of loading it — so it must declare a command for its entry | `check "zz-router loads a routed flow and names how a person opens one they open"` |
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

## 5. What the console reads, and what each read costs

A console figure is only honest if the document that decided where it came from was written before the
figure moved. This section is that decision, taken once: every metric has a line saying what it is
counted from, over what range and grain, what moves it, and whether a read model or the tables answer it.

`zz.event_work_week` is the read model — `migrations/011_event_work_week.sql`, declared
`class=projection; rebuilt_from=zz.event`, so every row is reproducible by re-running one statement over
`zz.event` and nothing in it is a fact of its own. It carries no `matched`, no `continued_sessions` and
no `last_call_at`: the first two are business state decided elsewhere and recorded nowhere in `zz.event`,
so a rebuild would lose them without an error, and the third is derivable and unbounded. `check "the read
model holds no business state it cannot rebuild, and its register is written"` refuses a column of any of
those three names and holds the four sections below to their headings, their six rows and their budgets.

The measurements below are `EXPLAIN (ANALYZE, BUFFERS)` on this deployment, read-only, on 2026-10-24 at
**41,772 real-work calls** (`zz.event` where `kind = 'tool_call'` and `origin = 'work'`), the ten-times seed;
a projection at ten times is that figure at ten times the row count, labelled as one. The rows and shared
buffers were read again at **41,891 real-work calls**; the milliseconds are recorded, and the two evidence each budget.

### The metric register

| Metric | Source | Range | Grain | What makes its answer change | Served by | Budget |
|---|---|---|---|---|---|---|
| Calls by week and team | `zz.event`, real-work tool calls, joined to `zz.team` for the slug | the seven weeks the page draws, the running one last | team · local week | any real-work call | the read model, `teamWeeks` | `rows ≤ 1000, ms ≤ 50` — 720 rows, 1.0 ms at today's traffic and at ten times it |
| Calls by tool and week, with the median | `zz.event`, real-work tool calls, the tool named through `zz.plugin_tool` | the seven weeks the page draws, the running one last | tool · local week | any real-work call, or a tool the doors stop registering | the read model, `toolWeeks`, its median the merge of the buckets' `ms` arrays | `rows ≤ 1000, ms ≤ 50` — 720 rows, 1.0 ms at today's traffic and at ten times it |
| Calls by refusal owner | `zz.event`, real-work tool calls carrying a `refusal_owner` | the seven weeks the page draws, the running one last | refusal owner · team · local week | any refused call | the read model, `refusal_owner` being part of its grain | `rows ≤ 1000, ms ≤ 50` — 720 rows, 1.0 ms at today's traffic and at ten times it |
| Refusals put right — `matched`, `median_ms` | `zz.event`, a refusal and the first real-work call of the same team, session and tool inside the 120 seconds after it | every refusal in the record, and the 120 seconds after each | refusal · local week | a refusal, or the call that puts it right | a raw query, `followupWeeks` | `rows ≤ 850000, ms ≤ 1800` — 80,966 rows read in 148 ms, about 810,000 in about 1.5 s at ten times |
| Refusals put right — `continued_sessions` | `zz.event`, a refused session's own later calls | every refused session, through the record's newest call | refused session · local week | a call of that session after a refusal | a raw query, `followupWeeks`, the same statement | the same statement, so the same two numbers: `rows ≤ 850000, ms ≤ 1800` — 80,966 rows in 148 ms, about 810,000 in about 1.5 s at ten times |
| Calls by local weekday and hour | `zz.event`, real-work tool calls | the whole record, by local day | local day and hour | any real-work call | a raw query, `readDays` | `rows ≤ 450000, ms ≤ 1300` — 41,891 rows in 122 ms, about 419,000 in about 1.2 s at ten times |

The two `followupWeeks` rows are the ones the model may not answer. A refusal is put right by the two minutes
after it, and a session continued is a fact about every later call of that session: a rebuild of `zz.event`
could not reproduce either, so neither is a column of a projection. Both stay a raw query with the cost
recorded below; a cross-bucket median is the merge of the `ms` arrays, never a median of medians.

### The budget of each answer class

A budget is two numbers — the rows a class may read and the milliseconds it may take — set for ten times
today's traffic and each evidenced twice: `EXPLAIN (ANALYZE, BUFFERS)` at today's data and the same plan at
ten times, because rows alone are not the cost: three of Status's statements read 41,891 to return seven.
Task I-19's third arm parses the line below, seeds to ten times the 41,772 real-work calls, and fails there.

- **Usage's calls by week and team** — `rows ≤ 1000, ms ≤ 50`. Today it reads 645 rows and takes 1.2 ms
  from the read model, against 41,772 rows and 133 ms for the same figure from `zz.event`. At ten times
  the traffic the bucket count is bounded by the grain — seven weeks, five team slugs, the tools the
  doors register — so the rows barely move while the arrays inside them grow. The composed statement,
  on a throwaway migrated by the real runner — the model plus the raw tail FR-16b(i) requires — reads
  **720 rows in 1.0 ms at 41,772 calls and 720 rows in 1.0 ms at ten times them**: the whole figure.

The `ms` array is the one field whose size is not obviously bounded: its widest bucket holds 2,414 integers
in 9,680 bytes against an average bucket's 276, and at ten times about 24,140 and 95 KB, one row's value still.

The settings reads count people, teams and tokens rather than work, so the register does not reach them.
Three of the five issue a statement, read with `EXPLAIN (ANALYZE, BUFFERS)` at 8 principals, 9 memberships
and 34 tokens.

| Settings read | What it runs | Range · grain | Budget | Today | At ten times |
|---|---|---|---|---|---|
| `/settings/me/tokens` | `myAccessTokensFor`, `pat` joined to `principal` | the caller's own token history · one row per token | `rows ≤ 400, ms ≤ 5` | 34 rows read, 6 buffers, 0.3 ms | about 340 rows, 60 buffers, under 3 ms |
| `/settings/team/members` | the membership, principal and team join, for one team | that team's roster · team · member | `rows ≤ 400, ms ≤ 5` | 22 rows read, 14 buffers, 0.2 ms | about 220 rows, 140 buffers, about 2 ms |
| `/settings/platform/people` | `listPeople`, a principal per row with its teams aggregated | the platform's principals · principal · its teams | `rows ≤ 800, ms ≤ 5` | 22 rows read, 13 buffers, 0.7 ms | about 220 rows, 130 buffers, about 7 ms |
| `/settings/me/teams`, `/settings/me/client-setup` | `myTeamsSummary`, over the `Identity` the request resolved, and `renderClientSetup` around the caller's email: no statement between them | what the request already carries · the identity's teams, and one row for the setup | `rows 0, ms ≤ 1` | no statement, no buffers | no statement, no buffers |

Their cost grows with the population, not with `zz.event` — a hundred people is eight hundred rows here — so
none of the five needs a read model and none is on the strand list below.

### Answer classes that miss on every event write

Four answer classes are stranded by every `zz.event` write, correctly: each figure they show includes events,
so an event is exactly what moves it (FR-11b), and none may be kept across a write.

| Answer class | What its read runs | Range · grain | Budget | Measured today | At ten times | Staleness it may be served at |
|---|---|---|---|---|---|---|
| Home | the whole record reduced to a week: two core MCP reads and the events behind them | the last 24 whole weeks, and the whole record where the weeks do not reach its start · local week, and local day for the agents' days | `rows ≤ 600, ms ≤ 1200` computed, `ms ≤ 190` served | 0.6–1.2 s computed, 0.19 s served (recorded in `answer-cache.ts`; not re-measured here, because its read goes through the core MCP door and timing it against production would need a session that writes) | about 6–12 s computed, about 1.9 s served: the whole-record legs grow tenfold where the 24 drawn weeks do not, which is what the cache holds | zero: an event write moves the answer, so `answer-cache.ts` strands the entry on that write |
| Record | five statements over the document and event tables, one read per period and page | the period asked for — a quarter, a year or the whole record — and one page of the table · local week or month, initiative · page | `rows ≤ 2400, ms ≤ 1200` computed, `ms ≤ 190` served | 0.6–1.2 s computed, 0.19 s served (the same recorded measurement, on the same page class) | about 6–12 s computed, about 1.9 s served, for the same reason | zero, for the same write |
| Usage | `teamWeeks`, `toolWeeks`, `followupWeeks` | the seven weeks the page draws, and every refusal in the record · team, tool and refusal owner · local week | `rows ≤ 1000, ms ≤ 50` on the model, `rows ≤ 850000, ms ≤ 1800` on the raw tail | 559 ms before Task I-19 (133 + 278 + 148), the 278 being `callDays`, which only `toolWeeks` read on this page and which the page no longer reads at all; the two week-grain reductions now read the model, and their composed statement measures 1.0 ms at 41,772 real-work calls and 1.0 ms at ten times them, inside the budget declared above, so the class is `followupWeeks`' 148 ms and the model read beside it | about 1.5 s, the raw tail's projection, with the model still at 1.0 ms | zero: the model absorbs the call in the transaction that writes it and the raw tail is read at request time, so a served answer is never behind `zz.event` |
| Status | `readDays`, `latencyMeasures`, `sessionsMeasure` | the whole record by local day and by local week, and the doors' last 365 days · local day, local week | `rows ≤ 450000, ms ≤ 5000` | 500 ms (122 + 109 + 269); all three scan the same 41,891 rows and about 6,480 shared buffers, `readDays` to return 65 day rows and the other two seven week rows | about 5.0 s (1.2 + 1.1 + 2.7), the projections in `### What stays a raw query` | zero, for the same write |

The `rows` half of Home's and Record's budget is the answer's own rows — the weeks the period draws times the
reductions drawn — because both are the record reduced to a week, so their row bound is the grain's, not the
table's; Status's buffers figure is the whole-table evidence beside it.

Task I-19's first shipped union was unusable on real traffic. Its `weekBuckets` read the raw half as a range
inside each bucket's own week, assuming the row had absorbed that week: **470 of the 645 buckets end an
average of 41.6 hours before their week does**, so every range spanned other keys' events and discarded
them — 1,057,133 rows filtered to nothing across 645 probes, **482 ms** for what the model alone gives in
1.2 ms; flattened by the planner into a materialised nested loop, **1.85 s at 41,772 calls and 25 s at
417,720**, 3,488,198 temp blocks. The shipped shape bounds the raw half **once**, by the newest `through_ts`
in the table, and joins it to the model by key — exact, because `WEEK_RECORD` sets a bucket's `through_ts`
to that bucket's own newest `ts` in the transaction that inserts the call. Verified **on all 645 buckets,
field for field, and against the raw statement at team and week**, then on a throwaway seeded so that 496
of its 720 buckets end early: **720 rows and 1.0 ms at 41,772 calls, 720 rows and 1.0 ms at 417,720** —
inside both numbers, with no new index. A table with no rows takes `-infinity`, so an unbuilt model answers
from the whole history; `checks/event-work-week-reads.ts` holds all of it, buffers included.

### What stays a raw query

These seven read `zz.event` from its first row on every request, each for a reason the model cannot fix, with the cost measured today and its projection at ten times the calls.

| Reduction | Why its grain cannot be held | Today | At ten times |
|---|---|---|---|
| `followupWeeks` | a refusal and the 120 seconds after it; a session's whole later history | 148 ms platform-wide, 3.0 ms for one team (1,388 refusals) | about 1.5 s |
| `latencyMeasures` | a per-week malformed split by side | 109 ms | about 1.1 s |
| `searchDays(from = null)` | a null `from` asks for the first search ever made, so the window is the whole history | 50 ms | about 0.5 s |
| `sessionsMeasure` | a session's whole later history, not a bucket's | 269 ms platform-wide, 1.9 ms for one team | about 2.7 s |
| `readDays` | the local day and hour, finer than the model's week | 122 ms | about 1.2 s |
| `callWeeks` | it would answer from the model; it is left raw because the metric table this phase agreed to ship moves exactly `teamWeeks` and `toolWeeks`, and moving more is a change to what the spec agreed | 133 ms platform-wide, 1.9 ms for one team | about 1.3 s |
| `callDays` | the local day, and a `batched` dimension the model's `ms` array deliberately excludes | 278 ms | about 2.8 s |

### Which read models exist, and why each one does

One model exists, because its cost grows with `zz.event` and its answer does not.

| Read model | The question it answers | Why a table rather than a view |
|---|---|---|
| `zz.event_work_week` | what one team's real-work calls added up to in one week of the deployment calendar under one refusal owner — calls, refusals, failures, and the durations a median is taken over | the answer is a few hundred keyed rows and each count is an integer the writing transaction increments, so it costs 1.2 ms where `zz.event` reads 41,772 rows in 133 ms; a view would re-run that read under a shorter name |

`zz.event` above is the source a model is rebuilt from and not a model, which is why the arm holding this list reads the table's first column and never every `zz.` name in the section.

A second model is worth declaring when a statement reads rows in proportion to a table's size rather than to
what the page shows, the answer is derivable from something already stored, and the write path can absorb the
change in the transaction that caused it. None of the seven meets that — a session's later history, the two
minutes after a refusal, a local hour — and a model holding it would store state a rebuild loses.

### What a page may cost

The rule, stated once: **a page's statement cost is bounded by what the page shows, not by what its table
holds — a statement whose rows read grow with `zz.event` is either served by a read model or named in
`### What stays a raw query` with its measured cost today and its projection at ten times.** Every register
row above is held to it; a figure in neither place is the defect this section prevents. Staleness is per
class in the strand table and all four are zero: no write, no clock boundary may be served past.

### The two shapes this refuses

**A plain SQL view is refused by name.** It is a saved query and saves no work: the planner expands it into every statement that reads it, so the reduction still runs over `zz.event` on every request.

**A materialized view is refused beside it, by four mechanisms rather than by an adjective:**

- `REFRESH MATERIALIZED VIEW` takes an ACCESS EXCLUSIVE lock on the view, so every reader waits;
  `CONCURRENTLY` drops the lock and cannot run inside the writing transaction, where a model must be absorbed.
- It recomputes the whole history on every refresh: the answer at 41,772 calls costs what the answer at
  417,720 costs, each time.
- `REFRESH` refreshes no optimizer statistics, so `pg_statistic` describes the rows the view held before
  until `ANALYZE` is run by hand.
- `schema-target.ts:35` declares only `tables`, so a materialized view is the one object in the database the
  schema gate cannot see: in no target, diffed against nothing, driftable with the gate green.

DELIBERATE: the refusal does not rest on autovacuum. PostgreSQL's autovacuum does consider `RELKIND_MATVIEW`
and analyzes one on its own schedule; the claim that it ignores them is false and is not repeated here, and
the statistics reason above is a fact about refresh time rather than vacuum. A materialized view is the right
tool when a change cannot be expressed incrementally — here it can, and the write path absorbs the call.
