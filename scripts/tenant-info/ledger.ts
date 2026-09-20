/**
 * ledger.ts — the repository's own edit-surface ownership ledger, the store walk, and the
 * manifest hashing a baseline capture is assembled from.
 *
 * `plan-approved.md`'s "Repository edit-surface ownership" table assigns every path this
 * initiative may touch to the task that owns it, and I-2's acceptance criterion reads "the
 * complete edit-surface ownership ledger is checked against that checkout, not inferred from a
 * filename's existence alone". `EDIT_SURFACE_LEDGER` is that table transcribed; `classify` is
 * the second half of that sentence, cross-checking `existsSync` against this initiative's own
 * commits rather than trusting that a file being present means this work put it there.
 *
 * IT HAS ALREADY EARNED ITS KEEP. Run against the checkout after I-1 it refused to report a
 * clean capture and named nine paths I-1 had created or regenerated that the approved edit
 * surface did not carry; the specification was revised to declare them. A detector loosened the
 * first time it is inconvenient reports success instead, which is the failure it exists to
 * prevent.
 *
 * Split out of inventory.ts at the 700-line ceiling during I-3.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
interface LedgerEntry {
  readonly path: string;
  readonly task: string;
  /** A second ledger row for a path another task already owns is not a collision — the plan
   *  says explicitly "shared files can be extended by later listed tasks" and names several
   *  (verify.ts by I-25, this very file by I-3 and I-13, the I-11 read adapters by I-18). This
   *  row records that later touch rather than the path's primary ownership. */
  readonly extension?: boolean;
  /** True for a row the plan names as a build output of a canonical source elsewhere in the
   *  ledger (a marketplace skill mirror) rather than a path anyone authors directly. */
  readonly generatedFrom?: string;
  /** True for a row the plan lists as an EXISTING file I-22 re-verifies at final
   *  compatibility, not a file this initiative authors. */
  readonly verifyOnly?: boolean;
}

// Paths are written plainly. Most rows below name FUTURE tasks' outputs that do not exist yet,
// which is the normal state of a ledger describing a plan partway through; `checks/literal-
// paths-resolve.ts` exempts this file by name for exactly that reason, so the rows can read as
// what they are instead of being assembled at runtime to slip past a check.

const braces = (task: string, prefix: string, names: readonly string[], suffix: string): LedgerEntry[] =>
  names.map((name) => ({ path: `${prefix}${name}${suffix}`, task }));

/**
 * `plan-approved.md`'s "Repository edit-surface ownership" table, one row expanded per
 * declared path. Grouped by task in the plan's own order; a comment marks each source row so
 * a later diff against the plan is legible.
 */
const EDIT_SURFACE_LEDGER: readonly LedgerEntry[] = [
  // I-1 — Safe command entry and check activation
  { path: "package.json", task: "I-1" },
  { path: "package-lock.json", task: "I-1" },
  { path: "tsconfig.tooling.json", task: "I-1" },
  { path: "scripts/tenant-info/cli.ts", task: "I-1" },
  { path: "scripts/tenant-info/verify.ts", task: "I-1" },
  { path: "checks/tenant-info-cli.ts", task: "I-1" },
  { path: "catalog/sdlc/sdlc-flow/skills/sdlc-execute/SKILL.md", task: "I-1" },
  { path: "marketplace/sdlc/skills/sdlc-execute/SKILL.md", task: "I-1",
    generatedFrom: "catalog/sdlc/sdlc-flow/skills/sdlc-execute/SKILL.md" },
  { path: "scripts/tenant-info/verify.ts", task: "I-25", extension: true }, // finalization

  // I-2 — Read-only baseline and exact dependency inventory (this task)
  { path: "scripts/tenant-info/baseline.ts", task: "I-2" },
  { path: "scripts/tenant-info/inventory.ts", task: "I-2" },
  { path: "checks/tenant-info-baseline-fields.ts", task: "I-2" },
  { path: "scripts/tenant-info/inventory.ts", task: "I-3", extension: true },  // fixture exports
  { path: "scripts/tenant-info/inventory.ts", task: "I-13", extension: true }, // migration-name validation

  // I-3 — Deterministic corpora with separately measured manifests
  { path: "testing/tenant-info/manifest.json", task: "I-3" },
  { path: "checks/tenant-info-corpus-shape.ts", task: "I-3" },

  // I-4 — Judged questions and an accountable review prerequisite
  { path: "testing/tenant-info/queries.jsonl", task: "I-4" },
  { path: "testing/tenant-info/qrels.jsonl", task: "I-4" },
  { path: "scripts/tenant-info/benchmark.ts", task: "I-4" },
  { path: "checks/tenant-info-qrels-integrity.ts", task: "I-4" },
  { path: "scripts/tenant-info/benchmark.ts", task: "I-23", extension: true },

  // I-5 — Pinned PostgreSQL 17 and exact-release feature proof
  { path: "deploy/postgres/Dockerfile", task: "I-5" },
  { path: "deploy/postgres/versions.lock.json", task: "I-5" },
  { path: "deploy/postgres/postgresql.conf", task: "I-5" },
  { path: "testing/tenant-info/deployment.ts", task: "I-5" },
  { path: "Dockerfile", task: "I-5" },
  { path: "deploy/docker-compose.build.yml", task: "I-5" },
  { path: "scripts/release/build.ts", task: "I-5" },
  { path: "checks/postgres-image-pinned.ts", task: "I-5" },
  { path: "testing/tenant-info/deployment.ts", task: "I-21", extension: true },
  { path: "scripts/release/build.ts", task: "I-21", extension: true },

  // I-6 — Shared types and runtime validation
  { path: "packages/contracts/src/tenant-information.ts", task: "I-6" },
  { path: "packages/contracts/src/index.ts", task: "I-6" },
  { path: "packages/contracts/package.json", task: "I-6" },
  { path: "packages/indexing/package.json", task: "I-6" },
  { path: "services/zz-core/package.json", task: "I-6" },
  { path: "checks/tenant-information-contract.ts", task: "I-6" },

  // I-7 — Durable record commits and publication boundaries
  { path: "services/zz-core/src/tenant-info/record.ts", task: "I-7" },
  { path: "testing/tenant-info/persistence.ts", task: "I-7" },
  { path: "checks/tenant-record-durability.ts", task: "I-7" },
  { path: "testing/tenant-info/persistence.ts", task: "I-8", extension: true },
  { path: "testing/tenant-info/persistence.ts", task: "I-11", extension: true },

  // I-8 — Coordinating kernel, concurrency and uncertain outcomes
  { path: "services/zz-core/src/tenant-info/mutations.ts", task: "I-8" },
  { path: "services/zz-core/src/tenant-info/recovery.ts", task: "I-8" },
  { path: "checks/tenant-kernel-codes.ts", task: "I-8" },

  // I-9 — Semantic revisions and authorized provenance
  { path: "services/zz-core/src/tenant-info/policies.ts", task: "I-9" },
  { path: "testing/tenant-info/model.ts", task: "I-9" },
  { path: "checks/tenant-revision-boundary.ts", task: "I-9" },
  { path: "testing/tenant-info/model.ts", task: "I-10", extension: true },
  { path: "testing/tenant-info/model.ts", task: "I-11", extension: true },

  // I-10 — Independent gate, knowledge and closure transitions
  { path: "testing/tenant-info/lifecycle.ts", task: "I-10" },
  { path: "services/zz-core/src/document-rules.ts", task: "I-10" },
  { path: "services/zz-core/src/write-guards.ts", task: "I-10" },
  { path: "services/zz-core/src/guards.ts", task: "I-10" },
  { path: "services/zz-core/src/chain.ts", task: "I-10" },
  { path: "services/zz-core/src/versions.ts", task: "I-10" },
  { path: "services/zz-core/src/attest.ts", task: "I-10" },
  { path: "services/zz-core/src/initiative-record.ts", task: "I-10" },
  { path: "services/zz-core/src/tools/initiative-status.ts", task: "I-10" },
  { path: "checks/tenant-lifecycle-matrix.ts", task: "I-10" },

  // I-11 — Thin adapters with explicit safe-write contracts
  { path: "services/zz-core/src/tools/artifacts.ts", task: "I-11" },
  { path: "services/zz-core/src/tools/initiative-acts.ts", task: "I-11" },
  { path: "services/zz-core/src/tools/knowledge.ts", task: "I-11" },
  { path: "services/zz-core/src/persist.ts", task: "I-11" },
  { path: "services/zz-core/src/paths.ts", task: "I-11" },
  { path: "services/zz-core/src/server.ts", task: "I-11" },
  { path: "services/zz-core/src/tools/initiative-open.ts", task: "I-11" },
  { path: "services/zz-core/src/tools/initiative-close.ts", task: "I-11" },
  { path: "checks/tenant-single-writer.ts", task: "I-11" },
  ...[
    "services/zz-core/src/tools/artifacts.ts", "services/zz-core/src/tools/initiative-acts.ts",
    "services/zz-core/src/tools/knowledge.ts", "services/zz-core/src/persist.ts",
    "services/zz-core/src/paths.ts", "services/zz-core/src/server.ts",
    "services/zz-core/src/tools/initiative-open.ts", "services/zz-core/src/tools/initiative-close.ts",
  ].map((path): LedgerEntry => ({ path, task: "I-18", extension: true })),
  { path: "services/zz-core/src/server.ts", task: "I-21", extension: true }, // maintenance entry

  // I-12 — OKF interoperability without fabricated history
  { path: "services/zz-core/src/tenant-info/export.ts", task: "I-12" },
  { path: "scripts/tenant-info/export.ts", task: "I-12" },
  { path: "packages/contracts/schemas/zz-knowledge-v1.json", task: "I-12" },
  { path: "testing/tenant-info/okf.ts", task: "I-12" },
  { path: "checks/okf-round-trip.ts", task: "I-12" },

  // I-13 — Forward migration and atomic derived projections
  { path: "services/gateway/migrations/<NNN>_artifacts_revisions_events_and_scoped_search.sql", task: "I-13" },
  { path: "packages/indexing/src/tenant-projections.ts", task: "I-13" },
  { path: "services/zz-core/src/platform-db.ts", task: "I-13" },
  { path: "services/gateway/src/db.ts", task: "I-13" },
  { path: "testing/tenant-info/rebuild.ts", task: "I-13" },
  { path: "checks/tenant-migration-shape.ts", task: "I-13" },
  { path: "testing/tenant-info/rebuild.ts", task: "I-15", extension: true }, // completion

  // I-14 — Complete text and versioned analysis
  { path: "packages/indexing/src/tenant-analysis.ts", task: "I-14" },
  { path: "packages/indexing/src/rules.ts", task: "I-14" },
  { path: "checks/tenant-complete-text.ts", task: "I-14" },

  // I-15 — Rebuild generations from canonical records
  { path: "packages/indexing/src/tenant-rebuild.ts", task: "I-15" },
  { path: "packages/indexing/src/index.ts", task: "I-15" },
  { path: "services/zz-core/src/indexing.ts", task: "I-15" },
  { path: "checks/tenant-rebuild-inputs.ts", task: "I-15" },

  // I-16–I-19 — retrieval, built sequentially on the same path
  { path: "services/zz-core/src/tenant-info/retrieval.ts", task: "I-16" },
  { path: "services/zz-core/src/tenant-info/retrieval.ts", task: "I-17", extension: true },
  { path: "services/zz-core/src/tenant-info/retrieval.ts", task: "I-18", extension: true },
  { path: "services/zz-core/src/tenant-info/retrieval.ts", task: "I-19", extension: true },
  { path: "checks/tenant-scope-predicates.ts", task: "I-16" },
  { path: "checks/tenant-fusion-arithmetic.ts", task: "I-17" },
  { path: "services/zz-core/src/tools/knowledge-search.ts", task: "I-18" },
  { path: "testing/tenant-info/retrieval.ts", task: "I-18" },
  { path: "checks/tenant-query-syntax.ts", task: "I-18" },
  { path: "testing/tenant-info/isolation.ts", task: "I-19" },
  { path: "checks/tenant-isolation-statistics.ts", task: "I-19" },

  // I-20 — Lossless migration onto a separate record volume
  { path: "services/zz-core/src/tenant-info/legacy-import.ts", task: "I-20" },
  { path: "scripts/tenant-info/migrate.ts", task: "I-20" },
  { path: "testing/tenant-info/migration.ts", task: "I-20" },
  { path: "checks/tenant-migration-losslessness.ts", task: "I-20" },

  // I-21 — Backup and cutover rehearsal, not a production switch
  { path: "deploy/backup.sh", task: "I-21" },
  { path: "deploy/docker-compose.yml", task: "I-21" },
  { path: "deploy/.env.example", task: "I-21" },
  { path: "deploy/README.md", task: "I-21" },
  { path: "scripts/release.ts", task: "I-21" },
  { path: "scripts/release/tool-chain.ts", task: "I-21" },
  { path: "scripts/doctor/layers/data.ts", task: "I-21" },
  { path: "scripts/ops/purge-probes.ts", task: "I-21" },
  { path: "testing/reset-store.sh", task: "I-21" },
  { path: "checks/backup-covers-the-undisposable.ts", task: "I-21" },

  // I-22 — Compatible readers, truthful gate reports and nonrecursive registration
  { path: "services/gateway/src/server.ts", task: "I-22" },
  { path: "services/gateway/src/console/knowledge.ts", task: "I-22" },
  { path: "services/gateway/src/client-package.ts", task: "I-22" },
  { path: "services/gateway/src/package/skills.ts", task: "I-22" },
  { path: "services/gateway/src/package/plugin-lock.ts", task: "I-22" },
  { path: "services/gateway/src/console/overview.ts", task: "I-22" },
  { path: "services/gateway/src/console/overview-metrics.ts", task: "I-22" },
  { path: "services/gateway/src/runs.ts", task: "I-22" },
  { path: "services/gateway/src/discussion.ts", task: "I-22" },
  { path: "services/zz-core/src/eval/plugin-judge.ts", task: "I-22" },
  { path: "testing/tenant-info/compatibility.ts", task: "I-22" },
  { path: "checks/tenant-checks-registered.ts", task: "I-22" },
  { path: "services/gateway/src/server.ts", task: "I-21", extension: true }, // maintenance entry
  // "all remaining listed existing gate/check/client exerciser ... entries described below" —
  // re-verified, not authored: existing gate producer, existing regression set, canonical skills.
  ...["gate.ts"].map((n): LedgerEntry => ({ path: `scripts/${n}`, task: "I-22", verifyOnly: true })),
  ...braces("I-22", "scripts/gate/", ["read", "run"], ".ts").map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "scripts/gate/checks/",
    ["documents-guards", "documents-schema", "documents-lifecycle", "data-sql", "deploy-ops", "image", "suites"],
    ".ts").map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "checks/",
    ["document-rules", "revise-cause", "definition-rules", "initiative-open", "core-surface-19",
     "alias-maps", "verification-stages-write", "skill-renames"], ".ts").map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "packages/tools/src/testing/",
    ["chain-check", "chain-shelf", "manifest-audit", "tool-report"], ".ts").map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "skills/", ["zz-platform", "zz-handover", "zz-breakout"], "/SKILL.md")
    .map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "catalog/zz/zz-access/skills/", ["zz-admin", "zz-migrate"], "/SKILL.md")
    .map((e) => ({ ...e, verifyOnly: true })),
  ...braces("I-22", "catalog/sdlc/sdlc-flow/skills/",
    ["sdlc-flow", "sdlc-method", "sdlc-explore", "sdlc-investigate", "sdlc-recall", "sdlc-research",
     "sdlc-spec", "sdlc-spec-audit", "sdlc-audit-criteria", "sdlc-plan", "sdlc-plan-audit", "sdlc-review"],
    "/SKILL.md").map((e) => ({ ...e, verifyOnly: true })),
  { path: "plugins.lock.json", task: "I-22", verifyOnly: true },

  // I-23 — Full-scale benchmark and independent pass/fail evaluation
  { path: "checks/benchmark-report-completeness.ts", task: "I-23" },

  // I-25 — Final evidence assembly and release-readiness decision
  { path: "docs/tenant-information-v4.md", task: "I-25" },
  { path: "README.md", task: "I-25" },
  { path: "ARCHITECTURE.md", task: "I-25" },
  { path: "CHANGELOG.md", task: "I-25" },
  { path: "checks/acceptance-covers-every-criterion.ts", task: "I-25" },
  // I-24 — end-to-end reuse under agent review — declares no repository implementation output.
];

export interface EditSurfaceEntry {
  readonly path: string;
  readonly task: string;
  readonly change: "created" | "modified" | "pending" | "missing";
  readonly exists: boolean;
  readonly coverage: string;
  readonly evidence: string;
}

interface GitCommit {
  readonly sha: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/** Commits strictly between `reviewReferenceSha` and `HEAD`, oldest first, each with the
 *  files it touched — restricted to this range so a reused task number from an earlier
 *  initiative (this repository has more than one "I-13:") never gets credited to this plan. */
function thisInitiativesCommits(repoRoot: string, reviewReferenceSha: string): GitCommit[] {
  const run = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  const shas = run(["log", "--reverse", "--format=%H", `${reviewReferenceSha}..HEAD`])
    .split("\n").filter(Boolean);
  return shas.map((sha) => {
    const subject = run(["log", "-1", "--format=%s", sha]).trim();
    const files = run(["show", "--name-only", "--format=", sha]).split("\n").filter(Boolean);
    return { sha, subject, files };
  });
}

/** Whether `path` exists, resolving the one pattern the ledger carries (a migration filename
 *  with an unassigned sequence number) against what is actually on disk. */
function resolveExistence(repoRoot: string, path: string): { exists: boolean; resolvedPath: string } {
  if (path.includes("<NNN>")) {
    const dir = join(repoRoot, path.slice(0, path.indexOf("<NNN>")).replace(/[^/]*$/, ""));
    const suffix = path.slice(path.lastIndexOf("_"));
    if (!existsSync(dir)) return { exists: false, resolvedPath: path };
    const hit = readdirSync(dir).find((f) => f.endsWith(suffix));
    return hit ? { exists: true, resolvedPath: join(relative(repoRoot, dir), hit).split(sep).join("/") }
               : { exists: false, resolvedPath: path };
  }
  return { exists: existsSync(join(repoRoot, path)), resolvedPath: path };
}

const TASK_COVERAGE: Readonly<Record<string, string>> = {
  "I-1": "safe command entry and check activation", "I-2": "read-only baseline and dependency inventory",
  "I-3": "deterministic corpora with separately measured manifests",
  "I-4": "judged questions and an accountable review prerequisite",
  "I-5": "pinned PostgreSQL 17 and exact-release feature proof",
  "I-6": "shared types and runtime validation", "I-7": "durable record commits and publication boundaries",
  "I-8": "coordinating kernel, concurrency and uncertain outcomes",
  "I-9": "semantic revisions and authorized provenance",
  "I-10": "independent gate, knowledge and closure transitions",
  "I-11": "thin adapters with explicit safe-write contracts",
  "I-12": "OKF interoperability without fabricated history",
  "I-13": "forward migration and atomic derived projections", "I-14": "complete text and versioned analysis",
  "I-15": "rebuild generations from canonical records", "I-16": "authorized corpus and scope resolution",
  "I-17": "four lanes and cross-corpus fusion", "I-18": "mode-aware parsing and the actual wire response",
  "I-19": "real isolation and nonvacuous statistics observations",
  "I-20": "lossless migration onto a separate record volume",
  "I-21": "backup and cutover rehearsal, not a production switch",
  "I-22": "compatible readers, truthful gate reports and nonrecursive registration",
  "I-23": "full-scale benchmark and independent pass/fail evaluation",
  "I-24": "end-to-end reuse under agent review",
  "I-25": "final evidence assembly and release-readiness decision",
};

/**
 * The technical AC's "checked against that checkout, not inferred from a filename's
 * existence alone": for every ledger row, look up whether THIS initiative's own commits
 * (between `reviewReferenceSha` and HEAD) created or touched it, and let that — not just
 * `fs.existsSync` — decide `change`. A path a done task's commit does not touch is `missing`
 * even though some earlier, unrelated initiative may have left a file at that name; a path no
 * commit in range has produced yet is `pending`, which is the ledger simply describing the
 * plan's remaining work rather than reporting a defect.
 */
export function buildEditSurface(repoRoot: string, reviewReferenceSha: string): EditSurfaceEntry[] {
  let commits: GitCommit[] = [];
  let gitAvailable = true;
  try {
    commits = thisInitiativesCommits(repoRoot, reviewReferenceSha);
  } catch {
    gitAvailable = false;
  }
  const doneTasks = new Set(
    commits.map((c) => /^(I-\d+):/.exec(c.subject)?.[1]).filter((t): t is string => t !== undefined),
  );
  return EDIT_SURFACE_LEDGER.map((entry) => {
    const { exists, resolvedPath } = resolveExistence(repoRoot, entry.path);
    const coverage = entry.verifyOnly
      ? `${TASK_COVERAGE[entry.task] ?? entry.task} (existing file, re-verified)`
      : entry.generatedFrom
      ? `${TASK_COVERAGE[entry.task] ?? entry.task} (generated from ${entry.generatedFrom})`
      : TASK_COVERAGE[entry.task] ?? entry.task;
    if (!gitAvailable) {
      return { path: entry.path, task: entry.task, exists, coverage,
        change: exists ? "modified" : "pending",
        evidence: `git history unavailable in this checkout; existence only: fs.existsSync("${resolvedPath}") = ${exists}` };
    }
    const touching = commits.filter((c) => c.files.includes(resolvedPath));
    let change: EditSurfaceEntry["change"];
    let evidence: string;
    if (!exists) {
      change = doneTasks.has(entry.task) ? "missing" : "pending";
      evidence = doneTasks.has(entry.task)
        ? `${entry.task} has a commit in ${reviewReferenceSha.slice(0, 12)}..HEAD but "${resolvedPath}" is absent`
        : `no commit in ${reviewReferenceSha.slice(0, 12)}..HEAD touches "${resolvedPath}" yet; ${entry.task} not yet run`;
    } else if (touching.length === 0) {
      change = "modified"; // exists, but not from this initiative's own commit range
      evidence = `"${resolvedPath}" exists but predates ${reviewReferenceSha.slice(0, 12)} or was not committed by this initiative`;
    } else {
      const first = touching[0];
      change = first.subject.startsWith(`${entry.task}:`) ? "created" : "modified";
      evidence = `${touching.length} commit(s) touch "${resolvedPath}" in range, first ${first.sha.slice(0, 12)} "${first.subject}"`;
    }
    return { path: entry.path, task: entry.task, exists, coverage, change, evidence };
  });
}

/**
 * Every path this initiative's own commits (`reviewReferenceSha..HEAD`) have actually
 * changed, that the ledger does NOT declare — "an unlisted required edit is blocking" from
 * I-2's contract. Pattern rows (the one `<NNN>` migration) are matched by suffix so a real
 * migration filename does not read as unlisted.
 */
export function unlistedChanges(repoRoot: string, reviewReferenceSha: string): string[] {
  const changed = execFileSync("git", ["diff", "--name-only", `${reviewReferenceSha}..HEAD`],
    { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  const declared = new Set(EDIT_SURFACE_LEDGER.map((e) => resolveExistence(repoRoot, e.path).resolvedPath));
  return changed.filter((f) => !declared.has(f));
}

// ────────────────────────── store manifest (owner/path/byte/hash) ──────────────────────────

interface FileManifestRow {
  readonly owner: string;
  readonly path: string;
  readonly bytes: number;
  readonly hash: string;
}

/**
 * `ZZ_TENANT_INFO_STORE_ROOT` is expected to point at the store's `teams/` directory (see
 * `services/zz-core/src/paths.ts`'s `ARTIFACTS_DIR/teams/<slug>`) — each immediate child is
 * one team, which is the "owner" the spec's "complete owner/path/byte/hash manifests" and
 * `owner_inventory` mean: a tenant, not an OS file uid. `.git` and other dot-entries are
 * skipped, matching what the store itself refuses to write (see `paths.ts`'s `safeName`).
 */
export function walkStore(storeRoot: string): FileManifestRow[] {
  // A real `teams/` directory holds team-slug directories, never a literal child also named
  // `teams` — that shape means the operator pointed `ZZ_TENANT_INFO_STORE_ROOT` one level too
  // high (at `ARTIFACTS_DIR` instead of `ARTIFACTS_DIR/teams`), which would otherwise silently
  // report a team named "teams" holding everyone's files instead of blocking on the mistake.
  if (existsSync(join(storeRoot, "teams"))) {
    throw new Error(`"${storeRoot}" contains a "teams" entry — point ZZ_TENANT_INFO_STORE_ROOT ` +
      'at the "teams" directory itself, not its parent');
  }
  const rows: FileManifestRow[] = [];
  for (const owner of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
    const ownerRoot = join(storeRoot, owner.name);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        const bytes = statSync(full).size;
        const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
        rows.push({ owner: owner.name, path: relative(storeRoot, full).split(sep).join("/"), bytes, hash });
      }
    };
    walk(ownerRoot);
  }
  return rows.sort((a, b) => (a.owner === b.owner ? a.path.localeCompare(b.path) : a.owner.localeCompare(b.owner)));
}

/** A deterministic fingerprint of the whole manifest: the capture timestamp must never be
 *  part of it (I-2's contract: "a changed capture timestamp does not invalidate unchanged
 *  semantic/file hashes"), so this hashes only owner/path/bytes/hash tuples, sorted. */
export function fileManifestHash(rows: readonly FileManifestRow[]): string {
  const canonical = rows.map((r) => JSON.stringify(r)).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function ownerInventory(rows: readonly FileManifestRow[]): { owner_id: string; files: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([owner_id, files]) => ({ owner_id, files }));
}
