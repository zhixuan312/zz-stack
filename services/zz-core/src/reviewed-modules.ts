/**
 * What this release packages and approves for the generic host.
 *
 * CONTENT, NOT KERNEL, and that is why it sits here rather than under `host/`. Everything in
 * that directory is the mechanism — what a registration is, what a digest proves, how a run's
 * steps are evaluated — and it holds for every procedure a host will ever run. A module BODY
 * is the opposite: it is one procedure, with one flow's steps, evidence kinds and completion
 * rules written into it. Keeping the two apart is what lets the mechanism be judged on its own
 * terms, and what stops one flow's vocabulary from becoming a branch in code that serves all
 * of them.
 *
 * EMPTY, TODAY, AND SAYING SO. No reviewed module has been approved yet: this phase builds the
 * host and the registration path, and the procedures it will run are packaged by the tasks
 * that write them. An empty allowlist is not an inert placeholder — it refuses every id asked
 * of it, and it refuses a body that appears in `bodies` without one, which is the correct
 * behaviour for a release that has approved nothing.
 *
 * ADDING ONE, when there is one: put the body in `bodies`, run `moduleDigest` over it, and
 * record that digest in `allowlist` beside the id. The digest is written down rather than
 * computed here on purpose — a digest derived from the body it is checked against would match
 * every body, including one edited after it was reviewed.
 */
import type { PackagedCatalogue } from "./host/registry.js";

export const packagedModules: PackagedCatalogue = {
  allowlist: [],
  bodies: new Map(),
};
