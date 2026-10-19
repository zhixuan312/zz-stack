# Contributing

## Node 24

`scripts/`, `checks/` and `testing/` are TypeScript with no build step — Node runs them
directly by stripping the types, and that only reached Stable in 24.12. `engines` and
`.nvmrc` say so, and on Node 22 the gate does not fail a check, it fails to parse.

```bash
nvm use               # reads .nvmrc
```

**DELIBERATE: the Docker images stay on `node:22.23.2-alpine`.** `scripts/` and `checks/` are
never copied into them, so the contributor floor and the image are unrelated facts. The
console's image is on 24, because its Dockerfile installs against the manifest that declares
the floor.

## The gate is the contract

```bash
npm install
npm run gate          # offline, a few seconds; it prints how many checks ran
```

Everything this project believes about itself is a check in there. They are named as
properties rather than as test cases — "a door that refuses ends the request", "every
route this gateway serves has a caller", "redaction lets no secret through, on the real
predicate" — so the output reads as a list of claims the repository is currently
entitled to make.

**A red gate is never bypassed.** If a check is wrong, fix the check and say in its
comment what it was wrong about; a check nobody trusts is worse than no check. If you
add behaviour, add the check that would have caught its absence.

`scripts/gate.ts` is an order, not a list — one `import` line per subject. A module
missing from it is a check that silently does not run, so `report()` refuses to pass
unless the number of checks written under `scripts/gate/checks/` equals the number that
ran. Neither number is written down here: a count in prose is a count that stops being
true.

## Running it

```bash
npm run build                                    # tsc -b, project references
node scripts/gate.ts                             # every check; needs Docker for the sixty that start a PostgreSQL
node scripts/rehearse.ts --dump <zz-db-*.sql.gz> # a pending migration on a restored backup
npm run doctor                                   # where a deployment stops matching this checkout
node scripts/doctor.ts --layer repo,image       # offline; no host needed
```

**Docker is needed by the sixty gate checks that migrate a real PostgreSQL** — the schema inventory,
the evaluation readers, which EXPLAINs every evaluation statement against a database
migrated from `services/gateway/migrations/`, `plugin_profile`'s document record (`checks/eval-profile-record.ts`),
which runs its built readers over a seeded one, the document write path (`checks/document-store.ts`), which drives
`saveDocument` against one, upload staging (`checks/upload-staging.ts`), which drives the
gateway's upload routes against one, the platform's status and the reader's own team's figures
(`checks/console-platform-status.ts`), which drives the gateway's identity gate and status route
against one, the platform's releases (`checks/console-platform-releases.ts`), bugs
(`checks/console-platform-bugs.ts`), evaluation (`checks/console-platform-evaluation.ts`), one plugin's evaluation against the console's fake (`checks/console-plugin-eval-shape.ts`), usage
(`checks/console-platform-usage.ts`), knowledge health (`checks/console-platform-knowledge.ts`) and
audit (`checks/console-platform-audit.ts`), and the fleet's teams (`checks/console-platform-teams.ts`,
which also drives the team and platform settings routes) and people
(`checks/console-platform-people.ts`, which also drives the platform settings routes), each
driving the gateway's identity gate and its own route against one, the console's page view (`checks/console-page-view.ts`), which drives the gateway's
page-view, activity, activity summary and Home routes against one and listens on the console's change channel,
the caller's own Access, its applications revoked and its other browsers signed out from a browser alone (`checks/console-access.ts`), which drives the gateway's identity gate, Access read and settings routes against one over HTTP,
the console's change stream (`checks/console-live-greeting.ts`), which opens the gateway's live route
against one and reads its greeting, the revisions a console read carries and the greeting a first stream asked with them is given (`checks/console-live-since.ts`), which serves the gateway's identity gate, reads and live route over HTTP against one and writes events in two teams, a team's observed agent runs, their coverage, peak overlap and what ran
lately (`checks/console-runs-observed.ts`), which calls the gateway's own reads over seeded runs,
a team's refusals counted once under four owners by week and grouped by owner, tool and normalised message (`checks/console-refusals.ts`), which calls the gateway's own reads over seeded calls,
the console's Runs, the active team's runs since its first with their observed output, by skill and lately
(`checks/console-work-runs.ts`), which calls the gateway's own read and route over the same seeded runs,
the console's Plugins and skills, each plugin's requirement, install command and public score with its comparability beside the active team's own calls, and the team's skills narrowed by plugin
(`checks/console-work-plugins.ts`), which drives the gateway's identity gate and its plugin, skill, evaluation and owner's evaluation routes over seeded scores, calls and runs,
a second team's member and a superadmin acting for it finding nothing of the first team's in Activity, Knowledge, Runs, Plugins and the skills, Access or the prepared queries over their measures, its refusal message, question, run, lesson and token, application, browser and passkey sentinels and its figures alike (`checks/console-isolation-destinations.ts`), which drives the gateway's identity gate, whole console and settings against one,
and the thirty-six that run a real zz-core against one: the rule that tells an import from a team's
own work (`checks/console-imports.ts`), which calls the gateway's own rule over what a real zz-core
recorded, the writing ledger, words added by period and the retained stock from the revisions kept
(`checks/console-writing.ts`), which calls the gateway's own ledger over what a real zz-core recorded, the console's document reads, presentation and approval (`checks/console-versions.ts`),
the decision basis an approval records (`checks/approval-basis.ts`), the console's Initiatives, the active team's work filtered and paged on the server with zz-core's next move (`checks/console-work-initiatives.ts`), the console's Approvals, its team's waiting queue and the caller's own approvals with their evidence (`checks/console-work-approvals.ts`), the console's Home, the active team's last whole week, what waits and what is open, with the approvals in it the caller's own (`checks/console-work-home.ts`), the console's Activity, the active team's refusals under four owners by week, grouped, and its event log with four filters, carrying no other team's refusal text (`checks/console-work-activity.ts`), the console's Knowledge, the active team's shelf, its own questions that found nothing and its searches by week, with the shelf filtered and paged on the server and a shared-shelf lesson open to a member (`checks/console-work-knowledge.ts`), Record's Knowledge, Your agents, and Firsts and bests slices, the window's activity beside as-of stocks no window moves (`checks/console-record-slices.ts`), the console's Record, the retained text as of the cutoff beside the period's work in six slices and the record of every initiative (`checks/console-work-record.ts`), Work's prepared queries, each measure of the active team by each dimension it allows answering the figures the pages draw (`checks/console-work-query.ts`), Work's prepared queries over Activity, Runs, Plugins and Knowledge, calls, refusals, observed output, the calls of each plugin's skills and the shelf, each equal to the figure its page draws and the team's own alone (`checks/console-work-query-destinations.ts`), the Platform prepared query, each measure by each dimension equal to the figure its page draws, a member's answers projected as their pages are (`checks/console-platform-query.ts`), the console's fake Platform prepared query held to the route's shape and refusals, every measure grouped and drilled for a member and for the superadmin (`checks/console-platform-query-shape.ts`), the console's search of
documents and nodes by their content (`checks/console-search.ts`), a person's own document or lesson found by the number-like part of a hyphenated word, with every earlier search still answering and a boot re-deriving rows of the previous generation (`checks/knowledge-search-hyphen-parts.ts`), one question ranked the same through the console's page, its assistant and MCP, in English and in Chinese, on every call and however the rows are stored (`checks/knowledge-search-parity.ts`), the console's bug resolution
held to zz-core's own `bug_resolve` (`checks/console-bug-resolve.ts`), the console's close of an
initiative held to zz-core's own `initiative_close` (`checks/console-close.ts`), what needs attention on the
platform's Status, its doors and records, with a resolve through the console's route
(`checks/console-platform-needs.ts`), a member of one team finding nothing of another's in any answer
the whole console gives, a colleague in both teams included, its writes refused or the member's own,
and the superadmin's Audit and Knowledge health holding no planted body but a question, which no other
page gives them, and Work, every prepared query but the calls of a plugin's skills drilled to its rows and a close included, holding
nothing of another team's and no person's approvals or tokens but their own, nor in Access any of another's tokens, applications, browsers or passkeys, a second person on the
same team included (`checks/console-isolation.ts`), a person in two teams switching the team
their browser acts for, every read then answering the new team alone and the old team's links 404,
while four callers in two teams read at once and each is answered their own
(`checks/console-team-switch.ts`), the document walking
skeleton and every edit mode
(`checks/document-edit.ts`), concurrent changes and keyed requests (`checks/document-edit-races.ts`),
the version table and the acts racing an edit (`checks/document-version.ts`), the causes that
link themselves (`checks/document-version-causes.ts`), normalisation, counted receipts and
detail pages (`checks/document-normalize.ts`), and presenting what changed and approving exactly
what was shown (`checks/document-present-changes.ts`), and a plain-text file uploaded by the shell,
the link and the ChatGPT file route (`checks/document-upload.ts`), and what each source supports,
a document not written yet included (`checks/source-list.ts`), the origin every event
carries, from the migration's backfill and from both of its writers
(`checks/event-origin-db.ts`), the origin of every act the gateway writes, an administration
act, a team switch and a console write on either door (`checks/event-origin-gateway.ts`),
the node a lesson's event names and the team a supersede is recorded under
(`checks/knowledge-events.ts`), and `initiative_status` answering a page of named initiatives
while a console session's read records nothing (`checks/initiative-status-names.ts`); a release's record, written once and reconciled with the tags, on a
database migrated by the real runner (`checks/release-record-db.ts`); and the rollback boundary
(`checks/rollback-boundary.ts`), which fills new-format data through a real zz-core and runs the
previous release's own statements against it. Each exits 2 when Docker is absent rather
than passing, because a throwaway database that could not be started is not a check that agreed.
The rehearsal (`scripts/rehearse.ts`) needs Docker too; it is its own command, not a gate check.
Everything else in the gate, and the whole of `tsc`, runs without it, and
`.github/workflows/gate.yml` runs the entire gate on every push to master, building the pinned
PostgreSQL image on the runner. So a machine that never
runs those sixty checks or the rehearsal never needs Docker.

Each starts a container from the postgres image and removes it — with `-v` and `--rm`, because that
image declares its data directory as a VOLUME and an anonymous volume left behind is invisible to
`docker ps` and never reclaimed. If a machine that has run them for a while is short of disk:

```bash
docker volume prune -f      # the leaked ones: 128 GB across 2,043 of them on one machine
docker builder prune -af    # build cache
docker image prune -a -f    # images no container uses
```

For a local stack from this checkout rather than published images:

```bash
cd deploy
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Server install and day-2 operations are `deploy/README.md`. That path needs no
repository, no toolchain and no build — it runs published images from a release bundle.

## Where things live

`ARCHITECTURE.md` is the answer, and it is kept current because a gate
check reads it. The short version: `packages/` is shared code, `services/` is the two
processes, `catalog/` is what a team installs, `skills/` is what everyone gets,
`scripts/` is this repository's own lifecycle.

**No source file exceeds 700 lines,** and the gate enforces it: above it, a file here has
held a whole second subject. There is no exemption list, because a list of files allowed to be
large is a list nobody prunes.

## Schema changes

Read `SCHEMA.md` first — it states the five questions, the six classes, the twelve
rules and the comment contract the schema is judged by. Declare the change in
`schema-target.ts` before writing any migration; a migration nothing has checked
against the target is not proven. Then write the release's `00N_<name>.sql`
migration, and let `checks/schema-inventory.ts` prove it matches.

## House rules

- **Branches are `master` or `release/<version>`.** Nothing else.
- **No backward-compatibility scaffolding** — no shims, no deprecated markers, no
  re-exports from old locations. Change it and say what broke.
- **Comments explain why, not what**, and a comment that states a fact the code can
  check is a check waiting to be written.
- **Never claim a check that does not exist.** A comment asserting "this is verified
  before it ships" is a promise somebody will rely on; either write the check or delete
  the sentence.

### Comments are read by agents

A comment says what the code does, now. Nothing else.

Three destinations, and only the first is a comment:

- **current behaviour the code cannot show for itself** — the comment
- **a lesson that generalises past this line** — the knowledge base, via `knowledge_add`
- **what it used to be, when it changed, the incident behind it** — delete it. `git log -p`
  has the change, the diff and the reasoning, and is never out of date

Keep exactly three things:

1. Behaviour or an invariant the code does not state on its own.
2. `DELIBERATE:` — this looks wrong and is not. Do not "fix" it. The line that stops a
   confident wrong change, and the most valuable one in the file.
3. `COUPLED:` — editing here requires editing there. Name the there.

Delete, always:

- what the code used to be, and when it changed
- the incident that produced the rule, and the measurement that justified it
- persuasion, capitals for emphasis, the same point made twice, narrative build-up
- anything arguing that a design is good

Keep a measured number only where the rule is unusable without it — a cap, a threshold, a
size. `64 KB decides it` stays; `measured on 2,369 rows` goes.

Sentence case. No ALL-CAPS headings, no `── section ──` dividers inside a doc comment.

An agent greps `DELIBERATE:` and `COUPLED:` before editing a directory. That is what the two
prefixes are for; prose is not greppable.

Three more prefixes exist and are enforced by checks, so they are not a style choice:

    NOT A TOOL:   checks/core-names.ts
    RAW NAME:     checks/pre-rename-literals.ts
    SYNTHETIC:    checks/skill-renames.ts

Each marks a code line that names a pre-rename tool word — `close`, `approve`, `add_source`,
`reconcile` — in a string or a regex, and says it is the English word rather than the tool.
Without the marker the check demands a rename that must not happen.

They are `DELIBERATE:` under a name a check can find, and three rules follow from that:

- keep the literal string, in capitals. The sentence-case rule above does not apply to them,
  and downcasing one to `Not a tool:` removes it while leaving the line looking fine — a diff
  shows nothing, because no line disappeared.
- keep it in the contiguous comment block directly above the line it guards. A blank line
  between the two breaks it.
- never fold one into `DELIBERATE:`. The check matches the string, not the meaning.

Two more, `SEAMED:` and `REDACTED:`, are conventions rather than checks. `SEAMED:` sits in
`scripts/mutation/specs-*.ts` above a payload written in pieces — `` `zz.${"block_tool"}` `` —
so the repository's own sweeps do not read the spec file as committing the defect it plants.
`REDACTED:` marks the same thing one step further on: the payload would be quoted verbatim into
`testing/mutation-report.json`, which is tracked and swept in turn. Both stay in capitals for the
same reason the three above do, and since no check reads them, a downcased one goes unnoticed —
audit them by count against `HEAD` exactly as the three above.

Audit by count, never by reading a diff:

    grep -c "NOT A TOOL:\|RAW NAME:\|SYNTHETIC:\|SEAMED\|REDACTED" <file>
    git show HEAD:<path> | grep -c "NOT A TOOL:\|RAW NAME:\|SYNTHETIC:\|SEAMED\|REDACTED"

**Editing prose can turn the gate red.** Every `between()` anchor in the gate is on code,
and no check is green because of a comment, but `checks/flow-classification.ts` asserts
`ARCHITECTURE.md`'s flow rule by design. Run the gate after a sweep, and re-run the mutation
rows of any `scripts/gate/checks/` file touched.

## Releasing

`node scripts/release.ts --preflight` reports every fact about a release that is not a
judgement call. The release itself gates, builds, pushes, deploys and then verifies
against the live deployment, rolling back on a disagreement. It ends four ways:
agreement tags; disagreement rolls back; disagreement on a release whose migrations refuse
a rollback (a `-- rollback: refused` line, or destructive DDL) stays live with the failures
and the reasons printed, to be fixed forward, because the previous version's code cannot
write or rightly read what those migrations made; and probes that could not run leave the
version live and untagged — because rolling back on those undoes a release for a reason
that was never about it, and tagging would stamp a version nothing verified.

A machine without Docker releases the same way with the build moved to CI: dispatch the
`images` workflow for the merged commit with `push` on, then run
`node scripts/release.ts <version> --gate-in-ci --images-from-ci`. Each flag refuses unless its
workflow passed on the exact commit being released.
