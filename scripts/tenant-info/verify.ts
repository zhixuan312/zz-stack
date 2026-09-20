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
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { SUITE_NAMES, availableSuiteNames, suiteModulePath, type SuiteName } from "./suites.ts";
import { safeWritePath } from "./workspace.ts";

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

async function runNamedSuite(name: SuiteName): Promise<SuiteOutcome> {
  const resolution = resolveSuite(name, availableSuiteNames());
  if (resolution.status === "not_run") {
    return { suite: name, status: "not_run", module: resolution.module, partial: false };
  }
  return runReadySuite(name, resolution.module, undefined, "acceptance");
}

/** `verify --finalize` — every suite, none of them partial, all of them required. A missing
 *  module blocks finalization exactly as a failing one would: neither can pass a whole
 *  business acceptance criterion on the strength of the suites that happen to exist yet. */
export async function finalize(workspaceReal: string) {
  const suites: SuiteOutcome[] = [];
  for (const name of SUITE_NAMES) suites.push(await runNamedSuite(name));
  const status: "passed" | "blocked" = suites.every((s) => s.status === "passed") ? "passed" : "blocked";
  const result = { profile: "acceptance" as const, suites, status };
  const receiptPath = safeWritePath(workspaceReal, "acceptance-finalize.json");
  writeFileSync(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
