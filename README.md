# zz-stack

**A platform for running AI delivery agents against real systems, where every
document, gate and approval is recorded rather than remembered.**

An agent asked to deliver something real needs three things this gives it: a set of
skills that say how the work is done, MCP doors onto the systems it must touch, and a
governance layer that will not let it claim a decision nobody made. A document is
approved by a person, under their name, at a recorded time — or it is not approved.

**What it is not.** Not a chat product: the only browser surface is a read-mostly console,
in its own repository. Not an agent framework; it does not run the model loop. It is the platform underneath one — doors,
identity, a team's document store, and the rules about who may write what.

**Who it is for.** Somebody standing up delivery agents for a team, who needs the
result to be auditable by someone who was not in the room.

```bash
npm install && npm run gate     # every offline check, a few seconds
```

**Start there.** The gate is the most useful thing in this repository: its checks are
named as claims rather than as test cases — *"a door that refuses ends the request"*, *"every
route this gateway serves has a caller"*, *"redaction lets no secret through, on the
real predicate"*. Reading its output is the fastest way to learn what the platform
believes about itself.

To install it on a server, read **`deploy/README.md`**. That path needs no repository,
no toolchain and no build: it runs published images from a release bundle.
To work on it, read **`CONTRIBUTING.md`**.

**The gate expects `../zz-stack-dashboard` beside this checkout.** The console lives in its
own repository and is the only caller of the `/api/console/*` routes, so without it three
checks cannot answer: two say so and pass, and *"every route this gateway serves has a
caller"* fails naming the missing repository rather than reporting every console-only route
as uncalled. Clone it as a sibling before running `npm run gate`.

## What is where

Everything here is TypeScript (npm workspaces, `npm run build`) — services and
tools alike, with no dependency outside what the services already carry:

```
packages/contracts/   shared types & zod schemas — the single source of truth
packages/catalog/     the one reader of catalog/: manifests, entries, skill text
packages/mcp-http/    session-managed streamable-HTTP MCP hosting + identity
packages/mcp-client/  the one MCP client anything here uses to call an endpoint — the
                      counterpart to mcp-http, which hosts one
packages/indexing/    the knowledge index: the row a document gets in zz.doc, the claims
                      derived from it, and the walks that rebuild both. A package because
                      both doors index — zz-core on every document write, the gateway for
                      knowledge_reindex — and a service cannot import another service
packages/tools/       the platform's command-line tools: the testing engines under
                      src/testing/, day-2 ops under src/ops/, shared libraries under
                      src/lib/. Every one has an npm script, and the gate refuses a
                      script whose tool is not in the tree
services/zz-core/     process MCP: skills library, team-shared knowledge store,
                      document-chain guardrails, knowledge tools
services/gateway/     the one door: identity (PATs, and a passkey for the console),
                      platform registry + admin MCP, the proxy to zz-core's doors,
                      and the console's read API.
                      Three offline checks live beside the code they are about:
                      identity-check (the adapter walk, whose ordering is an
                      authentication property no reading of the loop shows),
                      scope-check (the real resolveScope over ten callers, so a
                      caller can never come back with "no scope" — only a team,
                      the platform, or a refusal), and redact-check (every
                      settings response shape through the real redactor, so a
                      credential value or a stored token never survives — nested
                      or not — while the metadata beside it still does, and a
                      field nobody named yet is caught on its name alone rather
                      than left to be remembered)
catalog/    the flows and platform capabilities, one directory per owner. A
            flow.json says what each is; `shelved: true` marks a capability
            every person gets from the shelf rather than one a team installs:
            sdlc/sdlc-flow      software delivery, 13 skills — explore, spec,
                                audit, plan, audit, execute, review (closing
                                the initiative is an act, not a stage), plus the
                                libraries the stages load. One command, /sdlc:flow
            zz/zz-access        access, on one door: a person's own token and
                                client setup (zz-access), and the platform
                                register behind them — people and teams
                                (zz-admin). Which tools a caller is offered
                                is their role. It also carries the three skills
                                about the machine and the credential rather than
                                the record — zz-doctor, zz-update, zz-migrate —
                                each shipping as a typed command with its own
                                script beside it
            zz/zz-core          the baseline every account carries: the manifest
                                only. It declares what the platform's own plugin is
                                and what a person types — deck, tldr, breakout —
                                while its skills are the tree at skills/ below,
                                plus zz-router, which is generated from the shelf's
                                flows when a package is built and so has no file in
                                the catalog
            zz/zz-plugin-eval   plugin evaluation and improvement, 9 skills — the whole unit a person
                                installs, which is the level the platform ships at and
                                the only level two of its properties are visible from:
                                whether a flow that goes wrong can return to an earlier
                                stage, and whether a tool its skills name was ever
                                called. One kind of evidence: traces from real runs.
                                locate, profile, define (the gate: what good means for
                                this plugin), judge, report. Measures; never changes
skills/     the baseline plugin's skills, served whatever flow a team runs. They
            live here rather than under the baseline's catalog entry, beside the
            generated router skill rather than in the catalog. Two are
            universal and bookend every flow: zz-platform (the spine, loaded first
            — file tools, gates, documents, credentials, the tag kinds the
            knowledge base enforces, and what a team overlay may and may not do)
            and zz-handover (the handover, run last — one closed initiative's
            documents and telemetry turned into what the next team should know).
            Three more are typed rather than loaded, and ship as the baseline's
            commands: zz-deck (turn something already written into a slide deck
            that makes an argument), zz-tldr (compress a long source to what the
            reader must act on) and zz-breakout (one bounded expert dialogue,
            closing into the knowledge base). None is about software delivery;
            all three are operations on the core's own nouns, which is why they
            are here rather than in a flow. zz-authoring is a library behind the
            first two — never typed, loaded by both, and the one place the rules
            they share are written down. What an
            evaluation calls for is not edited in place: for a plugin we own,
            the IMPROVE stage proves a candidate patch on sealed replays and
            improvement.md's approval authorises the release-apply CLI to ship
            exactly that patch, because /catalog and /skills are read-only
            wherever the platform runs; a plugin we do not own gets proposal.md.
            What a round found is not in the catalog — findings.md lives in the
            initiative the evaluation ran as, with the scores in the platform's
            own tables, because a finding belongs to a moment and a version.
testing/    the shell around the engines: eval-step.sh (every requirement in
            the corpus through one step, each in its own initiative, keeping
            what it produced), reset-store.sh (archives a corpus's initiatives
            so the next version answers instead of resuming the last one). The
            engines themselves
            are TypeScript, in
            packages/tools/src/testing/:
            manifest-audit (mechanical record audit), chain-check (the document
            chain over MCP, no model in the loop — it answers whether the
            platform works when a provider outage means the harness cannot get a
            turn), tool-report (what the tools actually did, read back from the
            platform's own tool_call record), evolve-report (which step stalls,
            in the platform's own refusal sentences), mcp-client-check (the shared MCP client, against a stub server — no
            gateway, no network, one second) and sql-check (every query in the
            repository PREPAREd against a migrated empty database, which is what
            answers "would this statement run at all" — the one question the
            offline gate cannot ask and the type system cannot either, since the
            SQL lives in template literals), step-score (what "better" means
            for a step, as numbers, from the refusals the
            platform already recorded) and skill-reflect (the reflect half of
            prompt evolution: one proposed addition to one skill, in the skill's
            own words, from the refusal sentences that name the rule that was
            broken) — flow content lives in each flow's tests/. All engines exit
            non-zero on failure.
deploy/     the server package: docker compose, the Caddyfile (a template —
            install-caddy.sh is the only thing that should apply it),
            provision-host.sh for standing a host up (the stack itself
            arrives as a release bundle, never as a checkout),
            issue-first-pat.sh (the one token that opens a fresh
            install) and zz-tool (the platform's tools, run inside the image
            already on the host). Plus the cron'd record-keeping installed by
            install-backup-cron.sh — a nightly backup and a weekly restore drill
scripts/    gate.ts (the order the gate runs in — every check itself lives in
            gate/checks/<subject>.ts, with gate/run.ts holding the one `check`
            they all register through and gate/facts.ts the facts they share),
            doctor.ts (the order the layers run in — where the deployment stops
            matching what this checkout declares, with doctor/layers/<layer>.ts
            the probes and doctor/run.ts the runner that tells a probe's own
            breakage apart from its subject's; release step 5 runs these, so
            there is one list rather than a second that is only ever read during
            a release), deployment.ts (the one description of the deployment —
            its address, paths, images and how to speak to it — read by the
            release and the doctor alike), release.ts,
            build-marketplace.ts (renders the public Claude Code shelf into
            marketplace/ and .claude-plugin/, through the same buildClientPackage
            the gateway serves packages with — the gate fails a release whose
            committed shelf no longer matches the catalog),
            set-version.ts, skill-versions.ts (each skill's declared version beside
            the hash of what it actually says), plugin-versions.ts (the same
            argument one level up, for the unit a person actually installs: each
            plugin's declared version beside a digest of what it ships, recorded in
            plugins.lock.json so the gate can refuse content that moved under a
            frozen number), rederive-analyzer-generation.ts
            (dry-run by default: rederives every existing `zz.doc`/`zz.knowledge_node`
            row's `body_tsv`/`analyzer_version` under the current analyzer generation
            through `@zz/indexing`'s `rederiveAll`, resumable by watermark — `--write`
            is the only path that changes anything),
            control-loop-e2e.ts (drives a real initiative through the real doors against a
            scratch deployment and checks the loop refuses and grants as the flow declares —
            it refuses to run against production by name, because it writes an initiative,
            four documents, two sources and a close. Not a gate check: the gate is offline and
            proves things about the source, and this asks whether a run recorded through the
            platform reaches a grant, which no offline check can answer), manifests.ts (where the packages are, read by
            both), mutation-run.ts (run on demand, never by the gate: plants a
            defect in what each gate check examines, in a disposable copy of this
            checkout, and records whether the check noticed — mutation/ holds the
            workspace, the planting and
            one spec per check, and the answer lands in
            testing/mutation-report.json), activation-rehearsal.ts (rehearses
            deploy/activation-runbook.json on copied fixtures and against nothing
            live: it derives the blocker list from the runbook itself, proves a
            precondition cannot be waived by deep-copying the document and trying,
            and refuses to start if any database URL is set in the environment —
            it exits non-zero while a precondition is blocked, which today is all
            eight of them) and build-image.sh (the runtime image, from the
            lockfile).
            tenant-info/ is `npm run tenant-info` — cli.ts's six verbs (baseline,
            fixtures, verify, benchmark, migrate, export), each requiring a workspace
            outside this checkout and none of them running anything at import time,
            with verify.ts resolving the ten named suites a `verify --suite` or
            `--finalize` run dispatches. The
            day-2 ops tools are npm scripts over packages/tools/src/ops/:
            register-skills (what we offer, from
            the catalog into zz.skill — a file cannot be joined against five
            thousand events), register-plugins (the same, one level up: each
            plugin version and which skill versions it contained, from
            plugins.lock.json. Release is the only moment anybody knows, because
            zz.skill.flow is current registration rather than per-version),
            plugin-surface (what a plugin's
            tool surface did between its last two recorded versions — including a
            tool that stayed and changed door, which a diff of names alone reports
            as no change at all) and watch-results (alerts on results getting
            worse — stuck gates, rising refusals, slower tools, quiet teams — from
            what the platform already records). ops/purge-probes.ts removes what a
            live chain-check leaves behind. probes/ holds what the gate cannot
            assert by reading — it builds a real client package and looks at it. A
            file rather than a string inside a gate module, because these are full
            of regexes and escaping them twice is how a probe ends up testing
            nothing
```

The interface is a projection, not the platform: Claude Code, installing from the
public shelf this repository publishes (`client_setup` prints the steps, with
`email` to render somebody else's).

Start here: `deploy/README.md` (server install and day-2 operations).
