/**
 * A minimal `--flag value` / `--flag` reader for tenant-info's own six verbs.
 *
 * Every unexpected token — an unknown flag, a value-flag with nothing after it, a bare
 * positional argument — is `INVALID_ARGUMENTS`, in the JSON shape `CliError` gives every
 * rejection, so a verb handler never has to invent its own wording for "that argument made no
 * sense".
 */
import { CliError } from "./errors.ts";

/** `true` for a bare boolean flag (`--apply`), the literal value for a `--flag value` pair. */
export type FlagValue = string | true;

export function parseFlags(
  argv: string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): Map<string, FlagValue> {
  const flags = new Map<string, FlagValue>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      throw new CliError("INVALID_ARGUMENTS", `unexpected argument "${tok}".`);
    }
    const name = tok.slice(2);
    if (boolFlags.has(name)) {
      flags.set(name, true);
      continue;
    }
    if (valueFlags.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliError("INVALID_ARGUMENTS", `--${name} requires a value.`);
      }
      flags.set(name, value);
      i += 1;
      continue;
    }
    throw new CliError("INVALID_ARGUMENTS", `unknown flag --${name}.`);
  }
  return flags;
}

/** A value-flag that must have been given — the flags every verb declaring them treats as
 *  mandatory (`--seed`, `--scale`, `--profile` on `benchmark`). */
export function requireFlag(flags: Map<string, FlagValue>, name: string): string {
  const v = flags.get(name);
  if (typeof v !== "string") throw new CliError("INVALID_ARGUMENTS", `--${name} is required.`);
  return v;
}
