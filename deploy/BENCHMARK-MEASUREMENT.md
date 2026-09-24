# Benchmark measurement

How an operator turns each blocked target in `benchmark.json` into an observation: what to run,
on what hardware, against which corpus, and where to put the result so the `benchmark` verb
reads it.

This exists because **no target in this repository's benchmark report has ever been measured**.
The report is honest about that — every `observed` field is `null` beside the reason — and the
command exits nonzero on it. This document is the only path from that state to a release
verdict. Nothing in it may be skipped by writing a number into the report by hand.

---

## 0. The rule that outranks everything below

**This procedure never runs against production.** It generates 780,000 synthetic records and
drives a sustained query load for thirty minutes. Run it on a throwaway host you control, with
no network route to the production database, exactly as `RESTORE-AND-CUTOVER.md` section 0
requires of the rehearsal. At least one developer laptop in this project runs a local container
pointed at the *production* database; that laptop is not the machine.

A benchmark pass is also **not** a substitute for integrity evidence. If the cutover rehearsal
lost an acknowledged write, no latency figure repairs that.

---

## 1. The reference deployment

| Axis | Required |
|---|---|
| CPU | 8 vCPU |
| RAM | 32 GiB |
| Disk | local SSD, at least 200 GiB free |
| Topology | one artifact-writer host; the database on that same test host |
| Database | PostgreSQL 17 with pinned `pg_textsearch` v1.4.0, built per `deploy/postgres/` |
| Record | the actual CPU model, disk type and OS, captured on the host |

`hardware.declared` in the report is the agreement's figures. `hardware.observed` is what you
read off the host. A run on a smaller box is a run of a different workload; report it as such
rather than comparing it to these targets.

**Prerequisite:** every pin in `deploy/postgres/versions.lock.json` is verified — its
`unverified_fields` is empty — before any figure produced here means anything. A benchmark
against an image nobody can identify binds to nothing.

---

## 2. Generate the full-scale corpus

```bash
export ZZ_TENANT_INFO_WORKSPACE=/srv/bench            # outside the checkout, on the big disk
npm run tenant-info -- fixtures --seed 1 --scale 1
```

Full scale is 780,000 records across the seven declared corpora and 520 exactly-1-MiB fixtures.
`scale 1` is the only scale that produces full-scale evidence; a reduced run is refused by the
report validator, not silently scaled up.

Then **census what is actually on disk** — walk the generated tree, do not copy
`testing/tenant-info/manifest.json`, which is the public *definition* and not a count of files:

```json
// $ZZ_TENANT_INFO_WORKSPACE/benchmark-inputs/acceptance/corpus-census.json
{
  "method": "filesystem-walk",
  "scale": 1,
  "declared": { "primary_current": { "records": 150000, "one_mib_fixtures": 100 }, "...": {} },
  "observed": {
    "primary_current": {
      "records": 150000, "one_mib_fixtures": 100,
      "mean_bytes": 8192, "p95_bytes": 65536,
      "histogram": [[0, 4096, 61000], [4096, 16384, 78000]], "aggregate_hash": "<sha256>"
    },
    "...": {}
  },
  "blocked_reason": null
}
```

Each corpus is checked independently: mean 8 KiB within 5%, p95 64 KiB within 5%, exactly one
1-MiB fixture per 1500 records. An overall average that passes while one corpus is wrong is
rejected.

---

## 3. Load, project and index

Apply the migrations against the PG17 cluster, load the corpus, and let projection complete.
Then record what is actually indexed:

```json
// benchmark-inputs/acceptance/index-census.json
{
  "method": "index-scan",
  "observed_indexed_artifacts": 780000,
  "projection_generation": "<generation id>",
  "blocked_reason": null
}
```

An indexed count below the censused record count is refused: a full manifest with too few
indexed artifacts is not full-scale evidence.

---

## 4. Run the reference workload

Ten concurrent clients, a sustained 5 queries/second for thirty minutes at limit 15, after a
recorded warm-up, mixed 80% current / 10% evidence / 10% history. **Record what was achieved,
not what was requested** — a run that asked for 5 q/s and sustained 2 did not run this workload.

```json
// benchmark-inputs/acceptance/workload.json
{
  "requested": { "clients": 10, "queries_per_second": 5, "duration_minutes": 30, "limit": 15,
                 "mix": { "current": 0.8, "evidence": 0.1, "history": 0.1 } },
  "achieved": { "clients": 10, "queries_per_second": 4.98, "warm_up_seconds": 120,
                "observed_queries": 8964 },
  "blocked_reason": null
}
```

Retain the per-query log. It is what `latency_p95_ms` and `latency_p99_ms` are computed from and
what I-25 re-derives them from; a summary with no log behind it cannot be verified.

---

## 5. Score quality against the approved judged set

Quality uses **limit 20** and the held-out answerable slice; latency uses **limit 15**. The
definitions are fixed and are restated in `quality.definitions` of every report:

- **Recall@k** — distinct required relevant refs in the first *k* **displayed** results, over
  all judged relevant refs, arithmetic mean across the slice. A response-budget omission counts
  as a miss; an undisplayed candidate is never scored.
- **MRR@10** — reciprocal rank of the first relevant result within 10, zero on miss.
- **nDCG@10** — gain `2^grade − 1`, discount `log2(rank+1)`, against that query's ideal ordering.
- Grades 1 and 2 are relevant. No-answer cases are excluded from every quality denominator.
- Multiple passages of one artifact count once; a historical answer requires the judged revision.

Sample English, Chinese and mixed held-out answerable slices **separately**, each with its own
denominator. A slice reporting a metric over a denominator of zero is refused.

```json
// benchmark-inputs/acceptance/quality.json
{
  "definitions": { "quality_limit": 20, "latency_limit": 15 },
  "slices": [
    { "slice": "held-out-answerable-en", "denominator": 72,
      "metrics": { "recall_at_20": 0.0, "recall_at_5": 0.0, "mrr_at_10": 0.0, "ndcg_at_10": 0.0 },
      "blocked_reason": null }
  ],
  "rates": { "no_answer_correct_rate": 0.0, "false_empty_rate": 0.0, "incomplete_rate": 0.0,
             "blocked_reason": null }
}
```

The metric values above are placeholders for the shape only — replace every one with what your
run scored. A `denominator` must be the positive number of cases the slice was sampled over; a
slice you did not sample is `"denominator": null` with a `blocked_reason`, never zero. All three
rates must be present as finite numbers or as `null` beside a reason. `quality_limit` must be 20
and `latency_limit` must be 15: those are the agreement's, not the run's, and a report scored at
another limit is refused rather than compared.

The dataset must be the one H1 approved. The command hashes `testing/tenant-info/queries.jsonl`
and `qrels.jsonl` itself and compares them to `artifacts/tenant-info-v4/qrels-approval.json`; a
mismatch voids the approval rather than inheriting it, and needs a new signature against a new
dataset version.

---

## 6. The remaining targets

| Target | What produces it |
|---|---|
| `rebuild_minutes` | a timed rebuild of all seven corpora, with atomic publication only after parity |
| `projection_freshness_p99_ms` | committed-mutation-to-searchable timing on a healthy database during the run |
| `semantic_parity` | a semantic manifest comparison between canonical records and the published generation |
| `unauthorized_results` | `npm run tenant-info -- verify --suite isolation --profile acceptance` over the full-scale corpora |
| `lost_acknowledged_writes` | the cutover rehearsal's acknowledged-write replay after recovery |
| `silent_truncations` | projection of every corpus with zero undisclosed omissions |

Each is a required measurement in its own right. A missing one stays `blocked`; it does not
default to zero, and a zero written where nothing was counted is indistinguishable in the file
from a zero somebody measured.

---

## 7. Bind the runtime and produce the report

```json
// benchmark-inputs/acceptance/runtime.json
{ "candidate": { "image_digest": "sha256:…", "migration_head": "…" },
  "baseline": { "image_digest": "sha256:…" }, "blocked_reason": null }
```

Then:

```bash
npm run tenant-info -- benchmark --profile acceptance    # writes artifacts/tenant-info-v4/benchmark.json
npm run tenant-info -- benchmark --profile baseline      # writes artifacts/tenant-info-v4/benchmark-baseline.json
```

Both write their resolved inputs to `raw/benchmark/<profile>/inputs.json` and reference that
file by hash from the report, so I-25 can re-derive every summary.

The baseline profile measures the **preserved old executable** from I-2 against the same qrels
and the same corpus. Capabilities that build never had — scoped corpora, identifier-part and
typo handling, the history scope — are declared in `coverage.baseline.unsupported`. They are
not scored as misses and they are not improved; a baseline report that declares no unsupported
capability is refused.

---

## 8. Reading the exit code

| Exit | Meaning |
|---|---|
| 0 | the report is structurally valid **and** all eighteen targets passed |
| 1 | the report ran and did not pass — a failed, missing or blocked target, or a structural refusal |
| 2 | the invocation was invalid (no workspace, bad `--profile`) |

**A structurally valid report is not a passing one.** The report this checkout produces today
validates cleanly, carries eighteen blocked targets, and exits 1. That is the correct exit code
for "nothing has been measured", and it is the whole reason the verb reads its verdict off the
targets rather than off the fact that it produced a file.
