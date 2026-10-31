/**
 * The smallest explore and spec bodies the platform's gates take: every section the explore gate
 * declares, and every section the spec gate declares with one phase and one core statement whose
 * evidence is a probe, so no `evidence_relation` question is due.
 *
 * COUPLED: the spec gate's declared sections (catalog/sdlc/sdlc-flow). A section it adds is added
 * here once, for every check and script that writes a spec.
 */

/** An explore.md the explore gate takes. */
export const EXPLORE_BODY = "## Background\nx\n\n## Current state\nx\n\n## Rough direction\nx\n";

/** A spec.md the spec gate takes, its Context section reading `context`. */
export const specBody = (context = "x"): string =>
  `## Context\n${context}\n\n## Problem\nx\n\n## Goals & Requirements\nx\n\n## Alternatives\nx\n\n` +
  "## Approach, Method & Structure\nx\n\n## Verification Plan\nx\n\n## Risks & Mitigations\nx\n\n" +
  "## Stakeholders & Work\nx\n\n" +
  "## Phase outline\n- **Phase 0 — Loop:** the control loop runs end to end.\n\n" +
  "## Core statements\n| ID | Statement | If false | Status | Evidence | Note |\n|---|---|---|---|---|---|\n" +
  "| CS-1 | The loop runs. | Nothing is checked. | fails | run:control-loop-e2e — `loop` | resolved-by-design-change: a probe has no design |\n";

/** The spec with its Context section reading `x`. */
export const SPEC_BODY = specBody();
