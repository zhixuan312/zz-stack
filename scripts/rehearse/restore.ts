/**
 * Restoring a gzipped `pg_dump --clean --if-exists` (`deploy/backup.sh`'s own format) into a
 * database `scripts/rehearse.ts` already has a connection URL for.
 *
 * Streamed rather than read into memory: `createReadStream` -> `gunzip` -> `psql`'s stdin, so a
 * production dump many times the size tried in development still runs in constant memory.
 * `psql` rather than the `pg` driver — the dump is plain SQL with `\restrict`/`\unrestrict`
 * meta-commands modern `pg_dump` wraps it in, which only `psql` understands.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

export async function restoreDump(url: string, dumpPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    // The dump's own `setval`/`set_config` statements each echo a result row; stdout is
    // discarded rather than shown; only stderr — where a real restore failure would go — reaches
    // the caller's report.
    const psql = spawn("psql", [url, "-v", "ON_ERROR_STOP=1", "-q"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    psql.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    psql.on("error", (err) => {
      reject(new Error(`could not start psql to restore ${dumpPath}: ${err.message} — is the PostgreSQL client installed?`));
    });
    psql.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`psql exited ${code} while restoring ${dumpPath}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });

    const src = createReadStream(dumpPath);
    const gunzip = createGunzip();
    src.on("error", (err) => reject(new Error(`could not read ${dumpPath}: ${err.message}`)));
    gunzip.on("error", (err) => reject(new Error(`could not decompress ${dumpPath}: ${err.message}`)));
    src.pipe(gunzip).pipe(psql.stdin);
  });
}
