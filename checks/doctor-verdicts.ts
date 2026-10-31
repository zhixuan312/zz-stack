#!/usr/bin/env node
/**
 * checks/doctor-verdicts.ts — the doctor's verdicts say what is true of the deployment, against a stubbed host.
 *
 *   node checks/doctor-verdicts.ts
 *
 * `ssh` and `docker` are replaced on PATH by stubs, and ZZ_HOST names a host that does not resolve, so nothing real is
 * reached. Each case runs `scripts/doctor.ts --json` and reads one probe's verdict:
 *
 *   1. git cannot read the checkout: the tag and clean-tree probes are `unknown`, never `wrong` or `ok`.
 *   2. docker cannot reach a daemon: both image probes are `unknown`, never "not in the registry" (the console's only
 *      where a console checkout sits beside this repo).
 *   3. the registry answers "no such manifest": the platform image probe is `wrong`.
 *   4. the host declares zz-core, cred-proxy and postgres, and zz-core's container has exited: "every declared
 *      service is up" is `wrong` and names zz-core.
 *   5. the live skill registry holds as many names as this checkout ships, one of them a name no SKILL.md carries in
 *      place of one that does: "the skill registry is not behind the catalog" is `wrong` and names the missing one.
 *
 * Exit 0: every case held. Exit 1: one did not, naming it.
 */
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { root } from "../scripts/deployment.ts";
import { everySkill, readSkill } from "../scripts/skill-versions.ts";

const fail: string[] = [];
const names = everySkill().map((f) => { const n = readSkill(f).name; return n === f ? basename(dirname(f)) : n; });
const live = [...names.slice(1), "a-skill-no-catalog-carries"];

const stubs = mkdtempSync(join(tmpdir(), "zz-doctor-stubs-"));
writeFileSync(join(stubs, "ssh"), `#!/bin/sh
for last; do :; done
case "$last" in
  *"config --services"*) printf 'zz-core\\ncred-proxy\\npostgres\\n' ;;
  *"compose ps -a --format"*) printf 'zz-core exited\\ncred-proxy running\\npostgres running\\n' ;;
  *"compose ps --format"*) printf 'cred-proxy running\\npostgres running\\n' ;;
  *"count(*) from zz.skill where not retired"*) echo ${live.length} ;;
  *"name from zz.skill where not retired"*) printf '${live.join("\\n")}\\n' ;;
esac
exit 0
`);
writeFileSync(join(stubs, "docker"), `#!/bin/sh
case "$STUB_DOCKER" in
  down) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2 ;;
  missing) echo "no such manifest: $3" >&2 ;;
esac
exit 1
`);
chmodSync(join(stubs, "ssh"), 0o755);
chmodSync(join(stubs, "docker"), 0o755);

type Finding = { layer: string; probe: string; verdict: string; detail?: string };
const doctor = (layers: string, extra: Record<string, string>): Finding[] => {
  const run = spawnSync(process.execPath, [join(root, "scripts/doctor.ts"), "--layer", layers, "--json"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, ZZ_HOST: "doctor-check.invalid", ...extra },
  });
  try { return JSON.parse(run.stdout).findings; }
  catch { fail.push(`doctor --layer ${layers} printed no JSON: ${(run.stderr || run.stdout).trim().slice(-300)}`); return []; }
};
const expect = (found: Finding[], probe: string, verdict: string, names?: string): void => {
  const f = found.find((x) => x.probe === probe);
  if (!f) { fail.push(`no finding for "${probe}"`); return; }
  if (f.verdict !== verdict) fail.push(`"${probe}" is ${f.verdict}, not ${verdict}: ${f.detail ?? ""}`);
  else if (names && !(f.detail ?? "").includes(names)) fail.push(`"${probe}" does not name ${names}: ${f.detail ?? ""}`);
};

try {
  const offline = doctor("repo,image", { GIT_DIR: join(stubs, "no-such-repository"), STUB_DOCKER: "down" });
  expect(offline, "the tag for this version exists", "unknown");
  expect(offline, "the tree is clean", "unknown");
  expect(offline, "this version's platform image is published", "unknown");
  // With no console checkout beside this repo the probe has nothing to ask, and says so with ok.
  if (existsSync(join(root, "..", "zz-stack-dashboard", "package.json"))) {
    expect(offline, "this version's console image is published", "unknown");
  }

  const missing = doctor("image", { STUB_DOCKER: "missing" });
  expect(missing, "this version's platform image is published", "wrong");

  const host = doctor("host,data", {});
  expect(host, "every declared service is up", "wrong", "zz-core");
  expect(host, "the skill registry is not behind the catalog", "wrong", names[0]);
} finally {
  rmSync(stubs, { recursive: true, force: true });
}

if (fail.length) {
  console.error(`doctor-verdicts: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("doctor-verdicts: could-not-run is unknown, a missing image and a stopped service are wrong, and the registry is compared by name");
