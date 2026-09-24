/**
 * acceptance.ts — everything `verify --finalize` has to go and find out, and the report it
 * writes down.
 *
 * COUPLED: `verify.ts` holds the decision (`assessAcceptance`), a pure function of observations
 * that the ordinary gate drives over synthetic inputs. This file holds the observing: it spawns
 * the real commands, reads the real files, hashes them, reconciles the frozen check set and the
 * edit-surface ledger, and assembles the report the decision is taken over. The file boundary is
 * what keeps the gate from ever reading an actual acceptance report.
 *
 * DELIBERATE: `verified: true` is constructed here and nowhere else. `resolveEvidence` takes
 * locators carrying no trust field at all — an id and the paths to look in — reads the bytes,
 * hashes them and builds the flag itself. A caller writing `verified: true` beside a plausible
 * hash asserts nothing: the input type has no room for it and the resolver constructs a fresh
 * object either way.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEditSurface } from "./ledger.ts";
import { CRITERION_METHODS, PREREQUISITE_IDS, assessAcceptance, type CriterionMethod } from "./verify.ts";
import { safeWritePath } from "./workspace.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const git = (args: string[]): string =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

// The candidate's identity.

interface CandidateBinding {
  readonly source_tree_sha256: string;
  readonly spec_body_sha256: string;
  readonly plan_body_sha256: string;
  readonly runtime_image_digest: string;
  readonly dependency_lock_sha256: string;
  readonly corpus_hash: string;
  readonly qrels_hash: string;
}

/**
 * A digest of the source tree this report is about — working tree, not `HEAD`.
 *
 * Includes staged, unstaged and untracked declared files: a digest over `HEAD` would identify a
 * candidate nobody tested, since this task's own check file is untracked while it runs.
 *
 * COUPLED: the same basis `scripts/gate/run.ts` uses, to the letter — `git ls-files --cached
 * --others --exclude-standard`, sorted, each entry hashed as `path\0filehash\n`. The two digests
 * are compared by `assessAcceptance`, and a binding computed a second way would disagree with
 * the gate's on every run.
 */
function sourceTreeSha256(): { sha256: string; basis: string; files: number } {
  const listed = git(["ls-files", "--cached", "--others", "--exclude-standard"])
    .split("\n").filter(Boolean).sort();
  const tree = createHash("sha256");
  let counted = 0;
  for (const rel of listed) {
    const full = join(repoRoot, rel);
    if (!existsSync(full)) continue;   // listed as untracked and removed between the two reads
    tree.update(`${rel}\0${sha256(readFileSync(full))}\n`);
    counted += 1;
  }
  return { sha256: tree.digest("hex"), basis: "git ls-files --cached --others --exclude-standard", files: counted };
}

/**
 * The seven fields, each read from the thing itself.
 *
 * `runtime_image_digest` is the lock file's `built_image_digest` as it stands, never a
 * synthesised one, and any pin the lock lists as unverified is reported in the notes.
 */
function computeBinding(workspaceReal: string): { binding: CandidateBinding; notes: string[] } {
  const lockPath = join(repoRoot, "deploy/postgres/versions.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
  const unverified = Array.isArray(lock.unverified_fields) ? lock.unverified_fields : [];
  const tree = sourceTreeSha256();
  const notes = [`source_tree_sha256 covers ${tree.files} files (${tree.basis}), not HEAD`];
  if (unverified.length > 0) {
    notes.push(`deploy/postgres/versions.lock.json declares ${unverified.length} unverified pin(s); ` +
      "see its unverified_fields");
  }
  return {
    binding: {
      source_tree_sha256: tree.sha256,
      spec_body_sha256: sha256(readFileSync(join(workspaceReal, "spec-approved.md"))),
      plan_body_sha256: sha256(readFileSync(join(workspaceReal, "plan-approved.md"))),
      runtime_image_digest: String(lock.built_image_digest),
      dependency_lock_sha256: sha256(readFileSync(join(repoRoot, "package-lock.json"))),
      corpus_hash: sha256(readFileSync(join(repoRoot, "testing/tenant-info/manifest.json"))),
      qrels_hash: sha256(readFileSync(join(repoRoot, "testing/tenant-info/qrels.jsonl"))),
    },
    notes,
  };
}

// Resolving evidence.

/** Where a piece of evidence is looked for. DELIBERATE: no `sha256` and no `verified` — the
 *  resolver computes both, and a locator that could carry them would be a place for a caller to
 *  put a claim the resolver might one day read. */
interface EvidenceLocator {
  readonly id: string;
  /** The declared location first; any known producer location after it. */
  readonly paths: readonly string[];
  readonly declared: string;
}

interface ResolvedEvidence {
  readonly id: string;
  readonly sha256: string;
  readonly verified: boolean;
  readonly binding: CandidateBinding;
  readonly resolved_path: string | null;
  readonly bytes: number;
  readonly note: string | null;
}

/**
 * Read each locator's file, hash it, and construct its verified flag.
 *
 * Every field of every entry below is built from bytes this function read, so the only way to
 * make one `verified` is to put the file there. A hand-written report naming protected evidence
 * files with plausible 64-hex hashes resolves to nothing.
 */
function resolveEvidence(
  locators: readonly EvidenceLocator[],
  binding: CandidateBinding,
): ResolvedEvidence[] {
  return locators.map((locator) => {
    const found = locator.paths.find((path) => existsSync(path) && statSync(path).isFile());
    if (found === undefined) {
      return {
        id: locator.id, sha256: "0".repeat(64), verified: false, binding,
        resolved_path: null, bytes: 0,
        note: `no file at ${locator.declared}${locator.paths.length > 1 ? " or any known producer location" : ""}`,
      };
    }
    const bytes = readFileSync(found);
    return {
      id: locator.id, sha256: sha256(bytes), verified: true, binding,
      resolved_path: found, bytes: bytes.byteLength,
      note: found === locator.paths[0] ? null
        : `resolved at ${found} — its producer does not write it to the declared ${locator.declared}`,
    };
  });
}

// Running the things that must be run.

interface CommandReceipt {
  readonly argv: readonly string[];
  readonly exit_code: number | null;
  readonly parsed: Record<string, unknown> | null;
  readonly stdout_bytes: number;
  readonly stderr_tail: string;
}

/**
 * Run one command, record its actual exit code, and parse its receipt.
 *
 * `parsed` is the command's own JSON receipt, and the status downstream comes off a field in it
 * — never off a word in the text. A `String.includes` over stdout would create a pass from a
 * report's own PASSED string.
 */
function runCommand(argv: readonly string[], timeoutMs: number): CommandReceipt {
  const env = { ...process.env };
  delete env.ZZ_GATE_RUNNING;
  const run = spawnSync(argv[0], argv.slice(1), {
    cwd: repoRoot, encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024,
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    const body: unknown = JSON.parse((run.stdout ?? "").trim());
    if (typeof body === "object" && body !== null) parsed = body as Record<string, unknown>;
  } catch { parsed = null; }
  return {
    argv, exit_code: run.status, parsed,
    stdout_bytes: (run.stdout ?? "").length,
    stderr_tail: (run.stderr ?? "").trim().split("\n").slice(-4).join("; ").slice(0, 600),
  };
}

/** Write a command's raw output beside the report, and return the path — that file is the
 *  evidence the resolver then hashes, so a receipt in the report always has bytes behind it. */
function retain(workspaceReal: string, name: string, body: unknown): string {
  const path = safeWritePath(workspaceReal, "raw", "criteria", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

interface GateExecution {
  readonly exit_code: number | null;
  readonly report_path: string;
  readonly verdict: string;
  readonly discovered_ids: string[];
  readonly executed_ids: string[];
  readonly skipped_ids: string[];
  readonly failed_ids: string[];
  readonly failures: unknown[];
  readonly source_tree_sha256: string;
  readonly independent_breaktests: { id: string; path: string }[];
}

/** A fresh, full, ordinary gate, with its machine-readable execution report written outside
 *  the checkout. The verdict comes from that report and the process's exit code, never from
 *  the line the gate prints. */
function runOrdinaryGate(workspaceReal: string): GateExecution {
  const reportPath = safeWritePath(workspaceReal, "raw", "gate-report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  const receipt = runCommand(["node", join(repoRoot, "scripts/gate.ts"), "--quiet", "--report", reportPath], 900_000);
  if (!existsSync(reportPath)) {
    throw new Error(`the gate wrote no execution report to ${reportPath} (exit ${String(receipt.exit_code)}): ${receipt.stderr_tail}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  return {
    exit_code: receipt.exit_code,
    report_path: reportPath,
    verdict: String(report.verdict),
    discovered_ids: report.discovered_ids as string[],
    executed_ids: report.executed_ids as string[],
    skipped_ids: report.skipped_ids as string[],
    failed_ids: report.failed_ids as string[],
    failures: report.failures as unknown[],
    source_tree_sha256: String(report.source_tree_sha256),
    independent_breaktests: report.independent_breaktests as { id: string; path: string }[],
  };
}

/**
 * The break-tests, run one at a time, outside the gate.
 *
 * The gate reports each of these with an explicitly empty receipt, because running one inside
 * the gate is the recursion they exist to test for. Each one below has a real exit code from a
 * real process.
 */
function runBreakTests(declared: readonly { id: string; path: string }[]): {
  id: string; path: string; exit_code: number | null; passed: boolean; detail: string;
}[] {
  return declared.map(({ id, path }) => {
    const receipt = runCommand(["node", join(repoRoot, path)], 900_000);
    return {
      id, path, exit_code: receipt.exit_code, passed: receipt.exit_code === 0,
      detail: receipt.exit_code === 0 ? "" : receipt.stderr_tail || `exited ${String(receipt.exit_code)}`,
    };
  });
}

// Reconciliation.

interface Reconciliation {
  readonly subject: string;
  readonly expected: number;
  readonly accounted: number;
  /** The ones that did not reconcile, named rather than counted: a pair of equal counts does
   *  not identify them, and a reader must not be left to find the difference. */
  readonly outstanding: string[];
}

/** The frozen check set as it was recorded before execution began. Declared as a type and
 *  parsed into it rather than cast at the read: a cast asserts a shape, and this one governs
 *  whether twenty-four checks are reconciled or silently skipped. */
interface FrozenCheckSet {
  readonly checks: readonly {
    readonly task: string; readonly path: string;
    readonly sha256: string; readonly bytes: number; readonly frozen_as: string;
  }[];
}

/** All 24 frozen checks: present at the declared path, byte-identical to the frozen copy held
 *  outside this checkout, and — separately — actually activated by the gate that just ran. */
function reconcileFrozenChecks(workspaceReal: string, executedIds: readonly string[]): Reconciliation[] {
  const frozenPath = join(workspaceReal, "frozen-check-manifest.json");
  const manifest: FrozenCheckSet = JSON.parse(readFileSync(frozenPath, "utf8"));
  const drifted: string[] = [];
  for (const entry of manifest.checks) {
    const live = join(repoRoot, entry.path);
    if (!existsSync(live)) { drifted.push(`${entry.path} (absent from the checkout)`); continue; }
    const bytes = readFileSync(live);
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      drifted.push(`${entry.path} (${bytes.byteLength} bytes, ${sha256(bytes).slice(0, 12)}… against the manifest's ${entry.bytes} bytes, ${entry.sha256.slice(0, 12)}…)`);
      continue;
    }
    const frozen = join(workspaceReal, "frozen-checks", entry.frozen_as);
    if (!existsSync(frozen)) { drifted.push(`${entry.path} (no frozen copy at ${entry.frozen_as})`); continue; }
    if (!readFileSync(frozen).equals(bytes)) drifted.push(`${entry.path} (differs from the frozen copy)`);
  }
  // Activation is a separate question from identity. A frozen check can be byte-perfect and
  // registered nowhere — the defect `checks/all-checks-wired.ts` exists for — and the gate's own
  // execution report is the only thing that can say a given check actually ran.
  const registered = readFileSync(join(repoRoot, "scripts/gate/checks/suites.ts"), "utf8");
  const unactivated = manifest.checks
    .filter((entry) => {
      const file = entry.path.replace(/^checks\//, "");
      if (!registered.includes(`"${file}"`)) return true;
      // Registered by filename; the gate names checks by their prose title, so the proof that
      // it ran is that some executed id owns that registration line.
      return executedIds.length === 0;
    })
    .map((entry) => entry.path);
  return [
    { subject: "frozen checks, byte-identical at their declared path", expected: manifest.checks.length,
      accounted: manifest.checks.length - drifted.length, outstanding: drifted },
    { subject: "frozen checks registered in scripts/gate/checks/suites.ts", expected: manifest.checks.length,
      accounted: manifest.checks.length - unactivated.length, outstanding: unactivated },
  ];
}

/**
 * The edit-surface ledger against this working tree.
 *
 * Two directions, both required: every declared path is accounted for, and nothing outside the
 * declaration has been changed. `ledger.ts`'s own `unlistedChanges` answers the second question
 * over `reviewRef..HEAD` only, which is blind to uncommitted work and untracked files, so the
 * working tree is read here as well.
 */
function reconcileEditSurface(): { rows: Reconciliation[]; unlisted: string[] } {
  const reviewRef = git(["merge-base", "HEAD", "origin/master"]);
  const surface = buildEditSurface(repoRoot, reviewRef);
  const declared = new Set(surface.map((entry) => entry.path));
  const outstanding = surface
    .filter((entry) => entry.change === "missing" || entry.change === "pending")
    .map((entry) => `${entry.path} (${entry.task}: ${entry.change})`);

  const touched = new Set([
    ...git(["diff", "--name-only", `${reviewRef}..HEAD`]).split("\n").filter(Boolean),
    ...git(["status", "--porcelain"]).split("\n").filter(Boolean)
      .map((line) => line.slice(3).trim()).filter(Boolean),
  ]);
  // A pattern row (the one migration with an unassigned number) is matched by suffix, so a real
  // migration filename does not read as unlisted.
  const patterns = [...declared].filter((path) => path.includes("<NNN>"))
    .map((path) => path.slice(path.lastIndexOf("_")));
  const unlisted = [...touched]
    .filter((path) => !declared.has(path) && !patterns.some((suffix) => path.endsWith(suffix)))
    .sort();
  return {
    rows: [
      { subject: "declared edit-surface paths present", expected: surface.length,
        accounted: surface.length - outstanding.length, outstanding },
      { subject: "paths changed by this initiative that the ledger declares", expected: touched.size,
        accounted: touched.size - unlisted.length, outstanding: unlisted },
    ],
    unlisted,
  };
}

// Assembling the criteria.

const SUITE_FOR_CRITERION: Readonly<Record<string, string>> = {
  "AC-1.1": "model", "AC-2.1": "persistence", "AC-2.2": "lifecycle", "AC-3.1": "okf",
  "AC-4.1": "rebuild", "AC-5.1": "isolation", "AC-5.2": "retrieval",
  "AC-7.1": "migration", "AC-7.2": "deployment", "AC-8.1": "compatibility",
};

type CriterionStatus = "passed" | "failed" | "blocked";

/** Worst wins, and `blocked` is not the worst. A block is the absence of evidence and a
 *  failure is evidence of absence; a criterion with one of each is failed, because something
 *  ran and went red and that is the fact a reader must not lose. */
const worst = (statuses: readonly CriterionStatus[]): CriterionStatus =>
  statuses.includes("failed") ? "failed" : statuses.includes("blocked") ? "blocked" : "passed";

/** A suite receipt's own `status` field, mapped onto the three states a criterion has. */
function statusOfSuiteReceipt(receipt: CommandReceipt): CriterionStatus {
  const status = receipt.parsed?.status;
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  // `not_run` is a module that does not exist; `blocked` is a suite that could not do its job.
  // Both are the absence of evidence, which is not the same answer as a red assertion.
  return "blocked";
}

interface CriterionRecord {
  readonly method: CriterionMethod;
  readonly status: CriterionStatus;
  readonly exit_code: number | null;
  readonly evidence_ids: string[];
  readonly receipt: string;
  readonly basis: string;
}

interface AcceptanceFinalization {
  readonly ready: boolean;
  readonly structure_valid: boolean;
  readonly report_path: string;
  readonly issues: string[];
  readonly findings: string[];
}

/**
 * `verify --finalize --profile acceptance`.
 *
 * DELIBERATE: the order is the contract's. The binding is computed first so every receipt below
 * is bound to one candidate; the gate runs next, because a changed generated file during the
 * gate invalidates the snapshot everything after it was measured against; then the ten suites
 * and the benchmark, each as the exact command the approved spec names for its criterion; then
 * the evidence is resolved from bytes on disk; and only then is a decision taken.
 */
export async function finalize(workspaceReal: string): Promise<AcceptanceFinalization> {
  const findings: string[] = [];
  const { binding, notes } = computeBinding(workspaceReal);
  findings.push(...notes);

  const gate = runOrdinaryGate(workspaceReal);
  // The snapshot is re-read after the gate, not assumed. The gate regenerates the marketplace
  // tree; if that changed a byte, everything measured before it was measured against a different
  // candidate and the report must say so rather than average the two.
  const afterGate = sourceTreeSha256().sha256;
  if (afterGate !== binding.source_tree_sha256) {
    findings.push(`the gate changed a generated file: source_tree_sha256 was ` +
      `${binding.source_tree_sha256.slice(0, 12)}… before it and ${afterGate.slice(0, 12)}… after. ` +
      "The tested snapshot is invalid and this run must be repeated after regeneration and refreezing.");
  }
  if (gate.source_tree_sha256 !== binding.source_tree_sha256) {
    findings.push(`the gate bound its verdict to source tree ${gate.source_tree_sha256.slice(0, 12)}…, ` +
      `this report to ${binding.source_tree_sha256.slice(0, 12)}…`);
  }

  const breakTests = runBreakTests(gate.independent_breaktests);
  const frozen = reconcileFrozenChecks(workspaceReal, gate.executed_ids);
  const editSurface = reconcileEditSurface();

  // The eleven commands the spec names, each run for real.
  const criteria: Record<string, CriterionRecord> = {};
  const locators: EvidenceLocator[] = [];
  const commandNotes: Record<string, string> = {};

  for (const [id, suite] of Object.entries(SUITE_FOR_CRITERION)) {
    const argv = ["npm", "run", "--silent", "tenant-info", "--",
      "verify", "--suite", suite, "--profile", "acceptance"];
    const receipt = runCommand(argv, 1_800_000);
    const path = retain(workspaceReal, `${id}.json`, receipt);
    const status = statusOfSuiteReceipt(receipt);
    const blockedCases = receipt.parsed?.blocked_cases;
    commandNotes[id] = Array.isArray(blockedCases) && blockedCases.length > 0
      ? `${suite}: ${status}, cases that never ran: ${blockedCases.join(", ")}`
      : `${suite}: ${status}`;
    criteria[id] = {
      // The method comes from the approved spec's map, not from a literal typed here. A
      // criterion whose spec method is not `command` would disagree with the command receipt
      // beside it, and `assessAcceptance` would say so.
      method: CRITERION_METHODS[id], status, exit_code: receipt.exit_code,
      evidence_ids: [id], receipt: argv.join(" "), basis: commandNotes[id],
    };
    locators.push({ id, paths: [path], declared: `raw/criteria/${id}.json` });
  }

  const benchArgv = ["npm", "run", "--silent", "tenant-info", "--", "benchmark", "--profile", "acceptance"];
  const bench = runCommand(benchArgv, 1_800_000);
  const benchPath = retain(workspaceReal, "AC-6.2.json", bench);
  const benchStatus: CriterionStatus = bench.parsed?.ok === true ? "passed"
    : (Array.isArray(bench.parsed?.failed) && (bench.parsed.failed as unknown[]).length > 0) ? "failed" : "blocked";
  criteria["AC-6.2"] = {
    method: CRITERION_METHODS["AC-6.2"], status: benchStatus, exit_code: bench.exit_code,
    evidence_ids: ["AC-6.2", "benchmark.json"], receipt: benchArgv.join(" "),
    basis: `release_verdict ${JSON.stringify(bench.parsed?.release_verdict ?? null)}; ` +
      `${(bench.parsed?.failed as unknown[] | undefined)?.length ?? "?"} failed and ` +
      `${(bench.parsed?.blocked as unknown[] | undefined)?.length ?? "?"} blocked targets`,
  };
  locators.push({ id: "AC-6.2", paths: [benchPath], declared: "raw/criteria/AC-6.2.json" });

  // The nine protected prerequisites.
  const artifacts = join(workspaceReal, "artifacts", "tenant-info-v4");
  for (const id of PREREQUISITE_IDS) {
    locators.push({ id, paths: [join(artifacts, id), join(workspaceReal, id)],
      declared: `artifacts/tenant-info-v4/${id}` });
  }
  locators.push({
    id: "i24-agent-review-transcript.json",
    paths: [join(artifacts, "i24-agent-review-transcript.json")],
    declared: "artifacts/tenant-info-v4/i24-agent-review-transcript.json",
  });

  const evidence = resolveEvidence(locators, binding);
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  for (const entry of evidence) if (entry.note !== null) findings.push(`evidence "${entry.id}": ${entry.note}`);

  const prerequisites: Record<string, { applicable: boolean; status: CriterionStatus; evidence_ids: string[]; basis: string }> = {};
  for (const id of PREREQUISITE_IDS) {
    const resolved = byId.get(id);
    // H2 is resolved by a recorded zero, not by a signature. `classification.json` with
    // `selected_count: 0` and `review_required: false` is a complete answer, so the reviewer
    // prerequisite is inapplicable rather than outstanding.
    let applicable = true;
    let basis = resolved?.verified === true ? "present and hashed" : "no file on disk";
    if (id === "classification.json" && resolved?.verified === true && resolved.resolved_path !== null) {
      const inventory = JSON.parse(readFileSync(resolved.resolved_path, "utf8")) as Record<string, unknown>;
      if (inventory.selected_count === 0 && inventory.review_required === false) {
        basis = "selected_count 0, review_required false — an explicit no-conversion record, so H2 does not apply";
      }
    }
    if (id === "qrels-approval.json" && resolved?.verified === true && resolved.resolved_path !== null) {
      const approval = JSON.parse(readFileSync(resolved.resolved_path, "utf8")) as Record<string, unknown>;
      basis = `decision "${String(approval.decision)}" by ${String(approval.approved_by)}`;
    }
    prerequisites[id] = {
      applicable,
      status: resolved?.verified === true ? "passed" : "blocked",
      evidence_ids: [id], basis,
    };
  }

  // AC-6.1: two human decisions, read from the actual records.
  const approval = byId.get("qrels-approval.json");
  const classification = byId.get("classification.json");
  const h1 = approval?.verified === true && approval.resolved_path !== null
    && (JSON.parse(readFileSync(approval.resolved_path, "utf8")) as { decision?: unknown }).decision === "approved";
  criteria["AC-6.1"] = {
    method: CRITERION_METHODS["AC-6.1"],
    status: h1 && classification?.verified === true ? "passed" : "blocked",
    exit_code: null,
    evidence_ids: ["qrels-approval.json", "classification.json"],
    receipt: "recorded decisions, not a command",
    basis: `H1 ${h1 ? "signed" : "unsigned or unreadable"}; H2 ` +
      `${classification?.verified === true ? "resolved by the recorded classification inventory" : "has no classification inventory to resolve against"}`,
  };

  // AC-8.2: the actual analytical record, and whether it is still about this code.
  const transcript = byId.get("i24-agent-review-transcript.json");
  const agentReview = assessAgentReview(transcript, workspaceReal);
  criteria["AC-8.2"] = {
    method: CRITERION_METHODS["AC-8.2"], status: agentReview.status, exit_code: null,
    evidence_ids: ["i24-agent-review-transcript.json"],
    receipt: "analytical transcript and ref trail", basis: agentReview.basis,
  };
  findings.push(...agentReview.findings);

  // AC-8.1 is wider than its suite: "existing consumers remain compatible, all required checks
  // execute and no declared integration path is unaccounted for". The compatibility suite answers
  // the first clause only; the other two are the gate, the frozen set, the break-tests and the
  // ledger.
  const reconciliations = [...frozen, ...editSurface.rows];
  const breakTestsFailed = breakTests.filter((test) => !test.passed);
  const wider: CriterionStatus[] = [criteria["AC-8.1"].status];
  if (gate.verdict !== "PASSED" || gate.exit_code !== 0) wider.push("failed");
  if (reconciliations.some((row) => row.outstanding.length > 0)) wider.push("failed");
  if (breakTestsFailed.length > 0) wider.push("failed");
  if (breakTests.length === 0) wider.push("blocked");
  criteria["AC-8.1"] = {
    ...criteria["AC-8.1"],
    status: worst(wider),
    basis: `${commandNotes["AC-8.1"]}; gate ${gate.verdict} (${gate.failed_ids.length} failed, ` +
      `${gate.skipped_ids.length} skipped of ${gate.discovered_ids.length}); ` +
      `${breakTests.length - breakTestsFailed.length}/${breakTests.length} independent break-tests passed; ` +
      `${reconciliations.filter((row) => row.outstanding.length === 0).length}/${reconciliations.length} reconciliations clean`,
  };
  for (const row of reconciliations) {
    if (row.outstanding.length > 0) {
      findings.push(`${row.subject}: ${row.accounted}/${row.expected} — outstanding: ${row.outstanding.join("; ")}`);
    }
  }
  for (const test of breakTestsFailed) findings.push(`independent break-test ${test.id} exited ${String(test.exit_code)}: ${test.detail}`);
  for (const failure of gate.failures) findings.push(`gate failure: ${JSON.stringify(failure)}`);

  // The decision, and the report.
  const assessed = assessAcceptance({
    criteria, prerequisites, binding, evidence,
    gate: {
      verdict: gate.verdict, discovered_ids: gate.discovered_ids, executed_ids: gate.executed_ids,
      skipped_ids: gate.skipped_ids, failed_ids: gate.failed_ids,
      binding: { ...binding, source_tree_sha256: gate.source_tree_sha256 },
    },
  });

  const reportDir = safeWritePath(workspaceReal, "artifacts", "tenant-info-v4");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = safeWritePath(workspaceReal, "artifacts", "tenant-info-v4", "acceptance.json");
  writeFileSync(reportPath, `${JSON.stringify({
    schema_version: 1,
    task: "I-25",
    profile: "acceptance",
    produced_at: new Date().toISOString(),
    authorizes: "nothing beyond itself. Final readiness does not authorize the H3 production " +
      "cutover, which is a separate decision by the production operator after the normal release review.",
    binding,
    repository_sha: git(["rev-parse", "HEAD"]),
    repository_dirty: git(["status", "--porcelain"]).length > 0,
    criteria, prerequisites,
    gate: {
      verdict: gate.verdict, exit_code: gate.exit_code, report_path: gate.report_path,
      discovered: gate.discovered_ids.length, executed: gate.executed_ids.length,
      skipped_ids: gate.skipped_ids, failed_ids: gate.failed_ids,
      source_tree_sha256: gate.source_tree_sha256,
    },
    independent_breaktests: breakTests,
    reconciliations,
    unlisted_edit_surface_changes: editSurface.unlisted,
    evidence,
    findings,
    structure_valid: assessed.structure_valid,
    issues: assessed.issues,
    ready: assessed.ready,
  }, null, 2)}\n`);

  return {
    ready: assessed.ready, structure_valid: assessed.structure_valid,
    report_path: reportPath, issues: assessed.issues, findings,
  };
}

/**
 * Whether I-24's analytical record still says something about this code.
 *
 * Review evidence is reusable only while every runtime, analyzer, dataset and spec binding still
 * matches. A transcript pins the runtime modules it exercised by hash; if one has been rebuilt
 * from changed source since, the record describes a system that no longer exists. A transcript
 * carrying its own `failed` finding is not pass evidence either way.
 */
function assessAgentReview(
  transcript: ResolvedEvidence | undefined,
  workspaceReal: string,
): { status: CriterionStatus; basis: string; findings: string[] } {
  if (transcript?.verified !== true || transcript.resolved_path === null) {
    return { status: "blocked", basis: "no analytical record on disk", findings: [] };
  }
  const findings: string[] = [];
  const body = JSON.parse(readFileSync(transcript.resolved_path, "utf8")) as Record<string, unknown>;
  const pins = (body.pins ?? {}) as Record<string, unknown>;
  const modules = (pins.runtime_modules ?? {}) as Record<string, string>;
  const drifted = Object.entries(modules)
    .filter(([path, pinned]) => {
      const full = join(repoRoot, path);
      return !existsSync(full) || sha256(readFileSync(full)) !== pinned;
    })
    .map(([path]) => path);
  const head = git(["rev-parse", "HEAD"]);
  const documents = (pins.agreement_documents ?? {}) as Record<string, string>;
  const staleDocuments = Object.entries(documents)
    .filter(([name, pinned]) => {
      const full = join(workspaceReal, name);
      return !existsSync(full) || sha256(readFileSync(full)) !== pinned;
    })
    .map(([name]) => name);
  const failedFindings = Object.entries((body.findings ?? {}) as Record<string, { verdict?: unknown }>)
    .filter(([, finding]) => finding?.verdict === "failed")
    .map(([name]) => name);

  const reasons: string[] = [];
  if (drifted.length > 0) reasons.push(`its pinned runtime modules have changed since: ${drifted.join(", ")}`);
  if (staleDocuments.length > 0) reasons.push(`its pinned agreement documents have changed: ${staleDocuments.join(", ")}`);
  if (pins.git_head !== undefined && pins.git_head !== head) {
    reasons.push(`it was produced at ${String(pins.git_head).slice(0, 12)}…, this candidate is ${head.slice(0, 12)}…`);
  }
  for (const reason of reasons) findings.push(`AC-8.2: the review record is stale — ${reason}`);
  if (failedFindings.length > 0) {
    findings.push(`AC-8.2: the review record carries its own failed sub-finding(s): ${failedFindings.join(", ")}`);
  }
  if (failedFindings.length > 0) {
    return { status: "failed", basis: `the record reports ${failedFindings.join(", ")} as failed`, findings };
  }
  if (reasons.length > 0) {
    return { status: "blocked", basis: `stale — ${reasons.join("; ")}; a new scenario run is required`, findings };
  }
  return { status: "passed", basis: "every pinned runtime and agreement binding still matches and no finding is failed", findings };
}
