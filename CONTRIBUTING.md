# Contributing

## The gate is the contract

```bash
npm install
npm run gate          # 279 checks, offline, a few seconds
```

Everything this project believes about itself is a check in there, and every check
encodes a failure that actually happened. They are named as properties rather than as
test cases — "a hostile document cannot become script in a reader's browser", "every
route this gateway serves has a caller", "redaction lets no secret through, on the real
predicate" — so the output reads as a list of claims the repository is currently
entitled to make.

**A red gate is never bypassed.** If a check is wrong, fix the check and say in its
comment what it was wrong about; a check nobody trusts is worse than no check. If you
add behaviour, add the check that would have caught its absence.

`scripts/gate.mjs` is an ORDER, not a list — 26 `import` lines, one per subject. A
module missing from it is a check that silently does not run, so `report()` refuses to
pass unless the number of checks written under `scripts/gate/checks/` equals the number
that ran.

## Running it

```bash
npm run build                                    # tsc -b, project references
npm run doctor                                   # where a deployment stops matching this checkout
node scripts/doctor.mjs --layer repo,image       # offline; no host needed
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

**No source file exceeds 700 lines,** and the gate enforces it. The number was measured
rather than chosen: above it, every file here held a whole second subject. There is no
exemption list, because a list of files allowed to be large is a list nobody prunes.

## House rules

- **Branches are `master` or `release/<version>`.** Nothing else.
- **No backward-compatibility scaffolding** — no shims, no deprecated markers, no
  re-exports from old locations. Change it and say what broke.
- **Comments explain why, not what**, and a comment that states a fact the code can
  check is a check waiting to be written.
- **Never claim a check that does not exist.** A comment asserting "this is verified
  before it ships" is a promise somebody will rely on; either write the check or delete
  the sentence. This has gone wrong here before.

## Releasing

`node scripts/release.mjs --preflight` reports every fact about a release that is not a
judgement call. The release itself gates, builds, pushes, deploys and then verifies
against the live deployment, rolling back on a disagreement. It ends three ways, not
two: agreement tags, disagreement rolls back, and probes that could not RUN leave the
version live and untagged — because rolling back on those undoes a release for a reason
that was never about it, and tagging would stamp a version nothing verified.
