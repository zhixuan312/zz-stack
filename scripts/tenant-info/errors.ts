/**
 * Operational CLI errors for tenant-info.
 *
 * WORKSPACE_REQUIRED, WORKSPACE_INVALID, WORKSPACE_UNSAFE, UNKNOWN_SUITE and
 * INVALID_ARGUMENTS are all failures of the INVOCATION — a caller asked this CLI to do
 * something it cannot safely attempt. They are deliberately a separate type from whatever
 * error union the tenant-info artifact mutations themselves use: a bad `--profile` is not a
 * new kind of domain failure, and folding it into that union would grow it for a reason that
 * has nothing to do with the domain.
 */

export type CliErrorCode =
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_UNSAFE"
  | "UNKNOWN_SUITE"
  | "INVALID_ARGUMENTS"
  // A SCALE THE FIXTURE PLAN CANNOT HONOUR, and it is here rather than left to the catch-all
  // because the contract names this refusal specifically. `planCorpora` throws its own error
  // with this code when a scale would demand a fraction of a 1-MiB fixture, which the frozen
  // check for I-3 asserts on. `cli.ts`'s catch-all relabels every unrecognised throw as
  // INVALID_ARGUMENTS, so before this line the named refusal was correct where it was tested
  // and invisible where it was used — a contract that holds only inside the process is a
  // contract nobody at a command line can rely on.
  | "FRACTIONAL_FIXTURE_COUNT";

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

/** The codes this CLI owns, as a runtime set, so the entry point can recognise a thrown value
 *  that already names itself instead of relabelling it. Kept beside the union it mirrors: two
 *  lists that can disagree is how the union grew a member nothing could ever report. */
const CLI_ERROR_CODES = new Set<string>([
  "WORKSPACE_REQUIRED", "WORKSPACE_INVALID", "WORKSPACE_UNSAFE",
  "UNKNOWN_SUITE", "INVALID_ARGUMENTS", "FRACTIONAL_FIXTURE_COUNT",
]);

export const isCliErrorCode = (v: unknown): v is CliErrorCode =>
  typeof v === "string" && CLI_ERROR_CODES.has(v);
