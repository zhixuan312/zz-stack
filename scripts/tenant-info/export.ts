/**
 * export.ts — the `export` verb.
 *
 * DELEGATES ENTIRELY TO THE REAL OKF ASSEMBLER — `buildOkfBundle` in
 * `services/zz-core/dist/tenant-info/export.js`, the same function I-12's suite exercises.
 * This file owns no YAML serializer and no second frontmatter format of its own; whatever this
 * verb ever hands a caller is exactly what that one function produced.
 *
 * What gets exported — reading real revisions/events out of an actual owner-store — is a later
 * task's contract: no store connection is wired here yet. Until then this always calls the
 * real assembler over an empty closure (nothing to export, nothing authorized to resolve), so
 * the exact bundling path a real caller will use is exercised today rather than invented from
 * scratch the day the store wiring lands.
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
