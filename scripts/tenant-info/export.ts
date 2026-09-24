/**
 * The `export` verb.
 *
 * Delegates entirely to `buildOkfBundle` in `services/zz-core/dist/tenant-info/export.js`.
 * This file owns no YAML serializer and no frontmatter format of its own; what the verb hands
 * a caller is exactly what that function produced.
 *
 * No store connection is wired yet, so it calls the real assembler over an empty closure —
 * nothing to export, nothing authorized to resolve.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { buildOkfBundle } from "../../services/zz-core/dist/tenant-info/export.js";
import { safeWritePath } from "./workspace.ts";

interface ExportReceipt {
  verb: "export";
  exportedAt: string;
  files: string[];
}

export function runExport(workspaceReal: string): ExportReceipt {
  const bundle = buildOkfBundle([], [], () => false);
  const bundleDir = safeWritePath(workspaceReal, "okf");
  mkdirSync(bundleDir, { recursive: true });
  for (const file of bundle.files) {
    writeFileSync(safeWritePath(workspaceReal, "okf", file.path), file.content);
  }
  const receipt: ExportReceipt = {
    verb: "export", exportedAt: new Date().toISOString(), files: bundle.files.map((f) => f.path),
  };
  writeFileSync(safeWritePath(workspaceReal, "export.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
