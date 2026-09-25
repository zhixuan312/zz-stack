/**
 * The OS sandbox every replay session's `claude` process runs inside — the half of the
 * candidate's isolation an environment allowlist cannot give (`candidateEnv`, plan.ts). A
 * temporary `HOME` hides `~/.zz/token` from `~`, but the session still runs as the operator's own
 * OS user with `bypassPermissions`, so `cat /Users/<operator>/.zz/token` by absolute path would
 * read the principal's unbound PAT. The kernel is the only thing that can refuse that read.
 *
 * macOS: `sandbox-exec` with a generated Seatbelt profile. Linux: `bwrap` (bubblewrap) with the
 * same shape expressed as mounts. Both say the same four things:
 *   - nothing under the operator's real home directory, the operator's checkout, an explicit
 *     `ZZ_TOKEN_FILE`, or the launcher's own log directory is readable (`sandboxContext`,
 *     session.ts, resolves that list);
 *   - except the few paths the session needs back (the `claude` install, when it lives under
 *     that home), which are re-allowed read-only;
 *   - nothing is writable except the session's own temporary home and the run's tree — and
 *     never the tree's `.git` gitfile (`readOnly`), which names the launcher's repository beside
 *     it. That repository is readable to the candidate (session.ts) and writable to nobody but the
 *     launcher, whose git reads it after the session ends: a `core.fsmonitor`, a hook or a filter
 *     driver written into it would run as the operator, outside any sandbox;
 *   - everything else (system libraries, network, process execution) is left as it is — the
 *     session must still reach its model and run the plugin's own tools.
 *
 * DELIBERATE: no unsandboxed fallback. A host with neither tool (or one where the tool cannot
 * start — nested inside another sandbox, say) is refused by `shellCapableRuntime` (plan.ts)
 * before any I/O, the same way a missing model credential is.
 *
 * Pure: every path arrives already resolved (`realpathSync`, by the caller — Seatbelt matches
 * the real path, and `/tmp` is `/private/tmp` on macOS), and whether a denied path is a file or
 * a directory is passed in rather than probed here, so `checks/replay-isolation-pure.ts` can
 * prove each rule on values alone.
 */
import { dirname } from "node:path";

export type SandboxTool = "sandbox-exec" | "bwrap";

interface SandboxSpec {
  /** Refused for reading. `dir` decides how bwrap hides it (an empty tmpfs over a directory,
   *  /dev/null over a file); Seatbelt treats both as a subpath. */
  readonly denyRead: readonly { readonly path: string; readonly dir: boolean }[];
  /** Re-allowed read-only, even though under a denied path — the `claude` install. */
  readonly allowRead: readonly string[];
  /** The only writable places: the session home and, for the candidate, the clone. Readable too. */
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
    // No process-info on anything outside this sandbox — the launcher included (its pid, path,
    // open files). Its own children stay visible: claude waits on the tools it spawns. What this
    // cannot gate, probed on macOS 26: `KERN_PROCARGS2` (another process's argv) is not a
    // Seatbelt operation at all; the kernel itself withholds another process's environment from
    // it, same uid or not, and `/bin/ps` is setuid and cannot exec here. So the launcher keeps
    // no token in its argv or environment (launch.ts's CLI note) — that is the other half.
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

/** The namespaces bwrap starts every session in: all of them fresh, then the network shared back
 *  — the session needs its model API and nothing else of the host's. A fresh PID namespace is
 *  what keeps `/proc/<launcher pid>/environ` (and every other host process) out of sight: with a
 *  shared one, the fresh `--proc` mount still listed the launcher, same uid, environ readable.
 *  It also means a process the session leaves running dies with the namespace's init when the
 *  turn ends. COUPLED: `detectSandbox` (session.ts) probes with these same flags, so a host that
 *  cannot unshare them is refused rather than discovered mid-launch. */
export const BWRAP_NAMESPACES = ["--unshare-all", "--share-net", "--die-with-parent"] as const;

/** bwrap's mount list, everything before `--`. Order is the policy here too: the root goes in
 *  read-only first, each denied path is covered, the re-allowed and writable paths are bound
 *  back on top of those covers, and the read-only paths inside a writable one go last.
 *  `--die-with-parent` so a launcher killed mid-turn takes the session with it. */
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
