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
 * each module registers its own checks when imported, so the imports below are the gate and an
 * import missing here is a module that does not run. `build` is first because several of its
 * checks run something and everything after may rely on the build having succeeded.
 */
import "./gate/checks/build.ts";
import "./gate/checks/image.ts";

import "./gate/checks/catalog-manifest.ts";
import "./gate/checks/plugin-declaration.ts";
import "./gate/checks/catalog-stages.ts";
import "./gate/checks/stage-produces.ts";
import "./gate/checks/marketplace.ts";
import "./gate/checks/catalog-servers.ts";

import "./gate/checks/skill-shape.ts";
import "./gate/checks/skill-claims.ts";
import "./gate/checks/skill-tools.ts";
import "./gate/checks/skill-calls.ts";
import "./gate/checks/skill-prose.ts";
import "./gate/checks/prose-names.ts";

import "./gate/checks/documents-envelope.ts";
import "./gate/checks/documents-frontmatter.ts";
import "./gate/checks/documents-schema.ts";
import "./gate/checks/documents-guards.ts";
import "./gate/checks/documents-lifecycle.ts";
import "./gate/checks/knowledge.ts";
import "./gate/checks/han-analysis.ts";
import "./gate/checks/query-grammar.ts";
import "./gate/checks/legacy-han-retrieval.ts";
import "./gate/checks/snippet-byte-ranges.ts";
import "./gate/checks/analyzer-opacity-fixture.ts";
import "./gate/checks/native-lane-applicability.ts";
import "./gate/checks/scope-filters-survive-lanes.ts";
import "./gate/checks/text-search-config-agreement.ts";
import "./gate/checks/skills-provider-neutral.ts";
import "./gate/checks/generic-host-genericity.ts";
import "./gate/checks/rule-registry.ts";
import "./gate/checks/recall-result-contract.ts";
import "./gate/checks/plan-validator.ts";
import "./gate/checks/issuer-unreachable.ts";
import "./gate/checks/grant-claim-refusals.ts";
import "./gate/checks/assessment-port.ts";
import "./gate/checks/central-binding.ts";
import "./gate/checks/dependency-invalidation.ts";
import "./gate/checks/commit-result-reconciliation.ts";
import "./gate/checks/label-only-adapter.ts";
import "./gate/checks/jev-adapter.ts";
import "./gate/checks/runtime-adapter-portability.ts";
import "./gate/checks/readiness-basis.ts";
import "./gate/checks/audit-identity.ts";
import "./gate/checks/gap-routing.ts";
import "./gate/checks/observation-manifests.ts";
import "./gate/checks/close-truthfulness.ts";
import "./gate/checks/stopped-close-exemption.ts";
import "./gate/checks/negative-control-probes.ts";
import "./gate/checks/search-predicate-parameters.ts";
import "./gate/checks/benchmark-report-slices.ts";
import "./gate/checks/search-read-synthesis.ts";
import "./gate/checks/activation-runbook.ts";
import "./gate/checks/trial-analyzer-agreement.ts";
import "./gate/checks/host-chain.ts";
import "./gate/checks/contracts-door.ts";
import "./gate/checks/write-path-analysis.ts";
import "./gate/checks/rederivation-generation.ts";

import "./gate/checks/data-sql.ts";
import "./gate/checks/data-telemetry.ts";
import "./gate/checks/data-telemetry-reports.ts";
import "./gate/checks/judged-corpus-census.ts";

import "./gate/checks/security-identity.ts";
import "./gate/checks/security-secrets.ts";
import "./gate/checks/security-boundary.ts";

import "./gate/checks/deploy-compose.ts";
import "./gate/checks/deploy-release.ts";
import "./gate/checks/deploy-ops.ts";
import "./gate/checks/config-env.ts";

import "./gate/checks/console.ts";
import "./gate/checks/docs-integrity.ts";
import "./gate/checks/hygiene.ts";
import "./gate/checks/suites.ts";
import "./gate/checks/suites-tooling.ts";
import "./gate/checks/suites-data.ts";
import "./gate/checks/suites-surface.ts";
import "./gate/checks/suites-tenant.ts";

import { report } from "./gate/run.ts";

report();
