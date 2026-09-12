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
npm install && npm run gate     # 279 offline checks, a few seconds
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
            flow.json says what each is; `kind: platform` marks a capability
            every person gets from the shelf rather than one a team installs:
            sdlc/sdlc-flow      software delivery, 17 skills — explore, spec,
                                audit, plan, audit, execute, review (closing
                                the initiative is an act, not a stage), plus
                                the deck / tldr / breakout tools
            zz/zz-access        access, on one door: a person's own token, block
                                keys and client setup (zz-access), and the platform
                                register behind them — people, teams, installs,
                                grants (zz-admin). Which tools a caller is offered
                                is their role
            zz/zz-skill-eval    skill evaluation, 6 skills — locate (which skill,
                                of the two kinds, at which version), profile, define
                                (the one gate: is the ruler right for this
                                version), judge, report. Measures; never changes
            zz/zz-block-eval    block evaluation, 4 skills — locate (which block,
                                which INSTANCE; stand-ins are refused), measure (three
                                scripts, no document: the surface and WHAT MOVED, tool-by-
                                tool usage with whose defect each refusal is, and
                                conformance), report. ONE document — the numbers, the
                                defects, what we ask for — gated, and it is what the
                                block team receives.
                                The MCP surface itself, never the skills about it
skills/     platform skills, served whatever flow a team runs. Two are UNIVERSAL and
            bookend every flow: zz-backbone (the spine, loaded first — file tools,
            gates, documents, credentials, the tag kinds the knowledge base
            enforces, and what a team overlay may and may not do) and zz-knowledge
            (the handover, run last — one closed initiative's documents and
            telemetry turned into what the next team should know). What an
            evaluation calls for is not a skill: the report SPECIFIES one change
            and its expected effect, and a repository edit plus a release applies
            it, because /catalog and /skills are read-only wherever this runs.
            Each skill carries its own evaluation history in skills/<step>/evals/
            — one file per VERSION, so opening a skill shows both what it says
            and how that version scored. What a flow's evaluation found lives in
            catalog/<owner>/<flow>/findings/, and goes when the flow does
blocks/     one directory per building block, holding everything written ON TOP
            of it — its usage skill and the tests that check our usage still
            holds. Separate from skills/ because a usage skill is written about
            somebody ELSE's server, is true only against the version it was
            checked on, and has to be deletable in one move when the block goes.
            Only the standard lives here — `_standard/` is what a block team is
            asked to meet. The blocks themselves are somebody else's and are not
            in this repository.
docs/       written for somebody who does not work on this every day.
            architecture.html is the platform end to end — one page, eight
            tabs, every capability described by what it is, how we look at it,
            and what better looks like, and deliberately never by what is
            finished: a deck that reports progress is wrong the week after it
            is shown, and invites an argument about percentages instead of
            about design.
testing/    the shell around the engines: reset-store.sh, oauth-delegation.mjs
            (the delegated-access
            loop end to end against a live deployment, starting from a REVOKED
            grant — without that baseline "the block names a person" would
            prove nothing), judge-all.sh (every step's quality scored AND
            its scrambled control, because one without the other is not a
            measurement), block-oracle.sh (which blocks a requirement needs,
            decided from the brief alone and blind to what was chosen),
            reset-store.sh (archives a corpus's initiatives so the next version
            answers instead of resuming the last one). The
            engines themselves
            are TypeScript, in
            packages/tools/src/testing/: eval-grade (the mechanical sanity floor for what ONE step produced
            across the requirement corpus: sections declared, facts carried —
            all of it answerable by pattern, none of it about quality),
            eval-store (puts an evaluation where it survives — one row per
            subject per dimension into zz.eval_score, never an average, because
            an average over 30 pieces of work and one over 130 are not
            comparable and a number collapsed at write time cannot be
            un-collapsed at read time),
            eval-judge (the other half: a rubric DERIVED from the step's own
            output, every instance marked against it by a model, a scrambled
            control proving the judge reads, and expect/compare/pattern — write
            the expected answer blind, diff it against the actual, and rank what
            goes wrong in MANY requirements over what went wrong in one),
            manifest-audit (mechanical record audit), chain-check (the document
            chain over MCP, no model in the loop — it answers whether the
            PLATFORM works when a provider outage means the harness cannot get a
            turn), tool-report (what the tools actually did, read back from the
            platform's own tool_call record), evolve-report (which STEP stalls,
            in the platform's own refusal sentences), flow-compare (the same
            metrics across flows and teams), block-conformance (each block
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
scripts/    gate.mjs (the order the gate runs in — every check itself lives in
            gate/checks/<subject>.mjs, with gate/run.mjs holding the one `check`
            they all register through and gate/facts.mjs the facts they share),
            doctor.mjs (the order the LAYERS run in — where the deployment stops
            matching what this checkout declares, with doctor/layers/<layer>.mjs
            the probes and doctor/run.mjs the runner that tells a probe's own
            breakage apart from its subject's; release step 5 runs these, so
            there is one list rather than a second that is only ever read during
            a release), deployment.mjs (the one description of the deployment —
            its address, paths, images and how to speak to it — read by the
            release and the doctor alike), release.mjs,
            build-marketplace.mjs (renders the public Claude Code shelf into
            marketplace/ and .claude-plugin/, through the same buildClientPackage
            the gateway serves packages with — the gate fails a release whose
            committed shelf no longer matches the catalog),
            set-version.mjs, skill-versions.mjs (each skill's declared version beside
            the hash of what it actually says), manifests.mjs (where the packages are, read by
            both) and build-image.sh (the runtime image, from the lockfile). The
            day-2 ops tools are npm scripts over packages/tools/src/ops/:
            set-credential, probe-block, register-skills (what we OFFER, from
            the catalog into zz.skill — a file cannot be joined against five
            thousand events), refresh-block-tools (what somebody else's tools
            actually COST us, derived from the bytes already recorded — a call
            that SUCCEEDS can still spend a caller's whole working memory, and
            no error is recorded when it does), eval-decide (what we decided about an
            evaluation finding, and whether a run's work landed — the only writer
            of zz.eval_finding.decision and zz.run.outcome, and a finding nobody
            records a decision about gets re-proposed forever),
            watch-results, loop-eval (did each skill REACH the work — the eval
            pipeline judges documents, and only 5 of 40 skills produce one, so
            this reads telemetry instead and separates "not exercised" from
            "NOT CONSULTED", a block called repeatedly while its own skills
            were never loaded), rubric-load (every definition of good the
            catalog carries, into zz.rubric — storing the ruler and taking the
            measurement are different acts, and eval-store could only do both
            at once, which left 36 skills unable to have one; --affirm records
            that a VERSION is judged by a ruler, which the evaluation gate
            decides and only eval-store could previously write), eval-record (one
            judgement of one document from a judge that is NOT eval-judge — a
            person at a gate, a reviewer disagreeing with the model — with the
            judge's own name in zz.eval.judge_model, because a delta between a
            model's baseline and a person's read measures the instrument rather
            than the work)
            probes/  what the gate cannot assert by reading — it builds a real
            client package and looks at it. A file rather than a string inside
            a gate module, because these are full of regexes and escaping them twice
            is how a probe ends up testing nothing
```

Interfaces are projections, not the platform: Claude
Code / Codex / Hermes through the client package (`my_client_setup` for your
own, `render_harness_config` for someone else's). The same PAT, knowledge store
and gates apply whichever one a team uses — and a flow declares which of them
it runs on, so a flow meant for a terminal never appears in the browser.


Building blocks are NOT in this repo. A block is somebody else's MCP server, reached
through the credential gateway; nothing here builds one. What the platform owns is its
side of that relationship — the per-block door, the credential proxy, and the usage
skills written about a block that are true only against the version they were checked
on. The requirements a block team must meet are
`blocks/_standard/skills/building-a-block/references/contract.md`, here and only here: a standard that exists twice is one nobody can trust.

Start here: `deploy/README.md` (server install and day-2 operations).
