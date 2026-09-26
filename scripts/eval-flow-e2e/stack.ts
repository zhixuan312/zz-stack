/**
 * The scratch deployment the eval-flow walk runs against: the current tree, committed into a
 * throwaway repository, served by postgres + zz-core + the gateway on a docker network of their
 * own, with a first token minted the way a fresh install mints one.
 *
 * The shape is the release rehearsal's (`scripts/release/tool-chain.ts`): the deployment's own
 * postgres image and command, a network rather than links so `zz-core` and `cred-proxy` resolve
 * the way the deployment's compose network resolves them, the superadmin seeded from the
 * gateway's environment, and a PAT row inserted beside it.
 *
 * DELIBERATE: zz-core and the gateway run from `node:24` with the throwaway repository mounted,
 * not from a release image built for the purpose: the mounted tree IS the release the walk
 * evaluates (tag `v<version>`), already built on the host, so a run costs no image build, and
 * the services' code and the clone every candidate build fetches are one commit.
 *
 * Nothing here touches another container: every name carries this process's own prefix, and
 * the teardown removes exactly what `up` created.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Mcp } from "@zz/mcp-client";

import { postgresService } from "../release/postgres-service.ts";

export const live = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The superadmin the gateway seeds, and the one team it makes them admin of. `.invalid` is
 *  reserved (RFC 2606) and never a real address. */
export const OPERATOR = "eval-flow@zz.invalid";
export const TEAM = "evalflow";

export interface Stack {
  readonly work: string;       // everything this stack wrote on the host
  readonly seed: string;       // the throwaway repository zz-core runs in; tagged v<version>
  readonly origin: string;     // its bare origin
  readonly version: string;    // the release the seed is tagged at
  readonly prefix: string;
  readonly url: string;        // the gateway, on loopback
  readonly pat: string;
  readonly db: string;         // postgres, on loopback
  readonly psql: string;       // a psql command the registry tools accept
  readonly stubPort: number;
}

export const sh = (cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string =>
  String(execFileSync(cmd, args, {
    cwd, env: env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20,
  })).trim();

/** A child process run WITHOUT blocking this one: the model stub answers from this process's own
 *  event loop, and a candidate build or a release calls zz-core, which calls the stub. A synchronous spawn
 *  here would deadlock the walk against itself. */
export function spawnAsync(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }):
  Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, out }); });
  });
}

const quiet = (cmd: string, args: string[]): void => {
  try { execFileSync(cmd, args, { stdio: "ignore" }); } catch { /* already gone */ }
};

function waitFor(what: string, attempt: () => boolean, limitSeconds = 120): void {
  for (let i = 0; ; i++) {
    if (attempt()) return;
    if (i > limitSeconds) throw new Error(`the scratch stack never became ready: ${what}`);
    execFileSync("sleep", ["1"]);
  }
}

/** Every file the live checkout would commit — tracked and untracked-but-not-ignored, minus
 *  anything deleted — so an uncommitted fix is in the release the walk evaluates. */
function seedRepository(work: string, version: string): { seed: string; origin: string } {
  const seed = join(work, "zz-stack");
  const listed = sh("git", ["ls-files", "-co", "--exclude-standard", "-z"], live).split("\0").filter(Boolean);
  const files = listed.filter((f) => existsSync(join(live, f)));
  writeFileSync(join(work, "files.lst"), files.join("\n"));
  execFileSync("mkdir", ["-p", seed]);
  execFileSync("rsync", ["-a", `--files-from=${join(work, "files.lst")}`, `${live}/`, `${seed}/`]);
  // Relative workspace links inside it resolve into the seed, not back into the live checkout.
  execFileSync("cp", ["-R", join(live, "node_modules"), join(seed, "node_modules")]);
  const git = (...a: string[]): string => sh("git", a, seed);
  git("init", "-q", "-b", "master");
  git("config", "user.email", OPERATOR);
  git("config", "user.name", "eval-flow-e2e");
  // Built before the locks: plugin-versions reads the compiled packager.
  sh("npm", ["run", "--silent", "build"], seed);
  sh("node", ["scripts/skill-versions.ts", "--write"], seed);
  sh("node", ["scripts/plugin-versions.ts", "--write"], seed);
  // The release is what the gate would pass: locks and shelf regenerated from the tree, and the
  // changelog's unreleased entries under the version's own heading, as a release commit carries
  // them.
  sh("node", ["scripts/build-marketplace.ts"], seed);
  const changelog = join(seed, "CHANGELOG.md");
  const notes = readFileSync(changelog, "utf8");
  if (!notes.includes(`## [${version}]`)) {
    writeFileSync(changelog, notes.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${version}] — eval-flow-e2e seed`));
  }
  git("add", "-A");
  git("commit", "-q", "-m", `zz-stack ${version} (eval-flow-e2e seed)`);
  git("tag", `v${version}`);
  const origin = join(work, "origin.git");
  sh("git", ["clone", "-q", "--bare", seed, origin]);
  git("remote", "add", "origin", origin);
  git("fetch", "-q", "origin");
  git("branch", "-q", "--set-upstream-to=origin/master", "master");
  return { seed, origin };
}

const PAT_OF = (token: string): string => createHash("sha256").update(token).digest("hex");

export async function up(stubPort: number): Promise<Stack> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "zz-eval-flow-")));
  const prefix = `zz-evalflow-${process.pid}`;
  const version = (JSON.parse(readFileSync(join(live, "package.json"), "utf8")) as { version: string }).version;
  // The gate the candidate build runs resolves the console's checkout as a sibling of the repo.
  const dash = resolve(live, "..", "zz-stack-dashboard");
  if (existsSync(dash)) symlinkSync(dash, join(work, "zz-stack-dashboard"));
  console.log(`  seeding ${work}/zz-stack from the working tree at v${version}`);
  const { seed, origin } = seedRepository(work, version);

  const net = `${prefix}-net`, pg = `${prefix}-pg`, core = `${prefix}-core`, gw = `${prefix}-gw`;
  sh("docker", ["network", "create", net]);
  const pgsvc = postgresService(live);
  sh("docker", ["run", "-d", "--name", pg, "--network", net, "--network-alias", "postgres",
    "-e", "POSTGRES_USER=zz", "-e", "POSTGRES_PASSWORD=evalflow", "-e", "POSTGRES_DB=zz",
    "-p", "127.0.0.1:0:5432", pgsvc.image, ...pgsvc.command]);
  waitFor("postgres", () => { try { sh("docker", ["exec", pg, "pg_isready", "-U", "zz", "-d", "zz"]); return true; } catch { return false; } });
  const pgPort = sh("docker", ["port", pg, "5432/tcp"]).split("\n")[0].split(":").pop();

  const inDb = "postgresql://zz:evalflow@postgres:5432/zz";
  const mounts = ["-v", `${work}:${work}`, ...(existsSync(dash) ? ["-v", `${dash}:${dash}:ro`] : []),
    // Where the image carries them: zz-core reads platform skills from /skills alone.
    "-v", `${seed}/skills:/skills:ro`, "-v", `${seed}/catalog:/catalog:ro`,
    "-w", seed, "--add-host", "host.docker.internal:host-gateway",
    "-e", `ZZ_CATALOG_DIR=${seed}/catalog`, "-e", `ZZ_SKILLS_DIR=${seed}/skills`, "-e", `TEAM_DB_URL=${inDb}`];
  // git refuses a repository another uid owns; the mount is the host user's and the service runs
  // as root. The build and gate a candidate runs need an identity for nothing but the worktree.
  const boot = (entry: string): string[] => ["sh", "-c",
    `git config --global --add safe.directory '*' && git config --global user.email ${OPERATOR} && ` +
    `git config --global user.name eval-flow && exec node ${entry}`];
  const stub = `http://host.docker.internal:${stubPort}`;
  // Fixed rather than `127.0.0.1:0`: docker picks a new port for `:0` on every restart, and the
  // walk restarts the gateway once to make it reconcile runs.
  const gwPort = sh("node", ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"]);
  sh("docker", ["run", "-d", "--name", core, "--network", net, "--network-alias", "zz-core", ...mounts,
    "-e", "TYPESAFE_API_KEY=stub", "-e", `TYPESAFE_BASE_URL=${stub}`, "-e", "TYPESAFE_ATTEMPTS=1",
    "-e", `LLM_BASE_URL=${stub}/v1`, "-e", "LLM_API_KEY=stub",
    "node:24", ...boot("services/zz-core/dist/server.js")]);
  sh("docker", ["run", "-d", "--name", gw, "--network", net, "--network-alias", "cred-proxy", ...mounts,
    "-e", `SUPERADMIN_EMAIL=${OPERATOR}`, "-e", `BOOTSTRAP_TEAM=${TEAM}`,
    "-e", `GATEWAY_PUBLIC_URL=http://127.0.0.1:${gwPort}`, "-p", `127.0.0.1:${gwPort}:8000`,
    "node:24", ...boot("services/gateway/dist/server.js")]);
  const psql = `docker exec -i ${pg} psql -U zz -d zz`;
  const q = (sql: string): string => sh("docker", ["exec", pg, "psql", "-U", "zz", "-d", "zz", "-tAc", sql]);
  waitFor("the gateway's own boot", () => {
    try { return q(`select count(*) from zz.membership m join zz.principal p on p.id = m.principal_id where p.email = '${OPERATOR}'`) === "2"; }
    catch { return false; }
  });

  // COUPLED: the row deploy/issue-first-pat.sh writes, as tool-chain.ts does.
  const pat = `zzp_${randomBytes(24).toString("hex")}`;
  q(`insert into zz.pat (principal_id, token_hash, label) select id, '${PAT_OF(pat)}', 'eval-flow-e2e' from zz.principal where email = '${OPERATOR}'`);

  // What a release writes after the deploy (scripts/release/registries.ts), in the same order,
  // BEFORE any traffic: a run resolves its skill version by `released_at <= event ts`.
  const regEnv = { ...process.env, ZZ_CATALOG_OWNER_TEAM: TEAM };
  sh("node", ["packages/tools/dist/ops/register-skills.js", "--root", seed, "--psql", psql], live, regEnv);
  sh("node", ["packages/tools/dist/ops/register-plugins.js", "--root", seed, "--psql", psql], live, regEnv);
  sh("docker", ["restart", core]);
  const stack: Stack = {
    work, seed, origin, version, prefix, url: `http://127.0.0.1:${gwPort}`, pat,
    db: `postgresql://zz:evalflow@127.0.0.1:${pgPort}/zz`, psql, stubPort,
  };
  await waitForAsync("zz-core behind the gateway", () => coreAnswers(stack));
  writeFileSync(join(work, "stack.json"), JSON.stringify(stack, null, 2), { mode: 0o600 });
  return stack;
}

/** Whether a call through the gateway reaches zz-core: the gateway answers while zz-core is still
 *  booting, with a JSON-RPC error, so only a real tool answer says it is up. */
async function coreAnswers(stack: Pick<Stack, "url" | "pat">): Promise<boolean> {
  try {
    const said = await new Mcp(`${stack.url}/core/mcp`, { pat: stack.pat, client: "eval-flow-probe", timeoutMs: 5_000 })
      .call("session_whoami", {});
    return !said.startsWith("ERROR");
  } catch { return false; }
}

async function waitForAsync(what: string, attempt: () => Promise<boolean>, limitSeconds = 120): Promise<void> {
  for (let i = 0; ; i++) {
    if (await attempt()) return;
    if (i > limitSeconds) throw new Error(`the scratch stack never became ready: ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** A gateway restart runs `reconcileRuns` at boot — what turns the event log into `zz.run` rows
 *  — instead of waiting out its five-minute timer. */
export async function restartGateway(stack: Stack): Promise<void> {
  sh("docker", ["restart", `${stack.prefix}-gw`]);
  await waitForAsync("the gateway after its restart", () => coreAnswers(stack));
}

/** The operator deploying a release: zz-core restarted reporting `version`, so every door call
 *  after it is stamped with the released version, the way real use of a deployed release is.
 *  The code stays the tree under evaluation — the walk's candidate changes a skill's words, which
 *  no door call reads — only the version it announces moves. */
export async function deployRelease(stack: Pick<Stack, "seed" | "prefix" | "url" | "pat">, version: string): Promise<void> {
  const pkg = join(stack.seed, "services", "zz-core", "package.json");
  const parsed = JSON.parse(readFileSync(pkg, "utf8")) as Record<string, unknown>;
  writeFileSync(pkg, `${JSON.stringify({ ...parsed, version }, null, 2)}\n`);
  sh("docker", ["restart", `${stack.prefix}-core`]);
  await waitForAsync("zz-core after the deploy", () => coreAnswers(stack));
}

export function down(stack: Pick<Stack, "prefix" | "work">): void {
  for (const c of ["gw", "core", "pg"]) quiet("docker", ["rm", "-f", `${stack.prefix}-${c}`]);
  quiet("docker", ["network", "rm", `${stack.prefix}-net`]);
  // The mounted tree was written by root inside the containers; a container removes it.
  quiet("docker", ["run", "--rm", "-v", `${stack.work}:/w`, "node:24", "sh", "-c", "rm -rf /w/* /w/.[!.]*"]);
  // Docker Desktop can re-create a bind mount's host directory just after the container that
  // mounted it exits, so the removal is repeated until it holds.
  for (let i = 0; i < 10 && existsSync(stack.work); i += 1) {
    rmSync(stack.work, { recursive: true, force: true });
    execFileSync("sleep", ["1"]);
  }
}
