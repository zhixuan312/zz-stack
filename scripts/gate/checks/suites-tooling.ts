/**
 * The repository's own build, strictness and naming, each delegated to `checks/`.
 *
 * The node floor, the tooling project's zero-strict-error rule, every script being `.ts`, and
 * the paths and locks that have to resolve. These are
 * about this repository rather than about the platform it ships, so a red gate here is not
 * product behaviour.
 */
import { check } from "../run.ts";
import { runsCheck } from "../suite-runner.ts";

check("the node floor is one decision written in package.json and .nvmrc, and the image does not move with it",
      runsCheck("engines-floor.ts"));

check("an unsupported Node fails naming both versions and why, as a runtime problem rather than a syntax error in the code",
      runsCheck("node-floor.ts"));

check("the node floor check fails, and fails informatively, when the floor is not met",
      runsCheck("node-floor-breaks.ts"));

check("the tooling project runs standalone through typecheck:tooling, is deliberately absent from tsc -b's reference graph, and inherits its strictness rather than softening it locally",
      runsCheck("tooling-project.ts"));

check("no file this rename touched went missing, and every sibling that imports one now names it by its .ts extension",
      runsCheck("rename-complete.ts"));

check("no discovery site under scripts/ or checks/ filters on .mjs alone, matching nothing after the rename",
      runsCheck("no-mjs-filters.ts"));

check("every literal path a script or check names under scripts/ or checks/ is a file that exists, so an import, a spawn or a read cannot outlive its target",
      runsCheck("literal-paths-resolve.ts"));

check("every entry point a human types — an npm script, a deploy script — names the .ts file that exists, not the .mjs file that no longer does",
      runsCheck("entry-points-resolve.ts"));

check("no file in checks/ reaches the compiler's zero by widening to any or silencing it",
      runsCheck("strict-checks-dir.ts"));

check("every scripts/gate/ module is reached, the registry it runs is intact, and none is typed by widening to any",
      runsCheck("strict-gate-dir.ts"));

check("nothing in the rest of scripts/ or in testing/ reaches the compiler's zero by widening to any",
      runsCheck("strict-scripts-dir.ts"));

check("the six shipped skill scripts are type-checked, every construct in them is erasable, and none is typed by widening to any",
      runsCheck("strict-catalog-skills.ts"));

check("what consumers receive is JavaScript, never the source, and rebuilding it changes nothing",
      runsCheck("marketplace-ships-js.ts"));

check("the command a model is told to run names a file the consumer will actually have",
      runsCheck("skill-commands-runnable.ts"));

check("a lock regenerated from the converted tree comes back unchanged, byte for byte",
      runsCheck("lock-current.ts"));

check("the whole tooling project carries zero strict errors, measured as one project rather than subtree by subtree",
      runsCheck("strict-tooling-zero.ts"));

check("every script or check a document or a thrown error names by path is a file that exists, and CHANGELOG.md alone is left free to remember one that isn't",
      runsCheck("docs-name-real-files.ts"));

check("a plugin's content identity moves with its content and not with its address",
      runsCheck("digest-per-plugin.ts"));

check("every planted defect still lands in its subject, so no check is covered by a plant that never ran",
      runsCheck("mutation-specs-match-subjects.ts"));

// The mutation suite is the only thing that tests the checks, it costs hours, and that is exactly
// why it is not a release step and why it must keep running on its own — two decisions that were
// neither stated nor guarded, and one of them was already broken in practice.
check("the mutation suite runs on its own, and no release can pull it in",
      runsCheck("mutation-is-not-a-release-step.ts"));

check("a file that resolves renamed tools never matches a pre-rename name",
      runsCheck("pre-rename-literals.ts"));

check("a failed check's reported detail ends with its reason — a FAILED or FAIL: line, a thrown error's message, a failure summary — whichever stream printed it, and a reason longer than the window keeps its head",
      runsCheck("check-failure-detail.ts"));
check("call takes every flag it reads: --timeout reaches the client, a bad value and an unknown flag are refused by name", runsCheck("call-flags.ts"));
check("testing/reset-store.sh reaches compose's psql through ssh, with the statement on stdin so psql interpolates its own variables", runsCheck("reset-store-transport.ts"));
check("testing/eval-step.sh tells an interviewing step the stakeholder answers, keeps that stakeholder in one session, continues the latest --from run, and names no gateway it does not use", runsCheck("eval-step-harness.ts"));
