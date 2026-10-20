/**
 * What the gate-plant break-tests share: run the gate, read its exit status or the checks it failed
 * by name, and undo a plant however the run ends.
 *
 * DELIBERATE: this file is not a check and must not be registered as one. It spawns
 * `scripts/gate.ts`, which `working-checks-registered.ts` refuses to run inside the gate — the
 * same classifier that keeps a registered check from launching the gate — and it asserts nothing
 * on its own.
 *
 * `gate()`, `run()` and `failing()` are read-only: each returns its findings rather than pushing into
 * a caller's array. `measure()` is deliberately NOT here: it reports by pushing into the `fail` of
 * the file that called it, so the copies that look identical across two break-tests are the same
 * shape over different state, not one implementation duplicated.
 *
 * DELIBERATE: the gate is awaited, never run with `execFileSync`. A plant spends its whole life
 * inside a gate run, and a synchronous one holds the event loop: a SIGINT or SIGTERM handler
 * cannot run until the script has finished, and Node drops the signal altogether when nothing
 * else is left to run, so the plant stays in the tree.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** The gate run in flight, so an interrupt can stop it before the plant is undone. */
let inFlight: ChildProcess | null = null;
/** Set by an interrupt. From then on no gate run settles and none starts: the plant's own steps
 *  would otherwise go on, plant the next defect and spawn the next gate while the plant is being
 *  undone. */
let interrupted = false;

/** How long a stopped gate's checks get to clean up after themselves — a throwaway database's check
 *  removes its container on SIGTERM — before whatever is left is killed. */
const GRACE_MS = 30_000;

/** Stop a gate and everything it started: `signal` to its whole process group, then SIGKILL to
 *  whatever is still there after GRACE_MS. Settles once the group is gone. */
function stopGroup(pgid: number, signal: NodeJS.Signals): Promise<void> {
  const alive = (): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
  try { process.kill(-pgid, signal); } catch { return Promise.resolve(); }
  const began = Date.now();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!alive()) { clearInterval(poll); resolve(); return; }
      if (Date.now() - began > GRACE_MS) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone meanwhile */ } }
    }, 100);
  });
}

/** One gate run: its exit status (null when a signal or `timeoutMs` ended it) and its whole output,
 *  stdout then stderr. A failing check prints its name and its sentence to stderr in one write, so
 *  the sentence is the line after the name. */
export function gate(extra: readonly string[] = [], timeoutMs?: number): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    if (interrupted) return;
    // Detached, so it leads a process group of its own: a timeout or an interrupt stops the gate and
    // every check it is running, and nothing else, each check with time to remove what it started.
    const child = spawn("node", ["scripts/gate.ts", ...extra], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    inFlight = child;
    // A run that times out settles only once its whole group is gone, so no check of it is still
    // cleaning up while the caller goes on.
    let stopping: Promise<void> = Promise.resolve();
    const timer = timeoutMs === undefined ? null
      : setTimeout(() => { stopping = stopGroup(child.pid!, "SIGTERM"); }, timeoutMs);
    // Decoded as text by the stream, never chunk by chunk: a `✓` or `✗` split across two pipe reads
    // would otherwise become two replacement characters and its check would drop out of the output.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => {
      inFlight = null;
      if (timer) clearTimeout(timer);
      void stopping.then(() => { if (!interrupted) resolve({ status, out: `${stdout}${stderr}` }); });
    });
  });
}

/** Every check the gate reported, as `ran` (the names it printed either way) and `failed` (name ->
 *  the sentence under it). */
export async function run(extra: readonly string[] = []): Promise<{ ran: Set<string>; failed: Map<string, string> }> {
  const { out } = await gate(extra);
  const lines = out.split("\n");
  const ran = new Set<string>();
  const failed = new Map<string, string>();
  for (const [i, line] of lines.entries()) {
    const ok = /^\s*✓ (.+)$/.exec(line);
    if (ok) { ran.add(ok[1]); continue; }
    const no = /^\s*✗ (.+)$/.exec(line);
    if (no) { ran.add(no[1]); failed.set(no[1], (lines[i + 1] ?? "").trim()); }
  }
  return { ran, failed };
}

/** The gate's failures only, name -> the sentence under each, from a `--quiet` run. */
export async function failing(): Promise<Map<string, string>> {
  return (await run(["--quiet"])).failed;
}

/**
 * Undo a plant however this process ends: on exit, after a throw, and on an interrupt.
 *
 * An interrupt stops the gate in flight first, passing the same signal to its whole process group
 * so each check can remove what it started, and waits until the group is gone, so nothing it writes
 * lands after the restore. The gate re-renders `marketplace/` from the catalog on every run, so a run stopped
 * part-way may leave the shelf rendered from the plant; it is rendered again from the restored
 * catalog, which is what the plant's own last gate run leaves when nothing interrupts it.
 */
export function restoreOnInterrupt(restore: () => void): void {
  process.on("exit", restore);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(signal, () => {
      interrupted = true;
      const child = inFlight;
      const stopped = child === null ? Promise.resolve() : stopGroup(child.pid!, signal);
      void stopped.then(() => {
        restore();
        spawn("node", ["scripts/build-marketplace.ts"], { stdio: "ignore" })
          .on("close", () => process.exit(code))
          .on("error", () => process.exit(code));
      });
    });
  }
}
