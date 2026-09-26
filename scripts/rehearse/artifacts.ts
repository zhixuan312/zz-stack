/**
 * Unpacking the artifacts tarball `deploy/backup.sh` writes, for the phase steps
 * `expect.ts#MigrationExpectation.withArtifacts` declares that need the file store rather than
 * the database. Unpacked outside the repository, in the OS's own temp directory, and removed
 * once `scripts/rehearse.ts` is done with it — the tarball itself is never copied into the repo.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function unpackArtifacts(tarballPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zz-rehearse-artifacts-"));
  try {
    execFileSync("tar", ["xzf", tarballPath, "-C", dir], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not unpack ${tarballPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return dir;
}

export function removeArtifacts(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
