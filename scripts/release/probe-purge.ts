/**
 * Remove what a live probe left behind, on the host where both halves of it are.
 *
 * DELIBERATE: its own module, not deployment.ts, which the doctor imports and which therefore
 * has to be safe to run during an outage. The gate check "the doctor changes nothing" covers
 * this.
 */
import { join } from "node:path";

import { HOST, REMOTE, root, run, ssh, warn } from "../deployment.ts";

/* What `chain-check` leaves behind, and why it has to be swept.
 *
 * `chain-check` opens a fresh initiative on every run and closes it; closing is not deleting,
 * so without this the probe's initiatives, documents, events and runs accumulate in the
 * production store and every ratio anybody computes is taken over them. `--dry-run` writes them
 * too, while printing that nothing was pushed, deployed, tagged or committed.
 *
 * Both halves or neither: the files are the source of truth and `zz.doc` is projected from each
 * file's frontmatter, so a row deleted without its file returns on the next reindex. That is
 * why this runs in the container rather than against the database over the network.
 *
 * Addressed as a compose service, never as a container name: the project prefix in
 * `deploy-zz-core-1` comes from deploy/.env, so a name built here is right on at most one
 * host. */
export function purgeProbes(): void {
  try {
    run("scp", ["-o", "ConnectTimeout=30", join(root, "scripts/ops/purge-probes.ts"),
                `${HOST}:/tmp/purge-probes.ts`]);
    ssh(
      `cd ${REMOTE}/deploy && ` +
      "docker compose exec -T zz-core mkdir -p /repo/scripts/ops && " +
      "docker compose cp /tmp/purge-probes.ts zz-core:/repo/scripts/ops/purge-probes.ts && " +
      'docker compose exec -T zz-core sh -c "cd /repo && node scripts/ops/purge-probes.ts --apply"; ' +
      "rc=$?; rm -f /tmp/purge-probes.ts; exit $rc"
    );
  } catch {
    // Reported, never fatal: the probe's verdict is what a release may roll back on, and rows
    // left behind are a mess rather than a broken deployment.
    warn("chain-check left its initiative behind: the probe purge did not run. " +
         `Run it by hand: ssh ${HOST} 'cd ${REMOTE}/deploy && docker compose exec -T zz-core ` +
         "sh -c \"cd /repo && node scripts/ops/purge-probes.ts --apply\"'");
  }
}
