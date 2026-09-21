/**
 * Registering a reviewed module: the allowlist, the digest, and the three things refused.
 *
 * THE ENGINE IS NOT HERE. `@zz/contracts` owns what a module is and what a host does with one,
 * because a fixture has to be able to drive the same engine the service does and this package
 * sits above it in the dependency graph. What this module owns is the part that is genuinely
 * the service's: which bodies the release packages, which of them are approved, and the
 * comparison that decides whether the body in hand is the body that was reviewed.
 *
 * THREE REFUSALS, AND EACH IS A DIFFERENT ATTACK.
 *
 *   · A CALLER-SUPPLIED BODY. Registration takes an id and nothing else. A request arriving
 *     with a body attached is refused by name rather than having the field quietly ignored,
 *     because "ignored" and "accepted" are indistinguishable to whoever sent it, and the
 *     ignoring is one refactor away from becoming acceptance.
 *
 *   · AN UNAPPROVED COMPONENT. An id nobody put on the allowlist is refused even when the
 *     release happens to package a body under that name. Packaging is not approval: a module
 *     that shipped in the tree and was never reviewed is precisely the case the allowlist
 *     exists for.
 *
 *   · AN ALTERED DIGEST. The allowlist records the digest of the body that was reviewed. The
 *     body the release hands over is hashed here, by the same function that produced that
 *     number, and a body edited after review does not match it. Recomputing the expected
 *     digest from the body in hand would make this comparison pass by construction, which is
 *     the one thing an integrity check must never do.
 *
 * A REFUSAL IS THROWN, not returned. Registration happens at the composition root, before the
 * process serves anything; there is no caller to hand a soft answer to, and a host that came
 * up having silently skipped a module would be a host whose behaviour depends on a failure
 * nobody saw.
 */
import { moduleDigest, type Host, type ReviewedModule } from "@zz/contracts";

import { Refusal } from "../refusal.js";

/** One approved module: which id, and the digest of the body that was approved under it. */
export interface AllowlistEntry {
  readonly id: string;
  readonly digest: string;
}

/** What the release packages: the approvals, and the bodies they approve. Two separate
 *  structures on purpose — an approval is a decision somebody recorded, a body is a file that
 *  shipped, and collapsing them into one would make every shipped file approved. */
export interface PackagedCatalogue {
  readonly allowlist: readonly AllowlistEntry[];
  readonly bodies: ReadonlyMap<string, ReviewedModule>;
}

/** A registration request: an id, and deliberately nothing else. `body` is declared as `never`
 *  so a typed caller cannot supply one and an untyped caller is refused for it below. */
export interface RegistrationRequest {
  readonly id: string;
  readonly body?: never;
}

/**
 * Refuse a catalogue that packages a body nobody approved.
 *
 * REGISTRATION IS DRIVEN BY THE ALLOWLIST, so a body with no entry beside it is never asked
 * for — and "never asked for" was being served as "harmless". It is not: an unapproved body
 * in the release is the case the allowlist exists to catch, and a release that carries one
 * and says nothing is the same silence as one that runs it. Fail-safe is not fail-silent.
 *
 * SWEPT FROM THE BODIES, NOT FROM THE ALLOWLIST, because that is the direction nothing else
 * looks. Every other refusal here starts from an id somebody asked about; this one starts
 * from what actually shipped.
 */
export function refuseUnapprovedBodies(packaged: PackagedCatalogue): void {
  const approved = new Set(packaged.allowlist.map((a) => a.id));
  const unapproved = [...packaged.bodies.keys()].filter((id) => !approved.has(id));
  if (unapproved.length) {
    throw new Refusal(
      `ERROR: ${unapproved.join(", ")} — packaged with this release and never approved. ` +
      "A body reaches a host through the allowlist and nowhere else, so this one would not " +
      "have run; it is refused rather than skipped because a body that arrived in a release " +
      "without approval is exactly what the allowlist is watching for",
    );
  }
}

/**
 * Register one approved module on `host`, or refuse.
 *
 * Returns the allowlist entry that approved it, so the composition root can report what it
 * registered with the digest it registered it under rather than with the id alone.
 */
export function registerReviewedModule(
  host: Host,
  packaged: PackagedCatalogue,
  request: RegistrationRequest,
): AllowlistEntry {
  if ("body" in request) {
    throw new Refusal(
      `ERROR: a module body may not be supplied by the caller — ${request.id} is registered ` +
      "from the body packaged with this release, and a body that arrived with the request " +
      "would be code nobody reviewed running under a reviewed name",
    );
  }
  const entry = packaged.allowlist.find((a) => a.id === request.id);
  if (!entry) {
    throw new Refusal(
      `ERROR: ${request.id} is not an approved component — this release's allowlist carries ` +
      `${packaged.allowlist.length} module(s), and packaging a body is not approval of it`,
    );
  }
  const body = packaged.bodies.get(entry.id);
  if (!body) {
    throw new Refusal(
      `ERROR: ${entry.id} is approved but no body for it was packaged with this release`,
    );
  }
  // THE BODY MUST ANSWER TO THE NAME IT WAS APPROVED UNDER. A body filed in the catalogue
  // under an approved id while calling itself something else registers on the host as that
  // other name — approval granted to one module, spent on another, with nothing said.
  if (body.id !== entry.id) {
    throw new Refusal(
      `ERROR: the body packaged as ${entry.id} identifies itself as ${body.id}, so approval ` +
      `for ${entry.id} would register a module nobody approved`,
    );
  }
  const actual = moduleDigest(body);
  if (actual !== entry.digest) {
    throw new Refusal(
      `ERROR: ${entry.id} does not match the digest it was approved under — the allowlist ` +
      `records ${entry.digest.slice(0, 12)} and the packaged body hashes to ` +
      `${actual.slice(0, 12)}, so the body changed after it was reviewed`,
    );
  }
  host.register(body);
  return entry;
}
