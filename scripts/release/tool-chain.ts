/**
 * Walk the tool chain against the image being released, before anything is pushed.
 *
 * `chain-check` proves the acts a flow is made of — write, approve, revise, close — and it needs
 * a live deployment, so the offline gate cannot run it. Run only after the deployment switched,
 * it reports a contract change against the deployment that has already replaced it.
 *
 * So the whole platform is stood up here from the image under test — postgres, zz-core, the
 * gateway — a token is minted the way a fresh install mints its first one, and the chain is
 * walked against that. Nothing touches the deployment and nothing is published.
 *
 * It is the same binary the release runs afterwards against the live deployment: this proves the
 * code, that proves the deployment.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { IMAGE, die, log, reapLeaked, root, run } from "../deployment.ts";
import { postgresService } from "./postgres-service.ts";

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
  // Registered before anything starts, like the sql-check stack: a die() between here and the
  // teardown would otherwise leave three containers running on whoever ran the release.
  process.on("exit", drop);
  // An exit handler cannot run when the process is killed outright, so anything a previous
  // release left under this prefix goes first. See reapLeaked().
  reapLeaked("zz-chain-");
  try {
    // A network, not links, because two of these names are load-bearing: zz-core answers only
    // the hosts in TRUSTED_PEERS, which defaults to `cred-proxy`, and the gateway reaches
    // zz-core at `zz-core`. A `--link` alias reaches only the container that declares it; on a
    // network every alias resolves for everybody, as the deployment's own compose network does.
    run("docker", ["network", "create", net]);
    // The deployment's own database image, read from compose (postgres-service.ts): a cluster
    // offering different extensions walks a chain the deployment does not have. Its command
    // comes too — the image ships `shared_buffers = 8GB` and compose cuts that down to
    // something a release host can map.
    const pgsvc = postgresService(root);
    run("docker", ["run", "-d", "--name", pg, "--network", net, "--network-alias", "postgres",
                   "-e", "POSTGRES_USER=zz", "-e", "POSTGRES_PASSWORD=chaincheck",
                   "-e", "POSTGRES_DB=zz", pgsvc.image, ...pgsvc.command]);
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

    // The gateway migrates and seeds, and both have to be finished before a token means
    // anything: the principal this mints for is created by that seed.
    waitFor("the gateway's own boot", () => {
      try {
        return run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc",
                              `select count(*) from zz.principal where email = '${OPERATOR}'`]).trim() === "1";
      } catch { return false; }
    });

    // COUPLED: the same row a fresh install writes — deploy/issue-first-pat.sh mints exactly
    // this, because `pat_issue` needs a token to issue one and a new deployment has none. When
    // that script and this disagree, the bootstrap is broken and nothing else would say so.
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
