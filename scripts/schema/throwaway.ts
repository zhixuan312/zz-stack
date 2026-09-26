/**
 * A throwaway PostgreSQL, migrated the way the gateway itself migrates one, handed to a
 * caller as a single client and always torn down afterwards — the one starting point
 * `scripts/schema-target-extract.ts`, the schema gate check and the rehearsal all share.
 *
 * The container runs the exact image and command `deploy/docker-compose.yml` ships
 * (`scripts/release/postgres-service.ts` reads it), so the catalog this produces is the one a
 * real deployment would end up with. Migrations are applied by `initPlatformDb` from
 * `services/gateway/src/db.ts` — imported from its built `dist`, because that file's own
 * relative imports use the `.js` extension convention `tsc` rewrites, which Node's type
 * stripping does not resolve back to a `.ts` file. That function's pool is a module-level
 * singleton (one migration run per process), so this only ever calls it once.
 *
 * DELIBERATE: refuses outright if `PLATFORM_DB_URL` or `TEAM_DB_URL` is already set in this
 * process's environment before it starts anything. `initPlatformDb` reads whichever of the two
 * is set and migrates it — a caller that inherited either from a sourced `.env` or a real
 * deployment's shell would silently point every migration this module runs at that database
 * instead of the container below. This module only ever hands a caller a URL it minted itself.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { root } from "../deployment.ts";
import { postgresService } from "../release/postgres-service.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitReady(container: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      run("docker", ["exec", container, "pg_isready", "-U", "zz", "-d", "zz"]);
      return;
    } catch {
      if (i > 60) throw new Error(`the throwaway postgres (${container}) never became ready`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * `pg_isready` above runs inside the container and answers as soon as the server accepts a
 * local connection — including the brief server the official image starts on its own to run
 * `initdb`'s bootstrap, before it restarts listening on the port compose actually maps out.
 * A connection from the host, on the mapped port, is the one that matters here.
 */
async function waitReachable(url: string): Promise<void> {
  for (let i = 0; ; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch (err) {
      if (i > 60) throw new Error(`the throwaway postgres never became reachable on ${url}: ${String(err)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      await client.end().catch(() => { /* never connected */ });
    }
  }
}

/**
 * Starts a throwaway PostgreSQL, migrates it and hands `fn` a client connected to it with an
 * empty `search_path` — so `pg_get_constraintdef`, `pg_get_indexdef` and `format_type` always
 * render `zz.*` names fully qualified, regardless of what search_path a caller's own session
 * would otherwise have carried. The container is removed when `fn` returns, throws, or is
 * killed by anything else that runs first — always, including on failure.
 *
 * `beforeMigrate`, when given, runs once the container is reachable and before `initPlatformDb`
 * migrates it — `scripts/rehearse.ts`'s one caller for this: it restores a production dump into
 * the empty container there, so the real runner then migrates a production copy instead of an
 * empty database. Every other caller leaves it out and gets exactly the behaviour above.
 */
export async function withThrowawayDb<T>(
  fn: (client: pg.Client) => Promise<T>,
  beforeMigrate?: (url: string) => Promise<void>,
): Promise<T> {
  const preset = process.env.PLATFORM_DB_URL ? "PLATFORM_DB_URL" : process.env.TEAM_DB_URL ? "TEAM_DB_URL" : null;
  if (preset) {
    throw new Error(`${preset} is already set in this process's environment — ` +
      "withThrowawayDb only ever migrates a container it starts itself, never a URL handed to it");
  }
  if (!dockerAvailable()) throw new Error("Docker is not running — start Docker and retry");

  const container = `zz-schema-target-pg-${process.pid}`;
  const pwd = "throwaway";
  const pgsvc = postgresService(root);
  run("docker", ["run", "-d", "--name", container, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=zz", `-e`, `POSTGRES_PASSWORD=${pwd}`, "-e", "POSTGRES_DB=zz",
    pgsvc.image, ...pgsvc.command]);
  try {
    await waitReady(container);
    const mapped = run("docker", ["port", container, "5432/tcp"]).split("\n")[0];
    const port = mapped.split(":").pop();
    if (!port) throw new Error(`could not read the mapped port for ${container} (docker port said "${mapped}")`);
    const url = `postgresql://zz:${pwd}@127.0.0.1:${port}/zz`;
    await waitReachable(url);

    if (beforeMigrate) await beforeMigrate(url);

    process.env.TEAM_DB_URL = url;
    const dbModule = (await import(pathToFileURL(`${root}/services/gateway/dist/db.js`).href)) as
      typeof import("../../services/gateway/dist/db.js");
    try {
      await dbModule.initPlatformDb();
    } finally {
      delete process.env.TEAM_DB_URL;
    }
    if (dbModule.platformDbReady()) await dbModule.platformDb().end();

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("set search_path = ''");
      return await fn(client);
    } finally {
      await client.end();
    }
  } finally {
    try { run("docker", ["rm", "-f", container]); } catch { /* nothing left to remove */ }
  }
}
