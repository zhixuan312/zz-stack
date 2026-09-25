/**
 * The one description of the deployment — its address, its paths, its images, and how to
 * speak to it. Imported by the release and by the doctor.
 *
 * DELIBERATE: the release's own flags stay in scripts/release/config.ts and nothing here
 * re-exports them. That module reads argv as a release version and dies at import when it
 * cannot resolve a public URL, so the doctor cannot import it and still run its offline
 * layers on a laptop that cannot reach the host.
 *
 * A fork that sets none of these variables gets a connection refused, which is loud.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// COUPLED: one level up assumes this file is scripts/deployment.ts. Moving it deeper
// re-roots every path derived from it, silently.
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* The repository's own gitignored .env, holding ZZ_TOKEN.
 *
 * DELIBERATE: a Map, not process.env. Assigning `process.env[k]` is a computed write and
 * reading one back a computed read; this repository refuses both, so `.env.example` and
 * zz-tool can be checked by finding a literal name in the source. Every read below spells
 * its name out. */
const DOTENV = new Map<string, string>();
for (const line of (() => { try { return readFileSync(join(root, ".env"), "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  // An inline comment is not part of the value, and the rule is the shell's: a hash preceded
  // by whitespace starts a comment, a hash inside a value does not.
  const value = m[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  DOTENV.set(m[1], value);
}
/** A value from the real environment first, then from that file. Literal names only. */
export const cfg = (fromProcess: string | undefined, fromFile: string | undefined): string =>
  (fromProcess || fromFile || "").trim();

export const HOST = process.env.ZZ_HOST || "zz-stack";
export const REMOTE = process.env.ZZ_DEPLOY_PATH || "/root/zz-parent/zz-stack";
export const IMAGE = process.env.ZZ_IMAGE || "ghcr.io/zhixuan312/zz-stack";
// The console deploys beside this platform, not inside it: its compose file is its own, on
// its own path on the host, so a console change is not a platform release.
export const DASH_IMAGE = process.env.ZZ_DASHBOARD_IMAGE || "ghcr.io/zhixuan312/zz-stack-dashboard";
export const DASH_SRC = resolve(root, "..", "zz-stack-dashboard");
export const DASH_REMOTE = process.env.ZZ_DASHBOARD_PATH || "/root/zz-stack-dashboard";

// Build for the machine being deployed to, not the machine building: the deploy host is
// x86_64 and a build on Apple Silicon otherwise pushes an arm64-only image.
export const PLATFORM = process.env.ZZ_PLATFORM || "linux/amd64";

export const log = (m: string): void => console.log(m);
export const step = (n: number | string, m: string): void => console.log(`\n\x1b[1m── ${n} · ${m}\x1b[0m`);
// DELIBERATE: a function declaration, not a const arrow like every other export here. Only a
// declared function lets TypeScript narrow what follows `if (!x) die(...)` to non-null; a
// `never`-typed const arrow types identically and drops the narrowing.
export function die(m: string): never { console.error(`\n\x1b[31mFAILED: ${m}\x1b[0m`); process.exit(1); }
/** Loud, and the caller carries on. For a failure worth a person's attention but not worth
 *  putting a working deployment back. */
export const warn = (m: string): void => console.error(`\n\x1b[33m${m}\x1b[0m`);

export const run = (cmd: string, cmdArgs: string[], opts: ExecFileSyncOptions = {}): string =>
  String(execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts })).trim();
export const ssh = (script: string): string => run("ssh", ["-o", "ConnectTimeout=30", HOST, script]);

/* The token that proves this caller to the deployment it is talking to: `ZZ_TOKEN` from the
 * environment or the repository's own gitignored .env, and nowhere else.
 *
 * DELIBERATE: no fallback to a per-host key file. A wrong token reports the target as broken
 * rather than reporting that it could not be checked. */
export const envToken = () => cfg(process.env.ZZ_TOKEN, DOTENV.get("ZZ_TOKEN"));

/* The token the live chain check walks with: a superadmin's, because bug_list, bug_resolve and
 * knowledge_reindex are offered to no other role. Separate from ZZ_TOKEN, which every other probe
 * is content with at admin. Same sources, same rule: no fallback. */
export const probeToken = () => cfg(process.env.ZZ_PROBE_TOKEN, DOTENV.get("ZZ_PROBE_TOKEN"));

/* The deployment's address.
 *
 * DELIBERATE: no default, ever. Callers send a bearer token to whatever this returns, so a
 * fork inheriting this repository's address would hand its own token to this deployment's
 * gateway. Unset, it is read off the host itself.
 *
 * DELIBERATE: a function, not a constant. Resolving it costs an ssh round trip, which a
 * constant would spend at import time in every process that imports this file — including the
 * doctor's offline layers on a laptop that cannot reach the host. A caller that requires an
 * address refuses for itself; see scripts/release/config.ts. */
let resolved: string | null = null;
export function publicUrl({ quiet = false }: { quiet?: boolean } = {}): string {
  if (resolved !== null) return resolved;
  resolved = (process.env.ZZ_PUBLIC_URL || "").trim();
  if (!resolved) {
    try { resolved = ssh(`grep -oP '(?<=^GATEWAY_PUBLIC_URL=).*' ${REMOTE}/deploy/.env`).trim(); }
    catch { resolved = ""; }
    if (resolved && !quiet) log(`  ZZ_PUBLIC_URL ${resolved} — read from ${HOST}:${REMOTE}/deploy/.env`);
  }
  return resolved;
}

/* Does this exact image already exist in the registry? Asked of the registry, not answered
 * from a local tag, which is only this checkout's opinion about what a server holds.
 * `docker manifest inspect` reads the manifest without pulling a layer. */
export const published = (ref: string): boolean => {
  try { run("docker", ["manifest", "inspect", ref]); return true; } catch { return false; }
};

/** The MCP protocol version this platform speaks, from the one place that defines it.
 *
 * DELIBERATE: parsed from source rather than imported, as the gate's facts are. This runs
 * before a build has necessarily produced any JavaScript, and a check that needs the build to
 * pass cannot be what tells you the build is wrong. */
export function mcpProtocol(): string {
  const src = readFileSync(join(root, "packages/mcp-client/src/index.ts"), "utf8");
  // `export` is optional in the pattern: the constant is not exported.
  const m = /(?:export )?const PROTOCOL = "([^"]+)"/.exec(src);
  if (!m) die("cannot read PROTOCOL from packages/mcp-client/src/index.ts");
  return m[1];
}

/** The initialize frame the live probes send. */
export const initFrame = (who: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
                   params: { protocolVersion: mcpProtocol(), capabilities: {},
                             clientInfo: { name: who, version: "1" } } });

/** Credentials never reach a failure message: execFileSync throws with the whole command in
 *  its message, and a failure message is what somebody pastes into an issue. */
export const redact = (m: unknown): string => String(m).replace(/zzp_[A-Za-z0-9]+/g, "zzp_<redacted>");

/** A caught value is never typed as an Error — narrow the shape being read rather than
 *  assume it. `unknown?.message` narrows to `{}`, which has no properties at all.
 *
 *  COUPLED: every file under checks/ carries its own copy, because a check runs standalone
 *  with no import from the tree it checks. This is the one copy for scripts/. */
export function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/** A thrown value from execFileSync, narrowed to the fields callers here read. Node raises a
 *  bare Error decorated with the child's captured output and exports no type for that shape. */
interface ExecError {
  message: string;
  stdout?: string;
  stderr?: string;
}
export function asExecError(err: unknown): ExecError {
  const message = err instanceof Error ? err.message : String(err);
  if (!err || typeof err !== "object") return { message };
  const r = err as Record<string, unknown>;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
  return { message, stdout: text(r.stdout), stderr: text(r.stderr) };
}

/**
 * Removes containers a previous release left behind, by the name prefix that release gave
 * them.
 *
 * The two rehearsal stacks name their containers `<prefix><pid>` and register
 * `process.on("exit", …)` to tear them down, which covers a normal exit and a `die()` but not
 * SIGKILL, a crashed terminal or a sleeping laptop.
 *
 * DELIBERATE: safe to run unconditionally. The PID in each name is from a process that is
 * gone, and a release does not run concurrently with another.
 */
export function reapLeaked(prefix: string): void {
  let names: string[];
  try {
    names = run("docker", ["ps", "-a", "--filter", `name=^${prefix}`, "--format", "{{.Names}}"])
      .split("\n").map((n) => n.trim()).filter(Boolean);
  } catch { return; }                       // no docker, or nothing to list — the caller's own start will say so
  if (names.length === 0) return;
  warn(`  reaping ${names.length} container(s) a previous release left behind: ${names.join(", ")}`);
  for (const n of names) {
    try { run("docker", ["rm", "-f", n], { stdio: ["ignore", "ignore", "ignore"] }); } catch { /* already gone */ }
  }
}
