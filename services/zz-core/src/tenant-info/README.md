# Tenant information v4

For somebody deciding whether this delivery can be released, and for whoever has to
discharge what is still outstanding.

This is the reference for the tenant-information work: what it added, how each business
acceptance criterion is proved, and — the part that matters most on the day you read it —
which criteria have evidence behind them and which do not.

**It does not say the delivery is ready.** Readiness is a computed answer, not a written
one. `npm run tenant-info -- verify --finalize --profile acceptance` recomputes it from
whatever is actually on disk at the moment it runs, writes it to
`artifacts/tenant-info-v4/acceptance.json` in the workspace, and exits non-zero when the
answer is no. This document explains how to read that report; it never stands in for it.

---

## 1. What was built

A tenant's information — its documents, its sources, its knowledge — needed four things the
platform did not separate cleanly before.

**Identity independent of path.** An artifact has an owner-qualified identity that survives a
move. A reference pins a revision and its content hash, so it cannot quietly come to mean
later text. `services/zz-core/src/tenant-info/record.ts` is the durable write;
`packages/contracts/src/tenant-information.ts` is the shared shape both doors agree on.

**Revisions distinct from events.** A changed semantic payload produces exactly one next
revision. Approval, verification, lifecycle transitions, attachment and moves are attributed
*events* — they bind the revision they were about, and an old approval never covers later
content. `services/zz-core/src/tenant-info/policies.ts` holds the boundary;
`services/zz-core/src/tenant-info/mutations.ts` is the kernel that commits through it.

**Retrieval that cannot leak.** Four lanes, scoped per corpus, fused after ranking rather
than filtered after a global ranking — because a global index filtered afterwards still lets
another tenant's private corpus move your statistics.
`services/zz-core/src/tenant-info/retrieval.ts` is the contract;
`services/zz-core/src/tools/knowledge-search.ts` is the wire.

**Derived data that can be rebuilt.** Canonical files are the truth; projections and the
search index are derived and reconstructable from them without inventing identity or dates.
`packages/indexing/src/tenant-rebuild.ts` and `packages/indexing/src/tenant-projections.ts`.

Around those sit an exact-release PostgreSQL 17 pin (`deploy/postgres/versions.lock.json`), a
lossless legacy migration (`services/zz-core/src/tenant-info/legacy-import.ts`), an OKF
interoperability export (`services/zz-core/src/tenant-info/export.ts`) and a full-scale
benchmark over an independently judged query set
(`scripts/tenant-info/benchmark-report.ts`).

---

## 2. The command

One entry point, six verbs, and a workspace that must resolve outside this checkout:

```bash
export ZZ_TENANT_INFO_WORKSPACE=/somewhere/outside/this/repository
npm run tenant-info -- verify --suite retrieval --profile acceptance
```

`ZZ_TENANT_INFO_WORKSPACE` is required rather than defaulted. This platform holds real
documents and real sources, and a verification run that defaulted to writing beside the
checkout would be one mistake away from them. `scripts/tenant-info/workspace.ts` resolves the
path through `realpathSync` and refuses anything that lands inside the repository, directly or
through a symlink that only looks like it points elsewhere.

| Verb | What it does |
|---|---|
| `baseline` | Reads the current state and the exact dependency inventory. Writes nothing to the platform. |
| `fixtures` | Generates deterministic corpora from a seed and a scale. |
| `verify` | Runs one of the ten suites, or `--finalize` for the whole acceptance decision. |
| `benchmark` | Runs the full-scale benchmark and evaluates every release target. |
| `migrate` | Plans, and with `--apply` performs, the legacy import onto a separate record volume. |
| `export` | Writes the OKF bundle. |

### The two profiles

`tenant-info verify --profile integration` is for working. A case that cannot run — no isolated database, no
built image — reports `not_run` and does not drag down the offline cases a checkout *can*
prove.

`tenant-info verify --profile acceptance` is for deciding. It forbids `--cases`, runs the complete required
suite, and **blocks a suite on any case that did not run**. It also blocks a suite whose
receipt cannot be read case by case, because a suite that cannot show what it ran cannot show
it ran everything.

`blocked` is not `failed`, and the two are kept apart everywhere. A failure is an assertion
that ran and went red — a fact about the system. A block is the absence of evidence — a fact
about the run. Collapsing them would let a reader mistake "nobody has stood up PostgreSQL 17"
for "isolation is broken", and both of those mistakes have been made in this delivery and
fixed.

---

## 3. The thirteen criteria and how each is proved

The method for each criterion is fixed by the approved specification and is read from
`CRITERION_METHODS` in `scripts/tenant-info/verify.ts`. A report's own claim about its method
is compared against that map, never trusted as it: otherwise AC-6.1, which a person must
sign, could be re-declared `command` by the very report claiming to have satisfied it.

| Criterion | Method | Evidence |
|---|---|---|
| AC-1.1 | command | `tenant-info verify --suite model --profile acceptance` |
| AC-2.1 | command | `tenant-info verify --suite persistence --profile acceptance` |
| AC-2.2 | command | `tenant-info verify --suite lifecycle --profile acceptance` |
| AC-3.1 | command | `tenant-info verify --suite okf --profile acceptance` |
| AC-4.1 | command | `tenant-info verify --suite rebuild --profile acceptance` |
| AC-5.1 | command | `tenant-info verify --suite isolation --profile acceptance` |
| AC-5.2 | command | `tenant-info verify --suite retrieval --profile acceptance` |
| AC-6.1 | human | The recorded decisions on the locked judged set and on selected legacy classifications |
| AC-6.2 | command | `tenant-info benchmark --profile acceptance` |
| AC-7.1 | command | `tenant-info verify --suite migration --profile acceptance` |
| AC-7.2 | command | `tenant-info verify --suite deployment --profile acceptance` |
| AC-8.1 | command | `tenant-info verify --suite compatibility --profile acceptance`, **plus** the gate, the frozen check set, the independent break-tests and the edit-surface ledger |
| AC-8.2 | agent-review | The analytical transcript and its reference trail |

AC-8.1 is wider than its suite on purpose. Its criterion reads "existing consumers remain
compatible, **all required checks execute** and **no declared integration path is unaccounted
for**". The compatibility suite answers the first clause. The other two are the gate's own
execution report, the reconciliation of all twenty-four frozen checks, the separately executed
independent break-tests, and the edit-surface ledger — so a criterion that reported its
suite's verdict alone would be answering a third of itself.

---

## 4. The finalizer

`tenant-info verify --finalize --profile acceptance` is the only thing that produces a readiness answer.
It runs **outside the ordinary gate**, and the gate never reads the report it writes. That is
a deliberate arrangement rather than an accident of layering: a gate that came to depend on
its own final acceptance report would be a gate that passes because it passed.

It is split across two files, and the split is the property:

- `scripts/tenant-info/verify.ts` holds `assessAcceptance`, a **pure function of
  observations**. It reads no file, spawns nothing, and resolves nothing. That is what lets
  `checks/acceptance-covers-every-criterion.ts` drive it over synthetic inputs inside the
  ordinary gate without the gate ever touching an actual acceptance report.
- `scripts/tenant-info/acceptance.ts` holds the observing: computing the candidate binding,
  spawning the real commands, resolving and hashing evidence, reconciling the frozen check
  set and the ledger, and writing the report.

### `verified` is constructed, never accepted

An evidence entry's `verified: true` is built by the resolver in `acceptance.ts` after it has
read the file and hashed it. The locator type it takes has no `sha256` and no `verified` field
at all, so there is nowhere for a caller to put a claim, and the resolver constructs a fresh
object either way. A hand-written report naming ten protected files with plausible 64-hex
hashes and `verified: true`, backed by nothing on disk, resolves to ten unverified entries and
`ready: false`.

### The candidate binding

Seven fields identify *which* candidate a piece of evidence is about, and all three copies —
the report's, the gate's, and every evidence entry's — must agree:

`source_tree_sha256` · `spec_body_sha256` · `plan_body_sha256` · `runtime_image_digest` ·
`dependency_lock_sha256` · `corpus_hash` · `qrels_hash`

`source_tree_sha256` covers the **working tree**, not `HEAD` — `git ls-files --cached --others
--exclude-standard`, sorted, each entry hashed as `path\0filehash`. A digest over `HEAD` would
identify a candidate nobody tested, because work is uncommitted while the suites run over it.
It is the same basis `scripts/gate/run.ts` uses for its own report digest, to the letter, so
the two can be compared at all.

The snapshot is re-read *after* the gate. The gate regenerates the marketplace tree; if that
changed a byte, everything measured before it was measured against a different candidate, and
the run must be repeated after regeneration and refreezing rather than averaged.

### What makes `ready` true

Everything, with no partial credit and no quorum. All thirteen criteria present, each with the
spec's own method, each `passed`, each command criterion exiting 0 and each non-command
criterion carrying no exit code; every applicable prerequisite passed; every evidence entry
verified and bound to this candidate; and a gate that returned `PASSED` with nothing skipped,
nothing failed, and every discovered check accounted for by an execution record — counted, not
set-tested, so two checks registered under one name cannot hide a missing one.

A structurally complete **failed** report is a good report and still not a release. That is
asserted directly by the frozen check: a report with all thirteen criteria failed is
`structure_valid: true, ready: false`.

---

## 5. Reading `acceptance.json`

```jsonc
{
  "binding":      { /* the seven fields above */ },
  "criteria":     { "AC-1.1": { "method", "status", "exit_code", "evidence_ids", "basis" } },
  "prerequisites":{ "benchmark.json": { "applicable", "status", "basis" } },
  "gate":         { "verdict", "exit_code", "discovered", "executed", "skipped_ids", "failed_ids" },
  "independent_breaktests": [ { "id", "exit_code", "passed" } ],
  "reconciliations": [ { "subject", "expected", "accounted", "outstanding": [ /* by name */ ] } ],
  "evidence":     [ { "id", "sha256", "verified", "resolved_path" } ],
  "findings":     [ /* prose, one per thing a reader has to know */ ],
  "issues":       [ /* every reason ready is false */ ],
  "ready":        false
}
```

`outstanding` is a list of names, never a count. "These cannot be inferred from equal counts
alone" is the contract's wording, and a reader handed two numbers that disagree would have to
go and find the difference themselves.

`findings` is separate from `issues` on purpose. An issue is a reason the answer is no. A
finding is something true a reader needs regardless — a producer writing its report to a
different path than the one the specification declares, an evidence file resolved somewhere
unexpected, a review record whose pinned runtime has moved since.

---

## 6. What is outstanding

Read this section as of the commit that carries it; the report recomputes it.

**No PostgreSQL 17 with `pg_textsearch` exists anywhere in this delivery.** Migration 070 is
deferred on every cluster by construction, no BM25 index has ever been created, and the
lexical lane's ranking has never executed. Four suites — `rebuild`, `isolation`, `migration`,
`deployment` — carry cases that need an isolated database and report them `not_run`, which at
the acceptance profile is a block.

**`deploy/postgres/versions.lock.json` carries nine unverified pins.** Every one is a
deliberate placeholder written with repeated digits so it is visually unmistakable from a real
digest, by a task that had no docker, no network and no registry access. `runtime_image_digest`
in the binding is one of them. No image has been built from this lock.

**Every benchmark release target is blocked**, for the same reason: the numbers come from a
workload that has never run against the real engine.

To discharge them, in order:

- [ ] Resolve the nine `unverified_fields` in `deploy/postgres/versions.lock.json` against a
      reachable registry and upstream repository, then `docker build` and read the real
      digests back out of the built image.
- [ ] Stand up an isolated PostgreSQL 17 with `pg_textsearch` and export
      `ZZ_TENANT_INFO_ISOLATED_DB_URL` pointing at it — never at a live deployment; the
      deployment suite refuses a URL that also appears as a live database.
- [ ] Re-run the four blocked suites and the benchmark with `tenant-info`, at the acceptance profile.
- [ ] Re-run `tenant-info verify --finalize --profile acceptance` and read `ready`.

Only after `ready` is true does the normal release review begin. **A ready result is not
permission to cut over.** The production freeze and cutover are a separate decision by the
production operator, taken after that review, and nothing in this delivery may stand in for
it.

---

## 7. Related files

| Path | What it is |
|---|---|
| `scripts/tenant-info/cli.ts` | The one entry point; argv, the workspace gate, and error shapes |
| `scripts/tenant-info/verify.ts` | Suite dispatch, the acceptance profile, and `assessAcceptance` |
| `scripts/tenant-info/acceptance.ts` | The finalizer's evidence resolution and reconciliation |
| `scripts/tenant-info/ledger.ts` | The edit-surface ownership ledger and the store manifest |
| `scripts/tenant-info/benchmark-report.ts` | The benchmark report and its release-target evaluation |
| `testing/tenant-info/` | The ten suites |
| `deploy/BENCHMARK-MEASUREMENT.md` | How the benchmark's numbers are measured, and what they are not |
