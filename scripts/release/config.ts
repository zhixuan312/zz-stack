/**
 * What this release is aimed at — the flags, and nothing else.
 *
 * The deployment's own facts — its address, its paths, its images, how to speak to it — are
 * scripts/deployment.ts, because the doctor needs every one of them. What is left is what only a
 * release has: which version, which console version, and which mode this script runs in.
 *
 * The address is resolved here rather than in deployment.ts, and refused here too. A release sends a
 * bearer token to it, so there is no default and an unresolvable address must stop the run before
 * anything is built — while the doctor must still work on a laptop that cannot reach the host, which
 * a module that dies at import takes away from it.
 */
import { die, publicUrl } from "../deployment.ts";

export const args = process.argv.slice(2);
export const dryRun = args.includes("--dry-run");
export const rollbackMode = args.includes("--rollback");
export const preflightMode = args.includes("--preflight");
export const exportMode = args.includes("--export");
export const version = args.find((a) => !a.startsWith("--"));
// zz-stack-dashboard: the console. An explicit version releases it; otherwise we ask its repo
// whether it moved and skip it only when it did not.
//
// There is no --no-dashboard. The platform and the console are one deployment in front of the same
// people, so a host on an old console is on a stale platform. Skipping is the right answer only
// when the console did not move, and that answer is reached by asking, in resolveDashboard().
export const dashArg = (args.find((a) => a.startsWith("--dashboard=")) || "").split("=")[1] || null;

/** The gateway address this release verifies against, refused rather than guessed.
 *
 * Checked when the release starts, not inside the verification, which runs after the deploy. A
 * release started without a resolvable address would otherwise build, push, deploy, and only then
 * exit on a missing environment variable, leaving the new version live and unverified — die() is not
 * the rollback path. Everything else here has a working default; this one cannot. */
function releaseTarget() {
  const url = publicUrl();
  if (!url) {
    die("ZZ_PUBLIC_URL is not set and the host could not be asked for it. The live checks " +
        "send a bearer token to it, so there is no default: set it to THIS deployment's " +
        "gateway address — the same value the host carries as GATEWAY_PUBLIC_URL in " +
        "deploy/.env.");
  }
  return url;
}

if (!rollbackMode && !preflightMode) releaseTarget();
