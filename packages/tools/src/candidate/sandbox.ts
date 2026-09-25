/**
 * The OS sandbox a candidate's install, build and gate run inside (build.ts). The build runs as
 * the operator's own OS user and executes the candidate's own code, so an environment allowlist
 * (`buildEnv`) is not enough: `cat /Users/<operator>/.zz/token` by absolute path would read the
 * operator's platform token. The kernel is the only thing that can refuse that read.
 *
 * macOS: `sandbox-exec` with a generated Seatbelt profile. Linux: `bwrap` (bubblewrap) with the
 * same shape expressed as mounts. Both say the same four things:
 *   - nothing under the operator's real home directory, the operator's checkout, an explicit
 *     `ZZ_TOKEN_FILE`, or the system temporary directory is readable (`sandboxContext` resolves
 *     that list);
 *   - except the few paths the build needs back (the node/npm install, when it lives under that
 *     home), which are re-allowed read-only;
 *   - nothing is writable except the build's own temporary home and its tree — and never the
 *     tree's `.git` gitfile (`readOnly`), which names the build's repository beside it. That
 *     repository is readable to the build and writable to nobody but this CLI, whose git reads it
 *     afterwards: a `core.fsmonitor`, a hook or a filter driver written into it would run as the
 *     operator, outside any sandbox;
 *   - everything else (system libraries, network, process execution) is left as it is — the
 *     build must still install its dependencies and run its own tools.
 *
 * DELIBERATE: no unsandboxed fallback. A host with neither tool (or one where the tool cannot
 * start — nested inside another sandbox, say) is refused by build.ts before anything is cloned.
 *
 * The profile and mount builders are pure: every path arrives already resolved (`realpathSync`,
 * by the caller — Seatbelt matches the real path, and `/tmp` is `/private/tmp` on macOS), and
 * whether a denied path is a file or a directory is passed in rather than probed, so
 * `checks/candidate-isolation-pure.ts` can prove each rule on values alone. The second half of
 * this file resolves them against this host and runs one process inside.
 */
import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

type SandboxTool = "sandbox-exec" | "bwrap";

interface SandboxSpec {
  /** Refused for reading. `dir` decides how bwrap hides it (an empty tmpfs over a directory,
   *  /dev/null over a file); Seatbelt treats both as a subpath. */
  readonly denyRead: readonly { readonly path: string; readonly dir: boolean }[];
  /** Re-allowed read-only, even though under a denied path — the node/npm install. */
  readonly allowRead: readonly string[];
  /** The only writable places: the build's home and its tree. Readable too. */
  readonly writable: readonly string[];
  /** Under a writable path, yet never written: the tree's `.git` gitfile. Narrows, never widens,
   *  so it is outside `assertNoWideningAllow`'s concern. Absent means none. */
  readonly readOnly?: readonly string[];
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Seatbelt string literal: backslash and double quote are the only characters with meaning. */
const sb = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Every directory from just below `root` down to `path`'s parent, plus `root` itself — the
 *  `file-read-metadata` a process needs to walk into a re-allowed path under a denied one. */
function ancestorsWithin(path: string, root: string): string[] {
  const out: string[] = [];
  for (let p = dirname(path); within(p, root); p = dirname(p)) {
    out.push(p);
    if (p === root) break;
  }
  return out;
}

/** A path under nothing denied is already readable; a spec that re-allows a whole denied root
 *  (or an ancestor of one) would undo the deny — refused rather than quietly obeyed. */
function assertNoWideningAllow(spec: SandboxSpec): void {
  for (const allowed of [...spec.allowRead, ...spec.writable]) {
    for (const d of spec.denyRead) {
      if (within(d.path, allowed)) {
        throw new Error(`sandbox: '${allowed}' would re-allow all of denied '${d.path}'`);
      }
    }
  }
}

/** The Seatbelt profile. Later rules win in SBPL, so the order below is the policy. */
export function seatbeltProfile(spec: SandboxSpec): string {
  assertNoWideningAllow(spec);
  const reAllowed = [...spec.allowRead, ...spec.writable];
  const metadata = new Set<string>();
  for (const p of reAllowed) {
    for (const d of spec.denyRead) if (within(p, d.path)) for (const a of ancestorsWithin(p, d.path)) metadata.add(a);
  }
  const lines = [
    "(version 1)",
    "(allow default)",
    // No process-info on anything outside this sandbox — this CLI included (its pid, path, open
    // files). Its own children stay visible: npm waits on the tools it spawns. What this cannot
    // gate, probed on macOS 26: `KERN_PROCARGS2` (another process's argv) is not a Seatbelt
    // operation at all; the kernel itself withholds another process's environment from it, same
    // uid or not, and `/bin/ps` is setuid and cannot exec here. So this CLI keeps no token in its
    // argv (build.ts reads it from the environment or a file) — that is the other half.
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    ...(spec.denyRead.length ? [`(deny file-read* ${spec.denyRead.map((d) => `(subpath ${sb(d.path)})`).join(" ")})`] : []),
    ...(reAllowed.length ? [`(allow file-read* ${reAllowed.map((p) => `(subpath ${sb(p)})`).join(" ")})`] : []),
    ...(metadata.size ? [`(allow file-read-metadata ${[...metadata].sort().map((p) => `(literal ${sb(p)})`).join(" ")})`] : []),
    "(deny file-write*)",
    `(allow file-write* ${[...spec.writable.map((p) => `(subpath ${sb(p)})`), '(subpath "/dev")'].join(" ")})`,
    // After the allow: later rules win, so this is what keeps `.git` read-only inside the clone.
    ...(spec.readOnly?.length ? [`(deny file-write* ${spec.readOnly.map((p) => `(subpath ${sb(p)})`).join(" ")})`] : []),
  ];
  return lines.join("\n");
}

/** The namespaces bwrap starts every build command in: all of them fresh, then the network shared
 *  back — `npm ci` needs its registry. A fresh PID namespace is what keeps `/proc/<this CLI's
 *  pid>/environ` (and every other host process) out of sight: with a shared one, the fresh
 *  `--proc` mount still listed the parent, same uid, environ readable. It also means a process the
 *  build leaves running dies with the namespace's init when the command ends. COUPLED:
 *  `detectSandbox` below probes with these same flags, so a host that cannot unshare them is
 *  refused rather than discovered mid-build. */
export const BWRAP_NAMESPACES = ["--unshare-all", "--share-net", "--die-with-parent"] as const;

/** bwrap's mount list, everything before `--`. Order is the policy here too: the root goes in
 *  read-only first, each denied path is covered, the re-allowed and writable paths are bound
 *  back on top of those covers, and the read-only paths inside a writable one go last.
 *  `--die-with-parent` so a CLI killed mid-build takes the build with it. */
export function bwrapArgs(spec: SandboxSpec, cwd: string): string[] {
  assertNoWideningAllow(spec);
  const args = [...BWRAP_NAMESPACES, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
  for (const d of spec.denyRead) args.push(...(d.dir ? ["--tmpfs", d.path] : ["--ro-bind", "/dev/null", d.path]));
  for (const p of spec.allowRead) args.push("--ro-bind", p, p);
  for (const p of spec.writable) args.push("--bind", p, p);
  for (const p of spec.readOnly ?? []) args.push("--ro-bind", p, p);
  args.push("--chdir", cwd);
  return args;
}

/** The argv that runs `bin args` inside the sandbox — what `execFileSync` is actually handed. */
export function sandboxedCommand(
  tool: SandboxTool, spec: SandboxSpec, bin: string, args: readonly string[], cwd: string,
): { file: string; argv: string[] } {
  if (tool === "sandbox-exec") return { file: "sandbox-exec", argv: ["-p", seatbeltProfile(spec), bin, ...args] };
  return { file: "bwrap", argv: [...bwrapArgs(spec, cwd), "--", bin, ...args] };
}

// -------------------------------------------------------------------------------------------
// The sandbox, resolved against this host.

/** Which sandbox this host can actually start, or null. Probed by running one trivial command
 *  inside it — the binary existing is not enough: `sandbox-exec` refuses to nest inside another
 *  sandbox, and `bwrap` needs unprivileged user namespaces the host may have disabled. */
export function detectSandbox(): SandboxTool | null {
  const probe = (file: string, args: string[]): boolean => {
    try { execFileSync(file, args, { timeout: 15_000, stdio: "ignore" }); return true; } catch { return false; }
  };
  if (process.platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec") &&
      probe("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]) ? "sandbox-exec" : null;
  }
  if (process.platform === "linux") {
    // The same namespaces every build command gets (BWRAP_NAMESPACES): a host that allows bwrap but
    // not an unshared PID namespace is refused here, never run with this CLI's /proc in view.
    return probe("bwrap", [...BWRAP_NAMESPACES, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"])
      ? "bwrap" : null;
  }
  return null;
}

/** What every sandboxed process in one build shares: the tool, what it may not read, and what it
 *  gets back read-only. Only the writable paths differ per process. */
export interface SandboxContext {
  readonly tool: SandboxTool;
  readonly denyRead: readonly { readonly path: string; readonly dir: boolean }[];
  readonly allowRead: readonly string[];
}

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** `bin` as `execFileSync` would find it — absolute as given, otherwise the first match on `PATH`. */
function locate(bin: string): string | null {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

/** Denied: the operator's real home directory (from the password database, not `$HOME`, which the
 *  caller could have pointed anywhere) and `$HOME` when that differs, the operator's checkout, an
 *  explicit `ZZ_TOKEN_FILE`, and the whole system temporary directory — another build's home and
 *  tree live there, and so may the operator's token files. This build's own home and tree are
 *  bound back per process, as its writable paths. Re-allowed read-only: wherever `bin` and the
 *  node running this CLI are installed, when that is under a denied path — a user-level install
 *  (`~/.local`, `~/.nvm`) is ordinary. */
export function sandboxContext(tool: SandboxTool, repoRoot: string, bin: string): SandboxContext {
  const denyRead: { path: string; dir: boolean }[] = [];
  const deny = (p: string | undefined): void => {
    const r = p ? real(p) : null;
    if (r && !denyRead.some((d) => d.path === r)) denyRead.push({ path: r, dir: statSync(r).isDirectory() });
  };
  deny(userInfo().homedir);
  deny(process.env.HOME);
  deny(repoRoot);
  deny(process.env.ZZ_TOKEN_FILE);
  deny(tmpdir());

  const located = locate(bin);
  if (!located) throw new Error(`candidate-build: '${bin}' is not on PATH`);
  const installs = [dirname(located), dirname(real(located) ?? located), dirname(dirname(real(process.execPath) ?? process.execPath))];
  const allowRead = [...new Set(installs.map((p) => real(p) ?? p))]
    .filter((p) => denyRead.some((d) => p.startsWith(`${d.path}/`)));
  return { tool, denyRead, allowRead };
}

/** One process run as the leader of its own process group, and the whole group killed once it
 *  returns — success, failure or timeout. A build step can leave a background command running
 *  (`cmd &`), and one still running when the tree is removed could move things under the walk.
 *  `spawnSync` rather than `execFileSync`, which hides the child's pid.
 *
 *  What this cannot reach: a command that leaves the group itself (`setsid`). Under bwrap the
 *  fresh PID namespace covers it: it dies with the command. Under Seatbelt nothing kills it; so
 *  what it could still write is taken away instead — the tree is renamed out of its writable
 *  path before it is removed (`holdWorktree`, git.ts), and so is the build home
 *  (`removeBuildHome`). Throws the way `execFileSync` does, with `stdout`/`stderr` on the error. */
export function runGrouped(
  file: string, argv: readonly string[], opts: { cwd: string; env: Record<string, string>; timeout: number; maxBuffer?: number },
): string {
  // `detached` is missing from Node's `spawnSync` typings, and honoured at runtime all the same —
  // probed on Node 24: the child's pgid is its own pid. Hence a variable, past the literal check.
  const options: SpawnSyncOptionsWithStringEncoding & { detached: true } =
    { ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], detached: true };
  const res = spawnSync(file, argv, options);
  try {
    if (res.pid) process.kill(-res.pid, "SIGKILL");
  } catch { /* ESRCH: nothing of the group is left */ }
  if (res.error || res.status !== 0) {
    const why = res.error?.message ?? (res.signal ? `killed by ${res.signal}` : `exited ${String(res.status)}`);
    throw Object.assign(new Error(`${file} failed: ${why}`), { stdout: res.stdout ?? "", stderr: res.stderr ?? "" });
  }
  return res.stdout;
}

/** One sandboxed process, writable only where `paths.writable` says, and never the `.git`
 *  gitfile inside one of those — it names the build's repository, which this CLI reads with `git`
 *  outside the sandbox (git.ts). `paths.readable` adds read-only paths for this one process: the
 *  build's repository, the console clone, host tools. */
export function execSandboxed(
  sandbox: SandboxContext, paths: { writable: readonly string[]; readable?: readonly string[] }, bin: string, args: string[],
  opts: { cwd: string; env: Record<string, string>; timeout: number; maxBuffer?: number },
): string {
  const readOnly = paths.writable.map((p) => join(p, ".git")).filter((p) => existsSync(p));
  const cmd = sandboxedCommand(sandbox.tool, {
    denyRead: sandbox.denyRead, allowRead: [...sandbox.allowRead, ...(paths.readable ?? [])],
    writable: paths.writable, readOnly,
  }, bin, args, opts.cwd);
  return runGrouped(cmd.file, cmd.argv, opts);
}

// -------------------------------------------------------------------------------------------
// The build's home and environment — an allowlist, never `{ ...process.env }`.

/** Copied across when present: the process basics a build needs, and the proxy/CA settings
 *  `npm ci` may need to reach its registry. No `ZZ_*` variable, no model credential and no cloud
 *  or git-host token is ever on this list: the build runs the candidate's own code. */
const BUILD_ENV_ALLOW = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "TZ",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  // Windows only — a child process there cannot start without them; absent on POSIX.
  "SystemRoot", "ComSpec", "PATHEXT",
] as const;

/** The whole environment a build command runs with. Pure: `source` is passed in (build.ts hands it
 *  `process.env`) so a check can prove what is dropped. `HOME` is the build's temporary one, so
 *  `~/.zz/token`, `~/.npmrc` and every other dotfile of the operator's resolves somewhere empty. */
export function buildEnv(source: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BUILD_ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  // Inside the build home: the sandbox leaves nothing else writable but the tree.
  env.TMPDIR = `${home}/tmp`;
  env.USERPROFILE = home;
  return env;
}

let developerTools: string | null | undefined;

/** macOS only: the directory the real `git` (and the other developer tools) live in, put first on
 *  a sandboxed process's PATH. `/usr/bin/git` is an `xcrun` shim that writes its lookup cache to
 *  the operator's own temporary directory — found through `confstr`, never `$TMPDIR`, so the
 *  build's own `TMPDIR` does not move it — and the sandbox denies that directory, so every shimmed
 *  call printed `couldn't create cache file ... xcrun_db` into the gate's output. Calling the real
 *  binary skips the shim. Letting the sandbox write that cache instead is refused on purpose: it
 *  maps tool names to binaries for every later `xcrun` call the operator makes. Resolved once per
 *  process, outside any sandbox. */
function developerToolsDir(): string | null {
  if (developerTools !== undefined) return developerTools;
  developerTools = null;
  if (process.platform !== "darwin") return developerTools;
  try {
    const git = execFileSync("xcrun", ["-f", "git"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (git && existsSync(git)) developerTools = dirname(git);
  } catch { /* no command line tools — nothing shimmed to skip */ }
  return developerTools;
}

/** One build's private home, and the environment its commands run with. `realpathSync` because
 *  the sandbox matches real paths (`/private/var/...`). Removed with `removeBuildHome`. */
export interface BuildHome { readonly root: string; readonly env: Record<string, string> }

export function makeBuildHome(): BuildHome {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "zz-candidate-home-")));
  mkdirSync(join(root, "tmp"));
  const env = buildEnv(process.env, root);
  const tools = developerToolsDir();
  if (tools) env.PATH = `${tools}${delimiter}${env.PATH ?? ""}`;
  return { root, env };
}

/** Renamed out of the build's writable path first, as the tree is (`holdWorktree`, git.ts): a
 *  command the build left running could otherwise swap a directory for a symlink under
 *  `rmSync`'s walk. */
export function removeBuildHome(home: BuildHome): void {
  if (!existsSync(home.root)) return;
  const held = `${home.root}.held`;
  renameSync(home.root, held);
  rmSync(held, { recursive: true, force: true });
}
