/**
 * Walk the tool chain against THE IMAGE BEING RELEASED, before anything is pushed.
 *
 * WHY THIS EXISTS, in two rollbacks. `chain-check` proves the acts a flow is made of — write,
 * approve, revise, close — and it needs a live deployment, so the offline gate cannot run it
 * and it ran for the first time against PRODUCTION, after the images were pushed and the
 * deployment switched. Twice in two days a release changed a contract the check still asserted
 * the old half of: 0.44 stopped stamping a status on an ungated document and stopped letting
 * one be approved, and 0.46 made closing the sign-off. Both were correct changes. Both were
 * found by a probe running against the deployment they had already replaced, and one of them
 * could not be rolled back because a migration had dropped a table underneath it.
 *
 * A dry run that cannot fail the way the release fails is a rehearsal of a different release.
 * So the whole platform is stood up here from the image under test — postgres, zz-core, the
 * gateway — a token is minted the way a fresh install mints its first one, and the chain is
 * walked against that. Nothing touches the deployment, nothing is published, and a contract
 * the check no longer matches is a local failure a minute into the release.
 *
 * It is the same binary the release runs afterwards against the live deployment: this proves
 * the code, that proves the deployment, and neither replaces the other.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { IMAGE, die, log, root, run } from "../deployment.ts";

/** A throwaway name per process, so two releases on one machine cannot collide. */
const tag = (what: string): string => `zz-chain-${what}-${process.pid}`;

/** The superadmin the gateway seeds from its environment on boot, and whose token this mints.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real address — this principal exists
 * for the length of one release, in a database that is dropped after it. */
const OPERATOR = "chain-check@zz.invalid";

function waitFor(what: string, attempt: () => boolean, limit = 90): void {
  for (let i = 0; ; i++) {
    if (attempt()) return;
    if (i > limit) die(`the release's own stack never became ready: ${what}`);
    execFileSync("sleep", ["1"]);
  }
}

export function walkToolChain(version: string | undefined): void {
  if (!version) die("no version to walk the tool chain against");
  const net = tag("net"), pg = tag("pg"), core = tag("core"), gw = tag("gw");
  const drop = (): void => {
    for (const c of [gw, core, pg]) {
      try { run("docker", ["rm", "-f", c], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* already gone */ }
    }
    try { run("docker", ["network", "rm", net], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* already gone */ }
  };
  // Registered BEFORE anything starts, like the sql-check stack: a die() between here and the
  // teardown would otherwise leave three containers running on whoever ran the release.
  process.on("exit", drop);
  try {
    // A NETWORK, NOT LINKS, because two of these names are load-bearing. zz-core answers only
    // the hosts in TRUSTED_PEERS, which defaults to `cred-proxy` — the compose service name the
    // gateway still runs under — and the gateway reaches zz-core at `zz-core`. A `--link` alias
    // reaches only the container that declares it, so zz-core could not have resolved the peer
    // it was asked to trust. On a network every alias resolves for everybody, which is what the
    // deployment's own compose network does.
    run("docker", ["network", "create", net]);
    run("docker", ["run", "-d", "--name", pg, "--network", net, "--network-alias", "postgres",
                   "-e", "POSTGRES_USER=zz", "-e", "POSTGRES_PASSWORD=chaincheck",
                   "-e", "POSTGRES_DB=zz", "postgres:16-alpine"]);
    waitFor("postgres", () => {
      try { run("docker", ["exec", pg, "pg_isready", "-U", "zz", "-d", "zz"]); return true; } catch { return false; }
    }, 60);

    const db = "postgresql://zz:chaincheck@postgres:5432/zz";
    run("docker", ["run", "-d", "--name", core, "--network", net, "--network-alias", "zz-core",
                   "-e", "SERVICE=zz-core", "-e", `TEAM_DB_URL=${db}`, `${IMAGE}:${version}`]);
    run("docker", ["run", "-d", "--name", gw, "--network", net, "--network-alias", "cred-proxy",
                   "-e", "SERVICE=gateway", "-e", `TEAM_DB_URL=${db}`,
                   "-e", `SUPERADMIN_EMAIL=${OPERATOR}`,
                   "-e", "GATEWAY_PUBLIC_URL=http://127.0.0.1:0",
                   "-p", "127.0.0.1:0:8000", `${IMAGE}:${version}`]);
    const port = run("docker", ["port", gw, "8000/tcp"]).trim().split("\n")[0].split(":").pop();
    if (!port) die("the release's own gateway published no port to walk the chain against");
    const base = `http://127.0.0.1:${port}`;

    // THE GATEWAY MIGRATES AND SEEDS, and both have to be finished before a token means
    // anything: the principal this mints for is created by that seed.
    waitFor("the gateway's own boot", () => {
      try {
        return run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc",
                              `select count(*) from zz.principal where email = '${OPERATOR}'`]).trim() === "1";
      } catch { return false; }
    });

    // The same row a fresh install writes — deploy/issue-first-pat.sh mints exactly this,
    // because `pat_issue` needs a token to issue one and a new deployment has none. When that
    // script and this disagree, the bootstrap is broken and nothing else would say so: this
    // found `scope` still named here after the column was dropped.
    const token = `zzp_${randomBytes(24).toString("hex")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-q", "-c",
                   `insert into zz.pat (principal_id, token_hash, label)
                      select id, '${hash}', 'release chain-check'
                      from zz.principal where email = '${OPERATOR}'`]);

    log("  walking the tool chain against this release's own image");
    execFileSync("node", [join(root, "packages/tools/dist/testing/chain-check.js")],
                 { cwd: root, stdio: "inherit",
                   env: { ...process.env, ZZ_GATEWAY: base, ZZ_PAT: token } });
    log("  every act in the chain behaves as this release's own code says it does");
  } catch {
    // The chain check prints its own FAILED lines, each naming the rule and the tool. Restating
    // "it exited nonzero" over the top of that would bury the only useful part.
    die("the tool chain does not hold on this release's image — nothing was pushed");
  } finally {
    drop();
    process.removeListener("exit", drop);
  }
}
