/**
 * baseline.ts — the `baseline` verb.
 *
 * What a baseline actually records is a later task's contract; this task's boundary is the
 * safe entry point only. Recording that the verb ran, into the caller's workspace, is enough
 * for I-1's job — the fields a baseline carries land with the task that owns them.
 */
import { writeFileSync } from "node:fs";

import { safeWritePath } from "./workspace.ts";

interface BaselineReceipt {
  verb: "baseline";
  capturedAt: string;
}

export function runBaseline(workspaceReal: string): BaselineReceipt {
  const receipt: BaselineReceipt = { verb: "baseline", capturedAt: new Date().toISOString() };
  writeFileSync(safeWritePath(workspaceReal, "baseline.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
