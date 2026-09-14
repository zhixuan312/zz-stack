/**
 * WHAT THIS RELEASE IS AIMED AT — the flags, and nothing else.
 *
 * The deployment's own facts — its address, its paths, its images, how to speak to it — are
 * scripts/deployment.mjs, because the doctor needs every one of them and a second copy here
 * is a second copy that drifts. What is left is what only a release has: which version, which
 * console version, and which of the modes this script runs in.
 *
 * The address is resolved HERE rather than in deployment.mjs, and refused here too. A release
 * sends a bearer token to it, so there is no default and an unresolvable address must stop the
 * run before anything is built — but the doctor must still work on a laptop that cannot reach
 * the host at all, which a module that dies at import takes away from it.
 */
import { die, publicUrl } from "../deployment.ts";

export const args = process.argv.slice(2);
export const dryRun = args.includes("--dry-run");
export const rollbackMode = args.includes("--rollback");
export const preflightMode = args.includes("--preflight");
export const exportMode = args.includes("--export");
export const version = args.find((a) => !a.startsWith("--"));
// zz-stack-dashboard: the console. An explicit version releases it; otherwise we ASK its repo
// whether it moved and skip it only when it did not.
//
// THERE IS NO --no-dashboard ANY MORE. It existed to leave the console behind "deliberately",
// and every use of it in practice was a way past a message: the console's tree was dirty, or
// it had commits and no version had been decided, and the flag turned a question into a skip.
// The platform and the console are one deployment in front of the same people, so a host on an
// old console is on a stale platform — and the one release that used the flag shipped a gateway
// field the console needed with no console able to read it.
//
// Skipping is still the right answer when the console did not move. That answer is now only
// ever reached by ASKING, in resolveDashboard(), which is the difference between a skip that
// was decided and one that was declared.
export const dashArg = (args.find((a) => a.startsWith("--dashboard=")) || "").split("=")[1] || null;

/** The gateway address this release verifies against, refused rather than guessed.
 *
 * Checked when the release STARTS — not inside the verification, which is where it used to
 * live and which runs AFTER the deploy. A release started without a resolvable address
 * therefore built, pushed, deployed, and only then exited on a missing environment variable,
 * leaving the new version live and unverified: die() is not the rollback path, so nothing
 * undid it. Everything else here has a working default; this one cannot. */
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
