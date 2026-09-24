/**
 * Step 5 runs the doctor's probes. It owns none of its own.
 *
 * A list that runs once per release is a list that is wrong at the moment it matters and right at no
 * other: the probes live in scripts/doctor/, where `npm run doctor` runs them any day, and this file
 * selects which layers a release cares about. There is one list.
 *
 * `repo` and `image` are excluded. They are about the checkout and the registry, which steps 1 and 2
 * already refused the release over, and asking again after the deploy answers a question whose
 * answer cannot have changed. Step 5 is for what only becomes true once the thing is running.
 *
 * A release rolls back on a disagreement and never on a probe that could not run: a probe that dies
 * on an unreachable host, a missing token or its own bug has told you nothing about the deployment.
 * The three-verdict split in doctor/run.ts is what keeps those apart. Unknowns are still printed;
 * they are just not evidence.
 */
import "../doctor/layers/host.ts";
import "../doctor/layers/doors.ts";
import "../doctor/layers/contract.ts";
import "../doctor/layers/data.ts";

import { diagnose, report } from "../doctor/run.ts";

/** The layers a release verifies. Named here rather than "everything after the second", so adding an
 *  offline layer to the doctor cannot silently add forty seconds to every release. */
export const RELEASE_LAYERS = ["host", "doors", "contract", "data"];

/**
 * Run them and hand back both kinds, because a release has three outcomes and not two.
 *
 * `wrong` is what it rolls back on. `unknown` means the probes could not look, so rolling back would
 * undo a release for a reason that was never about it, and tagging would stamp a version nothing
 * verified. The caller stops before the tag and says so.
 */
export function verifyLive() {
  const findings = diagnose({ only: RELEASE_LAYERS });
  report();
  return {
    wrong: findings.filter((f) => f.verdict === "wrong").map((f) => `${f.layer}/${f.probe}: ${f.detail}`),
    unknown: findings.filter((f) => f.verdict === "unknown").map((f) => `${f.layer}/${f.probe}: ${f.detail}`),
  };
}
