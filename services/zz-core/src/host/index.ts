/**
 * This service's generic host, composed: a host with every approved module registered on it.
 *
 * ONE PLACE WHERE REGISTRATION HAPPENS, and it is called from the composition root rather
 * than from a tool. Registration is where an unapproved component, a caller-supplied body and
 * an altered digest are refused, and a refusal that waits until the first caller asks is a
 * refusal that ships: the process comes up looking healthy and the problem surfaces as a
 * failed request to somebody who cannot act on it.
 *
 * THE CATALOGUE IS PASSED IN. What this release packages and approves is content, and content
 * that varies — by release, and, in a test, by whatever the case needs. A host that reached
 * for a module-scope catalogue could not be built twice with different ones, which is the
 * arrangement that makes the refusals testable at all.
 */
import { createHost, type Host, type ReviewedModule } from "@zz/contracts";

import { refuseIssuanceInRegistry } from "./grant-issuance.js";
import { evaluateRun, type StepEvaluation } from "./jobs.js";
import { refuseUnapprovedBodies, registerReviewedModule, type AllowlistEntry,
         type PackagedCatalogue, type RegistrationRequest } from "./registry.js";

/** A composed host: the host itself, what got registered on it with the digest each was
 *  approved under, and the evaluation job already bound to it. */
export interface ReviewedModuleHost {
  readonly host: Host;
  readonly registered: readonly AllowlistEntry[];
  readonly evaluate: (module: ReviewedModule, runId: string) => readonly StepEvaluation[];
}

/** Build the host and register every module `packaged` approves, in allowlist order. Throws
 *  the first refusal rather than returning a partly-built host. */
export function reviewedModuleHost(packaged: PackagedCatalogue): ReviewedModuleHost {
  const host = createHost();
  // FIRST, WHAT SHIPPED. The loop below reads the allowlist, so a body with no entry beside
  // it is never reached and its absence from the result is the only trace it leaves. This
  // asks the other question — is everything in the release approved — before anything is
  // registered, so the answer is a refusal rather than a shorter list nobody counted.
  refuseUnapprovedBodies(packaged);
  // The request is built here and nowhere else, and it is built to the type: an id, and no
  // second field. That is what makes "a caller-supplied body is refused" a rule about
  // requests rather than a rule about this one call site remembering not to send one.
  const registered = packaged.allowlist.map((entry) => {
    const request: RegistrationRequest = { id: entry.id };
    return registerReviewedModule(host, packaged, request);
  });
  return {
    host,
    registered,
    evaluate: (module, runId) => evaluateRun(host, module, runId),
  };
}

/**
 * Refuse any door in this process that has registered the grant issuance operation.
 *
 * TAKES WHAT THE DOORS ACTUALLY REGISTERED, which is the only list worth checking. `door.ts`
 * records every `registerTool` call against the door it was made on, so this reads the
 * registrations themselves rather than a declaration of them kept alongside — a second list
 * would be the one a reviewer reads and not the one the process serves.
 *
 * GROUPED BY DOOR so the refusal can name which one, because a process serving several and a
 * refusal saying only "somewhere" is a refusal somebody has to go hunting for.
 */
export function refuseIssuanceOnDoors(registered: ReadonlyMap<string, string>): void {
  const byDoor = new Map<string, string[]>();
  for (const [name, door] of registered) {
    const names = byDoor.get(door) ?? [];
    names.push(name);
    byDoor.set(door, names);
  }
  for (const [door, names] of byDoor) refuseIssuanceInRegistry(door, names);
}

/**
 * The module governing one flow, and the digest it was approved under — or null.
 *
 * ONE LOOKUP, NOT ONE PER CALLER. Five tools need to ask "is this initiative's flow governed
 * by a reviewed module", and five copies of `allowlist.find` plus `bodies.get` would be five
 * places for the pair to come apart — the body from one entry and the digest from another is
 * a run recorded as judged against something it was not.
 *
 * NULL IS AN ANSWER AND NOT A FAILURE. Most flows have no reviewed module and never will;
 * `zz-plugin-eval` and every freeform initiative reach this and get null, which is the
 * platform saying "not governed" rather than "something went wrong". A caller must be able to
 * tell that from a run that exists and is unsatisfied, so nothing here throws.
 */
export function moduleForFlow(
  packaged: PackagedCatalogue, flow: string | null,
): { module: ReviewedModule; digest: string } | null {
  if (!flow) return null;
  const entry = packaged.allowlist.find((e) => e.id === flow);
  if (!entry) return null;
  const module = packaged.bodies.get(flow);
  if (!module) return null;
  return { module, digest: entry.digest };
}
