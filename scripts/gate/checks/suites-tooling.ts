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

check("checks/ carries zero strict errors, and none of them was reached by widening to any",
      runsCheck("strict-checks-dir.ts"));

check("scripts/gate/ carries zero strict errors, the registry it runs is unchanged, and none of them was reached by widening to any",
      runsCheck("strict-gate-dir.ts"));

check("the rest of scripts/ and testing/ carry zero strict errors, and none of them was reached by widening to any",
      runsCheck("strict-scripts-dir.ts"));

check("the five shipped skill scripts carry zero strict errors, every construct in them is erasable, and none was reached by widening to any",
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

check("a check that works is a check the gate runs",
      runsCheck("working-checks-registered.ts"));

check("a file that resolves renamed tools never matches a pre-rename name",
      runsCheck("pre-rename-literals.ts"));
