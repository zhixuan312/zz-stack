/**
 * Remove what a live probe left behind, on the host where both halves of it are.
 *
 * ITS OWN MODULE, and not deployment.ts, because the doctor imports that one and the doctor
 * has to be safe to run during an outage. A shared module holding a destructive operation is
 * how a diagnostic turns into a change — the gate check "the doctor changes nothing" caught
 * exactly that when this lived there.
 */
import { join } from "node:path";

import { HOST, REMOTE, root, run, ssh, warn } from "../deployment.ts";

/* What `chain-check` leaves behind, and why it has to be swept.
 *
 * `chain-check` opens a FRESH initiative on every run and closes it. Closing is not deleting,
 * and for three days nothing deleted it: 58 probe initiatives, 463 documents, 1,882 events and
 * 240 of the platform's 350 runs accumulated in the production store, four of them on a real
 * person's team. Every ratio anybody computed about this platform was taken over that.
 *
 * `--dry-run` is the sharpest case. That mode prints "Nothing was pushed, deployed, tagged or
 * committed", which was not true — it wrote eight documents into the live record every time
 * somebody rehearsed a release.
 *
 * BOTH HALVES OR NEITHER: the files are the source of truth and `zz.doc` is projected from
 * each file's frontmatter, so a row deleted without its file returns on the next reindex. That
 * is why this runs IN the container rather than against the database over the network.
 *
 * Addressed as a compose SERVICE, never as a container name: the project prefix in
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
    // Reported, never fatal. The probe's VERDICT is what a release may roll back on; leaving
    // rows behind is a mess rather than a broken deployment. Silence is the real failure —
    // that is how three days of it accumulated unnoticed.
    warn("chain-check left its initiative behind: the probe purge did not run. " +
         `Run it by hand: ssh ${HOST} 'cd ${REMOTE}/deploy && docker compose exec -T zz-core ` +
         "sh -c \"cd /repo && node scripts/ops/purge-probes.ts --apply\"'");
  }
}
