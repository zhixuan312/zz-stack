/**
 * What the gate-plant break-tests share: run the gate, and read the checks it failed by name.
 *
 * DELIBERATE: this file is not a check and must not be registered as one. It spawns
 * `scripts/gate.ts`, which `working-checks-registered.ts` refuses to run inside the gate — the
 * same classifier that keeps a registered check from launching the gate — and it asserts nothing
 * on its own.
 *
 * `run()` and `failing()` are read-only: both return their findings rather than pushing into a
 * caller's array. `measure()` is deliberately NOT here: it reports by pushing into the `fail` of
 * the file that called it, so the copies that look identical across two break-tests are the same
 * shape over different state, not one implementation duplicated.
 */
import { execFileSync } from "node:child_process";

import { execOutput } from "../scripts/gate/read.ts";

/** Every check the gate reported, as `ran` (the names it printed either way) and `failed` (name ->
 *  the sentence under it). */
export function run(extra: readonly string[] = []): { ran: Set<string>; failed: Map<string, string> } {
  let out: string;
  try {
    out = execFileSync("node", ["scripts/gate.ts", ...extra], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    out = execOutput(err);
  }
  const lines = out.split("\n");
  const ran = new Set<string>();
  const failed = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    const ok = /^\s*✓ (.+)$/.exec(line);
    if (ok) { ran.add(ok[1]); continue; }
    const no = /^\s*✗ (.+)$/.exec(line);
    if (no) { ran.add(no[1]); failed.set(no[1], (lines[i + 1] ?? "").trim()); }
  }
  return { ran, failed };
}

/** The gate's failures only, name -> the sentence under each, from a `--quiet` run. */
export function failing(): Map<string, string> {
  return run(["--quiet"]).failed;
}
