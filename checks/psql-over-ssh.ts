#!/usr/bin/env node
/**
 * checks/psql-over-ssh.ts — a psql binding reaches the remote psql whole when the configured command
 * runs it through ssh.
 *
 *   node checks/psql-over-ssh.ts   # needs a built tree (`npm run build`)
 *
 * ssh joins every argument after the host into one line the remote shell parses again. A fake `ssh`
 * first on PATH does the same (`sh -c "$*"`) and prints the binding psql would have received. A JSON
 * list bound as `-v names=[...]` lost its quotes there, and 0.101.0's first release attempt stopped
 * on `register-skills --check` reading `[sdlc-...` as JSON.
 *
 * Exit 0: the binding arrived as sent. Exit 1: it did not, quoting what arrived.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { psqlText } = await import(pathToFileURL(join(process.cwd(), "packages/tools/dist/lib/psql.js")).href) as {
  psqlText: (psql: string, sql: string, vars?: Record<string, string>) => string;
};

const dir = mkdtempSync(join(tmpdir(), "psql-over-ssh-"));
try {
  // The host is dropped, the rest re-parsed by a shell, and `psql` answers with its `names` binding.
  writeFileSync(join(dir, "ssh"), '#!/bin/sh\nshift\nexec sh -c "$*"\n');
  writeFileSync(join(dir, "psql"), '#!/bin/sh\nfor a; do case "$a" in names=*) printf "%s" "${a#names=}";; esac; done\n');
  chmodSync(join(dir, "ssh"), 0o755);
  chmodSync(join(dir, "psql"), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const sent = JSON.stringify(["sdlc-plan", "it's"]);
  const got = psqlText("ssh fake-host psql -U zz -d zz", "select 1", { names: sent });
  if (got !== sent) {
    console.error(`psql-over-ssh: FAILED — bound ${sent}, the remote psql received ${JSON.stringify(got)}`);
    process.exitCode = 1;
  } else {
    console.log("psql-over-ssh: a JSON binding, an apostrophe included, reaches the remote psql whole: ok");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
