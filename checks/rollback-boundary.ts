#!/usr/bin/env node
/**
 * checks/rollback-boundary.ts — the rollback boundary this release carries, enforced and checked
 * on new-format data (AC-5.1).
 *
 *   node checks/rollback-boundary.ts   # needs Docker, curl, git with this repo's tags, and a built tree
 *
 * What it establishes, one line per case:
 *
 *   - the guard (`scripts/release/rollback-guard.ts`) over a fixture repository whose live version
 *     has no tag yet, release step 6's shape: a migration declaring `-- rollback: refused —
 *     <reason>` refuses with its file and reason, in any case and indented; destructive DDL — a
 *     drop, a retype with or without COLUMN, a dropped view or function, a rename of a column
 *     (COLUMN optional), table, view, type, enum value, function or schema — refuses with its
 *     existing reason, and a rename the old code cannot see (an index, sequence, trigger or
 *     constraint, or a table a new migration's plain CREATE made and the earlier release never
 *     created) permits, while one the release only re-creates (OR REPLACE, IF NOT EXISTS), names
 *     in a comment or a function body, or the earlier release creates refuses; a migration with
 *     neither permits; a version with no tag is the guard's error, never "every migration is
 *     new"; and a host on an untagged version that is not the checkout's is the guard's error;
 *   - the guard over a fixture repository of three tagged releases: the live release is read from
 *     its tag, so an unreleased migration in the checkout refuses nothing and a fold committed
 *     without a version bump still refuses what the release applied; a migration absorbed since the
 *     target release refuses as if it were still a file, read from the tag that has it, with its
 *     absorbs line in any case and indented; and one no tag carries, or a released one a fold did
 *     not record, is the guard's error;
 *   - this checkout as the release it would become, back to the derived previous release: the
 *     refusing set is exactly {002_document_versions.sql}, with its declared reason; and between
 *     that release and the one before it, from their tags, it is no part of the answer;
 *   - the lines a refused rollback prints: every verification failure, every reason or the guard's
 *     error, and that the release is STILL LIVE; fix forward;
 *   - `scripts/release.ts` read as text: step 6 asks the guard before its `try`, only when the
 *     previous version differs, telling it the host runs this release, its refusal branch dies
 *     before the rollback is called, and a same-version re-run never reaches the rollback;
 *     `--rollback` asks it, with the version the host runs, before the first command that changes
 *     the host; the compose header, the
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
import { boundary, CaseFailed, foldCases, guardCases, headCases, lineCases, previousRelease, textCases } from "../scripts/schema/rollback-cases.ts";
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";
import { listenGateway } from "../scripts/schema/upload-cases.ts";

const NAME = "rollback-boundary";

let previous = "";
try {
  previous = previousRelease();
  guardCases();
  foldCases();
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
