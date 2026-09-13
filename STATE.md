# State — zz-stack

Status: 0.32.3 (2026-09-13). What we believe, and what we have. The world as it stands at this
version — not a record of how it got here.

§6 is held to a stricter bar than the rest of this file: **verified, in production**. §6b
names what this release adds and has not yet run in front of anyone — whether or not it is
deployed, because being deployed is not being used.
Collapsing the two would let a version bump confirm work that nothing has confirmed.

That record is CHANGELOG.md, beside this file. The two are a pair and the division is strict:
the changelog is the transaction log, this is the balance. A reader asking "what changed in
0.2.0" wants the changelog; a reader asking "what IS this platform" wants this.

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
  back — by `reconcile`, by zz-knowledge, by the next person who asks what this team
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
One tool capability is likewise platform-owned: **zz-knowledge**, the
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
`@zz/*`, zz-blocks, future zz-kb, zz-knowledge). Product vocabulary lives under
`catalog/<owner>/` — `catalog/sdlc/` is software delivery (sdlc-flow and its tests),
and `catalog/zz/` holds the platform's own entries (zz-access, zz-admin, zz-knowledge, zz-flow-builder). Referring to
the platform from a flow uses the platform's real names; declaring a
flow's identity uses its own.

Two shapes live under one word there, and §6e says which is which: a package that declares
`stages` is a FLOW, one that does not is a SURFACE — an agent and its doors, no steps.

## 5a. Operating model — every flow is made by two teams

| | The flow's team | The ZZ platform team |
|---|---|---|
| writes | markdown skills + document-set declaration + scenario content | all TS services, guardrails, telemetry, snapshots, retries, monitoring, deployment |
| fixes | methodology: question style, stage wording, defaults | everything outside the flow |
| bar | **zero code** — a flow is markdown + a manifest | we absorb all engineering complexity |

**Improvement is a service, not a user duty.** Business teams only use the
flow; their usage mechanically produces documents, telemetry and ledger
rows. The platform team (the professionals) runs zz-knowledge across all teams,
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
- **Tools do format, skills do judgment**: add_source / knowledge_add /
  knowledge_supersede keep users out of format work; `zz-knowledge`, the skill
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

Stated once, in `zz-backbone`, inherited by every flow on every harness.

- **The initiative is the unit of work, not the chat.** Someone starts in
  LibreChat, a colleague continues in Claude Code, it finishes back in the
  browser. `initiative_status` computes the position — documents, gates,
  and the **next move**, including whether it waits on a human or on the
  agent — from the manifest and the frontmatter. Every harness gets the
  same answer; chat memory is never the state.
- **If someone's input changes a required document, that input becomes a
  source and the document goes to the next version.** The commonest case is
  not a meeting note but the *second brain dump* — the correction a
  stakeholder adds after reading their own intent. `revise_document` does
  it in one call: stores their words verbatim as a source, links it, bumps
  v1 → v2, puts `status` back to draft so the gate returns to a human, and
  leaves the approved v1 in `_versions/`.
- **Capture is the goal, never a toll.** A person may edit their own
  document and owes nobody a reason; an unexplained revision is allowed and
  simply records no cause. We make the right thing the easy thing, not the
  mandatory thing.
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
  writing them by hand is refused. `approve()` and `close()` stamp them from the
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
| Gates | which documents gate, and how many | `status` is exactly `draft` or `approved`, and only `approve()` moves it — the model writes no frontmatter at all |
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
— are first-class: from any harness they can search, read, `list_sources`,
`add_source`. It contributes knowledge without editing
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
| Team skills | two roots, both readable by that team from every client and invisible to others: the team's OWN STORE at `skills/<name>/SKILL.md`, written with `write_file` and needing nobody's approval, and a skills-only package under `catalog/<team>/` once one earns its keep beyond the team. Both are searched after the platform's and the flow's, so neither can shadow `zz-backbone` or a stage | zz-core |
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
- **Three flows in the catalog:** `sdlc-flow` (7 stages, 17 skills), `zz-plugin-eval`
  (5 stages, 6 skills), and `zz-access`, which is shelved. The two component-level
  evaluators, `zz-skill-eval` and `zz-block-eval`, were deleted when `zz-plugin-eval`
  replaced them; the rows they registered on this deployment are still in `zz.skill`.
- **The doors:** `/core/mcp`, `/manage/mcp` (the tool list IS the caller's role — 20 for a
  member, 24 for a team admin, 34 for a superadmin), `/p/<block>/mcp`.
  Every route the gateway serves has a caller; the gate holds that.
- **One terminal client.** claude-code. The console is the one browser
  surface, and it is a separate repository; the gateway serves it no HTML of its own.
- **No block is registered.** `blocks.ts` ships an empty built-in registry — a deployment's
  blocks come entirely from `PLATFORMS`, and this one sets none.
- **Governance in code, not in prose:** document-chain gates, the exact status and outcome
  vocabularies, an approval that only exists once `approve()` recorded it, a close that must
  name who accepted or say why nobody did, and `approve` now reporting whether anything fetched
  the document since its content last changed.
- **Backups work, and did not.** Nightly and weekly-verify, both in the host's crontab. Until
  2026-09-11 every run wrote three archives and then deleted all three, because a fourth step
  dumped a Mongo that had been removed and the cleanup treated the failure as a partial run.
  Now verified: three archives kept, 903 artifact entries read back and matched, and the restore
  drill returns 3 principals.
- **The offline gate is 285 checks**, and six of them RUN code rather than reading it: the
  identity resolver's ordering, the markdown sanitiser, the redaction predicate, the scope and
  authority rules, plus the two behaviour suites the zz-core split made reachable.

**What is NOT claimed here, and was:** there is no standing evaluation. All five eval tables
hold zero rows, the smoke engine is not in the tree, and the CLI half of that track writes raw
SQL past the MCP door. §6c has said "the evaluation track exists, and has not been run" since
0.11.0; it is still true, and the earlier §6 claimed a five-scenario standing suite on top of
it.

## 6r. In 0.32.0: the subject of an evaluation is a plugin, and it has not been run

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

**What is not verified: the flow itself.** `/zz:zz-plugin-eval sdlc` has never been run. On the
data as it stands it should take the full path — six usable runs and four cases both clear
their thresholds — but that is a prediction, not an observation, and this section does not
record predictions as facts.

**Three write tools exist because their absence was found three times.** `plugin_cases_record`,
`plugin_ruler_record` and `plugin_finding_record`. Each closed a hole where the flow READ a
table nothing could write: the case results are produced by a CLI on somebody's laptop and
zz-core is a container that cannot see them; a ruler was written into a document and never into
a row, so the judge would have refused forever with the gate green; and `zz.eval_finding` lost
its only writer when the old evaluation went. The shape was one shape three times — the design
specified what the flow reads and under-specified what it writes.

## 6q. In 0.29.0: one client, and a shelf anyone can read

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

## 6p. In 0.28.0: one front end, one set of APIs, and nothing that is not the package

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

## 6o. In 0.27.0: the doctor, and the difference between "wrong" and "could not look"

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

## 6n. In 0.26.1: nothing is over 700 lines, and the gate says so

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
held a whole second subject; `judge.ts` at 627 with three exports is genuinely one. A list of
files allowed to be large is a list nobody prunes. The gate is **285 checks** and the console's
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

## 6m. In 0.26.0: every file was read, and what it found was not dormant code

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
- **§6 of this file described a platform that was dismantled** — the Operations flow
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

## 6l. In 0.25.0: a deck is built in stages, and the record says who looked

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

**`approve` says whether anything fetched the document since its content last changed.** The
platform has always asked for `show_document` before a gate — a person approves bytes, and the
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

## 6k. In 0.24.0: one door, and the tool list is the role

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

## 6j. In 0.23.0: one person, one host, one door

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

## 6i. In 0.21.0: the team discusses, and the platform writes what they decided

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

**And a team can ask its own folder.** Retrieval is the existing `search_knowledge`, called as
the caller and therefore already scoped; the route adds generation only. Citations are built
from what was retrieved, never from the model's prose, and a citation the console cannot open
— the shared platform shelf is pooled into that search but its documents 404 outside their own
team — is named as plain text rather than linked to a page that would refuse it.

**The LLM credential never reaches the browser.** One server-held client, per-deployment, that
cannot throw at import: a deployment with no credential still boots and serves everything
else, and the route answers 503 naming the unset variable. A gate check runs the built module
with the variables stripped to prove exactly that, and scans the console for any import or
literal that would leak it.

## 6h. In 0.20.0: the console stops being a window and becomes a door

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

## 6g. In 0.18.0–0.19.0: knowledge is written twice, and the console ships as an image

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
  initiative; the handover carries a gate so the team approves what was distilled; `close()`
  refuses an initiative whose handover is not approved. `learnings.md` is abolished and
  sdlc-flow's own closing skill is deleted — `zz-knowledge` is the only skill that writes
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

## 6f. In 0.17.0: five rules leave prose for code, and nobody onboards by hand

**A rule stated in skill prose is a prompt, and it varies by interface. A rule stated in
server code holds identically everywhere.** That sentence is the whole release. Five
behaviours moved across the line, each one chosen because a live run had already shown the
prose version being routed around.

- **`show_document`** puts a document in front of a person: envelope facts, then the body
  verbatim, never a summary. Every document-writing stage now names it. **The fetch is
  recorded** as a `shown` entry with the path, version and caller — so "was this ever fetched
  before its gate was approved" is answerable from the initiative's own log. That is
  detection, not prevention: a tool result is model input, and the platform cannot vouch for
  a pair of eyes. The refusal that WOULD make it impossible is named and deliberately unbuilt.
- **Three tools stopped discarding a supplied value.** `close()` given both an acceptor and a
  no-signoff reason preferred the acceptor and dropped the reason; `reconcile()` given both an
  initiative and a block answered one and ignored the other. Both now refuse and name the
  contradiction.
- **`revise_document` accepts `self_edit`** — the record could not tell "no cause" from "cause
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
method `human` and no human has answered them: whether `show_document`'s output reads as a
document, and whether the spine's prose still overstates what the code does. Both were
exercised by an agent, which is the weakest possible reviewer of its own output.

## 6e. In 0.15.0: a package declares what it is, and nothing infers it

`zz-admin` sat in the console's flows tab beside `ops-flow`. It is not a flow — no stages, no
documents, no skills directory, an MCP surface and a hand-written prompt — and nothing in its
manifest said so, because the console had been inferring shape from contents.

The field that should have said it was already spoken for. `kind: "platform"` meant OWNERSHIP
(ZZ owns this, every account has it, a team cannot install it) while being named for SHAPE, and
`catalogEntry` carried the comment "ANY `kind` means not a flow" — false about three of the
five packages that had it, since `zz-skill-eval` is shelved and has five stages, two documents
and a gate. `governingPlatformFlows` then re-inferred flowness from `documents.length > 0` to
work around it.

**What is true now:** a package is a flow if and only if it declares a non-empty `stages`, and
`entry` and `stages` travel together in both directions — the gate refuses either alone.
Ownership is `shelved: true`, a separate axis from `install: "auto"` (all three evaluation
packages declare both, which is why one field could not carry them). `zz-access` declares its
stage; `zz-admin` stays a surface and carries its own prompt, because the generated router
assumes a flow and told it to `skill_view` an entry it does not have.

`ARCHITECTURE.md` is the definition the repository is now checked against, and
three gate checks enforce the parts a machine can read.

**What is NOT yet true:** the definition covers catalog packages, the eight roots and the
boundary between `scripts/`, `testing/` and `packages/tools`. It says nothing yet about the
`blocks/` tests corpus or about `deploy/`.

## 6d. In 0.12.0: an initiative's flow is resolved from the document that declared it

The first attempt to run an evaluation flow end to end is what found this, and it found it
the expensive way: the report reached its gate having been governed by the wrong flow from
its second document onward, so the gate the flow declares was never the gate it passed.

Two faults, one consequence. The resolver walked the initiative's folder in `readdir` order
and took the first `flow:` it met, where the design — stated in zz-backbone and repeated in
every comment around the resolver — is that the FIRST document declares it. And the check
that refuses an undeclared first document counted only rows in `zz.flow_install`, which a
platform flow never has: `team-one` was excused because it had exactly one install, and
`zz-platform`, which runs nothing BUT platform flows, was excused because it had none.

**What is true now:** documents are consulted oldest first, and the set a team must choose
from is its installs plus the platform flows the shelf ships to everyone. Every team is asked.

**What is NOT yet true:** no evaluation has completed a run under the corrected resolution.
The mis-stamped `2026-09-05-blockeval-casebox` is archived, not repaired, and its `zz.doc` rows
still name `ops-flow`.

## 6c. In 0.11.0: the evaluation track exists, and has not been run

Two flows, both platform capabilities, shipped to every team and neither yet exercised end to
end. Shipped, not installed: a platform package has no `zz.flow_install` row by construction,
which is the fact §6d records the platform having forgotten about itself.

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

## 6b. In 0.10.0, deployed and verified but not yet exercised by a round

**What 0.10.0 adds is that a skill can be read and judged in one place, wherever it lives.**
The console tells flows from blocks — a flow is an agent method that runs against blocks, a
block is something reached over MCP carrying its team's own skills — and every skill on
either serves its own text, its reference material, what it cost and what it scored.
`skill_view` gained a `file` argument, which is what made a block's reference material
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
this was used. None of it has run in front of a person. It moves into §6 when a round does.

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

- **A verdict is an act.** `approve(path)` and `close(initiative, disposition)` stamp
  `status`, `approved_by`, `approved_at`, `outcome` and `closed_by` from the session, and
  writing any of them by hand is refused. `outcome` lost `superseded` — supersession is a
  pointer between documents, not the fate of an initiative — and now reads
  `delivered | accepted | abandoned`, derived by `close()` from a disposition and whether a
  person is named.
- **`reconcile(initiative | block)`** joins `zz.decision` against `zz.event`: what a stage
  predicted about a block, beside what the platform later recorded happening to it.
  `zz.decision` had been write-only since it was added — rows derived on every index, read
  by nothing.
- **The store is a git repository**, initialised on a team's first write, committing every
  act under the name of the person who made it and under the name of the ACT: `approve:`,
  `close accepted:`, `revise:`, `patch:`, `write:`. `git` is in the runtime image, which it
  was not; without that, every commit would have failed silently.
- **A team's own skills.** `<team store>/skills/<name>/SKILL.md` is searched LAST, so a team
  can add a skill but can never shadow `zz-backbone` or a stage of the flow they run. The
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
- **The model writes the body; the platform writes the envelope.** `write_file` and
  `revise_document` refuse content that opens with frontmatter and take the rest as named
  arguments. Every envelope field now comes from a fact the platform holds or from an act,
  and the third source — a model typing YAML — is closed. `version` became the platform's;
  `sdlc-spec`'s `contract:` block moved into the body, where a reader can actually see it.
- **One way to change an approved document.** `patch_file` and `write_file` are refused on a
  gated document while it is approved, and point at `revise_document`. Two paths with
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

## 6a. Before 0.10.0: one door, a registry, a knowledge plane

The four capabilities everything above is built on, and the check that proved each. They are
listed by what they do rather than by when they landed: a delivery schedule is a fact about a
calendar, and this file is the balance.

| Capability | What it is | Proof |
|---|---|---|
| One door | the `zz` schema in our own database; PAT identity, hashed, scoped and revocable; `/admin/mcp` with RBAC, confirm-params and an audit trail; the `/core` proxy | a request without a PAT is refused; a spoofed identity header presented alongside a PAT is REWRITTEN to the PAT's owner, not trusted; every skill is reachable through one URL |
| Registry | `flow.json` manifests drive the guardrail chain; `install_flow` / `grant_tool` decide what a team has; `/p` enforces it once grants exist | the chain is enforced from the manifest rather than from code that knows the flow's name |
| Knowledge | one shelf on the platform's own team, read by every team; version snapshots taken at approval; `sources/` ungated and immutable; a mechanical ledger row at close; index-on-write with `search_knowledge` carrying provenance | a full chain test: three snapshots, a ledger row, and a search hit that cites its source |
| Many flows | the guardrails are flow-agnostic — the chain comes from each flow's own manifest | proven with a one-document, one-gate fixture: same image, different manifest, different discipline, zero code changes. The fixture was deleted once it had done its job |

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
`revise_document` cleared the signature and returned a document to draft while
`patch_file` edited the same document and moved nothing. None of the three was
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
