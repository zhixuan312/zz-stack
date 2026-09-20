/**
 * export.ts — the `export` verb. What gets exported and in what shape is a later task's
 * contract; this records that the verb ran, into the workspace, matching every other verb
 * in this directory that is scaffolding for now rather than the feature itself.
 */
import { writeFileSync } from "node:fs";

import { safeWritePath } from "./workspace.ts";

interface ExportReceipt {
  verb: "export";
  exportedAt: string;
}

export function runExport(workspaceReal: string): ExportReceipt {
  const receipt: ExportReceipt = { verb: "export", exportedAt: new Date().toISOString() };
  writeFileSync(safeWritePath(workspaceReal, "export.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
