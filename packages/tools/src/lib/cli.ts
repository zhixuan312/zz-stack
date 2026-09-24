/**
 * The small things every tool here needs: arguments, environment, and failing readably.
 *
 * Not a framework and deliberately not a dependency. What matters is not the parsing but what
 * happens when an argument is missing: an operator who mistypes a flag gets one sentence and a
 * non-zero status, every time, from every tool.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { NO_TOKEN_ONBOARDING } from "@zz/contracts";


/** Stop with one line on stderr and a non-zero status. Never a stack trace: the reader is an
 * operator who mistyped something, not someone debugging this file. */
export function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/** The platform token, resolved the way this platform says it is resolved.
 *
 * COUPLED: `services/gateway/src/package/skills.ts` generates the credential script every installed
 * client runs, and that script states the order in its own header: `$ZZ_TOKEN`, then
 * `$ZZ_TOKEN_FILE`, then `~/.zz/token`, which the install step writes at mode 600. This resolution
 * has to match it, or a machine carrying a token the platform installed is refused.
 *
 * DELIBERATE: one file, because a person has one token. A token carries the authority of whoever
 * it belongs to, and splitting that across `~/.zz/token-admin` and `~/.zz/token` means two things
 * to rotate, two to revoke, and one of them silently stale. Confining a token's scope — one pasted
 * into a third-party client, say — is something you ask for, not a second file on your disk.
 */
export function platformToken(): string {
  const fromEnv = (process.env.ZZ_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const explicit = (process.env.ZZ_TOKEN_FILE ?? "").trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    join(homedir(), ".zz", "token"),
  ];
  for (const path of candidates) {
    try {
      // Trimmed, because a file written with a trailing newline is the ordinary case and a
      // token with \n on the end is refused at the door as invalid — an error about the
      // credential when the fault is the whitespace around it.
      const t = readFileSync(path, "utf8").trim();
      if (t) return t;
    } catch {
      // Absent or unreadable. Try the next, then say every place that was looked.
    }
  }
  // Not just "no token". A missing credential is the one error where the reader needs the step
  // that gets them one rather than a statement of what is absent. The same six lines the gateway
  // prints at `GET /`, from the same declaration, so there is one onboarding rather than two.
  return die([
    `No platform token. Looked at $ZZ_TOKEN, $ZZ_TOKEN_FILE, and ${candidates.join(", ")}.`,
    "",
    ...NO_TOKEN_ONBOARDING,
    "",
    "  Then: printf '%s' '<token>' > ~/.zz/token && chmod 600 ~/.zz/token",
  ].join("\n"));
}

/** A required environment variable, or a sentence saying which one and why. */
export function envRequired(name: string, why: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) die(`no ${name}: ${why}`);
  return v;
}

interface ParsedArgs {
  /** `--flag value` pairs, and `--flag` alone as "". */
  flags: Map<string, string>;
  /** Every `--flag value` for a flag given more than once. */
  repeated: Map<string, string[]>;
  /** Everything that was not a flag or a flag's value. */
  positional: string[];
}

/**
 * `--flag value`, `--flag=value`, `--boolean`, and positionals.
 *
 * `booleans` names the flags that take no value, because without it `--json --gateway x`
 * would swallow `--gateway` as `--json`'s value and then complain that `--gateway` is
 * missing — a message pointing at the wrong flag, which is worse than no message.
 */
export function parseArgs(argv: string[], booleans: readonly string[] = []): ParsedArgs {
  const flags = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const positional: string[] = [];
  const isBool = new Set(booleans);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq < 0 ? a : a.slice(0, eq)).slice(2);
    let value: string;
    if (eq >= 0) value = a.slice(eq + 1);
    else if (isBool.has(name)) value = "";
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) value = argv[++i];
    else value = "";
    flags.set(name, value);
    repeated.set(name, [...(repeated.get(name) ?? []), value]);
  }
  return { flags, repeated, positional };
}

/** A flag's value, or `die` with which flag was missing. */
export function required(args: ParsedArgs, name: string, what: string, code = 1): string {
  const v = args.flags.get(name);
  // `code` exists so a caller needing a different exit status does not bypass this helper and lose
  // the `v === ""` half with it — a flag typed with nothing after it would then read as absent,
  // which the gate check "a flag given with nothing after it is refused" exists to catch.
  if (v === undefined || v === "") die(`--${name} is required: ${what}`, code);
  return v;
}

/**
 * An optional flag's value, or null when it was not given — and `die` when it was given with
 * nothing after it.
 *
 * A flag given with no value is a mistyped flag, not an absent one. parseArgs stores "" for
 * `--actor` written with nothing after it (or followed by another flag, which it will not
 * swallow), and `flags.get(name) ?? null` hands that "" straight through because "" is not
 * nullish; every caller then tests it with `if (value)` and skips the filter in silence.
 *
 * For a flag naming a file that is a mistyped flag doing nothing. For a flag that narrows a query
 * it is worse, because the tool still answers: `--actor` with no address reports on everybody
 * while the operator reads it as one evaluation run's calls.
 *
 * A flag with a real default is a different case and is written `flags.get(x) || fallback`. This
 * is for the flags whose absence changes what the answer is about.
 */
export function optional(args: ParsedArgs, name: string, what: string): string | null {
  if (!args.flags.has(name)) return null;
  const v = (args.flags.get(name) ?? "").trim();
  if (!v) die(`--${name} needs ${what}`);
  return v;
}
