/**
 * verify.ts — resolves a suite name to its module, runs a suite module once it is known to
 * be ready, and finalizes an acceptance run across all ten.
 *
 * `resolveSuite` is a plain function of its two arguments and nothing else: no argv, no
 * environment, no filesystem read of its own. A check gets to hand it a fixed
 * `availableNames` and get a fixed answer back, regardless of what this repository's
 * `testing/tenant-info/` actually contains at the moment the check runs — and `cli.ts`'s own
 * per-suite dispatch calls this same function rather than re-deciding readiness its own way.
 * Everything that DOES read the filesystem or write a receipt is a separate, explicitly-named
 * function below it, so importing this module, on its own, does nothing.
 */
import { pathToFileURL } from "node:url";

import { suiteModulePath } from "./suites.ts";

/** Whether `name`'s module is on disk, judged only against `availableNames` — never a
 *  filesystem read of its own. `name` need not even be one of the ten canonical suites; a
 *  name outside that list simply has no module and resolves `not_run`, same as a canonical
 *  one whose file has not been written yet. Distinguishing "not a suite at all" from "a
 *  suite with no module yet" is the CLI's job at the UNKNOWN_SUITE boundary, not this one's. */
export function resolveSuite(name: string, availableNames: readonly string[]) {
  const module = suiteModulePath(name);
  return availableNames.includes(name)
    ? { status: "ready" as const, module }
    : { status: "not_run" as const, module };
}

/** The two profiles the spec declares for `verify`. It lives here rather than in `cli.ts`
 *  because the profile's MEANING is enforced here — `cli.ts` only parses the flag. */
export type VerifyProfile = "integration" | "acceptance";

interface SuiteOutcome {
  suite: string;
  status: "passed" | "failed" | "blocked" | "not_run";
  module: string;
  partial: boolean;
  detail?: unknown;
  /** Named at `--profile acceptance` when a case did not run — see `blockedAtAcceptance`. */
  blocked_cases?: string[];
}

/**
 * The names of every case a suite reported `not_run`, or `null` when its detail carries no
 * readable case map at all.
 *
 * `null` IS NOT "nothing was skipped". A suite whose receipt cannot be read case-by-case
 * cannot demonstrate it ran a complete required set, and at the acceptance profile that is
 * the same answer as having skipped one. Returning `[]` for an unreadable receipt would make
 * the weakest suite in the repository the easiest one to pass.
 */
function notRunCases(detail: unknown): string[] | null {
  if (typeof detail !== "object" || detail === null) return null;
  const cases = (detail as { cases?: unknown }).cases;
  if (typeof cases !== "object" || cases === null) return null;
  const out: string[] = [];
  for (const [name, value] of Object.entries(cases as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) return null;
    const status = (value as { status?: unknown }).status;
    if (typeof status !== "string") return null;
    if (status === "not_run") out.push(name);
  }
  return out;
}

/**
 * `--profile acceptance` FORBIDS A SUITE FROM PASSING ON CASES IT DID NOT RUN.
 *
 * The spec's CLI contract is explicit: "`--profile acceptance` forbids case restrictions and
 * runs the complete required suite. Partial cases never pass a whole business AC." Every one
 * of the thirteen acceptance criteria names `verify --suite <name> --profile acceptance` as
 * its evidence command, so this predicate is what stands between a criterion's evidence and a
 * green tick it did not earn.
 *
 * WHAT THIS CORRECTS. Until this existed, `--profile` was parsed, validated and then never
 * threaded anywhere — `runReadySuite` called `mod.run({ cases })` identically for both
 * profiles. Suites deliberately treat `not_run` as non-blocking so an honestly-unreachable
 * live database does not drag down the offline cases a checkout CAN prove, which is right at
 * the integration profile and exactly wrong at the acceptance one: it made `passed` the
 * default answer for a case that never executed.
 *
 * `blocked`, NOT `failed`, and the distinction is the point. A failure is an assertion that
 * ran and went red — a fact about the system. A block is the absence of evidence — a fact
 * about the run. Collapsing them would let a reader of `acceptance.json` mistake "we never
 * stood up PostgreSQL 17" for "isolation is broken".
 */
function blockedAtAcceptance(outcome: SuiteOutcome): SuiteOutcome {
  if (outcome.status !== "passed") return outcome;
  const notRun = notRunCases(outcome.detail);
  if (notRun === null) {
    return { ...outcome, status: "blocked", blocked_cases: ["<the receipt carries no readable per-case status>"] };
  }
  if (notRun.length === 0) return outcome;
  return { ...outcome, status: "blocked", blocked_cases: notRun };
}

/** A suite module's own shape: it exposes `run`, takes whatever case subset it was asked
 *  for, and reports whether it passed. Nothing about resolving or dispatching a suite
 *  assumes more than that one export exists. */
interface SuiteModule {
  run(opts: { cases?: string }):
    | Promise<{ passed: boolean; detail?: unknown }>
    | { passed: boolean; detail?: unknown };
}

/**
 * Runs a suite already known to be `ready` — dynamic-imports its module and calls `run`.
 * Shared by `cli.ts`'s per-suite dispatch and this module's own `finalize`, so there is one
 * place that knows how a suite module is actually invoked.
 */
export async function runReadySuite(
  name: string,
  modulePath: string,
  cases: string | undefined,
  profile: VerifyProfile,
): Promise<SuiteOutcome> {
  const mod = (await import(pathToFileURL(modulePath).href)) as SuiteModule;
  const outcome = await mod.run({ cases });
  // A SUITE THAT SAYS IT IS BLOCKED IS BLOCKED, NOT FAILED — at either profile.
  //
  // A suite reports `passed: false` for two different reasons and says which in its own
  // detail: an assertion ran and went red, or the suite could not do its job at all and
  // declares `detail.status === "blocked"`. Reading only the boolean collapsed those, and the
  // collapse was visible: `verify --suite deployment` reported "failed" on a checkout where
  // nothing was wrong, because `versions.lock.json` still carries the unverified pins I-5
  // deliberately recorded as placeholders. Nobody reading that word would have guessed it
  // meant "the operator has not resolved the image pins yet".
  //
  // The same distinction `blockedAtAcceptance` draws below, applied one level up. A failure is
  // a fact about the system; a block is a fact about the run.
  const declaredBlocked = typeof outcome.detail === "object" && outcome.detail !== null
    && (outcome.detail as { status?: unknown }).status === "blocked";
  const result: SuiteOutcome = {
    suite: name,
    module: modulePath,
    partial: cases !== undefined,
    status: outcome.passed ? "passed" : (declaredBlocked ? "blocked" : "failed"),
    detail: outcome.detail,
  };
  return profile === "acceptance" ? blockedAtAcceptance(result) : result;
}

// ───────────────────────────── the acceptance decision itself ─────────────────────────────
//
// A PURE FUNCTION OF OBSERVATIONS, and everything that could make it impure lives in
// `acceptance.ts`. It reads no file, spawns nothing and resolves nothing: hand it a set of
// observations and it says whether they add up to a release. That separation is what lets
// `checks/acceptance-covers-every-criterion.ts` drive it over synthetic inputs inside the
// ordinary gate without the gate ever touching, or depending on, the actual acceptance report.
//
// WHAT IT IS NOT. It cannot tell you that this delivery is ready, because it cannot tell you
// that any of the evidence it was handed exists. `verified: true` on an evidence entry is a
// CONSTRUCTED FACT — `resolveEvidence` in `acceptance.ts` reads the file, hashes it and builds
// the flag — and a caller who simply writes `verified: true` beside a plausible hash has
// asserted something this function has no way to check and no business believing on its own.
// The finalizer never lets a caller's assertion reach here; the resolver is the only producer.

/** The three ways a criterion can be established. `command` is a program that ran and exited;
 *  `human` is a named person's recorded decision; `agent-review` is an analytical transcript. */
export type CriterionMethod = "command" | "human" | "agent-review";

/**
 * THE METHOD EVERY CRITERION IS PROVED BY, transcribed from `spec-approved.md`'s `acceptance:`
 * block, and read from HERE rather than from the report being assessed.
 *
 * "Map methods from the approved spec, never from a caller-supplied method field" is the
 * contract's wording, and this constant is the whole of that sentence. A report's own `method`
 * is not an input to the decision — it is COMPARED against this map, and a disagreement is an
 * issue. Otherwise AC-6.1, which the spec says a person must sign, could be re-declared
 * `command` by the very report claiming to have satisfied it, and a green exit code from any
 * program at all would stand in for the signature.
 */
export const CRITERION_METHODS: Readonly<Record<string, CriterionMethod>> = {
  "AC-1.1": "command", "AC-2.1": "command", "AC-2.2": "command", "AC-3.1": "command",
  "AC-4.1": "command", "AC-5.1": "command", "AC-5.2": "command",
  "AC-6.1": "human",
  "AC-6.2": "command", "AC-7.1": "command", "AC-7.2": "command", "AC-8.1": "command",
  "AC-8.2": "agent-review",
};

/** The spec's ten stable protected evidence reports, less `acceptance.json` — which is the
 *  report being assessed and cannot be its own prerequisite. */
export const PREREQUISITE_IDS = [
  "baseline.json", "extension-features.json", "qrels-approval.json", "classification.json",
  "migration.json", "parity.json", "restore.json", "cutover-rehearsal.json", "benchmark.json",
] as const;

/** The seven fields that identify WHICH candidate a piece of evidence is about. Every one of
 *  them must agree across the report's own binding, the gate's, and each evidence entry's —
 *  evidence bound to a different source tree is evidence about a different delivery. */
const BINDING_FIELDS = [
  "source_tree_sha256", "spec_body_sha256", "plan_body_sha256", "runtime_image_digest",
  "dependency_lock_sha256", "corpus_hash", "qrels_hash",
] as const;

const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CRITERION_STATUSES = ["passed", "failed", "blocked"];

interface AcceptanceAssessment {
  /** Whether the report has the SHAPE a report must have. A stage report missing nine of its
   *  thirteen criteria is structurally valid and not ready; a report whose criteria are a
   *  string is neither. */
  readonly structure_valid: boolean;
  readonly ready: boolean;
  readonly issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every way `value` fails to be a binding, named one at a time rather than collapsed into a
 *  boolean — "the binding is wrong" sends a reader to look at seven fields. */
function bindingProblems(label: string, value: unknown): string[] {
  if (!isRecord(value)) return [`${label} is not an object`];
  const problems: string[] = [];
  for (const field of BINDING_FIELDS) {
    const held = value[field];
    if (typeof held !== "string") { problems.push(`${label}.${field} is missing`); continue; }
    const shaped = field === "runtime_image_digest" ? IMAGE_DIGEST.test(held) : HEX64.test(held);
    if (!shaped) {
      problems.push(`${label}.${field} is not ${field === "runtime_image_digest"
        ? 'a "sha256:"-prefixed digest' : "64 lowercase hex characters"}`);
    }
  }
  return problems;
}

const bindingsAgree = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  BINDING_FIELDS.filter((field) => a[field] !== b[field]);

/**
 * Names in `discovered` that `executed` does not account for, counted rather than set-tested.
 *
 * THE SAME ARITHMETIC `scripts/gate/run.ts` USES, for the same reason: two checks registered
 * under one name would let a set-membership test report full coverage while one of them never
 * ran. "Every declared check was activated ... cannot be inferred from equal counts alone" is
 * the contract's phrasing and this is its executable half — the names are compared, and the
 * multiplicity of each name with them.
 */
function unaccountedFor(discovered: readonly string[], executed: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const name of executed) remaining.set(name, (remaining.get(name) ?? 0) + 1);
  const missing: string[] = [];
  for (const name of discovered) {
    const left = remaining.get(name) ?? 0;
    if (left > 0) remaining.set(name, left - 1);
    else missing.push(name);
  }
  return missing;
}

/** The report's shape, checked before any of it is believed. Returns the problems that make it
 *  unreadable — NOT the ones that merely make it not ready. A criterion that is absent, failed
 *  or blocked is a readable report saying something true and unwelcome. */
function structureProblems(report: Record<string, unknown>): string[] {
  const problems = bindingProblems("binding", report.binding);
  const { criteria, prerequisites, gate, evidence } = report;
  if (!isRecord(criteria)) problems.push("criteria is not an object");
  else {
    for (const [id, record] of Object.entries(criteria)) {
      if (CRITERION_METHODS[id] === undefined) { problems.push(`criteria["${id}"] is not a criterion this spec declares`); continue; }
      if (!isRecord(record)) { problems.push(`criteria["${id}"] is not an object`); continue; }
      if (typeof record.method !== "string") problems.push(`criteria["${id}"].method is missing`);
      if (typeof record.status !== "string" || !CRITERION_STATUSES.includes(record.status)) {
        problems.push(`criteria["${id}"].status must be one of ${CRITERION_STATUSES.join("/")}`);
      }
      if (record.exit_code !== null && typeof record.exit_code !== "number") {
        problems.push(`criteria["${id}"].exit_code must be a number or null`);
      }
      if (!Array.isArray(record.evidence_ids)) problems.push(`criteria["${id}"].evidence_ids is not an array`);
    }
  }
  if (!isRecord(prerequisites)) problems.push("prerequisites is not an object");
  else {
    for (const [id, record] of Object.entries(prerequisites)) {
      if (!isRecord(record)) { problems.push(`prerequisites["${id}"] is not an object`); continue; }
      if (typeof record.applicable !== "boolean") problems.push(`prerequisites["${id}"].applicable is not a boolean`);
      if (typeof record.status !== "string") problems.push(`prerequisites["${id}"].status is missing`);
    }
  }
  if (!isRecord(gate)) problems.push("gate is not an object");
  else {
    if (typeof gate.verdict !== "string") problems.push("gate.verdict is missing");
    for (const field of ["discovered_ids", "executed_ids", "skipped_ids", "failed_ids"]) {
      if (!Array.isArray(gate[field])) problems.push(`gate.${field} is not an array`);
    }
    problems.push(...bindingProblems("gate.binding", gate.binding));
  }
  if (!Array.isArray(evidence)) problems.push("evidence is not an array");
  else {
    for (const [index, entry] of evidence.entries()) {
      if (!isRecord(entry)) { problems.push(`evidence[${index}] is not an object`); continue; }
      if (typeof entry.id !== "string") problems.push(`evidence[${index}].id is missing`);
      if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256)) {
        problems.push(`evidence[${index}].sha256 is not 64 lowercase hex characters`);
      }
      if (typeof entry.verified !== "boolean") problems.push(`evidence[${index}].verified is not a boolean`);
      problems.push(...bindingProblems(`evidence[${index}].binding`, entry.binding));
    }
  }
  return problems;
}

/**
 * Whether a set of acceptance observations adds up to a release.
 *
 * THE THREE COVERAGES ARE COMPARED INDEPENDENTLY — criteria, prerequisites and the gate — and
 * each contributes its own issues, so a report that is short on two of them says so twice.
 * Folding them into one boolean would tell a reader that something is missing and make them
 * go and find out which, which is the shape of report this whole task exists to not produce.
 *
 * `ready` is true only when NOTHING is outstanding. There is no partial credit and no quorum:
 * "Only all required criteria passed with no unresolved applicable prerequisite yields
 * ready:true", and the inverse — a structurally complete failed report is a good report and
 * still not a release — is the case the frozen check asserts second.
 */
export function assessAcceptance(report: unknown): AcceptanceAssessment {
  if (!isRecord(report)) return { structure_valid: false, ready: false, issues: ["the report is not an object"] };
  const malformed = structureProblems(report);
  if (malformed.length > 0) return { structure_valid: false, ready: false, issues: malformed };

  const binding = report.binding as Record<string, unknown>;
  const criteria = report.criteria as Record<string, Record<string, unknown>>;
  const prerequisites = report.prerequisites as Record<string, Record<string, unknown>>;
  const gate = report.gate as Record<string, unknown>;
  const evidence = report.evidence as Record<string, unknown>[];
  const issues: string[] = [];

  // ── evidence, first: everything below asks whether a criterion's evidence is verified ─────
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of evidence) {
    byId.set(entry.id as string, entry);
    if (entry.verified !== true) {
      issues.push(`evidence "${String(entry.id)}" is not verified — the resolver read no file, or its hash did not match`);
    }
    const drifted = bindingsAgree(entry.binding as Record<string, unknown>, binding);
    if (drifted.length > 0) {
      issues.push(`evidence "${String(entry.id)}" is bound to a different candidate (${drifted.join(", ")})`);
    }
  }

  // ── criterion coverage ────────────────────────────────────────────────────────────────────
  for (const [id, method] of Object.entries(CRITERION_METHODS)) {
    const record = criteria[id];
    if (record === undefined) { issues.push(`criterion ${id} has no record at all`); continue; }
    if (record.method !== method) {
      issues.push(`criterion ${id} claims method "${String(record.method)}"; the approved spec proves it by "${method}"`);
    }
    if (record.status !== "passed") issues.push(`criterion ${id} is ${String(record.status)}`);
    // An exit code belongs to a command and to nothing else. A human decision with an exit
    // code of 0 is a decision somebody ran a program instead of making.
    if (method === "command" && record.exit_code !== 0) {
      issues.push(`criterion ${id} is proved by a command and its exit code is ${String(record.exit_code)}, not 0`);
    }
    if (method !== "command" && record.exit_code !== null) {
      issues.push(`criterion ${id} is proved by ${method} and carries an exit code (${String(record.exit_code)})`);
    }
    const ids = record.evidence_ids as string[];
    if (ids.length === 0) issues.push(`criterion ${id} names no evidence`);
    for (const evidenceId of ids) {
      if (!byId.has(evidenceId)) issues.push(`criterion ${id} names evidence "${evidenceId}", which the report does not carry`);
    }
  }

  // ── prerequisite coverage ─────────────────────────────────────────────────────────────────
  for (const id of PREREQUISITE_IDS) {
    const record = prerequisites[id];
    if (record === undefined) { issues.push(`prerequisite ${id} has no record at all`); continue; }
    // A PREREQUISITE RECORDED INAPPLICABLE IS RESOLVED, NOT MISSING. The plan says so of H2 in
    // as many words: "No selected conversions means an explicit no-conversion record, not a
    // missing sign-off." What is refused is an applicable prerequisite that did not pass.
    if (record.applicable === true && record.status !== "passed") {
      issues.push(`prerequisite ${id} is applicable and ${String(record.status)}`);
    }
  }

  // ── gate coverage ─────────────────────────────────────────────────────────────────────────
  const discovered = gate.discovered_ids as string[];
  const executed = gate.executed_ids as string[];
  if (gate.verdict !== "PASSED") issues.push(`the gate verdict is ${String(gate.verdict)}`);
  if (executed.length === 0) issues.push("the gate executed no checks at all");
  const neverRan = unaccountedFor(discovered, executed);
  if (neverRan.length > 0) issues.push(`the gate discovered ${neverRan.length} check(s) it never executed: ${neverRan.slice(0, 5).join(", ")}`);
  for (const field of ["skipped_ids", "failed_ids"] as const) {
    const named = gate[field] as string[];
    if (named.length > 0) issues.push(`the gate reports ${named.length} ${field.replace("_ids", "")} check(s): ${named.slice(0, 5).join(", ")}`);
  }
  const gateDrift = bindingsAgree(gate.binding as Record<string, unknown>, binding);
  if (gateDrift.length > 0) issues.push(`the gate ran against a different candidate (${gateDrift.join(", ")})`);

  return { structure_valid: true, ready: issues.length === 0, issues };
}
