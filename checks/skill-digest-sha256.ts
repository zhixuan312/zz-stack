#!/usr/bin/env node
// A skill's registered content_hash is the sha256 of its SKILL.md, the same kind of digest
// plugin_locate gives the servers and the flow beside it. It was `<size>-<length in hex>`
// ("3256-cae"): two different files of one length shared it, and a component manifest mixed two
// kinds of identity in one list.
//
// Drives the real register-skills over a one-skill catalog with a psql that only logs the variables
// it is handed, and compares the content_hash it registers with the file's own sha256.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const dir = mkdtempSync(join(tmpdir(), "skill-digest-"));
try {
  const skill = "---\nname: digest-probe\nversion: 0.1\ndescription: probe\n---\n\n# Probe\n";
  mkdirSync(join(dir, "skills", "digest-probe"), { recursive: true });
  writeFileSync(join(dir, "skills", "digest-probe", "SKILL.md"), skill);
  const log = join(dir, "sql.log");
  writeFileSync(join(dir, "psql"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\ncat > /dev/null\n`);
  chmodSync(join(dir, "psql"), 0o755);

  execFileSync("node", ["packages/tools/dist/ops/register-skills.js", "--root", dir, "--psql", join(dir, "psql")],
    { stdio: ["ignore", "pipe", "pipe"] });
  const args = readFileSync(log, "utf8").split("\n");
  const want = createHash("sha256").update(skill).digest("hex");
  const catalog = args.find((a) => a.startsWith("catalog="))?.slice("catalog=".length);
  const entry = catalog ? (JSON.parse(catalog) as { name: string; version: string; hash: string }[])
    .find((f) => f.name === "digest-probe" && f.version === "0.1") : undefined;
  const written = entry?.hash ?? "(none)";
  is(written === want, `register-skills wrote content_hash ${written}, not the file's sha256 ${want}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok skill-digest-sha256");
