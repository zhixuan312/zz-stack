/**
 * The line between "this host cannot build" and "this patch does not build" — the one line a
 * candidate's verdict must never cross. A host problem (no docker or no compose plugin, no node,
 * no registry) marking a candidate `invalid` would bar a sound hypothesis from ever being proposed
 * again (`REJECTED_CANDIDATE_STATUSES`, proposer-bundle.ts) for a reason that has nothing to do
 * with it. Two guards, in order:
 *   - `preflightCommands`: before anything is cloned, the exact tools the build and gate will
 *     reach for are run once inside the same sandbox, environment and home the build gets. Any
 *     that fails refuses the run with nothing recorded (candidate/build.ts, exit 2).
 *   - `hostFailure`: a failure that still surfaces mid-build and reads as the host's — a tool
 *     missing, the network or the docker daemon unreachable — is recorded as stage `host`, which
 *     returns the candidate to `recorded` (candidate-build-rules.ts), never `invalid`.
 * Pure, so `checks/candidate-build-live.ts` proves both on values as well as live.
 */

/** COUPLED: packages/tools/src/candidate/build.ts's defaults. */
export const DEFAULT_BUILD_CMD = "npm run build";
export const DEFAULT_GATE_CMD = "npm run gate -- --quiet";

/** The argv lists the preflight runs. Always the dependency install's own `npm`, and `git` (the
 *  gate reads the clone through it); the first word of each configured command; and for the
 *  default gate, `docker compose` — scripts/gate/checks/deploy-*.ts run `docker compose config`,
 *  which needs the compose plugin but no daemon. */
export function preflightCommands(buildCmd: readonly string[], gateCmd: readonly string[]): string[][] {
  const out: string[][] = [["npm", "--version"], ["git", "--version"]];
  for (const cmd of [buildCmd, gateCmd]) {
    const bin = cmd[0];
    if (bin && !out.some((c) => c[0] === bin)) out.push([bin, "--version"]);
  }
  if (gateCmd.join(" ") === DEFAULT_GATE_CMD) out.push(["docker", "compose", "version"]);
  return out;
}

/** Output that says the host, not the patch, stopped the command. Deliberately narrow: a
 *  sentence a broken patch could also produce ("command not found" from a script it edited, a
 *  failing assertion) stays the patch's. */
const HOST_SIGNS: readonly RegExp[] = [
  /unknown shorthand flag: 'f' in -f/,            // `docker compose` with no compose plugin
  /'compose' is not a docker command/,
  /Cannot connect to the Docker daemon/,
  /\bspawn (node|npm|git|docker) ENOENT\b/,
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET)\b.*registry|registry.*\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET)\b/,
  /npm (ERR!|error) code (ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
];

/** The first host sign in `output`, or null when the failure is the patch's to own. */
export function hostFailure(output: string): string | null {
  for (const sign of HOST_SIGNS) {
    const m = sign.exec(output);
    if (m) return m[0];
  }
  return null;
}
