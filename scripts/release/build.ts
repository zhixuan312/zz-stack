

/**
 * Building the images, and proving they answer before anything is pushed.
 *
 * Each service is started from the image about to ship and asked a real question: the platform
 * comes up, the catalog is in it, the migrations apply to an empty database, and every SQL
 * literal is one Postgres agreed to PREPARE against the schema those migrations leave behind.
 *
 * Takes whether the console is moving with this release as an argument rather than reading a
 * shared scope, and returns the deploy bundle. The dry-run exit is not here: stopping the
 * release is the release's decision, and a gate check holds every git write in the same file as
 * the guard that precedes it.
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
  // The root Dockerfile, the same one docker-compose.build.yml builds from. It installs git,
  // without which commitStore never throws and every document write succeeds, logs
  // `git_failed`, and leaves a team's store with no history. COUPLED: the gate check for that
  // reads this same file.
  run("docker", ["build", "--platform", PLATFORM, "-f", "Dockerfile", "-t", `${IMAGE}:${version}`, "."], { cwd: root });
  log(`  built ${IMAGE}:${version}`);
  // An already-published component is pulled, not built — here and in the push step below.
  // Nothing about it changed, and a rebuild would replace the bits behind a number another
  // deployment has already pulled. The dry run still needs the image locally, because the smoke
  // starts every service from what is on this machine.
  for (const [v, image, pub] of [[dashVersion, DASH_IMAGE, dash.alreadyPublished]]) {
    if (!v || !pub) continue;
    run("docker", ["pull", "--platform", PLATFORM, "-q", `${image}:${v}`]);
    log(`  pulled ${image}:${v} — already published, not rebuilt`);
  }

  if (dashVersion && !dash.alreadyPublished) {
    // COUPLED: the console's version lives in package.json and in its own compose literal, and
    // they move together — the compose file and the image it names are one release.
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
        // A replace that matched nothing returns the input, so each replace asserts it matched:
        // otherwise the version moves in one file and not the other.
        if (now === was) die(`could not set the version in ${f}: nothing matched ${re}`);
        writeFileSync(f, now);
      }
      // Restored from what was read, never with `git checkout` — a checkout would take anything
      // else uncommitted in that tree down with it.
      if (dryRun) {
        process.on("exit", () => {
          for (const [f, txt] of before) { try { writeFileSync(f, txt); } catch { /* nothing to put back */ } }
        });
      }
      // COUPLED: two statements, not an `else`. The gate reads this file as text and looks for
      // `if (!dryRun)` within six lines above any git write, so an `else` branch reads to it as
      // an unguarded commit.
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

  // One image, several services, so every service has to start from it — this catches an image
  // whose service switch broke.
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

  // The catalog is inside the image, so a released image that lost it would serve a platform
  // with no skills and nothing downstream would notice.
  const catalogCheck = run("docker", ["run", "--rm", `${IMAGE}:${version}`, "sh", "-c",
    "ls /catalog | wc -l; ls /skills | wc -l"]).split("\n").map(Number);
  if (!(catalogCheck[0] > 0 && catalogCheck[1] > 0)) {
    die(`image ships an empty catalog (${catalogCheck[0]} owners) or no skills (${catalogCheck[1]})`);
  }
  log(`  image carries ${catalogCheck[0]} catalog owners, ${catalogCheck[1]} platform skills`);

  // And carries no TypeScript: this repository is private and every deploy host pulls this
  // image. The Dockerfile prunes in the build stage — a `find -delete` in the runtime stage
  // looks identical from inside a container and changes nothing, because layers are additive
  // and `docker save` still has the files. This checks the filesystem the services see.
  const sourceInImage = Number(run("docker", ["run", "--rm", "--entrypoint", "sh", `${IMAGE}:${version}`,
    "-c", "find /repo/packages /repo/services -name '*.ts' | wc -l"]).trim() || "0");
  if (sourceInImage) die(`the image ships ${sourceInImage} TypeScript source file(s); nothing at ` +
                         "runtime reads one and this repository is private");
  log("  image ships no TypeScript source");

  /* Every query in the release, asked of a real Postgres before anything is pushed.
   *
   * A statement that fails at parse time — an ordered `select distinct` over an unprojected
   * column, say — never runs, so the gateway starts perfectly and only fails when the route is
   * called. The gate is offline and cannot run SQL, and the service-start smoke above passes.
   *
   * An empty database is a complete oracle: PREPARE resolves every table, column and rule
   * without touching a row. It runs in the dry run too, since a dry run that cannot fail this
   * way is a rehearsal of a different release.
   *
   * The gateway migrates it rather than this script applying the files, which reuses the real
   * boot path and exercises an empty-database migration run on every release.
   */
  {
    const pg = `zz-sqlcheck-pg-${process.pid}`, gw = `zz-sqlcheck-gw-${process.pid}`;
    const drop = () => {
      for (const c of [gw, pg]) {
        try { run("docker", ["rm", "-f", c], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* already gone */ }
      }
    };
    // Registered before anything starts. A die() between here and the teardown below would
    // otherwise leave two containers running on whoever ran the release.
    process.on("exit", drop);
    // An exit handler does not run when the process is killed, so a previous release's
    // containers are reaped by name first.
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
    // Every migration applies, and a deferral here is a release-blocking failure.
    //
    // A migration may declare `-- requires-extension: <name>`, and `db.ts` defers it when the
    // cluster cannot supply that extension. That is right for the runner and wrong for a
    // release: a deferred migration means the relations it creates are absent, and `sql-check`
    // then excuses every query that names one of them.
    //
    // This starts the image `deploy/docker-compose.yml` names, so the rehearsal's cluster offers
    // the same extensions as the deployment's. Nothing may be deferred there: if it is, the
    // deployment will defer it too.
    const migrations = migrationFiles.length;
    let applied = 0;
    for (let i = 0; ; i++) {
      // In a try, because for the first few seconds this asks about a table the gateway has not
      // created yet and psql exits non-zero — the loop's normal state, not its failure.
      try {
        applied = Number(run("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc",
                                        "select count(*) from zz.schema_migration"]).trim() || "0");
      } catch { applied = 0; }
      if (applied >= migrations) break;
      if (i > 90) {
        // Name the migrations, not just the shortfall: the commonest cause is a deferral, and
        // "applied 1 of 2" sends the reader to the logs. Ask the database which ones it
        // recorded, diff, and print each missing file beside whatever extension it declares.
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
      // with. The tree is clean and on master by now, so these are the release's queries.
      run("npm", ["run", "--silent", "build"], { cwd: root });
      execFileSync("node", [join(root, "packages/tools/dist/testing/sql-check.js"),
                            "--psql", `docker exec -i ${pg} psql -U zz -d zz`],
                   { cwd: root, stdio: "inherit" });
    } catch { die("a query in this release is one Postgres refuses to run"); }
    drop();
    process.removeListener("exit", drop);
  }

  /* And the acts, on the same image, before anything is published. sql-check above proves every
   * statement resolves; this proves the tools built on them still behave the way this release
   * says they do. */
  walkToolChain(version);

  /* The deploy bundle: everything a person needs to run this release and nothing else.
   * The compose file already names this release's images as literals, so the bundle is
   * self-describing — you can tell which version you were handed by reading it. */
  const bundle = `dist/release/zz-stack-deploy-${version}.tgz`;

  /* What ships is the compose file, the example environment, and the scripts an operator runs
   * by hand.
   *
   * COUPLED: backup.sh and install-backup-cron.sh ship too, because deploy/README.md's Day-2
   * section tells an operator to run both from the directory this bundle unpacks to. */
  run("bash", ["-c",
    `mkdir -p dist/release && cd deploy && tar czf ../${bundle} docker-compose.yml .env.example issue-first-pat.sh issue-enrolment.sh zz-tool backup.sh install-backup-cron.sh`],
    { cwd: root });
  // What the installer's first three commands need, checked in the artifact rather than assumed
  // from the command that made it.
  const packed = run("bash", ["-c", `tar tzf ${bundle}`], { cwd: root }).split("\n");
  for (const need of ["docker-compose.yml", ".env.example",
                      "issue-first-pat.sh", "zz-tool", "backup.sh", "install-backup-cron.sh"]) {
    if (!packed.some((f) => f === need || f === `./${need}`)) {
      die(`the deploy bundle is missing ${need} — the install instructions would fail on it`);
    }
  }
  const bundleSize = run("bash", ["-c", `du -h ${bundle} | cut -f1`], { cwd: root });
  log(`  deploy bundle: ${bundle} (${bundleSize}) — compose + .env.example + every script deploy/README tells an operator to run`);

  return bundle;
}
