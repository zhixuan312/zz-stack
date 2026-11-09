# Working in this repository

Node 24 runs `scripts/`, `checks/` and `testing/` directly with no build step; `npm install` first.
`scripts/gate.ts` is the contract: every claim this repository makes about itself is a check in it,
named as a property rather than as a test case. A red gate is never bypassed — fix the check and
say in its comment what it was wrong about.

## Test runs

Three commands, no arguments. The runner picks the tests; a person never chooses a subset by hand.

| Command | Runs |
| --- | --- |
| `npm run test:t1` | The Tier 1 checks affected by changes since the last green run. |
| `npm run test:t2` | The affected Tier 2 checks plus the affected Tier 1 checks. |
| `npm run test:release` | Every Tier 1 and Tier 2 check, plus the type checks. Once, before a release. |

This repository has no Tier 2 checks yet: Tier 2 is the file convention `<name>.perf.ts`, and no
such module exists. `test:t2` therefore selects the affected Tier 1 checks — the standard's rule
for a repository with no Tier 2 tests.

The gate has no import graph, so the tests are chosen through the path-to-module map in
`scripts/gate/test-groups.json`. A path the map does not cover runs the whole gate. A passing run
writes the commit to `.gate-last-green` (gitignored) and the next run starts there; with no marker
the runner diffs against `master`, and on `master`'s own head (or with no history) it runs the
whole gate rather than record a green nobody checked.

**The standard from 2026-11-10: only Tier 1 blocks.** A Tier 1 failure fails the run. A Tier 2
performance result is reported and compared against earlier releases; it never fails a run and
never blocks a release — this repository has no Tier 2 checks today, so nothing here is affected.
A check that did not run is listed as "not run" with its reason and is never counted as passed. A
Tier 1 failure that passes on a retry with no cause found is reported as flaky, not as a pass. CI
is the evidence for a release.

**A release in this repository is a tagged release cut with `npm run release`,** which builds,
deploys and tags. Pushing to `master` is not a release: CI runs `test:release` on every push, and
a release may only be cut from a commit whose `test:release` passed.

Every SDLC plan phase is labelled Tier 1, 2 or 3. Tier 1 phases use `test:t1`; Tier 2 and Tier 3
phases use `test:t2`. "Before delivery" in a plan means `test:release`.

There is no separate lint command: `tsc -b` and the tooling project are the static checks, and the
gate runs them.

Two workflow steps are not test entry points, and their absence from `test:release` is deliberate:

- `node scripts/mutation-run.ts` (`.github/workflows/mutation.yml`) measures the checks
  themselves — it plants defects and records which check notices — rather than the product.
- `npm run eval-flow-e2e` (`.github/workflows/images.yml`, dispatch-only with `walk: true`) is a
  Tier 1 walk of the whole eval flow. It stands up a scratch Docker stack, the built images and a
  scratch database, and runs for minutes; `images.yml` is where it runs, and it is not a release
  step.
