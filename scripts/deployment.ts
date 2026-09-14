/**
 * THE ONE DESCRIPTION OF THE DEPLOYMENT — its address, its paths, its images, and how to
 * speak to it. Imported by the release and by the doctor, which is the whole reason it is a
 * file rather than two agreeing copies.
 *
 * It was inside scripts/release/config.ts, mixed in with that script's own flags. The doctor
 * cannot import that: `version` there is "the first argv entry that is not a flag", so the
 * doctor's own arguments would have been read as a release version, and config.ts dies at
 * import when it cannot resolve a public URL — which would make a doctor unable to run its
 * offline layers on a laptop that cannot reach the host. Exactly the case a doctor is for.
 *
 * So: the facts live here, the release's flags stay with the release, and nothing re-exports
 * anything. A fork that sets none of these variables gets a connection refused, which is loud.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ONE LEVEL UP: this file is scripts/deployment.ts. Anything that moves it deeper must move
// this with it — a relocated file re-roots every path derived from it, in silence, and the
// only reason that was ever caught here was a preflight row printing "?" instead of failing.
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* The repository's own gitignored .env, read into a Map rather than into process.env.
 *
 * ZZ_TOKEN lives there. It is a Map because assigning `process.env[k]` is a computed write
 * and reading one back is a computed read — and this repository refuses both, so that
 * `.env.example` and zz-tool can be checked by finding a literal name in the source. Every
 * read below spells its name out. */
const DOTENV = new Map<string, string>();
for (const line of (() => { try { return readFileSync(join(root, ".env"), "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  // AN INLINE COMMENT IS NOT PART OF THE VALUE, and forgetting that cost two releases.
  //
  // `. .env` in a shell drops ` # …` because whitespace before the hash opens a comment, so
  // every human check of these values agreed with itself while this parser handed back the
  // token AND the note beside it — 87 characters where the token is 52. That went out as a
  // bearer, every door answered 401, and the release reported the platform dead and offered
  // to roll back. Same rule as the shell: a hash preceded by whitespace starts a comment; a
  // hash inside a value does not.
  const value = m[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  DOTENV.set(m[1], value);
}
/** A value from the real environment first, then from that file. Literal names only. */
export const cfg = (fromProcess: string | undefined, fromFile: string | undefined): string =>
  (fromProcess || fromFile || "").trim();

export const HOST = process.env.ZZ_HOST || "zz-stack";
export const REMOTE = process.env.ZZ_DEPLOY_PATH || "/root/zz-parent/zz-stack";
export const IMAGE = process.env.ZZ_IMAGE || "ghcr.io/zhixuan312/zz-stack";
// THE CONSOLE DEPLOYS BESIDE THIS PLATFORM, NOT INSIDE IT. Its compose file is its own, on
// its own path on the host, because folding it into zz-stack's compose would put a second
// repository's build inside this release and make every console change a platform release.
export const DASH_IMAGE = process.env.ZZ_DASHBOARD_IMAGE || "ghcr.io/zhixuan312/zz-stack-dashboard";
export const DASH_SRC = resolve(root, "..", "zz-stack-dashboard");
export const DASH_REMOTE = process.env.ZZ_DASHBOARD_PATH || "/root/zz-stack-dashboard";

// Build for the machine being DEPLOYED to, not the machine building. Both images went to
// ghcr as arm64-only once, because they were built on an Apple Silicon laptop and the deploy
// host is x86_64 — `no matching manifest for linux/amd64`.
export const PLATFORM = process.env.ZZ_PLATFORM || "linux/amd64";

export const log = (m: string): void => console.log(m);
export const step = (n: number | string, m: string): void => console.log(`\n\x1b[1m── ${n} · ${m}\x1b[0m`);
// A FUNCTION DECLARATION, NOT A CONST ARROW — every other export here is a const, but only a
// declared function lets TypeScript narrow what follows `if (!x) die(...)` to non-null. A
// `never`-typed const arrow types identically and checks the same call sites; it just doesn't
// carry that narrowing, and the two look interchangeable until the caller needs it.
export function die(m: string): never { console.error(`\n\x1b[31mFAILED: ${m}\x1b[0m`); process.exit(1); }
/** Loud, and the caller carries on. For a failure worth a person's attention but not worth
 *  putting a working deployment back. */
export const warn = (m: string): void => console.error(`\n\x1b[33m${m}\x1b[0m`);

export const run = (cmd: string, cmdArgs: string[], opts: ExecFileSyncOptions = {}): string =>
  String(execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts })).trim();
export const ssh = (script: string): string => run("ssh", ["-o", "ConnectTimeout=30", HOST, script]);

/* The token that proves this caller to the deployment it is talking to.
 *
 * `ZZ_TOKEN` from the environment or the repository's own gitignored .env, and nowhere else.
 * There were per-environment keys beside it and a fallback to ~/.zz/token, which was one of
 * two hosts' and quietly wrong for the other. That does not report "I could not check" — it
 * reports the TARGET as broken, and a release did exactly that to a deployment that was live,
 * correct and serving. One deployment, one token, one place to look. */
export const envToken = () => cfg(process.env.ZZ_TOKEN, DOTENV.get("ZZ_TOKEN"));

/* THE ADDRESS, AND WHY IT IS A FUNCTION RATHER THAN A CONSTANT.
 *
 * No default, ever: whoever holds this sends a BEARER TOKEN to it, so a fork inheriting this
 * repository's address would hand its own token to this deployment's gateway. Unset, it is
 * read off the host itself — an address a machine gives for itself is not inherited from
 * anywhere.
 *
 * A FUNCTION because resolving it means an ssh round trip, and a constant would spend it at
 * import time in every process that imports this file for something else entirely. The
 * doctor's offline layers must work on a laptop that cannot reach the host at all; a module
 * that resolves an address eagerly, or dies when it cannot, takes that away. Callers that
 * genuinely require an address refuse for themselves — see scripts/release/config.ts. */
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

/* Does this exact image already exist in the registry?
 *
 * Asked of the REGISTRY rather than answered from a local tag, because the tag is this
 * checkout's opinion about what somebody else's server holds. `docker manifest inspect` reads
 * the manifest without pulling a layer, so it is cheap, and it is true — it also catches the
 * two cases a tag cannot see: a version tagged by a release whose push failed halfway, and a
 * number nobody ever built. */
export const published = (ref: string): boolean => {
  try { run("docker", ["manifest", "inspect", ref]); return true; } catch { return false; }
};

/** The MCP protocol version this platform speaks, from the one place that defines it.
 *
 * Parsed from source rather than imported, the same way gate.ts reads blocks.ts and for the
 * same reason: this must run before a build has necessarily produced any JavaScript, and a
 * check that needs the build to pass cannot be what tells you the build is wrong.
 *
 * It was a literal, twice, and it said 2024-11-05 while the client said 2025-06-18 — a fourth
 * version of a protocol that is supposed to have one. Nothing had broken, because the gateway
 * accepts both. */
export function mcpProtocol(): string {
  const src = readFileSync(join(root, "packages/mcp-client/src/index.ts"), "utf8");
  // `export` is OPTIONAL, because the constant is not exported and never was. Requiring the
  // word meant this never matched, and every path that builds an initialize frame died on it:
  // `--preflight` exited 1 before its first live check, and a real release reached step 5 —
  // the verification that decides whether to roll back — AFTER deploying, so the new version
  // stayed live, unverified, with the rollback never reached.
  const m = /(?:export )?const PROTOCOL = "([^"]+)"/.exec(src);
  if (!m) die("cannot read PROTOCOL from packages/mcp-client/src/index.ts");
  return m[1];
}

/** The initialize frame the live probes send. Built, not pasted: it appeared twice. */
export const initFrame = (who: string): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
                   params: { protocolVersion: mcpProtocol(), capabilities: {},
                             clientInfo: { name: who, version: "1" } } });

/** Credentials never reach a failure message. The client-package probe interpolated a token
 *  into a `bash -c` string and `curl -f` exits non-zero on a 401, so execFileSync threw with
 *  the whole command in its message — and a failure message is exactly what somebody pastes
 *  into an issue. That site passes the token through the environment now; this stays because
 *  the next site to hold a credential will not know to. */
export const redact = (m: unknown): string => String(m).replace(/zzp_[A-Za-z0-9]+/g, "zzp_<redacted>");

/** A caught value is never typed as an Error — narrow the shape actually being read rather
 *  than assume it. `unknown?.message` narrows to `{}`, which has no properties at all. Every
 *  file under checks/ carries its own copy of this, because a check has to run standalone
 *  with no import from the tree it is checking; scripts/ has no such constraint, so this is
 *  the one copy for everything that already imports from here. */
export function errMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as Record<string, unknown>).message;
    if (m !== undefined && m !== null) return String(m);
  }
  return String(err);
}

/** A thrown value from execFileSync, narrowed to the fields every caller here actually reads.
 *  Node raises a bare Error decorated with the child's captured output when the command wrote
 *  something before failing; there is no exported type for that shape, so this is the honest
 *  version of it rather than an `any` cast on `err`. */
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
