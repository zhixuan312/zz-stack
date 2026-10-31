#!/usr/bin/env node
/**
 * gate.ts — everything that must be true before a release leaves this machine.
 *
 *   node scripts/gate.ts            # all checks
 *   node scripts/gate.ts --quiet    # only failures
 *   node scripts/gate.ts --report PATH   # also write a machine-readable execution report
 *
 * Exit 0 = safe to release. Non-zero = do not.
 *
 * `tsc -b` is not a gate: a duplicate MCP tool registration typechecks cleanly, deploys cleanly,
 * and returns 500 for every request to zz-core, because the server is built per request and the
 * throw takes the whole builder down. The checks here are the ones that catch that class.
 *
 * `--report` is optional and changes nothing else: stdout, the exit codes and every check are what
 * they are without it. PATH must resolve outside this repository — the report names every check
 * discovered, executed, skipped and failed, and a report written into the tree would be hashed
 * into the next run's own `source_tree_sha256`. `scripts/gate/run.ts` refuses an inside path at
 * startup.
 *
 * DELIBERATE: a gate inside a gate is refused at runtime, before `marketplace.ts` regenerates
 * anything — see the `ZZ_GATE_RUNNING` guard in `gate/run.ts`, which this file's first import
 * pulls in ahead of every check module.
 *
 * COUPLED: this file is an order, not a list. Every check lives in `gate/checks/<subject>.ts` and
 * each module registers its own checks when imported, so the loads below are the gate and a load
 * missing here is a module that does not run.
 *
 * DELIBERATE: `build` is the only check module imported statically, and every other one is loaded
 * with `import()` after it. Node evaluates a module's whole static import graph before its body,
 * so a statically imported check would load `@zz/contracts` or `@zz/indexing` from the dist that
 * existed before `tsc -b` ran, and on a clone with no dist the gate could not start. A module that
 * fails to load is reported and skipped, and `report()` then ends the run GATE INCOMPLETE.
 * suites.ts holds the static graph to this.
 */
import "./gate/checks/build.ts";
import { errMessage } from "./gate/read.ts";
import { report } from "./gate/run.ts";

async function load(module: string): Promise<void> {
  try {
    await import(module);
  } catch (err) {
    console.error(`  ✗ ${module} did not load\n      ${errMessage(err)}`);
  }
}

await load("./gate/checks/image.ts");

await load("./gate/checks/catalog-manifest.ts");
await load("./gate/checks/plugin-declaration.ts");
await load("./gate/checks/catalog-stages.ts");
await load("./gate/checks/stage-produces.ts");
await load("./gate/checks/marketplace.ts");
await load("./gate/checks/catalog-servers.ts");

await load("./gate/checks/skill-shape.ts");
await load("./gate/checks/skill-claims.ts");
await load("./gate/checks/skill-tools.ts");
await load("./gate/checks/skill-calls.ts");
await load("./gate/checks/skill-prose.ts");
await load("./gate/checks/prose-names.ts");

await load("./gate/checks/documents-envelope.ts");
await load("./gate/checks/documents-frontmatter.ts");
await load("./gate/checks/documents-schema.ts");
await load("./gate/checks/documents-guards.ts");
await load("./gate/checks/documents-lifecycle.ts");
await load("./gate/checks/knowledge.ts");
await load("./gate/checks/han-analysis.ts");
await load("./gate/checks/query-grammar.ts");
await load("./gate/checks/legacy-han-retrieval.ts");
await load("./gate/checks/text-search-config-agreement.ts");
await load("./gate/checks/skills-provider-neutral.ts");
await load("./gate/checks/generic-host-genericity.ts");
await load("./gate/checks/rule-registry.ts");
await load("./gate/checks/recall-result-contract.ts");
await load("./gate/checks/plan-validator.ts");
await load("./gate/checks/assessment-port.ts");
await load("./gate/checks/checkpoints-consumed.ts");
await load("./gate/checks/jev-adapter.ts");
await load("./gate/checks/close-truthfulness.ts");
await load("./gate/checks/stopped-close-exemption.ts");
await load("./gate/checks/negative-control-probes.ts");
await load("./gate/checks/search-predicate-parameters.ts");
await load("./gate/checks/host-chain.ts");
await load("./gate/checks/contracts-door.ts");
await load("./gate/checks/write-path-analysis.ts");
await load("./gate/checks/rederivation-generation.ts");

await load("./gate/checks/data-sql.ts");
await load("./gate/checks/data-telemetry.ts");
await load("./gate/checks/data-telemetry-reports.ts");

await load("./gate/checks/security-identity.ts");
await load("./gate/checks/security-secrets.ts");
await load("./gate/checks/security-boundary.ts");

await load("./gate/checks/deploy-compose.ts");
await load("./gate/checks/deploy-release.ts");
await load("./gate/checks/deploy-ops.ts");
await load("./gate/checks/config-env.ts");

await load("./gate/checks/console.ts");
await load("./gate/checks/docs-integrity.ts");
await load("./gate/checks/hygiene.ts");
await load("./gate/checks/suites.ts");
await load("./gate/checks/suites-tooling.ts");
await load("./gate/checks/suites-data.ts");
await load("./gate/checks/suites-surface.ts");

report();
