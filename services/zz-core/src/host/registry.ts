/**
 * Registering a reviewed module: the allowlist, the digest, and the three things refused.
 *
 * COUPLED: `@zz/contracts` owns what a module is and what a host does with one, so a fixture
 * drives the same engine the service does. This module owns which bodies the release packages,
 * which of them are approved, and the comparison that decides whether the body in hand is the
 * body that was reviewed.
 *
 * Three refusals:
 *
 *   · A caller-supplied body. Registration takes an id and nothing else, and a request
 *     arriving with a body attached is refused by name rather than having the field ignored —
 *     ignored and accepted are indistinguishable to whoever sent it.
 *
 *   · An unapproved component. An id nobody put on the allowlist is refused even when the
 *     release packages a body under that name: packaging is not approval.
 *
 *   · An altered digest. The allowlist records the digest of the body that was reviewed, and
 *     the body the release hands over is hashed here by the same function. DELIBERATE: the
 *     expected digest is never recomputed from the body in hand, which would make the
 *     comparison pass by construction.
 *
 * A refusal is thrown, not returned. Registration happens at the composition root before the
 * process serves anything, so there is no caller to hand a soft answer to.
 */
import { moduleDigest, type Host, type ReviewedModule } from "@zz/contracts";

import { Refusal } from "../refusal.js";

/** One approved module: which id, and the digest of the body that was approved under it. */
export interface AllowlistEntry {
  readonly id: string;
  readonly digest: string;
}

/** What the release packages: the approvals, and the bodies they approve. DELIBERATE: two
 *  structures — an approval is a decision somebody recorded, a body is a file that shipped, and
 *  collapsing them would make every shipped file approved. */
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
 * Registration is driven by the allowlist, so a body with no entry beside it is never asked
 * for. That is not harmless: an unapproved body in the release is the case the allowlist
 * exists to catch.
 *
 * Swept from the bodies, not from the allowlist: every other refusal here starts from an id
 * somebody asked about, and this one starts from what shipped.
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
  // The body must answer to the name it was approved under: one filed under an approved id
  // while calling itself something else registers on the host as that other name.
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
