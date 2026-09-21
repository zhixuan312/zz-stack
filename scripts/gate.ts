#!/usr/bin/env node
/**
 * gate.ts — everything that must be true before a release leaves this machine.
 *
 * WHY THIS EXISTS. Until now the only gate between "I edited a file" and "every user's
 * platform is down" was `tsc -b`. That is not hypothetical: a duplicate MCP tool
 * registration typechecked cleanly, deployed cleanly, and returned 500 for every
 * request to zz-core for about four minutes — including document_write and
 * initiative_status — because the server is built per request and the throw took the
 * whole builder down. Nothing caught it. I found it by reading logs.
 *
 * The checks are the ones that would have. Most were written as throwaway scripts during a
 * loop test and found four real defects in five rounds; this is them, promoted to blocking.
 *
 *   node scripts/gate.ts            # all checks
 *   node scripts/gate.ts --quiet    # only failures
 *   node scripts/gate.ts --report PATH   # ALSO write a machine-readable execution report
 *
 * Exit 0 = safe to release. Non-zero = do not.
 *
 * `--report` is optional and changes nothing else: stdout, the exit codes and every check are
 * what they are without it. PATH must resolve OUTSIDE this repository — the report names every
 * check discovered, executed, skipped and failed, which is private acceptance evidence rather
 * than a repository deliverable, and a report written into the tree would be hashed into the
 * next run's own `source_tree_sha256`. `scripts/gate/run.ts` refuses an inside path at startup.
 *
 * A GATE INSIDE A GATE IS REFUSED, at runtime, before `marketplace.ts` regenerates anything —
 * see the `ZZ_GATE_RUNNING` guard in `gate/run.ts`, which this file's very first import pulls
 * in ahead of every check module.
 *
 * THIS FILE IS AN ORDER, NOT A LIST. Every check lives in `gate/checks/<subject>.ts`,
 * grouped by what it is about, and each module registers its own checks when it is
 * imported — so the imports below are the gate, and an import missing here is a module
 * that does not run. `build` is first because several of its checks RUN something and
 * everything after may rely on the build having succeeded.
 *
 * It was one 11,428-line file until 2026-09-11, with 273 checks and nine shared helpers
 * interleaved between them. Splitting it changed no check's logic; what it changed is that
 * a person looking for the rule about backups now opens `deploy-ops.ts` instead of
 * scrolling a file where §5 alone ran for 9,550 lines.
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
import "./gate/checks/assessment-port.ts";
import "./gate/checks/central-binding.ts";
import "./gate/checks/dependency-invalidation.ts";
import "./gate/checks/commit-result-reconciliation.ts";
import "./gate/checks/label-only-adapter.ts";
import "./gate/checks/jev-adapter.ts";
import "./gate/checks/runtime-adapter-portability.ts";
import "./gate/checks/eval-protocol-shape.ts";
import "./gate/checks/readiness-basis.ts";
import "./gate/checks/audit-identity.ts";
import "./gate/checks/gap-routing.ts";
import "./gate/checks/observation-manifests.ts";
import "./gate/checks/close-truthfulness.ts";
import "./gate/checks/benchmark-report-slices.ts";
import "./gate/checks/search-read-synthesis.ts";
import "./gate/checks/mutation-coverage.ts";
import "./gate/checks/activation-runbook.ts";
import "./gate/checks/trial-analyzer-agreement.ts";
import "./gate/checks/write-path-analysis.ts";
import "./gate/checks/rederivation-generation.ts";
import "./gate/checks/retrieval-serializer.ts";

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

import { report } from "./gate/run.ts";

report();
