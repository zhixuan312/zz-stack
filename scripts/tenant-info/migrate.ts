/**
 * migrate.ts — the `migrate` verb. Bare, it is a dry run; with `--apply`, it names a
 * `--target` and a `--manifest` (the CLI layer already refused an `--apply` missing either).
 * What migrating a tenant actually does is a later task's contract — its own losslessness
 * and shape checks are already frozen for when that task is dispatched. This records the
 * plan the verb was given, into the workspace, and touches nothing at `--target` itself.
 */
import { writeFileSync } from "node:fs";

import { safeWritePath } from "./workspace.ts";

interface MigrateArgs {
  apply: boolean;
  target?: string;
  manifest?: string;
}

interface MigrateReceipt {
  verb: "migrate";
  apply: boolean;
  target?: string;
  manifest?: string;
  plannedAt: string;
}

export function runMigrate(workspaceReal: string, args: MigrateArgs): MigrateReceipt {
  const receipt: MigrateReceipt = { verb: "migrate", ...args, plannedAt: new Date().toISOString() };
  writeFileSync(safeWritePath(workspaceReal, "migrate-plan.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
