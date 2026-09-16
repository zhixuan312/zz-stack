# zz-stack

**A platform for running AI delivery agents against real systems, where every
document, gate and approval is recorded rather than remembered.**

An agent asked to deliver something real needs three things this gives it: a set of
skills that say how the work is done, MCP doors onto the systems it must touch, and a
governance layer that will not let it claim a decision nobody made. A document is
approved by a person, under their name, at a recorded time — or it is not approved.

**What it is not.** Not a chat product; there is no browser front end. Not an agent
framework; it does not run the model loop. It is the platform underneath one — doors,
identity, a team's document store, and the rules about who may write what.

**Who it is for.** Somebody standing up delivery agents for a team, who needs the
result to be auditable by someone who was not in the room.

```bash
npm install && npm run gate     # 282 offline checks, a few seconds
```

**Start there.** The gate is the most useful thing in this repository: every check
encodes a failure that actually happened, and they are named as claims rather than as
test cases — *"a hostile document cannot become script in a reader's browser"*, *"every
route this gateway serves has a caller"*, *"redaction lets no secret through, on the
real predicate"*. Reading its output is the fastest way to learn what the platform
believes about itself.

To install it on a server, read **`deploy/README.md`**. That path needs no repository,
no toolchain and no build: it runs published images from a release bundle.
To work on it, read **`CONTRIBUTING.md`**.

## What is where

Everything here is TypeScript (npm workspaces, `npm run build`) — services and
tools alike, with no dependency outside what the services already carry:

```
packages/contracts/   shared types & zod schemas — the single source of truth
packages/catalog/     the one reader of catalog/: manifests, entries, skill text
packages/mcp-http/    session-managed streamable-HTTP MCP hosting + identity
packages/mcp-client/  the one MCP client anything here uses to CALL an endpoint — the
                      counterpart to mcp-http, which hosts one
packages/indexing/    the knowledge index: the row a document gets in zz.doc, the claims
                      derived from it, and the walks that rebuild both. A package because
                      BOTH doors index — zz-core on every document write, the gateway for
                      knowledge_reindex — and a service cannot import another service
packages/tools/       the platform's command-line tools: the testing engines under
                      src/testing/, day-2 ops under src/ops/, shared libraries under
                      src/lib/. Every one has an npm script, and the gate refuses a
                      script whose tool is not in the tree
services/zz-core/     process MCP: skills library, TEAM-shared knowledge store,
                      document-chain guardrails, knowledge tools
services/gateway/     the ONE door: identity (PATs, and a passkey for the console),
                      platform registry + admin MCP, per-user credential proxy to
                      blocks, knowledge web app, and the console's read API.
                      Four offline checks live beside the code they are about:
                      markdown-check (a hostile corpus through the real renderer,
                      because that page holds the reader's token),
                      identity-check (the adapter walk, whose ordering is an
                      authentication property no reading of the loop shows),
                      scope-check (the real resolveScope over ten callers, so a
                      caller can never come back with "no scope" — only a team,
                      the platform, or a refusal), and redact-check (every
                      settings response shape through the real redactor, so a
                      credential value or a stored token never survives — nested
                      or not — while which block, when it was set and by whom
                      still does, and a field nobody named yet is caught on its
                      name alone rather than left to be remembered)
catalog/    the flows and platform capabilities, one directory per owner. A
            flow.json says what each is; `shelved: true` marks a capability
            every person gets from the shelf rather than one a team installs:
            sdlc/sdlc-flow      software delivery, 13 skills — explore, spec,
                                audit, plan, audit, execute, review (closing
                                the initiative is an act, not a stage), plus the
                                libraries the stages load. One command, /sdlc:flow;
                                deck, tldr and breakout moved to the baseline
            zz/zz-access        access, on one door: a person's own token, block
                                keys and client setup (zz-access), and the platform
                                register behind them — people, teams, installs,
                                grants (zz-admin). Which tools a caller is offered
                                is their role. It also carries the three skills
                                about the MACHINE and the CREDENTIAL rather than
                                the record — zz-doctor, zz-update, zz-migrate —
                                each shipping as a typed command with its own
                                script beside it
            zz/zz-core          the baseline every account carries: the manifest
                                only. It declares what the platform's own plugin is
                                and what a person types — deck, tldr, breakout —
                                while its SKILLS are the tree at skills/ below,
                                because one of them (zz-router) is generated per
                                person from the flows they installed and cannot live
                                in a catalog shared by everyone
            zz/zz-plugin-eval   plugin evaluation, 6 skills — the whole unit a person
                                installs, which is the level the platform ships at and
                                the only level two of its properties are visible from:
                                whether a flow that goes wrong can return to an earlier
                                stage, and whether a tool its skills name was ever
                                called. TWO kinds of evidence with their own sufficiency
                                lines — cases from the ablation suite, which need no
                                history, and traces from real runs, which need five.
                                locate, profile, define (the gate: what good means for
                                THIS plugin), judge, report. Measures; never changes
skills/     the baseline plugin's skills, served whatever flow a team runs. They
            live here rather than under the baseline's catalog entry because the
            router skill is generated per person from the flows they installed and
            cannot live in a catalog shared by everyone. Two are
            UNIVERSAL and bookend every flow: zz-platform (the spine, loaded first
            — file tools, gates, documents, credentials, the tag kinds the
            knowledge base enforces, and what a team overlay may and may not do)
            and zz-handover (the handover, run last — one closed initiative's
            documents and telemetry turned into what the next team should know).
            Three more are TYPED rather than loaded, and ship as the baseline's
            commands: zz-deck (turn something already written into a slide deck
            that makes an argument), zz-tldr (compress a long source to what the
            reader must act on) and zz-breakout (one bounded expert dialogue,
            closing into the knowledge base). None is about software delivery;
            all three are operations on the core's own nouns, which is why they
            are here rather than in a flow. zz-authoring is a LIBRARY behind the
            first two — never typed, loaded by both, and the one place the rules
            they share are written down. What an
            evaluation calls for is not a skill: the report SPECIFIES one change
            and its expected effect, and a repository edit plus a release applies
            it, because /catalog and /skills are read-only wherever this runs.
            A PLUGIN carries its eval CASE SUITE beside its skills — evals/
            under the catalog package, and evals/ at the repository root for the
            baseline, whose skills are not in the catalog either. One directory per case, holding a
            case.yaml: the prompt, and the graders that read what came back. It
            ships with the plugin, so anyone who installs it can run the same
            ablation. What a round FOUND is not here — findings.md lives in the
            initiative the evaluation ran as, with the scores in the platform's
            own tables, because a finding belongs to a moment and a version
docs/       written for somebody who does not work on this every day.
            architecture.html is the platform end to end — one page, eight
            tabs, every capability described by what it is, how we look at it,
            and what better looks like, and deliberately never by what is
            finished: a deck that reports progress is wrong the week after it
            is shown, and invites an argument about percentages instead of
            about design.
testing/    the shell around the engines: eval-step.sh (every requirement in
            the corpus through ONE step, each in its own initiative, keeping
            what it produced), reset-store.sh (archives a corpus's initiatives
            so the next version answers instead of resuming the last one). The
            engines themselves
            are TypeScript, in
            packages/tools/src/testing/:
            manifest-audit (mechanical record audit), chain-check (the document
            chain over MCP, no model in the loop — it answers whether the
            PLATFORM works when a provider outage means the harness cannot get a
            turn), tool-report (what the tools actually did, read back from the
            platform's own tool_call record), evolve-report (which STEP stalls,
            in the platform's own refusal sentences), block-conformance (each block
            measured against the published building-block standard),
            mcp-client-check (the shared MCP client, against a stub server — no
            gateway, no network, one second) and sql-check (every query in the
            repository PREPAREd against a migrated empty database, which is what
            answers "would this statement run at all" — the one question the
            offline gate cannot ask and the type system cannot either, since the
            SQL lives in template literals), step-score (what "better" MEANS
            for a step and for a block, as numbers, from the refusals the
            platform already recorded) and skill-reflect (the reflect half of
            prompt evolution: ONE proposed addition to ONE skill, in the skill's
            own words, from the refusal sentences that name the rule that was
            broken) — flow content lives in each flow's tests/. The smoke harness
            that used to drive whole conversations against a deployment is no
            longer in this tree, and neither are the three shell scripts that
            launched it. All engines exit non-zero on failure.
deploy/     the server package: docker compose, the Caddyfile (a TEMPLATE —
            install-caddy.sh is the only thing that should apply it),
            provision-host.sh for standing a host up (the stack itself
            arrives as a release bundle, never as a checkout),
            issue-first-pat.sh (the one token that opens a fresh
            install) and zz-tool (the platform's tools, run inside the image
            already on the host). Plus the cron'd record-keeping installed by
            install-backup-cron.sh — a nightly backup and a weekly restore drill.
            The hourly turn collector was a third until the front end whose store
            it read was removed; it had been failing on every run since.
            There is no bootstrap script:
            it went with the front end it wrote presets into, and the registry
            answers instead
scripts/    gate.ts (the order the gate runs in — every check itself lives in
            gate/checks/<subject>.ts, with gate/run.ts holding the one `check`
            they all register through and gate/facts.ts the facts they share),
            doctor.ts (the order the LAYERS run in — where the deployment stops
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
            frozen number), manifests.ts (where the packages are, read by
            both) and build-image.sh (the runtime image, from the lockfile). The
            day-2 ops tools are npm scripts over packages/tools/src/ops/:
            set-credential, probe-block, register-skills (what we OFFER, from
            the catalog into zz.skill — a file cannot be joined against five
            thousand events), register-plugins (the same, one level up: each
            plugin VERSION and which skill versions it contained, from
            plugins.lock.json. Release is the only moment anybody knows, because
            zz.skill.flow is current registration rather than per-version and
            flow_install overwrites its own history), refresh-block-tools (what somebody else's tools
            actually COST us, derived from the bytes already recorded — a call
            that SUCCEEDS can still spend a caller's whole working memory, and
            no error is recorded when it does), block-surface (what a block's
            tool surface DID between its last two recorded versions — including a
            tool that stayed and changed door, which a diff of names alone reports
            as no change at all), watch-results
            probes/  what the gate cannot assert by reading — it builds a real
            client package and looks at it. A file rather than a string inside
            a gate module, because these are full of regexes and escaping them twice
            is how a probe ends up testing nothing
```

The interface is a projection, not the platform: Claude Code, installing from the
public shelf this repository publishes (`client_setup` prints the steps, with
`email` to render somebody else's). Codex and Hermes were served too until
2026-09-12; nobody ran either, and between them they carried a tarball route, an
archive writer and a client matrix threaded through the database. One client is
not a limit anyone is working around — it is the honest count.


Building blocks are NOT in this repo. A block is somebody else's MCP server, reached
through the credential gateway; nothing here builds one. What the platform owns is its
side of that relationship — the per-block door, the credential proxy, and the usage
skills written about a block that are true only against the version they were checked
on. The requirements a block team must meet were documented here and are not any more: that
contract describes something this repository does not ship, so it belongs with the blocks
rather than beside the platform they connect to.

Start here: `deploy/README.md` (server install and day-2 operations).
