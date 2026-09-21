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
 * ONE MODULE, AND IT IS A PROCEDURE THIS PLATFORM ALREADY RUNS. `sdlc-flow` is the delivery
 * discipline declared in `catalog/sdlc/sdlc-flow/flow.json` — seven stages, three gated
 * documents, two audits — restated in the vocabulary the host understands. The manifest is
 * still the authority on the ORDER and the GATES; what it does not carry, and what a control
 * loop needs, is what each step accepts as evidence, what count of it completes the step, and
 * what completing it makes claimable. Those are the authored half of this body, and they are
 * the half the word "reviewed" refers to.
 *
 * WRITTEN DOWN, NOT READ FROM `/catalog`. The registry's own words are that a body is a file
 * that shipped; a body assembled at boot from a mounted directory is instead a function of
 * `ZZ_CATALOG_DIR`, and its digest would be checked against a number recorded for some other
 * mount. So the body is a literal here, and the gate holds it in step with the manifest —
 * drift fails the build rather than the process.
 *
 * ADDING ONE, when there is another: put the body in `bodies`, run `moduleDigest` over it, and
 * record that digest in `allowlist` beside the id. The digest is written down rather than
 * computed here on purpose — a digest derived from the body it is checked against would match
 * every body, including one edited after it was reviewed. An id with no entry beside it is
 * refused, and so is a body that appears in `bodies` without one.
 */
import type { ProcedureStep, ReviewedModule } from "@zz/contracts";

import type { PackagedCatalogue } from "./host/registry.js";

/** The one material kind this procedure moves: a flow document written into the initiative.
 *  `explore.md`, `spec.md`, `plan.md` and `review.md` are all this kind — the step an entry is
 *  recorded against is what says which document it was. */
const DOCUMENT = { name: "document", carries: "material" } as const;

/** A person's approval of a gated document — `document_approve`'s stamp, which is a judgement
 *  on material already recorded and never a fact about the work. */
const APPROVAL = { name: "approval", carries: "judgement" } as const;

/** An audit round's findings, registered against the document they were raised about. The two
 *  audit stages `produce: "source"` in the manifest, which is what an audit leaves behind:
 *  material a later reader can follow, rating a document that already exists. */
const AUDIT = { name: "audit", carries: "judgement" } as const;

/** A stage that writes one document and, when the manifest gates it, waits for somebody to
 *  approve it. `about: "document"` on the approval rule is the part worth stating: an approval
 *  counts only when it points at a document entry the run actually holds, so a stage cannot be
 *  completed by approving nothing. */
function writes(id: string, after: string[], gated: boolean, method: string,
                grants: string[]): ProcedureStep {
  return {
    id,
    method,
    after,
    accepts: gated ? [DOCUMENT, APPROVAL] : [DOCUMENT],
    completion: gated
      ? [{ kind: "document", atLeast: 1 }, { kind: "approval", atLeast: 1, about: "document" }]
      : [{ kind: "document", atLeast: 1 }],
    grants,
  };
}

/** An audit stage. It records no document of its own — it rates the one the stage before it
 *  produced, which is why its single rule follows the back-reference into that stage's
 *  evidence rather than counting anything recorded here alone. */
function audits(id: string, after: string[], method: string, grants: string[]): ProcedureStep {
  return {
    id,
    method,
    after,
    accepts: [AUDIT],
    completion: [{ kind: "audit", atLeast: 1, about: "document" }],
    grants,
  };
}

/**
 * The delivery procedure, as the host reads one.
 *
 * `enrolment.requires` IS EMPTY, AND THAT IS THE TRUTH RATHER THAN A DEFAULT. `initiative_open`
 * refuses a flow the catalog does not carry; it asks nothing about the caller. Whether this
 * flow may be run is a property of the deployment's shelf, not of anybody's profile, so a
 * required attribute here would be an authority this platform does not actually check.
 *
 * `sdlc-execute` ACCEPTS NOTHING AND COMPLETES ON NOTHING, because the manifest says it
 * `produces: "nothing"` and the platform records nothing for it. A step whose predecessor has
 * completed is satisfied; inventing a `change` or `commit` kind nothing writes would have made
 * the procedure look better and the record false.
 *
 * THE METHOD LINES ARE ONE SENTENCE EACH, and deliberately short. Every byte of this body is
 * under the digest, so prose copied out of a skill would make the approval expire every time
 * somebody edited that skill's wording. The sentence names the skill; the skill carries the
 * method.
 */
const sdlcDelivery: ReviewedModule = {
  id: "sdlc-flow",
  enrolment: { requires: [] },
  steps: [
    writes("sdlc-explore", [], false,
           "Run the sdlc-explore skill; it grounds the idea and produces explore.md.",
           ["write:spec.md"]),
    writes("sdlc-spec", ["sdlc-explore"], true,
           "Run the sdlc-spec skill; it produces spec.md, which a person must approve.",
           ["audit:spec.md"]),
    audits("sdlc-spec-audit", ["sdlc-spec"],
           "Run the sdlc-spec-audit skill; it registers its findings as a source on spec.md.",
           ["write:plan.md"]),
    writes("sdlc-plan", ["sdlc-spec-audit"], true,
           "Run the sdlc-plan skill; it produces plan.md, which a person must approve.",
           ["audit:plan.md"]),
    audits("sdlc-plan-audit", ["sdlc-plan"],
           "Run the sdlc-plan-audit skill; it registers its findings as a source on plan.md.",
           ["execute:plan.md"]),
    {
      id: "sdlc-execute",
      method: "Run the sdlc-execute skill; it builds what the approved plan describes.",
      after: ["sdlc-plan-audit"],
      accepts: [],
      completion: [],
      grants: ["write:review.md"],
    },
    writes("sdlc-review", ["sdlc-execute"], true,
           "Run the sdlc-review skill; it produces review.md, which a person must approve.",
           ["close:initiative"]),
  ],
};

/**
 * The approvals, and the bodies they approve.
 *
 * The digest below was produced by running `moduleDigest` over the body above and writing the
 * answer here. It is not recomputed at this call site, and it must not be: see the header.
 */
export const packagedModules: PackagedCatalogue = {
  allowlist: [
    { id: "sdlc-flow",
      digest: "25bc5ab68ac111e75b81cbb470584f2bf728c3a08efd48740d6d4f7b85839de0" },
  ],
  bodies: new Map([["sdlc-flow", sdlcDelivery]]),
};
