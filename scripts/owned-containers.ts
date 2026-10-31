/**
 * Throwaway containers and networks, labelled with the process that started them.
 *
 * Every starter (`scripts/schema/throwaway.ts`, the two end-to-end stacks, the release's image checks) removes what it
 * started in a `finally` and on SIGINT, SIGTERM and SIGHUP. SIGKILL runs neither, so a starter killed that way leaves
 * its containers and their anonymous volumes behind: on 2026-10-31 a throwaway PostgreSQL had stood for six days after
 * the check that started it was killed. So each starter labels what it creates with its own pid (`owned()`) and, before
 * it creates anything, removes whatever carries the label of a process that no longer exists (`sweepOrphans()`).
 *
 * A pid the system has since given to another process reads as alive, and its leftovers wait for a later sweep: a
 * sweep never removes anything a live process could own.
 */
import { execFileSync } from "node:child_process";

export const OWNER_LABEL = "zz.owner-pid";

/** The `docker run` / `docker network create` arguments that mark what this process creates as its own. */
export const owned = (): string[] => ["--label", `${OWNER_LABEL}=${process.pid}`];

/** Whether a process exists. EPERM is a process of another user: it exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The ids among `rows` (`<id> <owner pid>`, one a line, as `docker ... --format` prints them) whose owner is gone. */
export function orphans(rows: string, isAlive: (pid: number) => boolean = alive): string[] {
  return rows.split("\n").flatMap((row) => {
    const [id, owner] = row.trim().split(/\s+/);
    const pid = Number(owner);
    return id && Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid) ? [id] : [];
  });
}

const docker = (args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).trim();

/** Removes every labelled container (with its volumes) and network whose owner has exited. Never throws. */
export function sweepOrphans(): void {
  const format = `{{.ID}} {{.Label "${OWNER_LABEL}"}}`;
  try {
    for (const id of orphans(docker(["ps", "-a", "--filter", `label=${OWNER_LABEL}`, "--format", format]))) {
      try { docker(["rm", "-f", "-v", id]); } catch { /* removed by another sweep */ }
    }
    for (const id of orphans(docker(["network", "ls", "--filter", `label=${OWNER_LABEL}`, "--format", format]))) {
      try { docker(["network", "rm", id]); } catch { /* removed by another sweep, or still in use */ }
    }
  } catch { /* Docker unreachable: the starter's own call says so */ }
}
