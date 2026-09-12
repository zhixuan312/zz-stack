# The Building Block Agent Plugin — Standard for ALL block teams

Status: STANDARD v1.3 (2026-09-02). Block teams build against this, so it changes rarely and
never silently — a version and a date here are what let a team tell whether the copy they
were handed is the one still in force.

**R1–R14 are word for word what they were in v1.1, so nothing a block team has built needs
revisiting.** v1.3 adds §2a, which is OPTIONAL and describes what a block must publish for a
person to sign in to it as themselves instead of the platform holding one shared key for a
whole organisation. A block that does none of it keeps working exactly as it does today.

**The date moved for 0.4.0 and the version did not, which is the split working as
intended.** The battery is invoked as `npm run conformance` now — the Python it used to
be is gone from the platform — so a copy dated 2026-08-28 tells a team to run a file that
no longer exists. That is a reason to re-read §6 and no reason to re-read R1–R14: the
version answers "have my requirements moved" (no), the date answers "is the copy in my
hands still the live one" (not if it predates this).

> **This file is the single source of truth for the block standard.** It lives
> in zz-stack because the platform is what defines the contract. Block teams are
> handed this file, and the two worked examples that satisfy it live in the
> sibling repository `zz-blocks` (`rulemill/`, `bookit/`).
> There is deliberately no second copy: the previous duplicate in zz-blocks had
> already drifted out of date, and a standard that exists twice is a standard
> nobody can trust.

**This is a generic standard.** Any team offering a platform as a building
block to the ZZ delivery agent delivers the SAME package, regardless of what
their platform does. The standard exists so the agent can discover, select,
assemble, and verify any block the same way — and so that adding block #10
costs the same as adding block #2.

## 1. The package (what every team delivers)

One **agent plugin** per platform, following the industry-standard
**[Agent Plugins 1.0.0](https://agent-plugins.org)** specification (open and
vendor-neutral; proposed by Vercel, refined with AWS, Anysphere, GitHub,
Microsoft and OpenAI, and stewarded by a technical steering committee drawn
from AWS, Cursor, Microsoft, OpenAI and Vercel). Fixed locations, no
relocation:

```
<your-block>-plugin/
├── plugin.json            REQUIRED  {"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
│                                     "name": "<your-block>-plugin"}
├── mcp.json               REQUIRED  declares your MCP server(s) + transport
│                                    (streamable HTTP), e.g.
│                                    {"mcpServers": {"<block>": {"type": "streamable-http",
│                                     "url": "https://<host>/mcp"}}}
└── skills/                REQUIRED  Agent Skills spec format
    └── <block>-usage/
        ├── SKILL.md                 usage skill (content spec in §3), with
        │                            name/description frontmatter
        └── references/              worked samples the agent can read: a
                                     configured entity, a wired integration,
                                     block metadata (category, integration
                                     points, contacts)
```

A bare `mcp.json` without skills does not meet the standard: it forces every
consumer to rediscover your platform's rules by trial and error. Per the
spec, a failing MCP server must not take the plugin's skills down — the
usage skill stays loadable even when the platform is degraded.

## 2. The MCP server — generic requirements (R1–R14)

| # | Requirement (applies to every block, whatever it does) |
|---|---|
| R1 | One MCP server per block, one tool namespace. Never merge blocks or split one across servers |
| R2 | Self-description: `get_platform_overview` — what the platform is, environment, web URL, in words a business user recognises |
| R3 | Docs tools: `read_api_spec(topic)` covering required fields, encodings, orderings, status vocabularies, and every non-obvious rule your API enforces |
| R4 | Usage skills served by the server: `list_usage_skills()` + `usage_skill_view(name)` (content spec in §3) |
| R5 | Honest tool verbs that state the capability (`create_x`, `approve_y`, `publish_z`) — never `do_action`/`submit` |
| R6 | Validation errors in prose that teach the rule ("a form source requires the form platform's secret_key") — no silent coercion, no bare status codes |
| R7 | Lifecycle enforced server-side: if publishing requires tests, REFUSE publish until tests pass. Advisory gates get skipped by agents |
| R8 | A catalogue tool for your connector/extension surface where you have one (`list_node_types`, `list_connectors`) — this is how agents find native integrations instead of hand-wiring |
| R9 | Human-checkable surface: `get_app_url(page)` returning web views for every stateful object — verification writes the stakeholder's manual from these screens |
| R10 | Read-back for every write (`get_*_details`), and an inspectable outbox/trace for every side effect (emails, deliveries, executions) |
| R11 | Audit tools: platform-level and per-record audit trails |
| R12 | Caller identity honoured from forwarded user headers (or an equivalent signed claim) for scoping and attribution |
| R13 | Staging affordances: safe test mode, clearly deletable test data, and a way to restore anything a test moves (counters, sequences, toggles) |
| R14 | Where your platform emits events: webhook registration + per-webhook delivery logs, and the FULL event payload delivered (consumers' templates/expressions must be able to reach nested keys — never flatten away or truncate nested data) |

## 2a. Delegated access — OPTIONAL (D1–D5)

Everything above works with one API key per block, held by the platform on a requester's
behalf. That key is the same for everybody: your audit log records the platform, not the
person, and the key can do far more than any individual person needs.

A block that implements this section gets the person instead. They sign in to YOU, they
choose what to grant, and every later call from the platform carries their token. **This is
optional and additive** — a block that publishes none of it keeps using the shared key, and
the platform falls back to that automatically rather than failing.

| # | Requirement (only if you want delegated access) |
|---|---|
| D1 | Protected-resource metadata at `<mcp-url>/.well-known/oauth-protected-resource` **or** at your origin, per RFC 9728, naming `authorization_servers` and `scopes_supported`. The platform tries both locations |
| D2 | `scopes_supported` lists what a token may carry. **Publish it here even if your authorization server also does** — this is the document the platform reads to build the request, and a block that omits it while its server requires a scope refuses every attempt with `invalid_scope` |
| D3 | Authorization-server metadata reachable from the issuer you name, giving `authorization_endpoint` and `token_endpoint`. Publish `userinfo_endpoint` too where you can: without it the platform holds a token and cannot say whose it is, so it cannot warn a person who connected the wrong account |
| D4 | `authorization_code` with **PKCE S256**, exact redirect matching, single-use codes, and refresh tokens. Where refresh needs a scope to be requested (`offline_access` is the usual spelling), say so in your developer documentation — without it a person re-consents every time the access token expires |
| D5 | Your `authorize`, `token`, `.well-known/` and `userinfo` paths must be reachable by a person's BROWSER. Your MCP endpoint does not have to be, and should not be |

**What we will ask you for**: the redirect URIs to register (one per environment — ask for
all of them at once), the client id and secret, and your token lifetimes. Register the URIs
exactly; a block that matches them loosely is a block that can be redirected somewhere else.

**What the person sees** is your consent screen, so the permission names on it are yours to
write. Write them as things a person does — "See bookings and available slots", not
`GET /v1/bookings` — because that screen is the only place anyone reads them.

## 3. Usage skills — content standard

Every usage skill answers, in this order, in plain language:

1. **What this block is for — and NOT for** (the selection paragraph: one
   honest sentence of fit, one of non-fit, and "do not rebuild what is
   native" listing your built-in automations)
2. **The standard assembly, in order** (numbered: what to configure first,
   what depends on what, which tool does each step)
3. **The traps** (every rule that would otherwise be learned by failing:
   encodings, required companions, irreversible actions)
4. **Smoke testing here** (how to test safely, what test residue to restore)
5. **Verifying and handing over** (which screens/tools prove it works to a
   human; your integration points for other blocks)

Keep it under ~80 lines. It is guidance for an agent mid-delivery, not
marketing.

## 4. Why each piece exists (evidence from our test runs)

- With R3 docs tools present, the agent read the rules FIRST and avoided an
  encoding trap it had previously discovered by failing (base64 email body).
- R7 enforced lifecycle made the agent run simulate→test→regression→publish
  in order, every time, unprompted.
- R8's catalogue is how the agent found a native case-management node in the
  automation platform and refused to hand-wire polling.
- R13's residue rule exists because a smoke test once left a rotation
  counter advanced; the stakeholder caught it at acceptance — one extra
  review round that a usage-skill warning now prevents.
- R9/R10 are what verification hands the stakeholder: screens plus outbox
  evidence, not claims.

## 5. Division of labour

- **Block team** owns platform knowledge → encode it in R3 docs + §3 usage
  skills, ship it with the server, version it with the API.

  **The version is the one in `serverInfo` at the MCP handshake**, which the protocol already
  requires every server to send, so this asks for no new surface. What it does ask is that the
  value be *comparable*: a version that a reader can order against the last one they saw, and
  that MOVES when behaviour moves. The protocol constrains the field's presence and not its
  contents, which is the whole gap — a block may answer a semantic version, and a block may answer
  a build timestamp that changes on every deploy whether or not anything a caller can see has
  changed. Both are honest; only one can be used to decide whether a usage skill written last
  month still holds.

  Everything the platform attaches to a block — a usage skill, a script, a recorded trap —
  declares `block:` and `verified_against:` naming the version its claims were checked
  against. The platform records the block's own reported version on every call, so drift is a
  query rather than something somebody has to remember: when the reported version leaves the
  verified one behind, everything attached goes back to be re-verified. That is the only
  mechanism by which a block improving on its own schedule does not silently invalidate the
  knowledge built on top of it.
- **The delivery flow** owns process knowledge → the flow's skills (e.g. the Operations flow in
  zz-stack's catalog, whose six stages run intent → spec → select → plan → build →
  verify); they never contain block-specific content. Every flow declares its own stages,
  so this list is one flow's, not the standard's — nothing in this contract depends on it.
- **Host environment** owns adaptation (which server is process vs block,
  artifact storage, output format).

A gap found in a run is fixed at the right layer: platform rule → your docs
tool or usage skill; process lesson → a flow skill; environment mismatch →
host prompt.

## 6. Reference implementations (samples of the standard)

Two sample plugins live in the sibling `zz-blocks` repository — use them as the
template for your own package. They are the closest thing to a worked example,
not a certificate: the gaps measured against this standard are listed with them,
because a sample that claims to pass and does not teaches the wrong lesson.

| Sample | Category | Where |
|---|---|---|
| RuleMill-like (workflow automation) | connective automation | `zz-blocks/rulemill/` |
| BookIt-like (appointments) | public-facing bookings | `zz-blocks/bookit/` |

**Where each block stands is measured, not written down here.** This section used
to carry a table of met and unmet requirements dated 2026-08-24. It was true when
someone looked, nothing re-checked it, and it read as current for as long as it
sat here — while one of its rows had already gone stale and none of them had ever
counted R5 or R10.

    ZZ_PAT=<your token> npm run conformance -- \
        --gateway https://api.<host> --block all

reads each block's tool surface through the gateway and settles R2, R3, R4, R5,
R6, R8, R9, R10 and R11 mechanically. R1, R7, R12, R13 and R14 are behavioural — they
need a write, a sequence, or a delivered event — and the report names them as not
measured rather than scoring them. A battery that guessed would hand out passes
this standard never granted.

Two things that measurement says, which the hand-written table did not:

- **R5 is where a large tool surface is furthest from the standard.** A block can publish
  a couple of hundred tools with not one of them undescribed, and still fail this
  requirement outright, because the overwhelming majority describe themselves by
  restating their own name — a tool called `read_user_guide` whose description is
  "Read user guide". An agent choosing among two hundred tools learns nothing from
  a description like that about WHEN to reach for one, which is the decision it is
  actually making. Counted descriptions are not the measure; useful ones are.
- **R10 was unmet in the samples and nobody had counted it.** `RuleMill` ships
  `create_table` and `create_timer` with no `get_*` to read either
  back; `bookit` has the same gap.

**R9 is met by nobody today.** Where it is implemented at all it is implemented under
a different verb — `generate_*` where this standard asks for `get_*` — and the report
says so in those words rather than calling it absent. Either the requirement names the
wrong verb or every implementation is wrong; that is a decision for the next revision of
this standard, not something to paper over here. R2 has the same shape: a block can meet
its intent through a differently-named tool and score zero against the letter.

They compose: a booking event webhooks into an automation workflow that
creates a case — each side discovered through R2/R3/R8 tools and each team's
usage skills, none of it hard-coded in the agent.

## Appendix — evidence log (why we will ask you for these)

> **Rows measured against a system this project did not write are not in this table.** Some of
> the sharpest findings came from calling one, and its defects are that organisation's to
> publish or not — a category label is not anonymity when there is one product in the
> category. What remains was measured against this project's own stand-ins. The rules the
> removed rows produced are stated in full above and stand on their own: what is gone is the
> evidence, not the requirement.

| Date | Kind | Gap | Requirement |
|---|---|---|---|
| 2026-08-20 | automation | webhook ingress URL only discoverable after publish — must be stated in trigger docs | R3 |
| 2026-08-20 | automation | template language lacked nested payload paths and webhook ingress flattened event objects — agent correctly stopped at a fork instead of guessing; platform patched to support {{payload.a.b}} + full nested payloads, docs updated | R3/R6 |
| 2026-08-20 | automation | webhook payload initially exposed only top-level scalar keys — nested booking fields unreachable from templates; agent had to halt mid-build and escalate. Fixed: nested path resolution ({{payload.a.b}}) + documented | R14, R3 |
| 2026-08-20 | bookings | notify convention (which field drives emails) was implicit — a differently-labelled email field silently produced no emails; agent could not self-verify AC. Fixed: any label containing 'email' + documented in read_api_spec | R3, R10 |
| 2026-08-20 | bookings | booking records are never deletable (audit design) but that rule was undocumented — now stated in read_api_spec('bookings') so agents plan test residue upfront | R3, R13 |
| 2026-08-20 | automation | simulate stubs for integration nodes were shape-blind (always a dict) — a foreach over a list result could never pass simulation, deadlocking the enforced lifecycle. Fixed: shape-aware stubs (search/list ops stub as lists). Generic rule: simulation must produce payloads of the same SHAPE as real calls | R7, R3 |
| 2026-08-20 | automation | foreach item-template bindings ({{item.*}}) not rendered in fan-out emails — blank recipients; agent held the blocker honestly. Fixed: item exposed as pseudo-node to the template resolver. Also: workflows had no delete primitive (same create-without-delete gap class) — delete_workflow added | R10, R3 |
| 2026-08-20 | bookings | which lifecycle events natively email the requester was undocumented — the agent assumed no rejection email existed and composed an unnecessary automation bridge (over-composition). Fixed: notification matrix in read_api_spec. Generic rule: document your NOTIFICATION MATRIX (event -> who gets told, via what) | R3 |
| 2026-08-24 | automation | `read_api_spec` (R3) absent, while the other two blocks have it — the sample listed in §6 as a template does not meet the requirement it is meant to demonstrate | R3 |
| 2026-08-26 | RuleMill (sample) | the same requirement, met on our side: a failing peer call now names the operation and the arguments sent, and says not to assume the peer is down. It cannot recover a reason the peer never gave — which is why R6 is a requirement on the BLOCK and cannot be worked around by its caller | R6 |
