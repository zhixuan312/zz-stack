#!/usr/bin/env node
// The release registers every catalog plugin under the owner team the host's deploy/.env names,
// and a register-plugins that fails is a failed verification, not a warning. 0.76.2 ran it on the
// release machine without ZZ_CATALOG_OWNER_TEAM, logged a WARNING, left every plugin with no
// release owner and the newest plugin version at 0.75.0, and reported itself released.
//
// The team is a relation now, not a jsonb list: the slug is resolved through zz.team into
// `zz.plugin.owner_team_id` and written as the plugin's `zz.plugin_release_owner` row. The two
// assertions below are pinned on the text of the statements that do it — the insert's column list,
// and the slug it resolves and the id it writes — because a pattern that no longer matches the
// statement it was written for passes while testing nothing.
//
// Drives the real `catalogOwnerTeam` and `writeRegistries` against a fake `ssh` first on PATH, so
// nothing reaches a host: the fake answers the deploy/.env grep with a sentinel team and every
// psql call with a row (the team's id where the statement asks zz.team for it), logs the SQL every
// psql call is handed, and fails every psql call when told to. Then reads release.ts for the two
// places it has to use them: the owner team before step 4, the failures before the rollback.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const SENTINEL = "owner-team-from-host";
/** The row the fake psql answers a `zz.team` lookup with. */
const TEAM_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const dir = mkdtempSync(join(tmpdir(), "release-plugin-owners-"));
const sqlLog = join(dir, "sql.log");
writeFileSync(join(dir, "ssh"), `#!/bin/sh
case "$*" in
  *ZZ_CATALOG_OWNER_TEAM*"deploy/.env"*) echo ${SENTINEL}; exit 0 ;;
  *"deploy/.env"*) exit 1 ;;
  *psql*)
    sql=$(cat)
    echo "$sql" >> "${sqlLog}"
    [ -n "$FAKE_PSQL_FAILS" ] && { echo "psql: connection refused" >&2; exit 2; }
    case "$sql" in
      *"from zz.team"*) echo "${TEAM_ID}" ;;
      *) echo 1 ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
`);
chmodSync(join(dir, "ssh"), 0o755);

// A local .env that sets it wins over the host, by design; the check expects whichever is in force.
const localEnv = (() => { try { return readFileSync(".env", "utf8"); } catch { return ""; } })();
const localTeam = /^\s*ZZ_CATALOG_OWNER_TEAM\s*=\s*(\S+)/m.exec(localEnv)?.[1] ?? "";

const drive = (script: string, extra: Record<string, string> = {}): string => {
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${dir}:${process.env.PATH}`,
    ZZ_HOST: "fake-host", ...extra };
  delete env.ZZ_CATALOG_OWNER_TEAM;
  return execFileSync("node", ["--input-type=module", "-e", script],
    { env: env as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
};

try {
  const team = drive(`import { catalogOwnerTeam } from "./scripts/deployment.ts";
    console.log("TEAM=" + catalogOwnerTeam({ quiet: true }));`);
  const got = /TEAM=(.*)/.exec(team)?.[1] ?? "";
  is(got === (localTeam || SENTINEL),
     `catalogOwnerTeam() answered "${got}", not the host deploy/.env's "${SENTINEL}" — the release does not read the owner team off the host`);

  const ok = drive(`import { writeRegistries } from "./scripts/release/registries.ts";
    console.log("FAILURES=" + JSON.stringify(writeRegistries("${SENTINEL}")));`);
  is(/FAILURES=\[\]/.test(ok), `writeRegistries reported failures on a healthy run: ${ok.split("\n").filter((l) => l.startsWith("FAILURES")).join("")}`);
  const sql = (() => { try { return readFileSync(sqlLog, "utf8"); } catch { return ""; } })();
  is(/insert into zz\.plugin \(name, origin, owner_team_id\)/.test(sql),
     "register-plugins never reached the zz.plugin insert — the owner team was not handed to it");
  is(sql.includes(`select id from zz.team where slug = '${SENTINEL}'`),
     "register-plugins did not resolve the owner team's slug through zz.team, so the team it " +
     "writes is whatever text it was given rather than a team this deployment has");
  is(sql.includes(`'${TEAM_ID}'::uuid`),
     "register-plugins did not write the resolved team as owner_team_id and as the plugin's one " +
     "zz.plugin_release_owner row");
  is(/insert into zz\.plugin_release_owner \(plugin_id, team_id\)/.test(sql),
     "register-plugins did not write a zz.plugin_release_owner row, so the plugin has an owner " +
     "team nobody can release under");

  const bad = drive(`import { writeRegistries } from "./scripts/release/registries.ts";
    console.log("FAILURES=" + JSON.stringify(writeRegistries("${SENTINEL}")));`, { FAKE_PSQL_FAILS: "1" });
  const failures = JSON.parse(/FAILURES=(.*)/.exec(bad)?.[1] ?? "[]") as string[];
  is(failures.length === 1 && /register-plugins failed/.test(failures[0]) && /connection refused/.test(failures[0]),
     `a register-plugins that fails is not returned as a failure with its own reason: ${JSON.stringify(failures)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const rel = readFileSync("scripts/release.ts", "utf8");
const resolved = rel.indexOf("catalogOwnerTeam()");
const refused = rel.indexOf("no ZZ_CATALOG_OWNER_TEAM");
const deploy = rel.indexOf('step(4, "deploy")');
is(resolved > 0 && refused > resolved && refused < deploy,
   "release.ts does not resolve the owner team and refuse without it before step 4");
const written = rel.indexOf("writeRegistries(ownerTeam)");
// DELIBERATE: the claim, not a spelling of it. What has to hold is that `registryFailures` is
// counted in the array the rollback reads — pinned to one exact line, this reported a correct
// release as broken the moment a second contributor joined that array (the one-shot data step).
const problemsLine = /const problems = \[([^\]]*)\]/.exec(rel);
const counted = problemsLine && /\bregistryFailures\b/.test(problemsLine[1])
  ? rel.indexOf(problemsLine[0])
  : -1;
const rolled = rel.indexOf("/* 6 · roll back if verification failed */");
is(written > 0 && counted > written && counted < rolled,
   "release.ts does not count writeRegistries' failures among step 5's problems before the rollback");

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("ok release-plugin-owners");
