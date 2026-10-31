#!/usr/bin/env node
/**
 * testing/reset-store.sh reaches the database it names: through ssh to $ZZ_SSH_HOST, then compose's
 * psql, with the statement on stdin so psql interpolates `:'team'` and `:'prefix'` itself.
 *
 *   node checks/reset-store-transport.ts
 *
 * `ssh` and `docker` are stubs first on PATH. The ssh stub runs its command the way a remote shell
 * does, joined with spaces and parsed again, so a value the script quotes wrongly arrives split or
 * runs; the docker stub records the arguments and stdin psql would have received.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = "testing/reset-store.sh";
const fail: string[] = [];
const work = mkdtempSync(join(tmpdir(), "reset-store-"));

/** One run against fresh stubs: the exit, what ssh was given, and what psql would have received. */
function run(args: string[]) {
  const bin = mkdtempSync(join(work, "bin-")), log = mkdtempSync(join(work, "log-")), compose = join(log, "deploy");
  mkdirSync(compose);
  writeFileSync(join(bin, "ssh"), [
    "#!/usr/bin/env bash",
    `printf '%s' "$1" > '${log}/ssh.host'`,
    "shift",
    `cd '${log}' && exec bash -c "$*"`,
  ].join("\n"));
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    `printf '%s\\0' "$@" > '${log}/docker.args'`,
    `cat > '${log}/docker.stdin'`,
  ].join("\n"));
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZZ_SSH_HOST: "reset-host", ZZ_COMPOSE_DIR: compose },
  });
  const read = (f: string) => existsSync(join(log, f)) ? readFileSync(join(log, f), "utf8") : null;
  return {
    status: r.status, said: `${r.stdout}${r.stderr}`.trim(), log,
    host: read("ssh.host"), argv: read("docker.args")?.split("\0").slice(0, -1) ?? null, stdin: read("docker.stdin"),
  };
}

// A value a shell would split or run, so the quoting is what is under test.
const TEAM = "o'brien team; touch pwned";
const PREFIX = "2026-10-31-r0_";

for (const dry of [true, false]) {
  const label = dry ? "the dry run" : "the reset";
  const r = run(["--team", TEAM, "--prefix", PREFIX, ...(dry ? ["--dry-run"] : [])]);
  if (r.status !== 0) { fail.push(`${label} exited ${r.status}: ${r.said.split("\n")[0]}`); continue; }
  if (r.host !== "reset-host") fail.push(`${label} never went through ssh to $ZZ_SSH_HOST (ssh got ${JSON.stringify(r.host)})`);
  if (!r.argv) { fail.push(`${label} never reached compose's psql`); continue; }
  if (existsSync(join(r.log, "pwned"))) fail.push(`${label} let the team name run as a command on the host`);
  const at = r.argv.indexOf("exec");
  const head = r.argv.slice(0, at + 4).join(" ");
  if (head !== "compose exec -T postgres psql") fail.push(`${label} ran docker ${head}, not compose exec -T postgres psql`);
  if (r.argv.includes("-c")) fail.push(`${label} sends its statement with -c, where psql interpolates no variable`);
  for (const want of [`team=${TEAM}`, `prefix=${PREFIX}`]) {
    if (!r.argv.includes(want)) fail.push(`${label} did not hand psql ${JSON.stringify(want)} as one argument: ${JSON.stringify(r.argv)}`);
  }
  if (!dry && !r.argv.some((a) => /^suffix=--reset-\d{14}$/.test(a))) fail.push("the reset hands psql no --reset-<UTC second> suffix");
  const sql = r.stdin ?? "";
  for (const v of [":'team'", ":'prefix'", ...(dry ? [] : [":'suffix'"])]) {
    if (!sql.includes(v)) fail.push(`${label}'s statement on stdin does not use ${v}`);
  }
  if (/\blike\b/i.test(sql)) fail.push(`${label} matches the prefix with LIKE, so a _ or % in it is a wildcard`);
  if (!new RegExp(dry ? "^\\s*select\\b" : "^\\s*update zz\\.initiative\\b", "m").test(sql)) {
    fail.push(`${label} sent no ${dry ? "select" : "update"} on stdin: ${JSON.stringify(sql.slice(0, 80))}`);
  }
}

rmSync(work, { recursive: true, force: true });
if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("reset-store transport: ok");
