/**
 * STEP 5 RUNS THE DOCTOR'S PROBES. It does not own any of its own.
 *
 * It used to own eleven, and that is how they rotted: they ran for forty seconds during a
 * release and at no other time, so nothing exercised them between releases and nothing noticed
 * when the release.mjs split left three of them calling names they never imported. The first
 * attempt at 0.26.1 deployed, reported six failures that were all ReferenceErrors from inside
 * this file, and rolled a healthy platform back. A list that runs once per release is a list
 * that is wrong at the moment it matters and right at no other.
 *
 * So the probes live in scripts/doctor/, where `npm run doctor` runs them any day, and this
 * file selects which layers a release cares about. There is one list.
 *
 * WHICH LAYERS, AND WHY NOT ALL OF THEM. `repo` and `image` are about the checkout and the
 * registry — step 1 and step 2 already refused the release if either was wrong, and asking
 * again after the deploy answers a question whose answer cannot have changed. What step 5 is
 * for is everything that only becomes true once the thing is RUNNING.
 *
 * AND THE RULE THAT MAKES THIS SAFE: a release rolls back on a DISAGREEMENT and never on a
 * probe that could not run. A probe that dies on an unreachable host, a missing token or its
 * own bug has told you nothing about the deployment — rolling back on it undoes a good release
 * for a reason that was never about the release. That is exactly what happened here, and the
 * three-verdict split in doctor/run.mjs is what prevents it. Unknowns are still printed, and
 * still worth somebody's attention; they are just not evidence.
 */
import "../doctor/layers/host.ts";
import "../doctor/layers/doors.ts";
import "../doctor/layers/contract.ts";
import "../doctor/layers/data.ts";

import { diagnose, report } from "../doctor/run.ts";

/** The layers a release verifies. Named here rather than "everything after the second", so
 *  adding an offline layer to the doctor cannot silently add forty seconds to every release. */
export const RELEASE_LAYERS = ["host", "doors", "contract", "data"];

/**
 * Run them and hand back BOTH kinds, because a release has three outcomes and not two.
 *
 * `wrong` is what it rolls back on. `unknown` is the outcome that had nowhere to go: the
 * probes could not look, so rolling back would undo a release for a reason that was never
 * about it — and tagging would stamp a version nothing verified. Neither. The caller stops
 * before the tag and says so, which is the honest third answer.
 */
export function verifyLive() {
  const findings = diagnose({ only: RELEASE_LAYERS });
  report();
  return {
    wrong: findings.filter((f) => f.verdict === "wrong").map((f) => `${f.layer}/${f.probe}: ${f.detail}`),
    unknown: findings.filter((f) => f.verdict === "unknown").map((f) => `${f.layer}/${f.probe}: ${f.detail}`),
  };
}
