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

interface SuiteOutcome {
  suite: string;
  status: "passed" | "failed" | "not_run";
  module: string;
  partial: boolean;
  detail?: unknown;
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
): Promise<SuiteOutcome> {
  const mod = (await import(pathToFileURL(modulePath).href)) as SuiteModule;
  const outcome = await mod.run({ cases });
  return {
    suite: name,
    module: modulePath,
    partial: cases !== undefined,
    status: outcome.passed ? "passed" : "failed",
    detail: outcome.detail,
  };
}

async function runNamedSuite(name: SuiteName): Promise<SuiteOutcome> {
  const resolution = resolveSuite(name, availableSuiteNames());
  if (resolution.status === "not_run") {
    return { suite: name, status: "not_run", module: resolution.module, partial: false };
  }
  return runReadySuite(name, resolution.module, undefined);
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
