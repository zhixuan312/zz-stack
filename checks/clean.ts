#!/usr/bin/env node
// `npm run clean` leaves no build output behind, a stale one included.
//
// It was `tsc -b --clean`, which removes only what the current sources would emit: the output of a
// deleted source stays in dist/ for good (71 such files on one checkout: admin/bugs.js, kb.js,
// blocks.js…). A check that still imports one passes on that machine and fails on CI's fresh clone.
// This plants a stale output, a current one and the build info in a scratch tree laid out as this
// repository's workspaces are, runs the clean script on it, and reads what is left.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "zz-clean-"));
try {
  const put = (rel: string, text = "x\n") => {
    mkdirSync(join(scratch, rel, ".."), { recursive: true });
    writeFileSync(join(scratch, rel), text);
  };
  put("package.json", JSON.stringify({ workspaces: ["packages/*", "services/*"] }));
  put("tsconfig.tooling.tsbuildinfo");
  for (const ws of ["packages/one", "services/two"]) {
    put(`${ws}/src/index.ts`);
    put(`${ws}/dist/index.js`);
    put(`${ws}/dist/deleted-long-ago/kb.js`);
    put(`${ws}/tsconfig.tsbuildinfo`);
  }
  execFileSync(process.execPath, [join(process.cwd(), "scripts/clean.ts"), scratch], { stdio: "pipe" });
  for (const ws of ["packages/one", "services/two"]) {
    assert.ok(!existsSync(join(scratch, ws, "dist")), `${ws}/dist is gone, a stale output with it`);
    assert.ok(!existsSync(join(scratch, ws, "tsconfig.tsbuildinfo")), `${ws}'s build info is gone, so the next build is whole`);
    assert.ok(existsSync(join(scratch, ws, "src/index.ts")), `${ws}'s source is untouched`);
  }
  assert.ok(!existsSync(join(scratch, "tsconfig.tooling.tsbuildinfo")), "the tooling project's build info is gone");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log("clean: npm run clean removes every workspace's dist and build info, a stale output included: ok");
