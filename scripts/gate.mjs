#!/usr/bin/env node
/**
 * gate.mjs — everything that must be true before a release leaves this machine.
 *
 * WHY THIS EXISTS. Until now the only gate between "I edited a file" and "every user's
 * platform is down" was `tsc -b`. That is not hypothetical: a duplicate MCP tool
 * registration typechecked cleanly, deployed cleanly, and returned 500 for every
 * request to zz-core for about four minutes — including write_file and
 * initiative_status — because the server is built per request and the throw took the
 * whole builder down. Nothing caught it. I found it by reading logs.
 *
 * The checks are the ones that would have. Most were written as throwaway scripts during a
 * loop test and found four real defects in five rounds; this is them, promoted to blocking.
 *
 *   node scripts/gate.mjs            # all checks
 *   node scripts/gate.mjs --quiet    # only failures
 *
 * Exit 0 = safe to release. Non-zero = do not.
 *
 * THIS FILE IS AN ORDER, NOT A LIST. Every check lives in `gate/checks/<subject>.mjs`,
 * grouped by what it is about, and each module registers its own checks when it is
 * imported — so the imports below are the gate, and an import missing here is a module
 * that does not run. `build` is first because several of its checks RUN something and
 * everything after may rely on the build having succeeded.
 *
 * It was one 11,428-line file until 2026-09-11, with 273 checks and nine shared helpers
 * interleaved between them. Splitting it changed no check's logic; what it changed is that
 * a person looking for the rule about backups now opens `deploy-ops.mjs` instead of
 * scrolling a file where §5 alone ran for 9,550 lines.
 */
import "./gate/checks/build.mjs";

import "./gate/checks/catalog-manifest.mjs";
import "./gate/checks/catalog-stages.mjs";

import "./gate/checks/skill-shape.mjs";
import "./gate/checks/skill-claims.mjs";
import "./gate/checks/skill-tools.mjs";
import "./gate/checks/skill-prose.mjs";

import "./gate/checks/documents-envelope.mjs";
import "./gate/checks/documents-frontmatter.mjs";
import "./gate/checks/documents-schema.mjs";
import "./gate/checks/documents-guards.mjs";
import "./gate/checks/documents-lifecycle.mjs";
import "./gate/checks/knowledge.mjs";

import "./gate/checks/data-sql.mjs";
import "./gate/checks/data-telemetry.mjs";

import "./gate/checks/security-identity.mjs";
import "./gate/checks/security-secrets.mjs";
import "./gate/checks/security-boundary.mjs";

import "./gate/checks/deploy-compose.mjs";
import "./gate/checks/deploy-release.mjs";
import "./gate/checks/deploy-ops.mjs";
import "./gate/checks/config-env.mjs";

import "./gate/checks/console.mjs";
import "./gate/checks/docs-integrity.mjs";
import "./gate/checks/hygiene.mjs";
import "./gate/checks/suites.mjs";

import { report } from "./gate/run.mjs";

report();
