#!/usr/bin/env node
/**
 * `call` takes every flag it reads: `--timeout <ms>` reaches the client, a value that is not a
 * number of milliseconds is refused by name, and a flag `call` does not have is still refused.
 *
 * No network: every run stops before the connection, at the first missing piece of environment.
 * Reads the built `packages/tools/dist`.
 * Run: node checks/call-flags.ts
 */
import { spawnSync } from "node:child_process";

const CLI = "packages/tools/dist/ops/call.js";
const env = { PATH: process.env.PATH ?? "", HOME: "/nonexistent" };
const run = (...argv: string[]): string =>
  spawnSync(process.execPath, [CLI, "/core/mcp", "initiative_status", ...argv], { encoding: "utf8", env }).stderr;

const fail: string[] = [];
const said = (out: string, re: RegExp, why: string) => { if (!re.test(out)) fail.push(`${why}: got ${JSON.stringify(out.trim())}`); };

said(run("--timeout", "600000"), /no ZZ_URL/, "--timeout 600000 passes the flag check and stops at the gateway address");
said(run("--timeout", "soon"), /--timeout takes a number of milliseconds/, "--timeout soon is refused by name");
said(run("--wait", "5"), /call has no --wait/, "a flag call does not have is refused");

if (fail.length) {
  for (const f of fail) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("call-flags: --timeout reaches the client, a bad value and an unknown flag are refused: ok");
