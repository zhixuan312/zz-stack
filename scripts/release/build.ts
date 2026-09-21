

/**
 * Building the images, and proving they answer before anything is pushed.
 *
 * A release that only proves its own images BUILD has proved the easy half. Each service is
 * started from the image that is about to ship and asked a real question — the platform comes
 * up, the catalog is in it, the migrations apply to an empty database, and every SQL literal
 * is one Postgres agreed to PREPARE against the schema those migrations leave behind.
 *
 * Takes what step 1 established — whether the console is moving with this release — as an
 * argument rather than reading it from a shared scope, because a function that depends on
 * the caller's variables is a step that only runs in one order.
 * Returns the deploy bundle, which is the only thing the later steps need from here. The
 * dry-run exit is NOT here: stopping the release is the release's decision, and leaving it in
 * this file put every git write in a different file from the guard that precedes them, which
 * the check holding that order said so about.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";

import { DASH_IMAGE, DASH_SRC, IMAGE, PLATFORM, die, log, reapLeaked, root, run, step } from "../deployment.ts";
import { dryRun, version } from "./config.ts";
import { postgresService } from "./postgres-service.ts";
import type { DashboardResolution } from "./dashboard.ts";
import { walkToolChain } from "./tool-chain.ts";

export function buildAndSmoke({ dash, dashVersion }: { dash: DashboardResolution; dashVersion: string | null }): string {
  step(2, "build and smoke the images");
  // THE Dockerfile, the same one docker-compose.build.yml builds from. This named
  // deploy/ts.Dockerfile — a second recipe for the same image, and the two had drifted where
  // it mattered most: the root one installs git and says why (commitStore never throws, so
  // without it every document write succeeds, logs `git_failed`, and leaves a team's store
  // with no history), and ts.Dockerfile did not. So development built an image that could
  // commit and the RELEASE built one that could not. The gate's own check for that reads the
  // root Dockerfile, so it passed while guarding a file production was not built from.
  run("docker", ["build", "--platform", PLATFORM, "-f", "Dockerfile", "-t", `${IMAGE}:${version}`, "."], { cwd: root });
  log(`  built ${IMAGE}:${version}`);
  // AN ALREADY-PUBLISHED COMPONENT IS PULLED, NOT BUILT — here and in the push step below.
  // Nothing about it changed, its image exists, and the only thing a rebuild could do is
  // replace the bits behind a number another deployment has already pulled.
  //
  // The dry run still needs the image LOCALLY, because the smoke starts every service from
  // what is on this machine. It happens to be here today, left over from the release that
  // published it; on any other laptop it would not be, and the smoke would fail on a release
  // that is fine. So pull it.
  for (const [v, image, pub] of [[dashVersion, DASH_IMAGE, dash.alreadyPublished]]) {
    if (!v || !pub) continue;
    run("docker", ["pull", "--platform", PLATFORM, "-q", `${image}:${v}`]);
    log(`  pulled ${image}:${v} — already published, not rebuilt`);
  }

  if (dashVersion && !dash.alreadyPublished) {
    // The console's version lives in package.json and in its own compose literal, and they move
    // together for the same reason zz-stack's do: the compose file and the image it names are
    // one release, and a person receiving it has no way to know what to type.
    if (dash.current !== dashVersion) {
      const edits: [string, RegExp, string][] = [
        [join(DASH_SRC, "package.json"), /"version":\s*"[^"]*"/, `"version": "${dashVersion}"`],
        [join(DASH_SRC, "docker-compose.yml"), /ZZ_DASHBOARD_VERSION:-[0-9][^}]*\}/, `ZZ_DASHBOARD_VERSION:-${dashVersion}}`],
      ];
      const before = new Map(edits.map(([f]) => [f, readFileSync(f, "utf8")]));
      for (const [f, re, to] of edits) {
        // Read directly above, from this same `edits` array — always present.
        const was = before.get(f)!;
        const now = was.replace(re, to);
        // A replace that matched nothing returns the input, so the version would move in one
        // file and not the other and the release would ship an image whose compose literal
        // names a different one, which is why this pair asserts that each replace matched.
        if (now === was) die(`could not set the version in ${f}: nothing matched ${re}`);
        writeFileSync(f, now);
      }
      // Restored from what was READ, never with `git checkout` — a checkout would take
      // anything else uncommitted in that tree down with it. resolveDashboard already refused
      // a dirty tree, so today there is nothing else to lose; the next person to relax that
      // refusal should not have to notice this line to keep it true.
      if (dryRun) {
        process.on("exit", () => {
          for (const [f, txt] of before) { try { writeFileSync(f, txt); } catch { /* nothing to put back */ } }
        });
      }
      // Two statements, not an `else`. The gate reads this file as TEXT and looks for
      // `if (!dryRun)` within six lines above any git write — so an `else` branch that is
      // genuinely correct still reads to it as an unguarded commit, and it said so. Writing
      // the guard the way the check can see it is cheaper than a check that has to parse.
      if (!dryRun) {
        run("git", ["add", "package.json", "docker-compose.yml"], { cwd: DASH_SRC });
        run("git", ["commit", "-m", `zz-stack-dashboard ${dashVersion}`], { cwd: DASH_SRC });
      }
      log(`  console version ${dash.current} -> ${dashVersion}`
          + (dryRun ? " (on disk only, restored at exit)" : ""));
    }
    run("docker", ["build", "--platform", PLATFORM, "-t", `${DASH_IMAGE}:${dashVersion}`, "."], { cwd: DASH_SRC });
    log(`  built ${DASH_IMAGE}:${dashVersion}`);
  }

  // One image, several services — so every service has to start from it. This is the
  // check that catches an image whose SERVICE switch broke, before it reaches anyone.
  const serviceSmoke: [string, string, string[]][] = [
    [`${IMAGE}:${version}`, "SERVICE", ["gateway", "zz-core"]],
  ];
  for (const [img, envVar, values] of serviceSmoke) {
    for (const v of values) {
      const cid = run("docker", ["run", "-d", "-e", `${envVar}=${v}`, img]);
      execSync("sleep 4");
      const logs = run("docker", ["logs", cid], { stdio: ["ignore", "pipe", "pipe"] });
      const alive = run("docker", ["inspect", "-f", "{{.State.Running}}", cid]);
      run("docker", ["rm", "-f", cid]);
      if (alive !== "true") die(`${img} with ${envVar}=${v} exited:\n${logs.slice(-400)}`);
      log(`  ${envVar}=${v} starts`);
    }
  }

  // The catalog is inside the image now, so a released image that lost it would serve a
  // platform with no skills at all — and nothing downstream would notice until a user
  // asked for one.
  const catalogCheck = run("docker", ["run", "--rm", `${IMAGE}:${version}`, "sh", "-c",
    "ls /catalog | wc -l; ls /skills | wc -l"]).split("\n").map(Number);
  if (!(catalogCheck[0] > 0 && catalogCheck[1] > 0)) {
    die(`image ships an empty catalog (${catalogCheck[0]} owners) or no skills (${catalogCheck[1]})`);
  }
  log(`  image carries ${catalogCheck[0]} catalog owners, ${catalogCheck[1]} platform skills`);

  // And carries no TypeScript. This repository is private and every deploy host pulls this
  // image, so a source tree inside it hands the codebase to anyone who can pull a tag. The
  // Dockerfile prunes in the BUILD stage for that reason — a `find -delete` in the runtime
  // stage looks identical from inside a running container and changes nothing, because layers
  // are additive and `docker save` still has the files. Asserted from OUTSIDE a layer's
  // illusion is not possible here, so this checks the filesystem the services actually see
  // and the Dockerfile comment carries the rest.
  const sourceInImage = Number(run("docker", ["run", "--rm", "--entrypoint", "sh", `${IMAGE}:${version}`,
    "-c", "find /repo/packages /repo/services -name '*.ts' | wc -l"]).trim() || "0");
  if (sourceInImage) die(`the image ships ${sourceInImage} TypeScript source file(s); nothing at ` +
                         "runtime reads one and this repository is private");
  log("  image ships no TypeScript source");

  /* Every query in the release, asked of a real Postgres before anything is pushed.
   *
   * 0.4.0 is why. It shipped a `select distinct` ordered by a column it did not project —
   * error 42P10, raised when Postgres PARSES the statement, so the query never ran and /pkg
   * answered 500 to every caller on all three clients. The gate is offline and cannot run SQL.
   * The service-start smoke above passes, because the gateway starts perfectly and only fails
   * when the route is called. Verification caught it, which is what verification is for, but
   * by then the images were pushed and the version was spent.
   *
   * An EMPTY database is a complete oracle here: PREPARE resolves every table, column and rule
   * without touching a row. So this costs a throwaway postgres and a few seconds, and it runs
   * in the dry run too — which is the whole point, since a dry run that cannot fail this way
   * is a rehearsal of a different release.
   *
   * The gateway migrates it, rather than this script applying the files itself. That reuses the
   * real boot path instead of writing a second one, and it means an empty-database migration
   * run is now exercised on every release — which nothing did before.
   */
  {
    const pg = `zz-sqlcheck-pg-${process.pid}`, gw = `zz-sqlcheck-gw-${process.pid}`;
    const drop = () => {
      for (const c of [gw, pg]) {
        try { run("docker", ["rm", "-f", c], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* already gone */ }
      }
    };
    // Registered BEFORE anything starts. A die() between here and the teardown below would
    // otherwise leave two containers running on whoever ran the release.
    process.on("exit", drop);
    // And an exit handler does not run when the process is killed, so a previous release's
    // containers are reaped by name first — see reapLeaked() for the twelve-day-old pair that
    // showed this was not theoretical.
    reapLeaked("zz-sqlcheck-");
    const pgsvc = postgresService(root);
    run("docker", ["run", "-d", "--name", pg, "-e", "POSTGRES_USER=zz",
                   "-e", "POSTGRES_PASSWORD=sqlcheck", "-e", "POSTGRES_DB=zz",
                   pgsvc.image, ...pgsvc.command]);
    for (let i = 0; ; i++) {
      try { run("docker", ["exec", pg, "pg_isready", "-U", "zz", "-d", "zz"]); break; } catch {
        if (i > 60) die("the throwaway postgres never became ready");
        execSync("sleep 1");
      }
    }
    run("docker", ["run", "-d", "--name", gw, "--link", `${pg}:postgres`, "-e", "SERVICE=gateway",
                   "-e", "TEAM_DB_URL=postgresql://zz:sqlcheck@postgres:5432/zz",
                   "-e", "GATEWAY_PUBLIC_URL=https://sql-check.invalid", `${IMAGE}:${version}`]);
    const migrationFiles = readdirSync(join(root, "services/gateway/migrations")).filter((f) => f.endsWith(".sql"));
    // EVERY MIGRATION APPLIES, and a deferral here is a release-blocking failure.
    //
    // This used to expect fewer. A migration may declare `-- requires-extension: <name>`, and
    // `db.ts` DEFERS it when the cluster cannot supply that extension — skipped, deliberately
    // not recorded as applied, and left for the first boot on a cluster that can. That is the
    // right behaviour for the runner: a migration attempted where its extension is absent
    // throws, rolls back, un-sets the pool and rethrows, and the caller starts the server
    // anyway, which is the platform serving with no database while reporting itself healthy.
    //
    // It was the wrong bar for a RELEASE, because the throwaway Postgres was
    // `postgres:16-alpine` while the deployment ran an image built to carry pg_textsearch. So
    // the rehearsal deferred 070 and 071 every time, the search partitions and the BM25 index
    // were never created here, and `sql-check` went on to EXCUSE every query that named a
    // relation those migrations would have made. The release reported a pass over exactly the
    // DDL nobody had checked. The old code even counted the deferral correctly — the
    // arithmetic was right and the database was wrong.
    //
    // This now starts the image `deploy/docker-compose.yml` names, so the rehearsal's cluster
    // and the deployment's cluster offer the same extensions. Nothing may be deferred there:
    // if it is, the deployment will defer it too, and the operator should hear that from the
    // release rather than from a production boot.
    const migrations = migrationFiles.length;
    let applied = 0;
    for (let i = 0; ; i++) {
      // In a try, because for the first few seconds this asks about a table the gateway has
      // not created yet and psql exits non-zero — which is the loop's normal state, not its
      // failure. Reading that as fatal is what made the first version of this die instantly.
      try {
        applied = Number(run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc",
                                        "select count(*) from zz.schema_migration"]).trim() || "0");
      } catch { applied = 0; }
      if (applied >= migrations) break;
      if (i > 90) {
        // NAME THE MIGRATIONS, not just the shortfall. The commonest way to arrive here is now
        // a deferral — a migration declaring an extension the deployment's own image does not
        // carry — and "applied 69 of 71" sends the reader to the logs to work out which two
        // and why. Ask the database which ones it recorded, diff, and print each missing file
        // beside whatever extension it declares.
        let recorded = new Set<string>();
        try {
          recorded = new Set(run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc",
                                            "select name from zz.schema_migration"]).trim().split("\n"));
        } catch { /* the database may not be answering at all; the log below still says so */ }
        const missing = [...migrationFiles].sort().filter((f) => !recorded.has(f)).map((f) => {
          const needs = /^--\s*requires-extension:\s*([a-z0-9_]+)\s*$/im
            .exec(readFileSync(join(root, "services/gateway/migrations", f), "utf8"))?.[1];
          return `    ${f}${needs ? ` — declares ${needs}, which ${pgsvc.image} did not supply` : ""}`;
        });
        const why = run("docker", ["logs", "--tail", "20", gw], { stdio: ["ignore", "pipe", "pipe"] });
        die(`the gateway applied ${applied} of ${migrations} migrations to an empty database.\n`
            + `  Not applied:\n${missing.join("\n")}\n`
            + "  A migration deferred against the deployment's OWN image will be deferred in the\n"
            + "  deployment too. Either the image must carry the extension, or the migration must not\n"
            + `  declare it.\n${why}`);
      }
      execSync("sleep 1");
    }
    log(`  all ${migrations} migrations apply to an empty ${pgsvc.image}, none deferred`);
    try {
      // The host's build, because the image has the sources but no psql to reach the database
      // with. The tree is clean and on master by now, so these ARE the release's queries.
      run("npm", ["run", "--silent", "build"], { cwd: root });
      execFileSync("node", [join(root, "packages/tools/dist/testing/sql-check.js"),
                            "--psql", `docker exec -i ${pg} psql -U zz -d zz`],
                   { cwd: root, stdio: "inherit" });
    } catch { die("a query in this release is one Postgres refuses to run"); }
    drop();
    process.removeListener("exit", drop);
  }

  /* And the ACTS, on the same image, before anything is published.
   *
   * sql-check above proves every statement resolves; this proves the tools built on them still
   * behave the way this release says they do. It is the check that was only ever run against
   * production — see tool-chain.ts for the two rollbacks that bought it. */
  walkToolChain(version);

  /* The deploy bundle: everything a person needs to run this release and nothing else.
   * The compose file already names this release's images as literals, so the bundle is
   * self-describing — you can tell which version you were handed by reading it. */
  const bundle = `dist/release/zz-stack-deploy-${version}.tgz`;

  /* The bundle is the front end's configuration, not a script that mutates it.
   *
   * A release used to regenerate agent prompts from the catalog and tar them beside a
   * bootstrap script that wrote them into the front end's database. Prompts now come from
   * the registry at provisioning time (render_agent_definition), so there is nothing to
   * pre-generate and nothing to keep in step: what ships is the compose file, the example
   * environment, and the scripts an operator runs by hand. */

  /* backup.sh and install-backup-cron.sh ship too, and did not until 0.4.2.
   *
   * deploy/README.md's Day-2 section opens "Every command below runs from deploy/, which is
   * what the release bundle unpacks to" and then tells an operator to run both of them. They
   * were not in the tar. A bundle recipient — the whole no-repository install path this file
   * exists to produce — therefore had no way to back the platform up and nothing saying so,
   * while backup.sh's own header calls one of the four things it captures the one nobody can
   * reconstruct. The gate check named "the deploy bundle carries everything the install steps
   * use" could not see it: it retyped the list instead of reading the install steps. */
  run("bash", ["-c",
    `mkdir -p dist/release && cd deploy && tar czf ../${bundle} docker-compose.yml .env.example issue-first-pat.sh issue-enrolment.sh zz-tool backup.sh install-backup-cron.sh`],
    { cwd: root });
  // What the installer's first three commands need, checked in the artifact rather than
  // assumed from the command that made it. deploy/.env.example was gitignored for most of
  // this repo's life — last-match-wins in .gitignore — so a release cut from a clean clone
  // would have tarred a bundle without the file `cp .env.example .env` reads.
  const packed = run("bash", ["-c", `tar tzf ${bundle}`], { cwd: root }).split("\n");
  for (const need of ["docker-compose.yml", ".env.example",
                      "issue-first-pat.sh", "zz-tool", "backup.sh", "install-backup-cron.sh"]) {
    if (!packed.some((f) => f === need || f === `./${need}`)) {
      die(`the deploy bundle is missing ${need} — the install instructions would fail on it`);
    }
  }
  // There is deliberately NO check for prompts in the bundle. There used to be, and it
  // outlived what it guarded: prompts come from the registry at provisioning time now
  // (render_agent_definition), the tar above ships none on purpose, and the check demanded
  // them anyway — so every release failed here. The files it was looking for,
  // deploy/bootstrap/*-system-prompt.md, were inputs to a bootstrap script deleted with the
  // old front end, and had already drifted from the catalog copies that are actually used.
  const bundleSize = run("bash", ["-c", `du -h ${bundle} | cut -f1`], { cwd: root });
  log(`  deploy bundle: ${bundle} (${bundleSize}) — compose + .env.example + every script deploy/README tells an operator to run`);


  return bundle;
}
