#!/usr/bin/env node
/**
 * checks/update-restart-line.ts — zz-update says to restart whenever a plugin moved, and never that nothing changed
 * when something did.
 *
 *   node checks/update-restart-line.ts
 *
 * `claude` is replaced on PATH by a stub that answers `plugin list --json` from one file per call, in order, and fails
 * `plugin update` for the ids in $STUB_FAIL. Each case runs the updater and reads what it printed:
 *
 *   1. one plugin moves and another fails to update: exit 1, the restart line is printed, and the run does not claim
 *      nothing else on the machine changed.
 *   2. nothing moves and one plugin fails to update: exit 1, and no restart line.
 *   3. a renamed plugin is replaced and every update is a no-op: exit 0, the restart line, not "Nothing changed".
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { root } from "../scripts/deployment.ts";

const SCRIPT = join(root, "catalog/zz/zz-access/skills/zz-update/update.ts");
const fail: string[] = [];

const stubs = mkdtempSync(join(tmpdir(), "zz-update-stubs-"));
writeFileSync(join(stubs, "claude"), `#!/bin/sh
case "$*" in
  "plugin list --json")
    n=$(( $(cat "$STUB_STATE/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$STUB_STATE/count"
    cat "$STUB_STATE/list-$n.json" ;;
  "plugin update "*)
    case " $STUB_FAIL " in *" $3 "*) echo "could not update $3" >&2; exit 1 ;; esac
    echo ok ;;
  "plugin marketplace update "*|"plugin install "*|"plugin uninstall "*) echo ok ;;
  *) echo "the stub was not told about: $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(stubs, "claude"), 0o755);

type Listed = Record<string, string>;
const run = (name: string, lists: Listed[], failing: string[]): { status: number | null; out: string } => {
  const state = join(stubs, name);
  mkdirSync(state);
  lists.forEach((l, i) => writeFileSync(join(state, `list-${i + 1}.json`),
    JSON.stringify(Object.entries(l).map(([id, version]) => ({ id: `${id}@zz-stack`, version })))));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, STUB_STATE: state, STUB_FAIL: failing.join(" ") },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const RESTART = "Restart Claude Code";

try {
  const partial = run("partial", [
    { "zz-core": "1.0.0", "zz-access": "1.0.0" },
    { "zz-core": "1.1.0", "zz-access": "1.0.0" },
  ], ["zz-access@zz-stack"]);
  if (partial.status !== 1) fail.push(`a failed update with another moved exited ${partial.status}, not 1`);
  if (!partial.out.includes(RESTART)) fail.push(`zz-core moved but no restart line was printed:\n${partial.out}`);
  if (partial.out.includes("Nothing else on this machine was changed")) {
    fail.push(`zz-core moved but the run says nothing else changed:\n${partial.out}`);
  }

  const still = run("still", [
    { "zz-core": "1.0.0", "zz-access": "1.0.0" },
    { "zz-core": "1.0.0", "zz-access": "1.0.0" },
  ], ["zz-access@zz-stack"]);
  if (still.status !== 1) fail.push(`a failed update with nothing moved exited ${still.status}, not 1`);
  if (still.out.includes(RESTART)) fail.push(`nothing moved but a restart was asked for:\n${still.out}`);

  const renamed = run("renamed", [
    { zz: "1.1.0", "zz-access": "1.1.0" },
    { "zz-core": "1.1.0", "zz-access": "1.1.0" },
    { "zz-core": "1.1.0", "zz-access": "1.1.0" },
  ], []);
  if (renamed.status !== 0) fail.push(`a rename with no-op updates exited ${renamed.status}, not 0:\n${renamed.out}`);
  if (!renamed.out.includes(RESTART) || renamed.out.includes("Nothing changed")) {
    fail.push(`zz was replaced by zz-core but the run did not ask for a restart:\n${renamed.out}`);
  }
} finally {
  rmSync(stubs, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`update-restart-line: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("update-restart-line: a moved plugin always asks for a restart, a failed update never claims nothing changed");
