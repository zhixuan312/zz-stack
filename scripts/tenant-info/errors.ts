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

type CliErrorCode =
  | "WORKSPACE_REQUIRED"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_UNSAFE"
  | "UNKNOWN_SUITE"
  | "INVALID_ARGUMENTS";

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
