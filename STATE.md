# State — zz-stack

Status: 0.35.0 (2026-09-14). What we believe, and what we have. The world as it stands at this
version — not a record of how it got here.

§6 is held to a stricter bar than the rest of this file: **verified, in production**. §6b
names what this release adds and has not yet run in front of anyone — whether or not it is
deployed, because being deployed is not being used.
Collapsing the two would let a version bump confirm work that nothing has confirmed.

That record is CHANGELOG.md, beside this file. The two are a pair and the division is strict:
the changelog is the transaction log, this is the balance. A reader asking "what changed in
0.2.0" wants the changelog; a reader asking "what IS this platform" wants this.

**Where the version-by-version record went.** §6a–§6s held one entry per release — what that
release was for, and what it turned out to cost — nineteen sections and 751 of this file's
1309 lines. By the test in the paragraph above they are the changelog's kind of material, not
this file's, so they are now [HISTORY.md](HISTORY.md) for 0.23.0 onward and
[HISTORY-PRE-0.23.md](HISTORY-PRE-0.23.md) for everything earlier; each file's header says why
the two are split there. What stayed here is the balance: what the platform is (§1–§5f), where
it stands (§6 and §6b) and the rules that settle arguments (§7).

It was called "direction", three directories down, and read as neither. A document describing
where you are GOING has no obligation to be accurate about where you are — which is how it
came to say the old front end still borrowed our database, long after it was removed.

It carries the platform's own version so the two can be read against each other. It will keep
gaining detail; the principles section changes last.

The map lives in the repository README (what each directory is) and in §5's tables below (what each
layer owns). This document holds the reasoning.

## 1. What zz-stack is

> **zz-stack is the platform a solution development life cycle runs on: it
> stitches the parts together into a mechanism that actually runs instead of a
> document nobody follows, every step leaves evidence, and that evidence is what
> makes the next round smoother — agents do the work, people make the decisions,
> and the parts underneath are yours to choose.**

Read the four clauses as four claims, because each one is refusable and each one
is what some other product gets wrong:

- **A mechanism, not a document.** A life cycle written down is a life cycle
  nobody follows. Here the stages, the required documents and the gates are
  declared in a manifest and enforced in code, so following the method and doing
  the work are the same act.
- **Evidence as a by-product.** Nobody is asked to write the record. Approvals,
  outcomes, telemetry and the team's own git history fall out of the work being
  done, which is the only way a record stays true.
- **Evidence is the input to the next round.** The record exists to be read
  back — by `knowledge_reconcile`, by zz-handover, by the next person who asks what this team
  already decided about this block. A record nobody reads is filing, not memory.
- **The parts are yours.** Models, front ends, building blocks and flows are all
  replaceable, by design and one at a time. What the platform owns is the seam
  between them.

It is not an app. Apps (chat UIs, flows, agents, blocks) come and go on top
of it. The platform's product is what remains when they do.

## 2. The permanents (what the platform actually owns)

| Permanent | What it is | Why it outlives everything |
|---|---|---|
| **Knowledge** | every team's documents, decisions, learnings | the soul of an enterprise team |
| **Identity & membership** | who you are, which team, what you may see | teams outlive tools |
| **Provenance** | approvals, telemetry, audit — the *evidence* behind every document | knowledge without provenance is a wiki; with it, an asset |
| **Contracts** | the document envelope, the plugin standards (Agent Plugins 1.0.0, R1–R14) | knowledge is only permanent if its grammar is |

Two mechanical capabilities serve all four and are platform-owned forever:
**activity telemetry** (never model-written) and the **computed initiative state** —
`initiative_status`, derived from the documents rather than kept as a list, so it cannot disagree
with them.
One tool capability is likewise platform-owned: **zz-handover**, the
improvement analysis every team's every flow gets for free.

Everything else is deliberately replaceable: flows evolve and get
discarded; interfaces follow the times (Claude Code today, our own
web tomorrow); models rotate; blocks belong to other teams.

## 3. The three planes

```
┌─ CAPABILITY (pluggable everything) ─────────────────────────────┐
│ flows (per team/person, install what you need) · agents          │
│ blocks (MCP via gateway) · interfaces (any MCP-capable host)     │
├─ GOVERNANCE (small, stable, code not prose) ─────────────────────┤
│ identity (session/PAT → person + teams) · document-chain gates   │
│ approval semantics · audit                                       │
├─ KNOWLEDGE (the core; permanent) ────────────────────────────────┤
│ zz-kb: teams as tenancy · markdown documents with the envelope   │
│ links · versions · events · ledger — search and provenance       │
└──────────────────────────────────────────────────────────────────┘
```

## 4. The two-level document contract

**Level 1 — the envelope (organisation-wide, never forks).** Every document
from every flow carries: `flow: <name>`, `type`, `status`
(exactly `draft` or `approved`), `approved_by/at` when gated, `outcome` on
the closing document (exactly `delivered`, `accepted` or `abandoned`),
`closed_by` naming who closed it, team/stakeholder/dates — plus the mechanical
activity log and an index row. Search, provenance, governance and
analytics operate ONLY on this layer. Both vocabularies are closed for one
reason: they are what the ledger and the index are read BY, and a column
holding `accepted`, `shipped`, `done for now` and `mostly complete` answers
no question anybody asks of it. Be loose with the person, exact with
ourselves — openness belongs at the boundary with a human, determinism
everywhere after it, and the model is the thing that converts one into the
other. `flow` is the bare name — it is what resolves the
manifest, so it cannot carry a version and still be a key. Which version a team installed is
registry state (`zz.flow_install.version`), not envelope state; this said `<name>@<version>`
and no document has ever carried one.

**Level 2 — the flow's document set (flow-owned, forks freely).** Each flow
declares its own documents, roles, gate chain and — per document — the section
headings it must carry, in its plugin. The platform enforces the headings
without knowing what any of them mean: WHICH headings is the flow's business,
THAT they are present is the platform's. A list of them in zz-core would make
this an sdlc platform. The Operations flow declares five documents and three gates — `intent.md`, `spec.md`, `plan.md`, each
`gate: true`, with the acceptance at verification being a stakeholder verdict rather than a
fourth gate; a minimal flow may declare one spec and one gate; both are fully compliant. The platform enforces
*the chain each flow declares*, not our chain — zz-core holds no chain of its own, and a flow
whose documents declare none is reported as ungoverned rather than judged by someone else's.

Rule of rules: **flows may fork; the envelope may not.** That single
constraint is what keeps organisation-wide knowledge searchable and
trustworthy while every team works its own way.

## 5. Naming boundary

Platform vocabulary is **zz** (zz-stack, zz-core, gateway, the team store,
`@zz/*`, zz-blocks, future zz-kb, zz-handover). Product vocabulary lives under
`catalog/<owner>/` — `catalog/sdlc/` is software delivery (sdlc-flow and its tests),
and `catalog/zz/` holds the platform's own entries (zz-access, zz-admin, zz-handover, zz-flow-builder). Referring to
the platform from a flow uses the platform's real names; declaring a
flow's identity uses its own.

Two shapes live under one word there, and 0.15.0's entry in
[HISTORY-PRE-0.23.md](HISTORY-PRE-0.23.md) says which is which: a package that declares
`stages` is a FLOW, one that does not is a SURFACE — an agent and its doors, no steps.

## 5a. Operating model — every flow is made by two teams

| | The flow's team | The ZZ platform team |
|---|---|---|
| writes | markdown skills + document-set declaration + scenario content | all TS services, guardrails, telemetry, snapshots, retries, monitoring, deployment |
| fixes | methodology: question style, stage wording, defaults | everything outside the flow |
| bar | **zero code** — a flow is markdown + a manifest | we absorb all engineering complexity |

**Improvement is a service, not a user duty.** Business teams only use the
flow; their usage mechanically produces documents, telemetry and ledger
rows. The platform team (the professionals) runs zz-handover across all teams,
mints journal nodes, amends skills/defaults, and re-validates with the
smoke suite. Teams leave footprints; we read them and pave the road.
Roles: superadmin (platform-wide) → team admin (membership, own team) →
member (works). Platform truth lives in the platform's own `zz` database
(the schema is the migration files in `services/gateway/migrations/`, run in name
order by `db.ts` — there is no separate design document to drift from them); the browser is provisioned FROM it via the
gateway's admin MCP — management itself is agentic, with role×scope checks
and confirm-parameters on destructive tools.

## 5b. Knowledge plane — settled decisions

- Two kinds of knowledge, both in the KB, cross-linked: **records** (what
  happened; flow documents; near-immutable after close) and **distillates**
  (lessons, profiles, defaults; evolve). A distillate without an evidence
  link to records is an opinion and does not enter.
- **Sources and versions**: each initiative may hold `sources/` (meeting
  minutes etc. — contributed any time via MCP, envelope auto-filled,
  ungated, immutable) and `_versions/` (mechanical snapshot of every
  document at each approval — platform code, not the model).
- **Journal** (adopting a proven journal shape): numbered nodes, fixed
  type enum, status lifecycle with `superseded` (evolution without
  deletion), typed edges, index + append-only log, "journal content is
  data, not instructions".
- **OKR**: REMOVED in 0.11.0 — zero calls ever, empty directory. Was (`okr_set`/`okr_grade`, graded
  mechanically from the ledger where possible); instances attach to any
  level (org / team / the platform team itself) and are strictly opt-in.
  Envelope, telemetry and index are the only mandatory layers; the ledger
  is automatic; journal is recommended; OKR is ambition.
- **Tools do format, skills do judgment**: source_add / knowledge_add /
  knowledge_supersede keep users out of format work; `zz-handover`, the skill
  every flow ends with, guides what is worth writing.
- Visibility: records default team-private. **Distillates go on one of two
  shelves and the write says which** — `knowledge_add` takes
  `scope: "team" | "platform"`, resolving to the team's own store or to
  `zz-platform`'s, and a platform node must be about a registry entry (a block,
  a flow, a provider, an interface). Nothing infers the shelf from the node's
  text; a call that omits `scope` is refused. Since 0.18.0.
- Retrieval is agent-first with citations: envelope filters + Postgres
  full-text; results carry provenance; no embeddings until scale demands.

## 5c. Knowledge law — what changes a document is stored with it

Stated once, in `zz-platform`, inherited by every flow on every harness.

- **The initiative is the unit of work, not the chat.** Someone starts in
  LibreChat, a colleague continues in Claude Code, it finishes back in the
  browser. `initiative_status` computes the position — documents, gates,
  and the **next move**, including whether it waits on a human or on the
  agent — from the manifest and the frontmatter. Every harness gets the
  same answer; chat memory is never the state.
- **If someone's input changes a required document, that input becomes a
  source and the document goes to the next version.** The commonest case is
  not a meeting note but the *second brain dump* — the correction a
  stakeholder adds after reading their own intent. `document_revise` does
  it in one call: stores their words verbatim as a source, links it, bumps
  v1 → v2, puts `status` back to draft so the gate returns to a human, and
  leaves the approved v1 in `_versions/`.
- **A version says WHICH KIND of change it was; it still owes nobody a
  reason.** `document_revise` refuses a revision naming neither a cause nor
  a `self_edit`, and refuses one naming both. That is not a toll: `self_edit`
  is a declaration of what you edited, so a typo fix costs a few words rather
  than an invented source. What it buys is a record where silence is no
  longer ambiguous — v2 arriving with nothing attached used to mean either
  "nothing outside caused this" or "nobody wrote down what did", and the next
  reader could not tell an incorporated decision from a second thought.
- **Refinement is offered, not imposed.** Material that lands after an
  approval is reported (`sources_after_approval`) as a fact. Whether the
  document should change is the team's call.
- **A gate constrains the AGENT, never the person.** It is a line the agent
  owes the document, not a hoop somebody has to jump. Whether this person
  agreed is a judgement a colleague would make — not a phrase from a list, and
  a list is only a way to fail whoever phrased it the fourth way. A standing
  delegation is an ordinary answer and holds until it is withdrawn. Backbone
  once said the opposite, in these words: a gate passes ONLY on "approved" or
  "yes, I approve", and "please continue", "ok", "go ahead" do NOT pass. That
  was the platform instructing every flow to refuse a person's own words.
  Guardrails point at the model, which is the unreliable component; code is
  deterministic and people are not ours to restrict.
- **A signature records who the approval BELONGS to**, not that a human typed
  it. Put an agent in front of your work and what it does in your name is your
  decision carried out. What is refused is an approval belonging to nobody — a
  team slug, "the user", "the agent" — because an initiative nobody owns is one
  nobody can answer for.
- **Structure is the platform's job.** `flow` and `type` are stamped by
  zz-core on write from the manifest — asking every flow author to repeat
  them in every template is how three of five Operations documents once indexed
  with no provenance at all.
- **A verdict is recorded by an ACT, not by typing a field.** `status`,
  `approved_by`, `approved_at`, `outcome` and `closed_by` are the platform's;
  writing them by hand is refused. `document_approve()` and `initiative_close()` stamp them from the
  session, which is the only party that knows who is calling and what day it is.
  The evidence: of 93 approved documents on this deployment, four carried no
  `approved_at` and two no `approved_by`, each written by an agent that had just
  passed a gate — and two smoke runs put a team slug in the approver. No amount
  of prose in a skill makes a model reliably type a date it can only guess, so
  the fields stopped being writable. What is tested is the CHANGE, not the
  presence: a document may carry an approval it already had.
- **The store is a git repository the team can walk away with.** Every act that
  changes it is a commit naming that act — `approve:`, `close accepted:`,
  `revise:`, `patch:`, `write:` — authored as the person who made it. So "what
  changed between the approval and the close" is a question the team's own
  history answers, in a format that outlives this platform, on a repository that
  is already theirs. Mechanical telemetry stays out of it: a commit per skill
  load would bury the history the repository exists for.

## 5d. Component boundaries — five layers

(The table below is the inventory; it is the authority on what exists.)

The ordering rule: **everything above the platform services is
replaceable; the platform services and the state they guard are not.**

| Layer | Components | Replaceable | Owner |
|---|---|---|---|
| Clients | one CLI harness (Claude Code), installing from the public shelf | yes | ZZ (projections) |
| Catalog | sdlc-flow · zz-access (access and the platform register, two skills on one door) · zz-plugin-eval · each team's own packages under `catalog/<team>/` (flows, and skills-only packages) | yes, per team | flow team (content) / ZZ (machinery) |
| Platform services | gateway · zz-core | **no** | ZZ |
| Blocks | none registered on this deployment | yes, behind R1–R14 | third parties |
| State | Postgres `zz` schema · artifacts volume | **no** | ZZ |

Each service has one focus, and questions belong to exactly one of them:

- **gateway — authority.** "May this person do this?" is answered here and
  nowhere else: identity (session or PAT), the admin MCP, per-user
  credential proxying to blocks, the registry and its migrations, the
  knowledge web app.
- **zz-core — the record.** The skills library, each team's knowledge
  store, and the document discipline in code: gate chain, status
  vocabulary, close requirements, approval snapshots, envelope stamping,
  mechanical telemetry, and the initiative's computed next move.

What is pluggable and what never moves:

| Dimension | Pluggable | Fixed |
|---|---|---|
| Stages | any number, any names, per flow | they come from the manifest; telemetry proves the order |
| Documents | any set, names, roles, and which section headings each must carry | `flow`, `type`, `status` — stamped by the platform; a heading the flow declares is present or the write is refused |
| Gates | which documents gate, and how many | `status` is exactly `draft` or `approved`, and only `document_approve()` moves it — the model writes no frontmatter at all |
| Tools | which blocks a flow declares, which a team is granted | every call authenticates as the caller, through the one door |
| Client | web front end, CLI harness, agent runtime, read surface | the rules live in zz-core, so where the loop runs changes ergonomics and nothing else |
| Method | all of it — markdown the team writes | versioning, snapshots, telemetry, the ledger |
| Knowledge | what a team keeps and how they name it | files are the truth; the index is derived and rebuildable |

### Replacing the front end — the portability contract

"The front end is replaceable" is a fact, not a slogan, and 0.2.0 is the
receipt: Open WebUI was removed and the platform did not move. It is true because of where
things live. The platform's own database decides who you are
(`zz.principal`), which team is yours (`zz.membership`, and nothing
else — the fallback that read the front end's own groups for anyone with no
membership row is gone, because while it existed the front end was still a
source of platform truth), what your team runs (`zz.flow_install`, with the
manifest), and what it may call (`zz.tool_grant`). The rules live in
zz-core, in code, where no client can bypass them.

A new front end therefore has to do exactly three things: authenticate a
person and either carry their token or forward their identity from inside
the trusted network; speak MCP to `/core/mcp` (and `/manage/mcp` if it wants
access or registry calls), both self-describing via `tools/list` — which on
`/manage` returns what that caller's role can execute; and render whatever
it is good at. Nothing about a flow, a gate or a document lives in it, so
there is nothing to migrate when it goes.

**A person's credential is their own, and the front end obtains it by signing in.**
There is no shared team key any more — the level that let a new joiner work on day
one also meant the block's audit log recorded the platform rather than the
person, and made "am I connected?" unanswerable, because somebody holding no
credential at all looked connected while a colleague's key carried them. And there
is no box asking anyone to paste a token: the gateway is an OAuth authorization
server for its own doors, so the front end is refused with a challenge, discovers
it, registers itself, and holds what it is given. A block adds its own consent to
that, chained into the same click, because only the block can say who you are to
it. What this buys is one honest sentence: the dot is green when the handshake
completed, and a door with no credential refuses rather than answering with a stub
that made every server look connected.

**The doors hold no session, and never answer with an HTTP error status.** Both
are the same lesson, learned expensively. An MCP client reads the HTTP status as
the health of the TRANSPORT and the body as the answer to the call; we had been
putting answers in the status. A session id, meanwhile, is process memory, so it
died with every deploy and every idle sweep while the client's copy of it lived
on — and the SDK client has no recovery from the 404 the spec told us to send.
Measured on production over seven days: 52 `Error POSTing to endpoint`, 28 failed
stream opens, 12 bad gateways, against TEN `credential_required` calls in a
fortnight. Almost every "your block needs reconnecting" this platform has ever
shown a person was a dropped socket wearing a credential's clothes. Statelessness
costs a server per request — five milliseconds against a thirty-millisecond call —
and buys back a class of failure nobody could diagnose from inside a conversation.

What it cost, measured rather than estimated: a provisioning script, a
first-token bootstrap, and a new transport for the smoke engine. What it did
NOT cost: a single change to a gate, a document, an envelope, the knowledge
store or the PAT model. The platform database was untouched — the front end
had been a guest in it, not its owner.

What we still owe the claim: each new front end needs its own provisioning,
because the registry answers in platform terms and something has to turn that
into that client's shapes — a day of work, not an architecture change — and
the web knowledge base reads the record and takes sources, so a front end that wants
contribution outside a flow needs the upload surface we parked.

### Clients, segregated by where the agent loop runs

They are not variants of one thing, and calling them all "harnesses" hid
the difference that matters.

| Class | Examples | Loop runs | Person uses | Also brings |
|---|---|---|---|---|
| **Web front end** | LibreChat | on our server, inside the front end itself | a browser | nothing local — all server-side |
| **CLI harness** | Claude Code | on the person's own machine | a terminal | their files, git and shell — the reason to work there |
| **Read surface** | Web KB (`/app`) | nowhere — no agent | a browser | nothing; reads the record, attaches sources |

`my_client_setup` builds the shelf from the registry — marketplace, plugin,
router skill, MCP wiring, and a command for every skill a person TYPES rather
than a method loads — and prints how to install it; pass `email`, as a
superadmin, to render somebody else's. The shelf itself is committed to this
repository and cloned from GitHub rather than served from `/pkg/<client>.tgz`,
which went with Codex and Hermes on 2026-09-12. Skills travel as files, and
`CLAUDE.md` / `AGENTS.md` / `SOUL.md` are never written to, because those
are engine-global and a flow has no business changing how the whole engine
behaves.

## 5e. Roles and responsibilities

Three parties build a flow, and the split is what lets a team run a
governed flow without hiring an engineer.

| Who | Owns | Does not own | Answers for |
|---|---|---|---|
| **Flow team** | the method: stages, questions, documents, what "done" means — markdown only, zero code | guardrails, deployment, blocks, telemetry, engines | whether the flow describes how they actually work |
| **ZZ team** | everything under the method: both services, the store, the registry, the projections, the engines, deployment, backups | what the team's method should be | that the platform records the truth, and keeps doing so |
| **Block teams** | their platform and its MCP surface | anything about flows or identity | meeting `blocks/_standard/skills/building-a-block/references/contract.md` R1–R14 |

Platform roles (authority, re-derived from the database on every call):

| Role | Granted by | May do |
|---|---|---|
| **Superadmin** | seeded from config | everything: people, teams, block grants, installs |
| **Team admin** | superadmin, per team | their team's membership and installs; issue PATs for their team |
| **Member** | team admin | run flows, read and contribute to their team's knowledge, self-issue a PAT |

A person may belong to several teams and **acts for exactly one at a time** — their active
team, changed in ZZ Access. One token, one team in view, everywhere: the same rule in the
browser and in a CLI harness. It is a stored choice rather than a header a client sends, so
there is one answer to "which team" and one place to change it.

And the people who never run a flow at all — reviewers, auditors, partners
— are first-class: from any harness they can search, read, `source_list`,
`source_add`. It contributes knowledge without editing
around a gate.

## 5f. Platform capabilities (what a team gets for free)

| Capability | What it gives | Where it lives |
|---|---|---|
| Identity & teams | one principal per person; teams; PATs (hashed, scoped, revocable); harness accounts linked by email | gateway |
| Registry | which team runs which flow, with its manifest; which blocks they may use | gateway + `zz` schema |
| Projections | the registry is the truth and every client READS it: `render_agent_definition` returns a team's browser agent as data, and an installable package is generated per person and committed to this repository as the public shelf, which their client clones from GitHub — the per-client tarball at `/pkg/<client>.tgz` went with Codex and Hermes on 2026-09-12, as 5d says. `install_flow` records the row and creates nothing — writing into a client is what made a product we do not control hold a copy of platform truth | gateway |
| Guardrails | gate chain, status vocabulary, close requirements, envelope stamping, system-file protection | zz-core |
| Provenance | approval snapshots, immutable sources, mechanical ledger, activity telemetry | zz-core |
| Knowledge | team store, full-text + envelope search with citations, sources, journal, OKRs | zz-core + `zz` schema |
| Team skills | two roots, both readable by that team from every client and invisible to others: the team's OWN STORE at `skills/<name>/SKILL.md`, written with `document_write` and needing nobody's approval, and a skills-only package under `catalog/<team>/` once one earns its keep beyond the team. Both are searched after the platform's and the flow's, so neither can shadow `zz-platform` or a stage | zz-core |
| Continuity | `initiative_status`: the same next move in every harness | zz-core |
| Credentials | each person's own block keys, stored once, injected per call, never echoed | gateway |
| Evaluation | smoke engine, manifest audit, the tool record, block conformance against the published standard, the cross-flow comparison, and the claim index — all flow-agnostic | packages/tools + zz-core (`testing/` is the shell around them) |
| Running it | one compose file; `issue-first-pat.sh` for the one token a fresh install needs; `install-backup-cron.sh`, idempotent by construction, scheduling a nightly backup, a weekly restore drill and the hourly turn collector | deploy/ |

## 6. Where we are (verified, in production)

**Re-established on 2026-09-11, against the deployment rather than against memory.** Everything
below was checked by calling the live platform or reading its database while writing this. The
previous §6 opened with the Operations flow "running against a real block plus two reference mocks" — ops-flow is not in the catalog, LibreChat was
removed on 2026-09-10, and no block is registered. A section held to "verified, in production"
had become the one place describing a platform that was dismantled.

The rounds it narrated are not deleted; they moved to where a transaction log belongs. This file
is the balance, and the balance is:

- **One deployment**, whose address is read off the machine rather than written here — gateway
  on the `api.` subdomain of the host's own name, console on the bare host.
  `ssh <host> 'curl -s ifconfig.me'` is the one answer that cannot go stale. Four containers: zz-core, cred-proxy, postgres, and the console.
- **Four packages in the catalog:** `sdlc-flow` and `zz-plugin-eval` are flows — they declare
  documents — while `zz-core` (the baseline everyone gets) and `zz-access` declare none and are
  surfaces rather than flows. `@zz/catalog`'s `isFlow()` decides on that field and nothing else.
  The two component-level evaluators, `zz-skill-eval` and `zz-block-eval`, were deleted when
  `zz-plugin-eval` replaced them; the rows they registered on this deployment are still in
  `zz.skill`.
- **Four doors**, counted against the live deployment on 2026-09-14 rather than from memory:
  `/core/mcp` (19), `/manage/mcp` (31, and the tool list IS the caller's role — 16 for a member,
  +4 for a team lead, +11 for a superadmin), `/eval/mcp` (10, which you get by installing the
  zz-plugin-eval flow), and `/p/<block>/mcp`. This bullet said THREE doors and 20/24/34 until
  0.35.0 — a section held to "verified, in production" describing the release before it, which
  is the failure its own opening paragraph warns about.
  Every route the gateway serves has a caller; the gate holds that.
- **One terminal client.** claude-code. The console is the one browser
  surface, and it is a separate repository; the gateway serves it no HTML of its own.
- **No block is registered.** `blocks.ts` ships an empty built-in registry — a deployment's
  blocks come entirely from `PLATFORMS`, and this one sets none.
- **Governance in code, not in prose:** document-chain gates, the exact status and outcome
  vocabularies, an approval that only exists once `document_approve()` recorded it, a close that must
  name who accepted or say why nobody did, and `document_approve` now reporting whether anything fetched
  the document since its content last changed.
- **Backups work, and did not.** Nightly and weekly-verify, both in the host's crontab. Until
  2026-09-11 every run wrote three archives and then deleted all three, because a fourth step
  dumped a Mongo that had been removed and the cleanup treated the failure as a partial run.
  Now verified: three archives kept, 903 artifact entries read back and matched, and the restore
  drill returns 3 principals.
- **The offline gate is 331 checks**, and fifteen of them RUN code rather than reading it: the
  identity resolver's ordering, the markdown sanitiser, the redaction predicate, the scope and
  authority rules, the fetched-before-approval record, the two behaviour suites the zz-core
  split made reachable, the two alias checks that import the frozen maps and resolve through
  them, the eval-cost check that imports the real case parser, the contract-fields check that
  imports `FlowStage` and `CatalogManifest` and parses fixtures through them, and the judge's
  own usage recorder, driven through `markAll` against a fake pool and a stubbed `fetch`
  because "every path out of the fetch writes exactly one row" is not a property a regex can
  state, and the document-reads check, which harvests the real zod schemas off a stub server
  and drives `documentVersions`, `presentDocument` and `writeGuard` over a fixture store with
  `shownSinceLastChange` as its oracle, and the orientation check, which opens a real MCP
  `Client` over an `InMemoryTransport` pair against both doors and asserts what the handshake
  and `session_whoami`'s payload actually carried — a grep for `instructions:` cannot tell a
  field that is declared from one that is delivered, and the field is `ServerOptions`, the
  second argument, so putting it in the first is a mistake the source reads right for. And the
  initiative-open check, which drives `initiativeState` over a fixture store in BOTH
  directions — a freeform initiative must answer `next_move: null`, a flow-driven one must
  still be told its first document, and a check asserting only the first passes an
  implementation that answers null always — and drives the real `chainFor` against a real
  flow manifest to prove the open record is what resolves a chain while the folder is still
  empty.
  (This number is hand-maintained and has been wrong twice in one session — two authors each
  adjusted it and both undercounted, because the enumeration silently omitted the
  fetched-before-approval record. It is the exact species Task I-33 removes: a count describing
  the surface that nothing derives.)
- **The gate now invokes what is in `checks/`, which for months it did not.** It registered
  three of the forty-four files there; the rest ran only when somebody typed their name, so
  "the gate passes" and "the checks pass" were two claims that sounded like one. Each check
  is registered as its task completes. Two kinds stay out on purpose and neither is an
  oversight: a `gate-*.mjs` break-test SPAWNS the gate to prove a planted defect turns it red,
  so registering one would make the gate invoke itself forever; and a host-dependent check
  (`returns-sees-a-backtrack.mjs` reaches the live database over ssh) belongs to the release,
  which has a deployment to reach.

**What is NOT claimed here, and was:** there is no standing evaluation. All five eval tables
hold zero rows, the smoke engine is not in the tree, and the CLI half of that track writes raw
SQL past the MCP door. 0.11.0's entry in [HISTORY-PRE-0.23.md](HISTORY-PRE-0.23.md) has said
"the evaluation track exists, and has not been run" ever since; it is still true, and the earlier §6 claimed a five-scenario standing suite on top of
it.

## 6b. In 0.34.0: the surface is declared, and the gate reads the declaration

**Held to this file's second bar: delivered, and not yet run in front of anyone.** Everything
below is in the tree and passes the offline gate. None of it has been exercised by a person
doing real work, and being deployed will not change that — a deploy is ours to do and a round
is not. It moves into §6 when one happens.

**A plugin declares what it is, what it ships, and what each stage leaves behind.** `purpose`,
`skills`, `commands` and `libraries` are the four declaring fields, `documents` is what makes
a plugin a flow, and a stage's `produces` names the document that stage leaves. All four
plugins on the shelf were brought to it. `commandName()` — which derived a command from a
skill's name and therefore could not be wrong in a way anybody could see — is deleted, and
the commands are declared. The reasoning, and the check enforcing each rule, is the plugin
standard in [ARCHITECTURE.md](ARCHITECTURE.md) §3b.

**The core door's names were chosen twice and are now chosen once.** Sixteen core tools, seven
evaluation tools and the `/manage` surface were renamed to the noun-verb shape the door already
implied, through frozen alias maps so a caller using the old name still resolves. Three tools
left the core door for the evaluation one, `/eval/mcp` exists, and `initiative_open` makes a
freeform initiative a declared shape rather than a degraded one — it answers `next_move: null`
and says why, instead of inventing a stage nobody agreed to.

**Every tool call now says which plugin it was made for.** Migration 050 adds the columns, and
attribution is written on the event row rather than derived afterwards from a name. What a
call cost is a column beside it — including the judge's own completions, where an unreported
figure stays null rather than becoming a confident zero, and where nothing may cap spend.

**The gate stopped taking prose at its word.** It now refuses a skill that declares a tool no
door registers, prose that names a skill no plugin ships, a stage that says nothing about what
it produces, a plugin that ships a skill it never declared, and any shipped file stating a
hand-kept count of this platform's own surface. It also invokes what is in `checks/`, which
for months it did not: a check dropped in that directory is registered or named with a reason,
and a new one that is neither turns the gate red naming the file.

**What is no longer NOT claimed.** This said no evaluation round had run against any of it.
One has: four suites were run on 2026-09-14 — eleven cases across all four plugins, both arms
on every case, zero errored runs, $15.76 — and `case_record` carried all four into
`zz.plugin_case_run`, which now holds eight recordings across eight plugin versions. What is
still unclaimed is a JUDGED round: no ruler has been agreed and no `findings.md` has ever been
written, so the flow's last two stages remain unexercised. The rest of this paragraph, which
described the eval tables as empty, is kept below for the part of it that is still true.

**What is NOT claimed.** The eval tables still
hold zero rows, which is the same sentence 0.11.0 wrote. The renames are proven to resolve by
checks that import the frozen maps, not by a caller having used an old name in anger. The
telemetry columns are proven to be written and read by a check that drives the recorder against
a fake pool — no production row has been written through them. And the release's
fit-for-purpose review, added in this version, has never been answered by a reviewer, because
no release has been cut since it was added.
## 7. Principles (the rules that settle arguments)

Thirteen, grouped by **what question they answer** rather than by the order they
were written. Each one settles a real argument that has come up more than once,
and the third column names it — a principle nobody has ever had to reach for is
not a principle, it is a sentiment.

### I · What this thing is

| # | Principle | Settles |
|---|---|---|
| 1 | **Assemble; do not manufacture.** Borrow what exists, write only what nobody offers. The less we write, the healthier this is. | "Should we build this ourselves?" |
| 2 | **Every pluggable thing takes one shape: registry, contract, projection.** The number of services does not grow with the number of pluggable things. | "Where does this new thing go?" |
| 3 | **Shrink what cannot be replaced to the smallest set.** Everything else sits behind a contract; a profile decides what it binds to. | "Is this a permanent?" |

### II · What is true of knowledge and evidence

| # | Principle | Settles |
|---|---|---|
| 4 | **Flows may fork; the envelope may not.** That one constraint is what keeps organisation-wide knowledge searchable and trustworthy. | "Can this team change the document format?" |
| 5 | **Knowledge belongs to the tenant.** We own its grammar, never its content. | "Whose repository is it, and what do they take when they leave?" |
| 6 | **Evidence must be produced mechanically, and a decision must belong to someone.** If a model wrote it, it is not evidence; an approval that belongs to no one can be answered for by no one. | "Can the agent write its own log, or sign its own approval?" |

### III · Where the guardrails go

| # | Principle | Settles |
|---|---|---|
| 7 | **Constrain the model, never the person.** Refusals land on the agent; capture is the goal, never a toll. | "Who does this refusal land on?" |
| 8 | **Loose with the person, exact with ourselves.** Openness belongs at the boundary with a human; determinism belongs everywhere after it. Where a script can decide it, do not decide it yourself. | "Should this field be a closed set?" |
| 9 | **A prose rule skipped twice becomes a code guardrail.** A rule that only gets read is a rule that eventually goes unread. | "Does this rule need to become code?" |
| 10 | **Two paths to the same effect must cost the same.** If two tools or two field values achieve the same thing and one demands less, the model will take that one — that is not the model's fault; it is a design that offered a cheaper road. | "Why does the model keep routing around this rule?" |

### IV · How we know it is getting better

| # | Principle | Settles |
|---|---|---|
| 11 | **A contract is measured, not asserted.** And with another team, the contract is the relationship. | "Does this block/vendor qualify?" |
| 12 | **Monitor outcomes, not liveness; every incident becomes a scenario.** Silence is not success, and the suite only grows. | "What should we alert on?" |
| 13 | **Improvement is a service we run, not a duty we hand to users.** They leave footprints; we pave the road. | "This flow is awkward — whose job is it to fix?" |

**Principle 10 is the newest, and it met principle 9's own bar before it was
written**: the same shape of defect had been observed three times, each one two
paths to the same effect where one demanded less. `outcome: accepted` required a
signature and `delivered` did not, so writing the latter skipped it.
`approved_by` and `accepted_by` were two words and only one was enforced.
`document_revise` cleared the signature and returned a document to draft while
`document_patch` edited the same document and moved nothing. None of the three was
the model disobeying; all three were a design offering it a cheaper road.

Half of that is mechanically checkable: a **conditional validation** — a field
required only when another field holds a particular value — is the signature of
an asymmetric fork, and the gate check "no asymmetric fork in the document guards"
now refuses one. The other half, two tools
reaching the same effect, still needs a question asked at review: *is there
another way to do this, and is it cheaper?*

**Three principles left this list**, each for its own reason. "MCP is just an
adapter" is a corollary of 2 — a design fact, not a rule that settles an
argument. "One deploy per round boundary" is a working agreement whose altitude
is wrong for this list; it belongs with operations. "Blocks are consumed, never
owned" split into 1 and 11, and its best half — *the contract is the
relationship* — is kept verbatim in 11.

## 8. To refine next (placeholders for detail passes)

- Semantic search — today retrieval is keyword-only, so "what did we decide
  about X" works only when the words match. The largest knowledge gap.
- The web knowledge base as a real surface: uploads, attachments, export.
  Parked deliberately for a session of its own.
- Off-host backup target (backups currently sit beside the data).
- Ledger → dashboard (the leading/lagging indicators from the AI-native SDLC playbook).
- Multi-org story (one org per deployment for now; revisit only on real demand).
