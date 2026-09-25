/**
 * The build half of `candidate_validate`, as decisions on values alone: who may record a
 * candidate's build, when a recorded build still counts, and what a recorded build makes of the
 * candidate. Pure, so `checks/candidate-build-contract.ts` proves every branch with no database.
 *
 * The split (the spec's own: the server owns decisions, locks and records; a local CLI does git
 * and process work — the same one release already keeps): zz-core never builds a candidate. A
 * released image has no checkout to build one in, and a candidate's patch is arbitrary code that
 * must not run on the platform host. So `candidate_validate` moves a `recorded` candidate to
 * `awaiting_build` and answers `build_required` with the exact command; `npm run candidate-build`
 * (packages/tools/src/candidate/build.ts) clones the base subject, applies the patch and runs the
 * build and gate inside an OS sandbox, then reports through `candidate_build_record`; the next
 * `candidate_validate` consumes that record, and a passed build makes the candidate releasable.
 */

/** How long an `awaiting_build` candidate waits for its build to be recorded: the time to start
 *  the CLI, plus its clone, its build and its gate. COUPLED: `BUILD_TIMEOUT_MS` and
 *  `GATE_TIMEOUT_MS` in packages/tools/src/candidate/build.ts (10 and 15 minutes) must fit inside
 *  it with room for the clone and for the agent to run the command at all. A build recorded after
 *  the lease ended is refused; a lease that ends with nothing recorded returns the candidate to
 *  `recorded`. */
export const BUILD_LEASE_MS = 60 * 60_000;

/** Where a failed build stopped. `timeout` and `host` judged nothing about the candidate — a slow
 *  host, a missing tool, an unreachable registry or docker daemon is not the patch's fault
 *  (packages/tools/src/candidate/host.ts draws that line) — so they go back to `recorded`; every
 *  other stage is the candidate's own failure and makes it `invalid`. COUPLED: the CLI records
 *  exactly these. */
export const BUILD_STAGES = ["apply", "install", "build", "gate", "timeout", "host"] as const;
const NOTHING_JUDGED: readonly string[] = ["timeout", "host"];
type BuildStage = (typeof BUILD_STAGES)[number];

interface BuildResult {
  readonly ok: boolean;
  readonly stage?: BuildStage;
  readonly log_tail?: string;
  readonly commands?: readonly string[];
}

/** What `candidate_build_record` stores on the row: the result, and the digest of the patch the
 *  CLI actually applied — consumed against the candidate's own digest, never trusted as given. */
interface StoredBuild extends BuildResult { readonly patch_digest: string }

interface BuildRow {
  readonly status: string;
  readonly patch_digest: string;
  readonly build_requested_by: string | null;
  readonly build_requested_at: Date | null;
  readonly build_recorded_at: Date | null;
}

/** Null when `principal` may record `patchDigest`'s build into `row`; otherwise the refusal. In
 *  order: only while the build is still asked for; only the principal whose `candidate_validate`
 *  asked for it; once; inside the lease; and only for the patch the candidate actually recorded. */
export function buildRecordRefusal(principal: string, row: BuildRow, patchDigest: string, now: Date): string | null {
  if (row.status !== "awaiting_build") {
    const where = row.status;
    return `ERROR: this candidate is ${where}, not awaiting_build — only a build candidate_validate asked for can be recorded`;
  }
  if (row.build_requested_by !== principal) {
    return `ERROR: candidate_build_record is for ${row.build_requested_by ?? "the principal whose candidate_validate asked for the build"}, ` +
      `not ${principal}`;
  }
  if (row.build_recorded_at) {
    return "ERROR: a build is already recorded for this candidate — call candidate_validate to consume it";
  }
  if (!row.build_requested_at || now.getTime() - row.build_requested_at.getTime() > BUILD_LEASE_MS) {
    return `ERROR: this candidate's build lease (${BUILD_LEASE_MS / 60_000} minutes) has expired — ` +
      "call candidate_validate again and run the command it prints";
  }
  if (patchDigest !== row.patch_digest) {
    return `ERROR: patch_digest ${patchDigest} is not this candidate's (${row.patch_digest}) — ` +
      "the build ran against a different patch";
  }
  return null;
}

/** What a consumed build makes of the candidate. `valid` is releasable; the other two refuse,
 *  with the text the caller returns. */
type BuildVerdict =
  | { readonly next: "valid" }
  | { readonly next: "invalid" | "recorded"; readonly error: string };

export function judgeBuild(candidateId: string, candidateDigest: string, stored: unknown): BuildVerdict {
  const b = stored as Partial<StoredBuild> | null;
  if (!b || typeof b.ok !== "boolean" || b.patch_digest !== candidateDigest) {
    // Unreachable through candidate_build_record, which checks the digest before storing; read
    // as nothing judged rather than as a verdict on a patch nobody built.
    return {
      next: "recorded",
      error: `ERROR: candidate ${candidateId}'s recorded build is not for its own patch_digest ${candidateDigest} — ` +
        "call candidate_validate again and rebuild",
    };
  }
  if (b.ok) return { next: "valid" };
  const tail = b.log_tail ? `\n${b.log_tail}` : "";
  if (b.stage && NOTHING_JUDGED.includes(b.stage)) {
    const why = b.stage === "timeout" ? "did not finish in time" : "was stopped by a problem on the building host";
    return {
      next: "recorded",
      error: `ERROR: candidate ${candidateId}'s build ${why} — nothing was judged; fix the host if ` +
        `named below, then call candidate_validate again and rerun the build${tail}`,
    };
  }
  return {
    next: "invalid",
    error: `ERROR: candidate ${candidateId} failed its own ${b.stage ?? "build"}, which invalidates it. ` +
      `Failing command tail follows:${tail || " (none recorded)"}`,
  };
}

/** The command `build_required` prints — what the IMPROVE agent runs next. COUPLED: the CLI's
 *  own flags (packages/tools/src/candidate/build.ts). */
export function buildRequired(candidateId: string, patchDigest: string, requestedAt: Date): {
  readonly candidate_id: string; readonly status: "awaiting_build";
  readonly build_required: { readonly patch_digest: string; readonly lease_expires_at: string; readonly command: string };
} {
  return {
    candidate_id: candidateId, status: "awaiting_build",
    build_required: {
      patch_digest: patchDigest,
      lease_expires_at: new Date(requestedAt.getTime() + BUILD_LEASE_MS).toISOString(),
      command: `npm run candidate-build -- --candidate ${candidateId} --repo <path-to-a-checkout>`,
    },
  };
}
