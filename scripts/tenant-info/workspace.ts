/**
 * Where every tenant-info command is allowed to write, and where it never is.
 *
 * `ZZ_TENANT_INFO_WORKSPACE` is required so that "run the suite" never defaults to writing beside
 * the checkout it is testing: a disposable workspace outside the repository is the only shape that
 * cannot reach this platform's live data by construction.
 *
 * `resolveWorkspace` follows every symlink with `realpathSync` — the same resolution a write is
 * about to make — and refuses a workspace that lands inside this repository, directly or through
 * a link. DELIBERATE: nothing here runs at import time. Computing this module's own idea of the
 * repository root is a read, and every check is inside a function a verb calls after its own
 * argument parsing.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "./errors.ts";

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** Resolves and validates `ZZ_TENANT_INFO_WORKSPACE`, returning its realpath. Throws
 *  `CliError` for every way it can be unsafe to use — required, invalid, or unsafe, in that
 *  order, matching the order a caller sees failures for the same broken environment. */
export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ZZ_TENANT_INFO_WORKSPACE;
  if (!raw || !raw.trim()) {
    throw new CliError("WORKSPACE_REQUIRED", "ZZ_TENANT_INFO_WORKSPACE is required and was not set.");
  }
  if (!existsSync(raw) || !statSync(raw).isDirectory()) {
    throw new CliError("WORKSPACE_INVALID", `"${raw}" does not exist or is not a directory.`);
  }
  const real = realpathSync(raw);
  if (isInside(real, repoRoot)) {
    throw new CliError(
      "WORKSPACE_UNSAFE",
      `"${raw}" resolves inside this checkout (${repoRoot}) — tenant-info never writes there, ` +
      "directly or through a symlink.",
    );
  }
  return real;
}

/**
 * A write target inside an already-validated workspace, checked the same way again: its
 * parent directory is realpath'd and must still resolve under the workspace root. A
 * symlinked subdirectory planted after `resolveWorkspace` ran is caught here rather than
 * trusted because the workspace root once was safe — every write goes through this, not just
 * the first one.
 */
export function safeWritePath(workspaceReal: string, ...rel: string[]): string {
  const target = join(workspaceReal, ...rel);
  const parent = dirname(target);
  const parentReal = existsSync(parent) ? realpathSync(parent) : parent;
  if (!isInside(parentReal, workspaceReal)) {
    throw new CliError("WORKSPACE_UNSAFE", `"${target}" escapes the validated workspace.`);
  }
  return target;
}
