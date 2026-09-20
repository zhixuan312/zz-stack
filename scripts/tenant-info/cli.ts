#!/usr/bin/env node
/**
 * cli.ts — tenant-info's one entry point.
 *
 * Six verbs (`baseline`, `fixtures`, `verify`, `benchmark`, `migrate`, `export`), a required
 * workspace that must resolve outside this checkout, and ten named verification suites. Every
 * verb's actual work is a plain function in a sibling module; this file's whole job is argv,
 * the workspace gate, and turning a `CliError` into the JSON-on-stderr shape a caller can
 * parse — `code`, `message`, and `suites` for UNKNOWN_SUITE.
 *
 * NOTHING RUNS ON IMPORT. Dispatch only happens inside the "am I the file that was invoked"
 * guard at the bottom, so `checks/tenant-info-cli.ts` can import `resolveSuite` from
 * `verify.ts` — which this file also imports — without a command ever firing, and anything
 * else that wants these functions can import them the same way. That guard compares realpaths
 * rather than `import.meta.main`: the package floor is Node >=24.0.0 and the flag-free form of
 * `import.meta.main` is newer than that, so a plain `===` on `import.meta.url` would silently
 * read `undefined` — and hence never dispatch, exiting 0 having printed nothing — on an
 * otherwise-supported Node this repository declares as its floor.
 *
 * Exit codes: 2 is an invalid invocation (a WORKSPACE_*, UNKNOWN_SUITE or INVALID_ARGUMENTS
 * `CliError`); 1 is a required operation that ran and did not pass, including a suite whose
 * module does not exist yet (`not_run`); 0 means only the scope actually invoked passed.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CliError, failInvocation, isCliErrorCode, type CliErrorCode } from "./errors.ts";
import { resolveWorkspace } from "./workspace.ts";
import { parseFlags, requireFlag, type FlagValue } from "./args.ts";
import { runBaseline, validateBaseline } from "./baseline.ts";
import { runFixtures } from "./inventory.ts";
import { resolveSuite, runReadySuite, finalize } from "./verify.ts";
import { SUITE_NAMES, availableSuiteNames, type SuiteName } from "./suites.ts";
import { runBenchmark, type BenchmarkProfile } from "./benchmark.ts";
import { runMigrate } from "./migrate.ts";
import { runExport } from "./export.ts";

type VerifyProfile = "integration" | "acceptance";

interface DispatchResult {
  receipt: unknown;
  ok: boolean;
}

async function dispatchVerify(flags: Map<string, FlagValue>): Promise<DispatchResult> {
  const suite = flags.get("suite");
  const finalizeFlag = flags.get("finalize") === true;
  if (suite !== undefined && finalizeFlag) {
    throw new CliError("INVALID_ARGUMENTS", "--suite and --finalize are mutually exclusive.");
  }
  if (suite === undefined && !finalizeFlag) {
    throw new CliError("INVALID_ARGUMENTS", "verify needs --suite NAME or --finalize.");
  }
  const profileRaw = flags.get("profile");
  const profile: VerifyProfile = profileRaw === undefined ? "integration" : (profileRaw as VerifyProfile);
  if (profile !== "integration" && profile !== "acceptance") {
    throw new CliError(
      "INVALID_ARGUMENTS",
      `--profile must be "integration" or "acceptance", got "${String(profileRaw)}".`,
    );
  }
  const cases = flags.get("cases");
  if (typeof cases === "string" && profile === "acceptance") {
    throw new CliError("INVALID_ARGUMENTS", "the acceptance profile rejects --cases.");
  }
  if (finalizeFlag && profile !== "acceptance") {
    throw new CliError("INVALID_ARGUMENTS", "--finalize only runs at --profile acceptance.");
  }
  const workspace = resolveWorkspace();
  if (finalizeFlag) {
    const result = await finalize(workspace);
    return { receipt: result, ok: result.status === "passed" };
  }
  const name = suite as string;
  if (!SUITE_NAMES.includes(name as SuiteName)) {
    throw new CliError("UNKNOWN_SUITE", `"${name}" is not a tenant-info suite.`, { suites: [...SUITE_NAMES] });
  }
  const casesValue = typeof cases === "string" ? cases : undefined;
  const resolution = resolveSuite(name, availableSuiteNames());
  if (resolution.status === "not_run") {
    return {
      receipt: { suite: name, status: "not_run", module: resolution.module, partial: casesValue !== undefined },
      ok: false,
    };
  }
  const result = await runReadySuite(name, resolution.module, casesValue);
  return { receipt: result, ok: result.status === "passed" };
}

async function dispatch(argv: string[]): Promise<DispatchResult> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case "baseline": {
      parseFlags(rest, new Set(), new Set());
      const workspace = resolveWorkspace();
      const { report, ok } = await runBaseline(workspace);
      // Trust but verify at the boundary that emits the exit code: a "complete" receipt is
      // only ever ok if it would still pass the same validator the collector itself gates on.
      const verified = ok && (report.status !== "complete" || validateBaseline(report).ok);
      return { receipt: report, ok: verified };
    }
    case "fixtures": {
      const flags = parseFlags(rest, new Set(["seed", "scale"]), new Set());
      const seedRaw = requireFlag(flags, "seed");
      const scale = requireFlag(flags, "scale");
      const seed = Number(seedRaw);
      if (!Number.isInteger(seed)) {
        throw new CliError("INVALID_ARGUMENTS", `--seed must be an integer, got "${seedRaw}".`);
      }
      const workspace = resolveWorkspace();
      return { receipt: runFixtures(workspace, { seed, scale }), ok: true };
    }
    case "verify":
      return dispatchVerify(parseFlags(rest, new Set(["suite", "profile", "cases"]), new Set(["finalize"])));
    case "benchmark": {
      const flags = parseFlags(rest, new Set(["profile"]), new Set());
      const profile = requireFlag(flags, "profile");
      if (profile !== "baseline" && profile !== "acceptance") {
        throw new CliError("INVALID_ARGUMENTS", `--profile must be "baseline" or "acceptance", got "${profile}".`);
      }
      const workspace = resolveWorkspace();
      return { receipt: runBenchmark(workspace, profile as BenchmarkProfile), ok: true };
    }
    case "migrate": {
      const flags = parseFlags(rest, new Set(["target", "manifest"]), new Set(["apply"]));
      const apply = flags.get("apply") === true;
      const target = flags.get("target");
      const manifest = flags.get("manifest");
      if (apply && (typeof target !== "string" || typeof manifest !== "string")) {
        throw new CliError("INVALID_ARGUMENTS", "--apply requires --target PATH and --manifest PATH.");
      }
      const workspace = resolveWorkspace();
      return {
        receipt: runMigrate(workspace, {
          apply,
          target: typeof target === "string" ? target : undefined,
          manifest: typeof manifest === "string" ? manifest : undefined,
        }),
        ok: true,
      };
    }
    case "export": {
      parseFlags(rest, new Set(), new Set());
      const workspace = resolveWorkspace();
      return { receipt: runExport(workspace), ok: true };
    }
    case undefined:
      throw new CliError(
        "INVALID_ARGUMENTS",
        "no verb given — expected one of baseline, fixtures, verify, benchmark, migrate, export.",
      );
    default:
      throw new CliError("INVALID_ARGUMENTS", `unknown verb "${verb}".`);
  }
}

const isMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  dispatch(process.argv.slice(2))
    .then(({ receipt, ok }) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      process.exit(ok ? 0 : 1);
    })
    .catch((err: unknown) => {
      if (err instanceof CliError) failInvocation(err);
      // A THROWN VALUE THAT ALREADY NAMES ITSELF KEEPS ITS NAME. `planCorpora` refuses a scale
      // demanding a fraction of a 1-MiB fixture with its own `FRACTIONAL_FIXTURE_COUNT`, which
      // the contract names and the frozen check asserts — and the catch-all below used to
      // relabel it `INVALID_ARGUMENTS` on the way out, so the refusal was correct in process
      // and invisible at the command line. Anything carrying a code this CLI recognises is
      // reported as itself; everything else is still an invalid invocation.
      const code = err instanceof Error && "code" in err && isCliErrorCode((err as { code: unknown }).code)
        ? (err as { code: CliErrorCode }).code
        : "INVALID_ARGUMENTS";
      process.stderr.write(
        `${JSON.stringify({ code, message: err instanceof Error ? err.message : String(err) })}\n`,
      );
      process.exit(2);
    });
}
