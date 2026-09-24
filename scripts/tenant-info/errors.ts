/**
 * Operational CLI errors for tenant-info.
 *
 * Every code here is a failure of the invocation — a caller asked this CLI to do something it
 * cannot safely attempt. DELIBERATE: a separate type from the error union the tenant-info artifact
 * mutations use. A bad `--profile` is not a new kind of domain failure.
 */

export type CliErrorCode =
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_UNSAFE"
  | "UNKNOWN_SUITE"
  | "INVALID_ARGUMENTS"
  // A scale the fixture plan cannot honour, named rather than left to the catch-all because the
  // contract names this refusal. `planCorpora` throws with this code when a scale would demand a
  // fraction of a 1-MiB fixture. `cli.ts`'s catch-all relabels every unrecognised throw as
  // INVALID_ARGUMENTS, so without this line the named refusal is invisible at a command line.
  | "FRACTIONAL_FIXTURE_COUNT"
  // The two refusals that stand between `migrate --apply` and a live store, named rather than
  // folded into INVALID_ARGUMENTS because the contract names them. A caller scripting a cutover
  // has to tell "you pointed me at a store something is writing" from "you spelled a flag wrong".
  | "LIVE_SOURCE_REFUSED"
  | "AMBIGUOUS_TARGET";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(code: CliErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Exit 2: the invocation itself was invalid. One JSON object on stderr — `code`, `message`,
 * and whatever the error carries beyond that (`suites`, for UNKNOWN_SUITE) — never a stack
 * trace, which is not a shape a caller can parse reliably.
 */
export function failInvocation(err: CliError): never {
  process.stderr.write(`${JSON.stringify({ code: err.code, message: err.message, ...err.extra })}\n`);
  process.exit(2);
}

/** The codes this CLI owns, as a runtime set, so the entry point can recognise a thrown value that
 *  already names itself instead of relabelling it. COUPLED: kept beside the union it mirrors —
 *  two lists that can disagree let the union carry a member nothing can report. */
const CLI_ERROR_CODES = new Set<string>([
  "WORKSPACE_REQUIRED", "WORKSPACE_INVALID", "WORKSPACE_UNSAFE",
  "UNKNOWN_SUITE", "INVALID_ARGUMENTS", "FRACTIONAL_FIXTURE_COUNT",
  "LIVE_SOURCE_REFUSED", "AMBIGUOUS_TARGET",
]);

export const isCliErrorCode = (v: unknown): v is CliErrorCode =>
  typeof v === "string" && CLI_ERROR_CODES.has(v);
