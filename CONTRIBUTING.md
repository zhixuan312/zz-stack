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
node scripts/gate.ts                             # every check; needs Docker for the twelve that start a PostgreSQL
node scripts/rehearse.ts --dump <zz-db-*.sql.gz> # a pending migration on a restored backup
npm run doctor                                   # where a deployment stops matching this checkout
node scripts/doctor.ts --layer repo,image       # offline; no host needed
```

**Docker is needed by the twelve checks that migrate a real PostgreSQL** — the schema inventory,
the rehearsal, the evaluation readers, which EXPLAINs every evaluation statement against a database
migrated from `001_init.sql`, the document write path (`checks/document-store.ts`), which drives
`saveDocument` against one, upload staging (`checks/upload-staging.ts`), which drives the
gateway's upload routes against one, and the seven that run a real zz-core against one: the console's
document reads, presentation and approval (`checks/console-versions.ts`), the document walking
skeleton and every edit mode
(`checks/document-edit.ts`), concurrent changes and keyed requests (`checks/document-edit-races.ts`),
the version table and the acts racing an edit (`checks/document-version.ts`), the causes that
link themselves (`checks/document-version-causes.ts`), normalisation, counted receipts and
detail pages (`checks/document-normalize.ts`), and presenting what changed and approving exactly
what was shown (`checks/document-present-changes.ts`). Each exits 2 when Docker is absent rather
than passing, because a throwaway database that could not be started is not a check that agreed.
Everything else in the gate, and the whole of `tsc`, runs without it, and
`.github/workflows/gate.yml` runs the entire gate on every push to master, building the pinned
PostgreSQL image on the runner. So a machine that never
runs those twelve commands never needs Docker.

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
against the target is not proven. Then write the release's `002_<name>.sql`
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
against the live deployment, rolling back on a disagreement. It ends three ways, not
two: agreement tags, disagreement rolls back, and probes that could not run leave the
version live and untagged — because rolling back on those undoes a release for a reason
that was never about it, and tagging would stamp a version nothing verified.

A machine without Docker releases the same way with the build moved to CI: dispatch the
`images` workflow for the merged commit with `push` on, then run
`node scripts/release.ts <version> --gate-in-ci --images-from-ci`. Each flag refuses unless its
workflow passed on the exact commit being released.
