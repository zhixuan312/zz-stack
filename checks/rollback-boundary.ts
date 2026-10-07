#!/usr/bin/env node
/**
 * checks/rollback-boundary.ts — the rollback boundary this release carries, enforced and checked
 * on new-format data (AC-5.1).
 *
 *   node checks/rollback-boundary.ts   # needs Docker, curl, git with this repo's tags, and a built tree
 *
 * What it establishes, one line per case:
 *
 *   - the guard (`scripts/release/rollback-guard.ts`) over a fixture repository: a migration
 *     declaring `-- rollback: refused — <reason>` refuses with its file and reason, destructive DDL
 *     still refuses with its existing reason, a migration with neither permits, and a version with
 *     no tag is the guard's error, never "every migration is new";
 *   - from HEAD back to the derived previous release, the refusing set is exactly
 *     {002_document_versions.sql}, with its declared reason;
 *   - the lines a refused rollback prints: every verification failure, every reason or the guard's
 *     error, and that the release is STILL LIVE; fix forward;
 *   - `scripts/release.ts` read as text: step 6 asks the guard before its `try`, only when the
 *     previous version differs, and its refusal branch dies before the rollback is called;
 *     `--rollback` asks it before the first command that changes the host; the compose header, the
 *     `.env.example` ZZ_VERSION comment and the release script's header name the guarded route;
 *   - on a throwaway database migrated by the real runner and filled through a real zz-core with
 *     new-format state, the previous release's own revision insert (read from its tag with `git
 *     show`) is refused by the NOT NULL `version`, its public-version rendering disagrees with
 *     `current_version`, the runner re-run is a no-op that leaves every row as it was, and one more
 *     `document_edit` and `document_read` advance the version from the corrected state.
 *
 * It runs the previous release's STATEMENTS, not its image. It never contacts the host.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { boundary, CaseFailed, guardCases, headCases, lineCases, previousRelease, textCases } from "../scripts/schema/rollback-cases.ts";
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";
import { listenGateway } from "../scripts/schema/upload-cases.ts";

const NAME = "rollback-boundary";

let previous = "";
try {
  previous = previousRelease();
  guardCases();
  headCases(previous);
  lineCases();
  textCases();
} catch (err) {
  console.error(err instanceof CaseFailed ? `${NAME}: ${err.message}` : `${NAME}: ${String((err as Error)?.stack ?? err)}`);
  process.exit(1);
}

const gateway = await listenGateway();
// Read by the child's `upload_start`: the routes it answers are this listener's.
process.env.GATEWAY_PUBLIC_URL = gateway.url;
try {
  process.exitCode = await withThrowawayCore(NAME,
    `${NAME}: no rollback across a migration that refuses one; v${previous}'s own statements cannot write and misread new-format data, the runner is a no-op, and the new image writes on: ok`,
    async (c) => {
      const g = await gateway.attach(c);
      try {
        await boundary(c, g, previous);
      } finally {
        await g.end();
      }
    });
} finally {
  await gateway.stop();
  delete process.env.GATEWAY_PUBLIC_URL;
}
