/**
 * The ten tenant-info verification suites, and where each one's module is expected to live.
 *
 * COUPLED: `cli.ts`'s UNKNOWN_SUITE error and `verify.ts`'s `resolveSuite` read the list from
 * here rather than keeping their own copy, so a new suite is added in one place.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUITE_NAMES = [
  "model", "persistence", "lifecycle", "okf", "rebuild",
  "isolation", "retrieval", "migration", "deployment", "compatibility",
] as const;

export type SuiteName = typeof SUITE_NAMES[number];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE_DIR = join(repoRoot, "testing", "tenant-info");

export function suiteModulePath(name: string): string {
  return join(SUITE_DIR, `${name}.ts`);
}

/**
 * Which of the ten suites have a module on disk, right now. DELIBERATE: read fresh on every
 * call, never cached at import time — the answer is only true for the instant it was asked.
 */
export function availableSuiteNames(): string[] {
  if (!existsSync(SUITE_DIR)) return [];
  const present = new Set(readdirSync(SUITE_DIR));
  return SUITE_NAMES.filter((name) => present.has(`${name}.ts`));
}
